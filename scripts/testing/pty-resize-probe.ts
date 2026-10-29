/** Match complete protocol frames, including output split across PTY data callbacks. */
export function hasCompletePtyLine(output: string, expected: string): boolean {
  return output
    .split("\n")
    .slice(0, -1)
    .some((line) => line.replace(/\r$/u, "") === expected);
}

/** A successful resize request does not synchronously refresh the child's cached TTY size. */
export async function probePtyResize(
  terminal: {
    resize(cols: number, rows: number): void | Promise<unknown>;
    query(): void | Promise<unknown>;
    waitForLine(line: string, deadline: number): Promise<unknown>;
  },
  cols: number,
  rows: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await terminal.resize(cols, rows);
  await terminal.waitForLine(`RESIZED:${cols}:${rows}`, deadline);
  if (Date.now() >= deadline) throw new Error("PTY resize timed out");
  await terminal.query();
  await terminal.waitForLine(`SIZE:${cols}:${rows}`, deadline);
  if (Date.now() >= deadline) throw new Error("PTY resize timed out");
}
