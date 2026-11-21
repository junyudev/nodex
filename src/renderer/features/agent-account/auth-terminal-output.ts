/**
 * The Runtime sends a bounded tail of the sign-in transcript and the total characters written.
 * Returns what to append since `written`, or the whole tail after a gap the tail no longer covers.
 */
export function authTerminalDelta(
  written: number,
  output: string,
  outputOffset: number,
): { readonly reset: boolean; readonly data: string } {
  const unseen = outputOffset - written;
  if (unseen < 0 || unseen > output.length) return { reset: true, data: output };
  return { reset: false, data: unseen === 0 ? "" : output.slice(output.length - unseen) };
}
