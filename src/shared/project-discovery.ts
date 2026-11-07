import type { NativeSessionBackendKind } from "./native-session-catalog";

/** A recent native conversation that can be copied into Nodex along with its Project. */
export interface ProjectCandidateChat {
  readonly backendKind: NativeSessionBackendKind;
  readonly instanceConfigId?: string;
  readonly nativeHome: string;
  readonly nativeSessionId: string;
  readonly title: string;
  readonly cwd: string;
  readonly updatedAt: number;
}

/** A folder an Agent has already worked in, offered as a Project. */
export interface ProjectCandidate {
  readonly path: string;
  /** `path` with the home directory shortened to `~`. */
  readonly displayPath: string;
  readonly name: string;
  /** `owner/name` when the folder is a Git repository with a recognizable remote. */
  readonly repository: string | null;
  readonly isGitRepository: boolean;
  readonly chatCount: number;
  readonly lastActiveAt: number;
  /** Actively used; preselected when offered. */
  readonly suggested: boolean;
  /** Newest first and bounded; chats already copied into Nodex are absent. */
  readonly recentChats: readonly ProjectCandidateChat[];
}

export interface ProjectDiscoveryResult {
  readonly candidates: readonly ProjectCandidate[];
  /** The scan stopped at its bound, so older folders may be missing. */
  readonly truncated: boolean;
}
