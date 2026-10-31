import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  readPageEditorSelection,
  subscribePageEditorSelection,
} from "./page-editor-observation-registry";

export function usePageEditorSelection(editorKey: string): readonly string[] {
  const subscribe = useCallback(
    (listener: () => void) => subscribePageEditorSelection(editorKey, listener),
    [editorKey],
  );
  const read = useCallback(() => readPageEditorSelection(editorKey), [editorKey]);
  return useSyncExternalStore(subscribe, read, read);
}

export function usePageEditorSelections(
  editorKeys: readonly string[],
): readonly (readonly string[])[] {
  const key = JSON.stringify(editorKeys);
  const keys = useMemo(() => JSON.parse(key) as string[], [key]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const releases = keys.map((editorKey) => subscribePageEditorSelection(editorKey, listener));
      return () => {
        for (const release of releases) release();
      };
    },
    [keys],
  );
  const read = useCallback(() => JSON.stringify(keys.map(readPageEditorSelection)), [keys]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  return useMemo(() => JSON.parse(snapshot) as string[][], [snapshot]);
}
