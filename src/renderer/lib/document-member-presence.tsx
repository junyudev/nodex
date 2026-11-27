import { createContext, useContext, useMemo, type ReactNode } from "react";
import { memberIdentity, type MemberMentionDisplay } from "./member-identity";
import { useLocalMember } from "./members-runtime";

type DocumentMemberPresence = Pick<MemberMentionDisplay, "name" | "color">;
const DocumentMemberPresenceContext = createContext<DocumentMemberPresence | null>(null);

export function DocumentMemberPresenceProvider({ children }: { readonly children: ReactNode }) {
  const member = useLocalMember().data;
  const identity = useMemo(() => (member ? memberIdentity(member) : null), [member]);
  return <DocumentMemberPresenceContext value={identity}>{children}</DocumentMemberPresenceContext>;
}

export const useDocumentMemberPresence = () => useContext(DocumentMemberPresenceContext);
