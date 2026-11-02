import { createContext, useContext, useMemo, type ReactNode } from "react";

const FileReferenceIntent = createContext({ sidePanel: true, markdownContext: false });
export const useFileReferenceIntent = () => useContext(FileReferenceIntent);

/** Message authorship controls file intent; Browser availability is supplied by its owner. */
export function FileReferenceIntentProvider({
  children,
  sidePanel,
  markdownContext = false,
}: {
  readonly children: ReactNode;
  readonly sidePanel: boolean;
  readonly markdownContext?: boolean;
}) {
  const value = useMemo(() => ({ sidePanel, markdownContext }), [sidePanel, markdownContext]);
  return <FileReferenceIntent value={value}>{children}</FileReferenceIntent>;
}
