import { persistedAtom, usePersistedAtomValue, useSetPersistedAtom } from "@/lib/maitai";

export type WorkspaceFileDiffLayout = "unified" | "split";

/** How a file's changes are laid out in the Files editor, shared by every file and window. */
const diffLayoutAtom = persistedAtom<WorkspaceFileDiffLayout>({
  debugLabel: "workspace-file-diff-layout",
  storageKey: "nodex:workspace-file-diff-layout:v1",
  defaultValue: "unified",
  hydration: "eager",
  decode: (value) => (value === "split" ? "split" : "unified"),
});

/** Whether the Files editor shows the author and commit of the line under the caret. */
const activeLineBlameAtom = persistedAtom({
  debugLabel: "workspace-file-active-line-blame",
  storageKey: "nodex:workspace-file-active-line-blame:v1",
  defaultValue: false,
  hydration: "eager",
  decode: (value) => value === true,
});

function ignoreWriteFailure() {
  // The preference stays applied in this window; the next change retries the write.
}

export function useWorkspaceFileDiffLayout() {
  const layout = usePersistedAtomValue(diffLayoutAtom).value;
  const write = useSetPersistedAtom(diffLayoutAtom);
  const toggle = () => {
    void write((current) => (current === "split" ? "unified" : "split")).catch(ignoreWriteFailure);
  };
  return { layout, toggle };
}

export function useWorkspaceFileActiveLineBlame() {
  const enabled = usePersistedAtomValue(activeLineBlameAtom).value;
  const write = useSetPersistedAtom(activeLineBlameAtom);
  const toggle = () => {
    void write((current) => !current).catch(ignoreWriteFailure);
  };
  return { enabled, toggle };
}
