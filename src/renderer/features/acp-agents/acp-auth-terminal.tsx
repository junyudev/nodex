import { useEffect, useEffectEvent, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { readTerminalTheme } from "../../lib/use-terminal";
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
  const terminal = useRef<Terminal | null>(null);
  const written = useRef(0);
  const input = useEffectEvent(onInput);
  const resize = useEffectEvent(onResize);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const typography = resolveTerminalTypography(element);
    const term = new Terminal({
      allowTransparency: true,
      convertEol: true,
      cursorBlink: true,
      fontFamily: typography.fontFamily,
      fontSize: typography.fontSize,
      lineHeight: 1.2,
      rows: 12,
      scrollback: 1_000,
      theme: readTerminalTheme(element),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    terminal.current = term;
    written.current = 0;
    const dataListener = term.onData((data) => input(data));
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
      dataListener.dispose();
      term.dispose();
      terminal.current = null;
    };
  }, []);

  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    const offset = outputOffset ?? output.length;
    const delta = acpTerminalDelta(written.current, output, offset);
    if (delta.reset) term.reset();
    if (delta.data) term.write(delta.data);
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
