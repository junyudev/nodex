/** A Member who can be mentioned in a Comment. */
export interface MentionCandidate {
  readonly id: string;
  readonly name: string;
}

const MEMBER_MENTION = /<nodex:\/\/members\/([^>\s]+)>/g;

/** The `@` word the caret is in, if any: `@` at a word start followed by non-space text. */
export function activeMentionQuery(
  text: string,
  caret: number,
): { readonly start: number; readonly text: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@]*)$/u.exec(before);
  if (!match) return null;
  return { start: caret - match[2]!.length - 1, text: match[2]! };
}

/**
 * Turns the `@Name` words a person chose from the mention list into canonical member mentions.
 * Longer names are replaced first so "@Ann Lee" wins over "@Ann".
 */
export function encodeCommentMentions(
  text: string,
  mentioned: readonly MentionCandidate[],
): string {
  let encoded = text;
  for (const member of mentioned.toSorted((a, b) => b.name.length - a.name.length)) {
    const pattern = new RegExp(
      `(^|\\s)@${escapeRegExp(member.name)}(?=$|[\\s.,;:!?，。；：！？])`,
      "gu",
    );
    encoded = encoded.replace(
      pattern,
      (_whole, lead: string) => `${lead}<nodex://members/${member.id}>`,
    );
  }
  return encoded;
}

/** Shows member mentions as `@Name` for reading; unknown Members read as `@someone`. */
export function decodeCommentMentions(
  markdown: string,
  nameOf: (memberId: string) => string | null,
): string {
  return markdown.replace(
    MEMBER_MENTION,
    (_whole, id: string) => `**@${nameOf(id) ?? "someone"}**`,
  );
}

/** The Members a Comment body mentions, in order of first appearance. */
export function mentionedMemberIds(markdown: string): readonly string[] {
  const ids: string[] = [];
  for (const match of markdown.matchAll(MEMBER_MENTION)) {
    if (!ids.includes(match[1]!)) ids.push(match[1]!);
  }
  return ids;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
