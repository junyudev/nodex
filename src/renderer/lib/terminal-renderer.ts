import { Terminal, type ITerminalInitOnlyOptions, type ITerminalOptions } from "@xterm/xterm";
import { createWriter } from "./terminal-writer";

export type AlternateScreenMode = 47 | 1047 | 1049;

export class TerminalRenderer {
  readonly terminal: Terminal;
  ready = Promise.resolve();
  isReady = true;
  isReplayingInitLog = false;
  isRestoringAlternateScreen: boolean;
  onOutput: (() => void) | null = null;
  /** The display was rebuilt, even when this replay superseded one already in progress. */
  onReplay: (() => void) | null = null;
  private readonly writer: ReturnType<typeof createWriter>;
  private readonly alternateScreenMode: AlternateScreenMode | undefined;
  private readonly queuedOutput: (string | null)[] = [];
  private finishReady: (() => void) | null = null;
  private restoreAlternateScreen: boolean;
  private isOutputBlocked = false;
  private disposed = false;

  constructor(
    options: ITerminalOptions & ITerminalInitOnlyOptions,
    alternateScreenMode?: AlternateScreenMode,
  ) {
    this.terminal = new Terminal({
      allowTransparency: true,
      allowProposedApi: true,
      cursorStyle: "bar",
      cursorBlink: true,
      letterSpacing: 0,
      lineHeight: 1.2,
      // Sizes the scrollbar gutter that Fit reserves; the ruler's own canvas is hidden in CSS.
      overviewRuler: { width: 10 },
      ...options,
    });
    this.writer = createWriter(this.terminal);
    this.alternateScreenMode = alternateScreenMode;
    this.isRestoringAlternateScreen = this.restoreAlternateScreen = alternateScreenMode != null;
  }

  write(data: string): void {
    if (this.disposed) return;
    if (this.isOutputBlocked) {
      this.queuedOutput.push(data);
      return;
    }
    this.writer.write(data);
    this.onOutput?.();
  }

  clear(): void {
    if (this.disposed) return;
    if (this.isOutputBlocked) {
      this.queuedOutput.push(null);
      return;
    }
    this.beginOutput();
    this.writer.flush(() => {
      this.terminal.clear();
      this.finishOutput();
    });
  }

  replaceOutput(
    data: string,
    offsets: readonly number[] = [],
    preservedMode?: AlternateScreenMode,
  ): void {
    if (this.disposed) return;
    this.finishReady?.();
    this.finishReady = null;
    this.beginOutput();
    const mode =
      preservedMode ?? (this.restoreAlternateScreen ? this.alternateScreenMode : undefined);
    const restore = mode !== undefined;
    this.restoreAlternateScreen = false;
    this.isRestoringAlternateScreen = restore;
    this.queuedOutput.length = 0;
    const first = data.slice(0, offsets[0] ?? data.length);

    const replayPart = (index: number) => {
      const start = offsets[index];
      if (start === undefined) {
        this.isReplayingInitLog = this.isRestoringAlternateScreen = false;
        this.finishOutput();
        this.onReplay?.();
        return;
      }
      this.terminal.clear();
      this.writer.write(data.slice(start, offsets[index + 1] ?? data.length));
      this.writer.flush(() => replayPart(index + 1));
    };

    this.writer.replaceOutput(
      restore ? `\x1b[?${mode ?? 1049}h${first}` : first,
      () => replayPart(0),
      () => {
        this.isReplayingInitLog = true;
      },
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.isReady = false;
    this.onOutput = null;
    this.onReplay = null;
    this.queuedOutput.length = 0;
    this.writer.dispose();
    this.terminal.dispose();
    this.finishReady?.();
    this.finishReady = null;
  }

  private beginOutput(): void {
    if (this.finishReady === null) {
      this.ready = new Promise((resolve) => {
        this.finishReady = resolve;
      });
    }
    this.isReady = false;
    this.isOutputBlocked = true;
  }

  private finishOutput(): void {
    this.isOutputBlocked = false;
    for (const item of this.queuedOutput.splice(0)) {
      if (item === null) this.clear();
      else this.write(item);
    }
    if (this.isOutputBlocked) return;
    this.isReady = true;
    this.onOutput?.();
    this.finishReady?.();
    this.finishReady = null;
  }
}
