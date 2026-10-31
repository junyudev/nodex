import { createContext, useContext, type ReactNode } from "react";
import type { AgentHistoryImageReference } from "../../../shared/agent-history-images";
import type { AgentRuntimeAttachmentReference } from "../../../shared/agent-runtime-attachments";
import { DEFAULT_CODEX_HOST_ID } from "../../../shared/codex-host";
import type { ImageEditComposerTarget } from "./types";

/**
 * Where the content around an image lives, so the image's source reads from the right place: the
 * host whose files a path names, the folder a relative path starts from, and the owner that holds
 * the content, such as a chat, which admits reads only while it still holds the content's source.
 * Content outside any scope lives on this computer.
 */
export interface ContentImageScope {
  readonly hostId: string;
  /** The conversation the content belongs to; its images are read and cached with it. */
  readonly conversationId: string | null;
  /** The folder a relative path reads from. */
  readonly cwd: string | null;
  /** The Composer an image is added to, or edited into. */
  readonly composerTarget: ImageEditComposerTarget | null;
  /** The owner holding the content, by identity; null for this computer's own content. */
  readonly authority: object | null;
  /** The owner's current source of the content; a new source reads afresh. */
  readonly sourceIdentity: string;
  /** Whether the content is still shown from this source; an image's actions stop once not. */
  readonly isCurrent: () => boolean;
  /** Whether the owner still holds the source, independently of any one image on screen. */
  readonly isResourceCurrent: () => boolean;
  readonly resolveHistoryImage?: (reference: AgentHistoryImageReference) => Promise<string>;
  readonly resolveRuntimeAttachment?: (
    reference: AgentRuntimeAttachmentReference,
  ) => Promise<string>;
}

const always = () => true;

/** Content this computer holds itself, such as a Page or an Inbox message. */
export const THIS_COMPUTER_IMAGE_SCOPE: ContentImageScope = {
  hostId: DEFAULT_CODEX_HOST_ID,
  conversationId: null,
  cwd: null,
  composerTarget: null,
  authority: null,
  sourceIdentity: "this-computer",
  isCurrent: always,
  isResourceCurrent: always,
};

const ContentImageScopeContext = createContext<ContentImageScope>(THIS_COMPUTER_IMAGE_SCOPE);

export function ContentImageScopeProvider({
  scope,
  children,
}: {
  readonly scope: ContentImageScope;
  readonly children: ReactNode;
}) {
  return <ContentImageScopeContext value={scope}>{children}</ContentImageScopeContext>;
}

export const useContentImageScope = (): ContentImageScope => useContext(ContentImageScopeContext);
