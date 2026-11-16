/**
 * JSON Lines from a byte stream, one record per `\n`. Node's readline also ends a line at U+2028
 * and U+2029, which JSON text may contain unescaped inside strings, so it would cut such a record
 * in two; this reader splits only where the format does. A `\r` before the `\n` is dropped, and a
 * final record without a newline is still delivered.
 */
export async function* jsonLines(
  input: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of input) {
    pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let end = pending.indexOf("\n");
    while (end !== -1) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      yield line.endsWith("\r") ? line.slice(0, -1) : line;
      end = pending.indexOf("\n");
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) yield pending.endsWith("\r") ? pending.slice(0, -1) : pending;
}
