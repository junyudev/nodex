import { useCallback } from "react";

import {
  readCopyFileReferencesAsLocalPaths,
  writeCopyFileReferencesAsLocalPaths,
} from "./copy-file-reference-settings";
import { appScope, scopedAtomWithInitializer, useScopedAtom } from "./maitai";

const copyFileReferencesAsLocalPathsAtom = scopedAtomWithInitializer(
  appScope,
  readCopyFileReferencesAsLocalPaths,
  { debugLabel: "copy-file-references-as-local-paths" },
);

export function useCopyFileReferenceSettings() {
  const [copyAsLocalPaths, setCopyAsLocalPathsState] = useScopedAtom(
    copyFileReferencesAsLocalPathsAtom,
  );
  const setCopyAsLocalPaths = useCallback(
    (enabled: boolean) => {
      setCopyAsLocalPathsState(writeCopyFileReferencesAsLocalPaths(enabled));
    },
    [setCopyAsLocalPathsState],
  );

  return { copyAsLocalPaths, setCopyAsLocalPaths } as const;
}
