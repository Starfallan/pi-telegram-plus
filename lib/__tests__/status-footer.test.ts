import type { FooterComponent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  renderFooterWithTelegramStatusRight,
  rightAlignStatusText,
} from "../status-footer.ts";
import { TELEGRAM_STATUS_KEY } from "../status.ts";

type TestFooterData = {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  getAvailableProviderCount(): number;
  onBranchChange(callback: () => void): () => void;
};

type TestFooter = { footerData: TestFooterData };

function createFooter(statuses: ReadonlyMap<string, string>): {
  footer: TestFooter;
  footerData: TestFooterData;
} {
  const footerData: TestFooterData = {
    getGitBranch: () => "master",
    getExtensionStatuses: () => statuses,
    getAvailableProviderCount: () => 1,
    onBranchChange: () => () => undefined,
  };
  return {
    footer: { footerData },
    footerData,
  };
}

function renderTestFooter(this: FooterComponent): string[] {
  const footerData = (this as unknown as TestFooter).footerData;
  const lines = ["~/workspace", "stats                  model"];
  const statusLine = [...footerData.getExtensionStatuses().values()].join(" ");
  if (statusLine) lines.push(statusLine);
  return lines;
}

describe("rightAlignStatusText", () => {
  it("right-aligns ANSI-colored text by visible width", () => {
    const text = "\u001b[32mtelegram+\u001b[39m connected";
    expect(rightAlignStatusText(text, 24)).toBe(`     ${text}`);
  });

  it("counts wide characters as two terminal cells", () => {
    expect(rightAlignStatusText("状态", 6)).toBe("  状态");
  });
});

describe("renderFooterWithTelegramStatusRight", () => {
  it("places Telegram status below the model and keeps other statuses", () => {
    const statuses = new Map([
      ["goal", "goal active"],
      [TELEGRAM_STATUS_KEY, "telegram+ connected"],
    ]);
    const { footer, footerData } = createFooter(statuses);

    const lines = renderFooterWithTelegramStatusRight(
      footer as unknown as FooterComponent,
      renderTestFooter,
      24,
    );

    expect(lines).toEqual([
      "~/workspace",
      "stats                  model",
      "     telegram+ connected",
      "goal active",
    ]);
    expect(footer.footerData).toBe(footerData);
  });

  it("uses the original renderer once when Telegram status is absent", () => {
    const { footer } = createFooter(new Map([["goal", "goal active"]]));
    const render = vi.fn(renderTestFooter);

    expect(renderFooterWithTelegramStatusRight(
      footer as unknown as FooterComponent,
      render,
      24,
    )).toEqual([
      "~/workspace",
      "stats                  model",
      "goal active",
    ]);
    expect(render).toHaveBeenCalledOnce();
  });
});
