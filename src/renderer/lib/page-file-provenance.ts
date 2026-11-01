import type { AgentBackendBinding } from "../../shared/agent-backend";
import type { LibraryPageFileItem } from "../../shared/library-files";
import type { PageFileTreeFile } from "./page-file-tree";

/** Who attached a Page File entry, as the Files tree presents it. */
export type PageFileSource =
  | { readonly kind: "person" }
  | {
      readonly kind: "agent";
      readonly sessionId: string;
      readonly backendKind: AgentBackendBinding["kind"];
    }
  | { readonly kind: "external" };

/** Entry provenance, or null for body-only Files and entries with no recorded origin. */
export const pageFileSource = (item: LibraryPageFileItem): PageFileSource | null => {
  const actor = item.attachment?.attached_by;
  if (!actor) return null;
  switch (actor.kind) {
    case "person":
      return { kind: "person" };
    case "agent":
      return { kind: "agent", sessionId: actor.session_id, backendKind: actor.backend };
    case "external":
      return { kind: "external" };
    default:
      return null;
  }
};

/** One key per origin; a chat that changed providers between attachments has two. */
export const pageFileSourceKey = (source: PageFileSource): string =>
  source.kind === "agent" ? `agent:${source.sessionId}:${source.backendKind}` : source.kind;

export const parsePageFileSourceKey = (key: string): PageFileSource | null => {
  if (key === "person" || key === "external") return { kind: key };
  const match = /^agent:(.+):([^:]+)$/u.exec(key);
  if (!match) return null;
  return {
    kind: "agent",
    sessionId: match[1]!,
    backendKind: match[2] as AgentBackendBinding["kind"],
  };
};

const attachedAtMs = (item: LibraryPageFileItem): number | null => {
  const value = item.attachment?.attached_at;
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const toPageFileTreeFile = (
  item: LibraryPageFileItem,
): PageFileTreeFile<LibraryPageFileItem> => {
  const source = pageFileSource(item);
  return {
    fileId: item.file.file_id,
    logicalPath: item.logical_path ?? null,
    defaultName: item.file.default_name,
    sourceKey: source ? pageFileSourceKey(source) : null,
    attachedAtMs: source ? attachedAtMs(item) : null,
    value: item,
  };
};
