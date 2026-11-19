import type { Member } from "../../shared/work-graph";
import { hueOf, initialsOf } from "./identity-glyph";

export interface MemberMentionDisplay {
  readonly name: string;
  readonly initials: string;
  readonly color: string;
}

export interface SpaceDirectoryMember extends Omit<MemberMentionDisplay, "name"> {
  readonly id: Member["id"];
  readonly displayName: Member["display_name"];
  readonly role: Member["role"];
  readonly lifecycle: Member["lifecycle"];
  readonly isCurrentMember: boolean;
}

// Yjs selection decorations append an alpha byte to the six-digit color.
const MEMBER_COLORS = [
  "#1d4ed8",
  "#6d28d9",
  "#a21caf",
  "#be185d",
  "#b91c1c",
  "#c2410c",
  "#92400e",
  "#4d7c0f",
  "#15803d",
  "#0f766e",
  "#0e7490",
  "#4338ca",
] as const;

export function memberIdentity(member: Pick<Member, "id" | "display_name">): MemberMentionDisplay {
  return {
    name: member.display_name,
    initials: initialsOf(member.display_name),
    color: MEMBER_COLORS[hueOf(member.id) % MEMBER_COLORS.length] ?? MEMBER_COLORS[0],
  };
}

export function resolveMemberMention(
  memberId: string,
  members: readonly SpaceDirectoryMember[],
): MemberMentionDisplay | null {
  const member = members.find(({ id }) => id === memberId);
  if (!member) return null;
  return { name: member.displayName, initials: member.initials, color: member.color };
}
