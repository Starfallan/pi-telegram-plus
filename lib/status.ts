export const TELEGRAM_STATUS_KEY = "telegram-plus";

export type StatusLineTheme = {
  fg(token: "accent" | "error" | "muted" | "warning" | "success", text: string): string;
};

export type StatusLineUi = {
  theme: StatusLineTheme;
  setStatus(key: string, text: string | undefined): void;
};

export function formatTelegramStatusLine(
  theme: StatusLineTheme,
  state: {
    hasBotToken: boolean;
    pollingActive: boolean;
    paired: boolean;
    connected?: boolean;
    current?: boolean;
    processing?: boolean;
    error?: string;
    botUsername?: string;
  },
): string {
  const label = theme.fg("accent", "telegram+");
  if (state.error) {
    return `${label} ${theme.fg("error", "error")} ${theme.fg("muted", state.error)}`;
  }
  if (!state.hasBotToken) {
    return `${label} ${theme.fg("muted", "not configured")}`;
  }
  if (!state.pollingActive && !state.connected) {
    return `${label} ${theme.fg("muted", "disconnected")}`;
  }
  if (!state.paired) {
    return `${label} ${theme.fg("warning", "awaiting pairing")}`;
  }
  const bot = state.botUsername ? ` @${state.botUsername}` : "";
  if (state.processing) {
    const active = state.current ? "active(current)" : "active";
    return `${label} ${theme.fg("warning", active)}${bot}`;
  }
  if (state.current) {
    return `${label} ${theme.fg("success", "connected(current)")}${bot}`;
  }
  return `${label} ${theme.fg("success", "connected")}${bot}`;
}

export function clearTelegramStatus(ctx: { ui?: StatusLineUi }): void {
  if (!ctx?.ui?.setStatus) return;
  ctx.ui.setStatus(TELEGRAM_STATUS_KEY, undefined);
}