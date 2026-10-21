import { parseNfm } from "./parser";
import { serializeNfm } from "./serializer";
import type { NfmBlock } from "./types";

// Character escapes, and the escapes that keep a paragraph line from reading as a Block marker
// or as indentation; each one goes only when the text reads back the same without it.
const ESCAPE = /\\[\\*~`$[\]<>{}|^ \t\-+#▶▼.)]/g;
/** Past this many escapes, only the all-at-once form is tried; a message rarely gets close. */
const MAX_SINGLE_ESCAPE_TRIES = 256;

/**
 * Nested Markdown for people to read and edit: the canonical form without each backslash escape
 * that reads back the same without it. `a \< b` becomes `a < b`, while an escape that keeps
 * text from becoming markup stays. Parsing the result always yields `blocks` again.
 */
export function serializePlainNfm(blocks: readonly NfmBlock[]): string {
  const canonical = serializeNfm([...blocks]);
  const reference = JSON.stringify(parseNfm(canonical));
  const readsBack = (source: string) => JSON.stringify(parseNfm(source)) === reference;

  const unescaped = canonical.replace(ESCAPE, (escape) => escape.slice(1));
  if (unescaped === canonical || readsBack(unescaped)) return unescaped;
  if ((canonical.match(ESCAPE)?.length ?? 0) > MAX_SINGLE_ESCAPE_TRIES) return canonical;

  let source = canonical;
  let from = 0;
  for (;;) {
    ESCAPE.lastIndex = from;
    const escape = ESCAPE.exec(source);
    if (!escape) return source;
    const candidate = source.slice(0, escape.index) + source.slice(escape.index + 1);
    if (readsBack(candidate)) {
      source = candidate;
      from = escape.index + 1;
    } else {
      from = escape.index + 2;
    }
  }
}
