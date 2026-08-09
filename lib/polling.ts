import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "./config.ts";
import { getTelegramUpdates } from "./telegram-api.ts";
import type { TelegramConfig, TelegramUpdate } from "./types.ts";
import { log } from "./logger.ts";

const pollLog = log.child("polling");

export type TelegramPollingRuntime = {
  start(): void;
  stop(): Promise<void>;
  isActive(): boolean;
};

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const POLL_LOCK_STALE_MS = 45_000;
const POLL_LOCK_TOUCH_MS = 5_000;
// Keep live candidate dirs long enough that a concurrent stager cannot be swept mid-write.
const POLL_LOCK_CANDIDATE_MAX_AGE_MS = POLL_LOCK_TOUCH_MS * 2;

type PollingLockOwner = {
  id: string;
  pid: number;
  at: string;
  touchedAt: string;
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

function tokenLockPath(token: string): string {
  const hash = createHash("sha256").update(token).digest("hex").slice(0, 24);
  return join(getAgentDir(), `tg-poll-${hash}.lock`);
}

function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    pollLog.debug("isPollingLockStale stat failed (treated as not stale)", { err });
    return false;
  }
}

function ownerText(owner: PollingLockOwner): string {
  return JSON.stringify(owner, null, 2) + "\n";
}

async function readPollingLockOwner(ownerPath: string): Promise<PollingLockOwner | undefined> {
  try {
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Partial<PollingLockOwner>;
    if (typeof owner.id !== "string" || typeof owner.pid !== "number") return undefined;
    return {
      id: owner.id,
      pid: owner.pid,
      at: typeof owner.at === "string" ? owner.at : "",
      touchedAt: typeof owner.touchedAt === "string" ? owner.touchedAt : "",
    };
  } catch (err) {
    pollLog.debug("readPollingLockOwner failed (treated as no owner)", { err });
    return undefined;
  }
}

type PollingLockSnapshot = {
  exists: boolean;
  stale: boolean;
  staleId: string;
};

async function inspectPollingLock(lockPath: string): Promise<PollingLockSnapshot> {
  const lockStat = await stat(lockPath).catch(() => undefined);
  if (!lockStat) return { exists: false, stale: false, staleId: "missing" };
  const ownerPath = join(lockPath, "owner.json");
  const owner = await readPollingLockOwner(ownerPath);
  const heartbeatPath = owner ? join(lockPath, `heartbeat-${owner.id}`) : ownerPath;
  const modifiedAt = await stat(heartbeatPath).then((value) => value.mtimeMs).catch(() => lockStat.mtimeMs);
  const age = Date.now() - modifiedAt;
  return {
    exists: true,
    stale: owner ? age > POLL_LOCK_STALE_MS || !isPidAlive(owner.pid) : age > POLL_LOCK_STALE_MS,
    staleId: (owner?.id ?? `unknown-${Math.trunc(modifiedAt)}`).replace(/[^a-zA-Z0-9_-]/g, "_"),
  };
}

async function removeLockArtifact(path: string, reason: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(pollLog.swallow("debug", reason, { path }));
}

/**
 * Best-effort cleanup of tombstones left by prior retire/quarantine and of
 * abandoned candidate directories from crashed acquirers. Safe because live locks
 * use the bare `*.lock` name; only suffix artifacts are removed.
 *
 * Young `.candidate-*` dirs are retained so a concurrent acquirer staging
 * owner/heartbeat files is not deleted out from under write/rename.
 */
async function cleanupPollingLockArtifacts(lockPath: string, retainPath?: string): Promise<void> {
  const dir = dirname(lockPath);
  const base = basename(lockPath);
  const names = await readdir(dir).catch(() => [] as string[]);
  const cleanedAt = Date.now();
  await Promise.all(names.map(async (name) => {
    if (name === base) return;
    const isRetired = name.startsWith(`${base}.retired-`);
    const isCandidate = name.startsWith(`${base}.candidate-`);
    if (!isRetired && !isCandidate) return;
    const path = join(dir, name);
    if (retainPath && path === retainPath) return;
    if (isCandidate) {
      const ageMs = await stat(path)
        .then((value) => cleanedAt - value.mtimeMs)
        .catch(() => Number.POSITIVE_INFINITY);
      if (ageMs < POLL_LOCK_CANDIDATE_MAX_AGE_MS) return;
    }
    await removeLockArtifact(path, "remove polling lock artifact failed");
  }));
}

