import { persistedAtom, usePersistedAtomValue, useSetPersistedAtom } from "@/lib/maitai";

/**
 * One reading preference for every read-only code block: toggling any block rewraps them all,
 * in every window. Editable Code Blocks keep their own per-Block wrap state.
 */
const codeBlockWordWrapAtom = persistedAtom({
  debugLabel: "code-block-word-wrap",
  storageKey: "nodex:code-block-word-wrap:v1",
  defaultValue: false,
  hydration: "eager",
  decode: (value) => value === true,
});

export function useCodeBlockWordWrap() {
  const wrapped = usePersistedAtomValue(codeBlockWordWrapAtom).value;
  const write = useSetPersistedAtom(codeBlockWordWrapAtom);
  const toggle = () => {
    void write((current) => !current).catch(() => {
      // The preference stays applied for this window; the next change retries the write.
    });
  };
  return { wrapped, toggle };
}
