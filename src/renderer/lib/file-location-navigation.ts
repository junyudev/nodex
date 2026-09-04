import { useEffect } from "react";
import type { LibraryPlacedResourceTarget } from "../../shared/library-module";
import { appScope, scopedAtom, useScopeHandle, useScopedAtomValue } from "./maitai";

type FileLocationNavigator = (target: LibraryPlacedResourceTarget) => Promise<boolean>;
const navigatorAtom = scopedAtom<{ open: FileLocationNavigator } | null>(appScope, null, {
  debugLabel: "file-location-navigation",
});

/** The Workbench owns navigation; File surfaces supply only an authorized target. */
export function useRegisterFileLocationNavigator(open: FileLocationNavigator) {
  const handle = useScopeHandle(appScope);
  useEffect(() => {
    const registration = { open };
    handle.set(navigatorAtom, registration);
    return () => {
      if (handle.get(navigatorAtom) === registration) handle.set(navigatorAtom, null);
    };
  }, [handle, open]);
}

export function useFileLocationNavigator() {
  return useScopedAtomValue(navigatorAtom)?.open ?? null;
}
