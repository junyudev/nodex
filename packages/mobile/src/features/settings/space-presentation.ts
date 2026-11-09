/**
 * The kind a Space's row names beside it, only when its name and avatar leave that unsaid. A
 * personal Space's avatar carries the Nodex mark, so it is never labelled; a team Space reads
 * "Team" unless its name already says so, as the default "Team Space" does.
 */
export const spaceKindLabel = (space: {
  readonly name: string;
  readonly kind: "personal" | "team";
}): string | null => (space.kind === "team" && !/\bteam\b/iu.test(space.name) ? "Team" : null);
