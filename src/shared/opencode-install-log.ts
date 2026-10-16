import type { OpenCodeInstallerLog } from "./opencode-setup";

/** Presentation keeps a terminal-like scrollback; older output leaves through the top. */
export const OPENCODE_INSTALLER_LOG_LINE_LIMIT = 200;
const LINE_CHARACTER_LIMIT = 400;

// CSI (color, cursor visibility), OSC (title, hyperlink) and single-character escapes.
const ESCAPE_SEQUENCE =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/gu;
// Every other C0 control except tab, line feed and carriage return.
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
// A download meter that reports its share: curl's `#####   42.5%` or the installer's `■■･･  42%`.
const MEASURED_METER = /^[#■･\s]*?(\d{1,3}(?:\.\d+)?)%$/u;
// curl animates `#=#=#` or `-=O=-` when the transfer size is unknown.
const UNMEASURED_METER = /^(?=.*[#=])[#=O\-\s]+$/u;
// Block-element lettering (`█▀▀█`) only reads on a terminal's gapless character grid.
const BLOCK_ART = /^[\u2580-\u259f\s]+$/u;

/** A carriage return rewinds to column zero; later text overwrites earlier text in place. */
function renderCarriageReturns(line: string): string {
  let rendered = "";
  for (const segment of line.split("\r")) rendered = segment + rendered.slice(segment.length);
  return rendered;
}

function boundLine(line: string): string {
  return line.length > LINE_CHARACTER_LIMIT ? `${line.slice(0, LINE_CHARACTER_LIMIT - 1)}…` : line;
}

/**
 * Renders raw installer output as a terminal would show it, without escape sequences or block-art
 * lettering. Download meters become `progress` (0–1, last reported value) instead of log lines;
 * output that never reports a share leaves `progress` null so presentation stays indeterminate.
 */
export function projectOpenCodeInstallerLog(raw: string): OpenCodeInstallerLog {
  const text = raw
    .replace(/\r\n/gu, "\n")
    .replace(ESCAPE_SEQUENCE, "")
    .replace(CONTROL_CHARACTER, "");
  const lines: string[] = [];
  let progress: number | null = null;
  for (const source of text.split("\n")) {
    const line = renderCarriageReturns(source).trimEnd();
    const content = line.trim();
    const measured = MEASURED_METER.exec(content);
    if (measured) {
      progress = Math.min(1, Number(measured[1]) / 100);
      continue;
    }
    if (UNMEASURED_METER.test(content) || BLOCK_ART.test(content)) continue;
    if (!content && (lines.length === 0 || lines.at(-1) === "")) continue;
    lines.push(boundLine(content ? line : ""));
  }
  const bounded = lines.slice(-OPENCODE_INSTALLER_LOG_LINE_LIMIT);
  while (bounded[0] === "") bounded.shift();
  while (bounded.at(-1) === "") bounded.pop();
  return { lines: bounded, progress };
}
