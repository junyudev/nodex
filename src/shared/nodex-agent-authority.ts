import { createHash } from "node:crypto";

export const NODEX_AGENT_AUTHORITY_PROVENANCE_VERSION = 1 as const;

export type NodexAgentAuthorityScope = "project" | "library";

export type NodexAgentAuthoritySource =
  | "project_turn"
  | "builtin_full_access"
  | "inherited_builtin_full_access";

/**
 * Main-owned execution authority captured for one exact Codex Turn.
 *
 * This is an internal transport shape. It is never exposed in a dynamic-tool
 * schema and must not be reconstructed from model-controlled arguments.
 */
interface NodexAgentTurnAuthorityCoordinates {
  readonly threadId: string;
  readonly turnId: string;
  readonly rootThreadId: string;
  readonly libraryId: string;
  readonly storeEpoch: string;
  /** Core-owned durable issue coordinate for identities derived from this Turn. */
  readonly frozenAtMs: number;
  /** Immutable Core execution constraint; resource consent cannot elevate it. */
  readonly readOnly: boolean;
  readonly source: NodexAgentAuthoritySource;
}

export type FrozenNodexAgentTurnAuthority = NodexAgentTurnAuthorityCoordinates &
  (
    | { readonly scope: "project"; readonly actorProjectId: string }
    | { readonly scope: "library"; readonly actorProjectId: string | null }
  );

export const nodexAgentAuthorityFingerprint = (authority: FrozenNodexAgentTurnAuthority): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        NODEX_AGENT_AUTHORITY_PROVENANCE_VERSION,
        authority.threadId,
        authority.turnId,
        authority.rootThreadId,
        authority.actorProjectId,
        authority.libraryId,
        authority.storeEpoch,
        authority.scope,
        authority.source,
        authority.readOnly,
      ]),
    )
    .digest("hex");
