import { useSyncExternalStore } from "react";
import { NfmEditor } from "@/components/board/editor/nfm-editor";
import { libraryContentRoute } from "../../../shared/content-routing-context";
import type { SkillEditorSession, SkillEditorSnapshot } from "./skill-editor-session";

export interface SkillBodyEditorProps {
  readonly session: SkillEditorSession;
  readonly readOnly?: boolean;
  readonly className?: string;
}

export function useSkillEditorSnapshot(session: SkillEditorSession): SkillEditorSnapshot {
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
}

/** Renders the rich body only. The surrounding view owns Source mode and save feedback. */
export function SkillBodyEditor({ session, className, readOnly }: SkillBodyEditorProps) {
  const { editorSource } = useSkillEditorSnapshot(session);
  if (!editorSource) return null;
  return (
    <NfmEditor
      contentRoutingContext={libraryContentRoute}
      source={{ ...editorSource, readOnly }}
      className={className}
    />
  );
}