async function quarantineStalePollingLock(lockPath: string): Promise<boolean> {
  const snapshot = await inspectPollingLock(lockPath);
  if (!snapshot.exists) return true;
  if (!snapshot.stale) return false;
  const stalePath = `${lockPath}.retired-${snapshot.staleId}`;
  try {
    await rename(lockPath, stalePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    if (code === "EEXIST" || code === "ENOTEMPTY") return false;
    throw error;
  }
  // Rename frees the live lock path atomically; the tombstone is disposable.
  await removeLockArtifact(stalePath, "remove retired polling lock failed");
  return true;
}

/**
 * Atomically claim the polling lock by fully preparing an owner directory and
 * renaming that non-empty candidate into place. No process can observe an
 * ownerless published lock or overwrite another owner's metadata.
 */
async function acquirePollingLock(token: string): Promise<{ owns: () => Promise<boolean>; release: () => Promise<void> } | undefined> {
  await mkdir(getAgentDir(), { recursive: true });
  const lockPath = tokenLockPath(token);
  const ownerPath = join(lockPath, "owner.json");
  const owner: PollingLockOwner = {
    id: randomUUID(),
    pid: process.pid,
    at: new Date().toISOString(),
    touchedAt: new Date().toISOString(),
  };
  const candidatePath = `${lockPath}.candidate-${owner.id}`;
  const heartbeatName = `heartbeat-${owner.id}`;

  // Drop abandoned leftovers, but retain any in-flight candidate we are about to (re)use.
  await cleanupPollingLockArtifacts(lockPath, candidatePath);

  try {
    await mkdir(candidatePath, { mode: 0o700 });
    await writeFile(join(candidatePath, "owner.json"), ownerText(owner), { mode: 0o600, flag: "wx" });
    await writeFile(join(candidatePath, heartbeatName), owner.touchedAt, { mode: 0o600, flag: "wx" });
  } catch (error) {
    await rm(candidatePath, { recursive: true, force: true });
    throw error;
  }

  // Atomically quarantine a stale lock. The owner-derived tombstone path keeps
  // concurrent stale-lock breakers from deleting a newly acquired lock.
  if (!await quarantineStalePollingLock(lockPath)) {
    await rm(candidatePath, { recursive: true, force: true });
    return undefined;
  }

  try {
    await rename(candidatePath, lockPath);
  } catch (error) {
    await rm(candidatePath, { recursive: true, force: true }).catch(pollLog.swallow("debug", "remove polling lock candidate failed", { candidatePath }));
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY") return undefined;
    throw error;
  }

  // Sweep any race-created artifacts now that we own the live lock path.
  await cleanupPollingLockArtifacts(lockPath);

  const heartbeatPath = join(lockPath, heartbeatName);
  const touch = setInterval(() => {
    owner.touchedAt = new Date().toISOString();
    void writeFile(heartbeatPath, owner.touchedAt, { mode: 0o600 })
      .catch(pollLog.swallow("warn", "polling lock heartbeat write failed", { heartbeatPath }));
  }, POLL_LOCK_TOUCH_MS);

  return {
    owns: async () => (await readPollingLockOwner(ownerPath))?.id === owner.id,
    release: async () => {
      clearInterval(touch);
      const retiredPath = `${lockPath}.retired-${owner.id}`;
      try {
        await rename(lockPath, retiredPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") return;
        pollLog.warn("retire polling lock on release failed", { lockPath, error });
        return;
      }
      // Tombstone only exists to free the live path safely; delete immediately.
      await removeLockArtifact(retiredPath, "remove retired polling lock on release failed");
      await cleanupPollingLockArtifacts(lockPath);
    },
  };
}


export type TelegramUpdateBatchDeps = {
  getConfig: () => TelegramConfig;
  setConfig: (config: TelegramConfig) => void;
  persistConfig: (config: TelegramConfig) => Promise<void>;
  persistUpdate?: (config: TelegramConfig, update: TelegramUpdate) => Promise<void>;
  shouldProcess?: () => boolean;
  handleUpdate: (update: TelegramUpdate) => Promise<void>;
  onError: (error: unknown) => void;
};

/**
 * Process one getUpdates batch in strict order. If handling or persisting an
 * update fails, stop immediately: later updates must not advance lastUpdateId
 * past the failed update, otherwise Telegram will never deliver it again.
 *
 * @internal Exported for tests; not part of the public package API.
 */
export async function processTelegramUpdatesBatch(
  updates: TelegramUpdate[],
  deps: TelegramUpdateBatchDeps,
  signal?: AbortSignal,
): Promise<void> {
  const batchToken = deps.getConfig().botToken;
  for (const update of updates) {
    if (signal?.aborted || (deps.shouldProcess && !deps.shouldProcess())) return;
    try {
      await deps.handleUpdate(update);
    } catch (error) {
      deps.onError(error);
      return;
    }
    if (deps.getConfig().botToken !== batchToken) return;
    const nextConfig = { ...deps.getConfig(), lastUpdateId: update.update_id };
    try {
      if (deps.persistUpdate) await deps.persistUpdate(nextConfig, update);
      else await deps.persistConfig(nextConfig);
      deps.setConfig(nextConfig);
    } catch (error) {
      deps.onError(error);
      return;
    }
  }
}

export function createTelegramPollingRuntime(deps: TelegramUpdateBatchDeps & {
  reloadConfig?: () => Promise<void>;
  onSuccess?: () => void;
  shouldPoll?: () => boolean;
}): TelegramPollingRuntime {
  let abort: AbortController | undefined;
  let loopPromise: Promise<void> | undefined;
  let pollLock: { token: string; owns: () => Promise<boolean>; release: () => Promise<void> } | undefined;

  const releasePollLock = async () => {
    const lock = pollLock;
    pollLock = undefined;
    await lock?.release().catch(pollLog.swallow("warn", "poll lock release failed"));
  };

  const ensurePollLock = async (token: string): Promise<boolean> => {
    if (pollLock?.token === token) {
      if (await pollLock.owns()) return true;
      await releasePollLock();
    } else {
      await releasePollLock();
    }
    const lock = await acquirePollingLock(token);
    if (!lock) return false;
    pollLock = { token, owns: lock.owns, release: lock.release };
    return true;
  };

  const loop = async (signal: AbortSignal) => {
    let backoffMs = MIN_BACKOFF_MS;

    try {
      while (!signal.aborted) {
        if (deps.shouldPoll && !deps.shouldPoll()) {
          await releasePollLock();
          await sleep(MIN_BACKOFF_MS, signal);
          continue;
        }
        const token = deps.getConfig().botToken;
        if (!token) {
          await releasePollLock();
          await sleep(MIN_BACKOFF_MS, signal);
          continue;
        }
        if (!(await ensurePollLock(token))) {
          deps.onError(new Error("Telegram polling skipped: another local pi instance is already polling this bot token."));
          await sleep(MAX_BACKOFF_MS, signal);
          continue;
        }

        try {
          // Refresh config after owning the poll lock. A process that waited for
          // the lock may have stale in-memory lastUpdateId; re-reading prevents it
          // from polling an already-persisted update after another process/reload.
          await deps.reloadConfig?.();
          if (signal.aborted) return;
          if (deps.shouldPoll && !deps.shouldPoll()) continue;
          const refreshedToken = deps.getConfig().botToken;
          if (!refreshedToken) continue;
          if (refreshedToken !== token) continue;

          const updates = await getTelegramUpdates(deps.getConfig(), signal);
          if (deps.getConfig().botToken !== refreshedToken) continue;
          if (deps.shouldPoll && !deps.shouldPoll()) continue;
          backoffMs = MIN_BACKOFF_MS;
          deps.onSuccess?.();

          await processTelegramUpdatesBatch(updates, deps, signal);
        } catch (error) {
          if (signal.aborted) return;
          deps.onError(error);
          await sleep(backoffMs, signal);
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        }
      }
    } finally {
      await releasePollLock();
    }
  };

  return {
    start() {
      if (abort || (deps.shouldPoll && !deps.shouldPoll())) return;
      const controller = new AbortController();
      abort = controller;
      loopPromise = loop(controller.signal)
        .catch((error) => {
          deps.onError(error);
        })
        .finally(() => {
          if (abort === controller) abort = undefined;
          loopPromise = undefined;
        });
    },
    async stop() {
      const controller = abort;
      controller?.abort();
      await loopPromise;
      if (abort === controller) abort = undefined;
    },
    isActive() {
      return !!abort;
    },
  };
}
