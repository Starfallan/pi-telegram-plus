import { stripVTControlCharacters } from "node:util";
import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { TELEGRAM_STATUS_KEY } from "./status.ts";

type FooterDataView = {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  getAvailableProviderCount(): number;
  onBranchChange(callback: () => void): () => void;
};

type FooterRender = (this: FooterComponent, width: number) => string[];
type FooterWithData = { footerData: FooterDataView };

const ORIGINAL_RENDER_KEY = Symbol.for("pi-telegram-plus.footer.original-render");
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function isWideCharacter(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1b000 && codePoint <= 0x1b2ff)
    || (codePoint >= 0x1f200 && codePoint <= 0x1f251)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function terminalWidth(text: string): number {
  const plainText = stripVTControlCharacters(text);
  let width = 0;

  for (const { segment } of graphemeSegmenter.segment(plainText)) {
    if (/\p{Extended_Pictographic}/u.test(segment)
      || /\p{Regional_Indicator}{2}/u.test(segment)
      || /[\uFE0F\u20E3]/u.test(segment)) {
      width += 2;
      continue;
    }

    for (const character of segment) {
      if (/[\p{Control}\p{Mark}]/u.test(character) || character === "\u200d") continue;
      width += isWideCharacter(character.codePointAt(0) ?? 0) ? 2 : 1;
    }
  }

  return width;
}

export function rightAlignStatusText(text: string, width: number): string {
  const padding = Math.max(0, width - terminalWidth(text));
  return `${" ".repeat(padding)}${text}`;
}

function createFooterDataView(
  footerData: FooterDataView,
  statuses: ReadonlyMap<string, string>,
): FooterDataView {
  return {
    getGitBranch: () => footerData.getGitBranch(),
    getExtensionStatuses: () => statuses,
    getAvailableProviderCount: () => footerData.getAvailableProviderCount(),
    onBranchChange: (callback) => footerData.onBranchChange(callback),
  };
}

export function renderFooterWithTelegramStatusRight(
  footer: FooterComponent,
  originalRender: FooterRender,
  width: number,
): string[] {
  const footerWithData = footer as unknown as FooterWithData;
  const footerData = footerWithData.footerData;
  const statuses = footerData.getExtensionStatuses();
  const telegramStatus = statuses.get(TELEGRAM_STATUS_KEY);
  if (telegramStatus === undefined) return originalRender.call(footer, width);

  const telegramStatuses = new Map([[TELEGRAM_STATUS_KEY, telegramStatus]]);
  const otherStatuses = new Map(statuses);
  otherStatuses.delete(TELEGRAM_STATUS_KEY);

  try {
    footerWithData.footerData = createFooterDataView(footerData, telegramStatuses);
    const telegramLines = originalRender.call(footer, width);
    const telegramLine = telegramLines.at(-1);

    footerWithData.footerData = createFooterDataView(footerData, otherStatuses);
    const lines = originalRender.call(footer, width);
    if (telegramLine !== undefined) {
      lines.splice(Math.min(2, lines.length), 0, rightAlignStatusText(telegramLine, width));
    }
    return lines;
  } finally {
    footerWithData.footerData = footerData;
  }
}

export function installTelegramStatusAlignment(): void {
  const prototype = FooterComponent.prototype as unknown as {
    render: FooterRender;
    [key: symbol]: FooterRender | undefined;
  };
  if (prototype[ORIGINAL_RENDER_KEY]) return;

  const originalRender = prototype.render;
  Object.defineProperty(prototype, ORIGINAL_RENDER_KEY, { value: originalRender });
  prototype.render = function renderWithTelegramStatusRight(width: number): string[] {
    return renderFooterWithTelegramStatusRight(this, originalRender, width);
  };
}
