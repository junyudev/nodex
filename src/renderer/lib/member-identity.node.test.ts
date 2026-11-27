import { expect, test } from "vite-plus/test";
import { memberIdentity, resolveMemberMention, type SpaceDirectoryMember } from "./member-identity";

test("keeps the Member's color through a rename and derives initials from their current name", () => {
  const ada = memberIdentity({ id: "member:ada", display_name: "Ada Lovelace" });
  const renamed = memberIdentity({ id: "member:ada", display_name: "Ada Byron" });
  const grace = memberIdentity({ id: "member:grace", display_name: "Grace Hopper" });

  expect(ada).toEqual({ name: "Ada Lovelace", initials: "AL", color: renamed.color });
  expect(renamed).toEqual({ name: "Ada Byron", initials: "AB", color: ada.color });
  expect(ada.color).toMatch(/^#[0-9a-f]{6}$/u);
  expect(grace.color).not.toBe(ada.color);
});

test("resolves a retained Member's last identity for a mention", () => {
  const removed: SpaceDirectoryMember = {
    id: "member:ada",
    displayName: "Ada Byron",
    initials: "AB",
    color: "#1d4ed8",
    role: "member",
    lifecycle: "removed",
    isCurrentMember: false,
  };

  expect(resolveMemberMention(removed.id, [removed])).toEqual({
    name: "Ada Byron",
    initials: "AB",
    color: removed.color,
  });
  expect(resolveMemberMention("member:missing", [removed])).toBeNull();
});
