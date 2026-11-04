import { useEffect, useEffectEvent, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { observeCodexDocumentAppearance } from "../../lib/codex-theme-variant";
import { applyTerminalTheme, readTerminalTheme } from "../../lib/terminal-appearance";
import { bindTerminalInput } from "../../lib/terminal-keyboard";
import { TerminalRenderer } from "../../lib/terminal-renderer";
import { resolveTerminalTypography } from "../../lib/terminal-typography";
import { acpTerminalDelta } from "./acp-agent-model";

/** An interactive terminal for an Agent's own sign-in command; input goes to its owned PTY. */
export default function AcpAuthTerminal({
  output,
  outputOffset,
  onInput,
  onResize,
}: {
  readonly output: string;
  readonly outputOffset: number | undefined;
  readonly onInput: (data: string) => void;
  readonly onResize: (size: { cols: number; rows: number }) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const renderer = useRef<TerminalRenderer | null>(null);
  const written = useRef(0);
  const input = useEffectEvent(onInput);
  const resize = useEffectEvent(onResize);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const typography = resolveTerminalTypography(element);
    const display = new TerminalRenderer({
      ...typography,
      rows: 12,
      theme: readTerminalTheme(element),
    });
    const term = display.terminal;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    renderer.current = display;
    written.current = 0;
    const terminalInput = bindTerminalInput(
      term,
      element,
      () => display.isReplayingInitLog,
      (data) => input(data),
    );
    const stopAppearanceObserver = observeCodexDocumentAppearance(
      element.ownerDocument,
      () => applyTerminalTheme(term, element),
      { observeBody: true },
    );
    const fitToContainer = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      resize({ cols: term.cols, rows: term.rows });
    };
    fitToContainer();
    const observer = new ResizeObserver(() => fitToContainer());
    observer.observe(element);
    term.focus();
    return () => {
      observer.disconnect();
      stopAppearanceObserver();
      terminalInput.dispose();
      display.dispose();
      renderer.current = null;
    };
  }, []);

  useEffect(() => {
    const display = renderer.current;
    if (!display) return;
    const offset = outputOffset ?? output.length;
    const delta = acpTerminalDelta(written.current, output, offset);
    if (delta.reset || written.current === 0) display.replaceOutput(delta.data);
    else if (delta.data) display.write(delta.data);
    written.current = offset;
  }, [output, outputOffset]);

  return (
    <div
      ref={container}
      role="group"
      aria-label="Sign-in terminal"
      className="h-56 w-full overflow-hidden rounded-lg bg-(--color-codex-terminal-background) p-2 ring-[0.5px] ring-token-border"
    />
  );
}
