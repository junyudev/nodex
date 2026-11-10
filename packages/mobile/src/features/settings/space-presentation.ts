import type { ConnectionState, SavedHost } from "../../runtime";

/** A linked Space as the phone shows it: what its avatar, name and kind are drawn from. */
export const linkedSpace = (host: SavedHost) => ({
  spaceId: host.spaceId,
  name: host.hostName,
  kind: host.spaceKind,
});

/**
 * The kind a Space's row names beside it, only when its name and avatar leave that unsaid. A
 * personal Space's avatar carries the Nodex mark, so it is never labelled; a team Space reads
 * "Team" unless its name already says so, as the default "Team Space" does.
 */
export const spaceKindLabel = (space: {
  readonly name: string;
  readonly kind: "personal" | "team";
}): string | null => (space.kind === "team" && !/\bteam\b/iu.test(space.name) ? "Team" : null);

const STATUS_WORDS: Readonly<Record<ConnectionState["status"], string>> = {
  idle: "Not connected",
  connecting: "Connecting",
  connected: "Connected",
  offline: "Unavailable",
  unavailable: "Unavailable",
  incompatible: "Needs an update",
  revoked: "Access revoked",
};

/** The current Space in a line beneath its name: its kind where that is unsaid, and its connection. */
export const spaceStatusLine = (
  space: { readonly name: string; readonly kind: "personal" | "team" },
  status: ConnectionState["status"],
): string => [spaceKindLabel(space), STATUS_WORDS[status]].filter(Boolean).join(" · ");
