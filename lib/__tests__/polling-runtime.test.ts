import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getTelegramUpdates: vi.fn(),
}));

vi.mock("../telegram-api.ts", () => ({
    getTelegramUpdates: mocks.getTelegramUpdates,
}));

import { createTelegramPollingRuntime } from "../polling.ts";
import type { TelegramConfig, TelegramUpdate } from "../types.ts";

const update: TelegramUpdate = {
    update_id: 10,
    message: { message_id: 10, chat: { id: 42 }, from: { id: 7 }, text: "switch" },
};

describe("TelegramPollingRuntime", () => {
    let agentDir: string;
    let previousAgentDir: string | undefined;

    beforeEach(async () => {
        previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        agentDir = await mkdtemp(join(tmpdir(), "pi-tg-polling-"));
        process.env.PI_CODING_AGENT_DIR = agentDir;
        mocks.getTelegramUpdates.mockReset();
    });

    afterEach(async () => {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(agentDir, { recursive: true, force: true });
    });

    it("waits for the current update to persist before stop releases the loop", async () => {
        let config: TelegramConfig = { botToken: `token-${Date.now()}`, lastUpdateId: 9 };
        let releaseHandler: () => void = () => undefined;
        const handlerGate = new Promise<void>((resolve) => {
            releaseHandler = resolve;
        });
        const events: string[] = [];
        mocks.getTelegramUpdates.mockResolvedValueOnce([update]);

        const runtime = createTelegramPollingRuntime({
            getConfig: () => config,
            setConfig: (next) => {
                config = next;
                events.push(`set:${next.lastUpdateId}`);
            },
            persistConfig: async () => undefined,
            persistUpdate: async (next) => {
                events.push(`persist:${next.lastUpdateId}`);
            },
            handleUpdate: async () => {
                events.push("handle:start");
                await handlerGate;
                events.push("handle:end");
            },
            onError: (error) => {
                throw error;
            },
            shouldPoll: () => true,
        });

        runtime.start();
        await vi.waitFor(() => expect(events).toContain("handle:start"));

        let stopped = false;
        const stopPromise = runtime.stop().then(() => {
            stopped = true;
            events.push("stopped");
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(stopped).toBe(false);

        releaseHandler();
        await stopPromise;

        expect(events).toEqual([
            "handle:start",
            "handle:end",
            "persist:10",
            "set:10",
            "stopped",
        ]);
        expect(runtime.isActive()).toBe(false);
    });

    it("quarantines a stale polling lock instead of deleting a new owner", async () => {
        const token = `stale-token-${Date.now()}`;
        const hash = createHash("sha256").update(token).digest("hex").slice(0, 24);
        const lockPath = join(agentDir, `tg-poll-${hash}.lock`);
        const ownerPath = join(lockPath, "owner.json");
        await mkdir(lockPath, { recursive: true });
        await writeFile(ownerPath, JSON.stringify({
            id: "old-owner",
            pid: 999_999,
            at: new Date(0).toISOString(),
            touchedAt: new Date(0).toISOString(),
        }));
        const staleTime = new Date(Date.now() - 60_000);
        await utimes(ownerPath, staleTime, staleTime);
        mocks.getTelegramUpdates.mockImplementationOnce(async (_config, signal: AbortSignal) => {
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
            return [];
        });

        const runtime = createTelegramPollingRuntime({
            getConfig: () => ({ botToken: token }),
            setConfig: () => undefined,
            persistConfig: async () => undefined,
            handleUpdate: async () => undefined,
            onError: (error) => { throw error; },
            shouldPoll: () => true,
        });
        runtime.start();
        await vi.waitFor(() => expect(mocks.getTelegramUpdates).toHaveBeenCalledTimes(1));

        const namesWhileActive = await readdir(agentDir);
        expect(namesWhileActive).toContain(`tg-poll-${hash}.lock`);
        expect(namesWhileActive.some((name) => name.includes(".retired-") || name.includes(".candidate-"))).toBe(false);

        await runtime.stop();

        const namesAfterStop = await readdir(agentDir);
        expect(namesAfterStop.some((name) => name.startsWith(`tg-poll-${hash}`))).toBe(false);
    });

    it("does not start a polling loop while the instance is not selected", () => {
        const runtime = createTelegramPollingRuntime({
            getConfig: () => ({ botToken: "token" }),
            setConfig: () => undefined,
            persistConfig: async () => undefined,
            handleUpdate: async () => undefined,
            onError: () => undefined,
            shouldPoll: () => false,
        });

        runtime.start();

        expect(runtime.isActive()).toBe(false);
        expect(mocks.getTelegramUpdates).not.toHaveBeenCalled();
    });
});
