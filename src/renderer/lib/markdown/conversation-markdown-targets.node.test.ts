import { describe, expect, test } from "vite-plus/test";
import type { CodexComposerSkill } from "../../../shared/types";
import cases from "./fixtures/conversation-markdown-targets.json";
import {
  interpretConversationFilePath,
  readConversationFileCitation,
  readConversationTextDecorations,
  resolveConversationFileLink,
  resolveConversationInlineCode,
  resolveConversationMarkdownLink,
  resolveConversationSkill,
  resolveConversationThreadLink,
} from "./conversation-markdown-targets";

describe("authored conversation targets", () => {
  test("blocked URI schemes cannot become filesystem targets or Skill actions", () => {
    for (const href of [
      "javascript:foo/path.ts",
      "vbscript:foo/path.ts",
      "data:text/plain,/tmp/a.ts",
    ])
      expect(resolveConversationMarkdownLink(href, "$edit")).toBeNull();
  });
  test.each(cases.filter((entry) => entry.links.length > 0))(
    "closes the href interpretation stages for $name",
    ({ links }) => {
      for (const link of links) {
        const target = resolveConversationFileLink(link.href, "x");
        if (link.reference === null) {
          expect(target).toBeNull();
          continue;
        }
        expect(target?.reference).toEqual(link.reference);
        expect(target?.label).toBe(link.label);
      }
    },
  );
  test("keeps malformed native escapes literal as a whole, rejects URI errors and never treats authority as a host", () => {
    expect(interpretConversationFilePath("/tmp/a%ZZ%23b.ts")).toBe("/tmp/a%ZZ%23b.ts");
    expect(interpretConversationFilePath("file:///tmp/a%ZZ.ts")).toBeNull();
    expect(resolveConversationFileLink("file://other-host/share/a.ts", "a")?.reference).toEqual({
      path: "\\\\other-host\\share\\a.ts",
    });
    expect(resolveConversationFileLink("/tmp/a\0b.ts", "a")).toBeNull();
  });
  test("does not decode the direct inline-code native lane like an ordinary link", () => {
    expect(resolveConversationInlineCode("@/tmp/a%2520b.ts:2")?.kind).toBe("file");
    expect(resolveConversationInlineCode("@/tmp/a%2520b.ts:2")).toMatchObject({
      reference: { path: "/tmp/a%2520b.ts", line: 2 },
    });
    expect(resolveConversationInlineCode("[a](/tmp/a%2520b.ts:2)")).toMatchObject({
      reference: { path: "/tmp/a b.ts", line: 2 },
    });
    expect(resolveConversationInlineCode("@/tmp/directory")).toBeNull();
    expect(resolveConversationInlineCode("$[multi word]")).toMatchObject({
      kind: "skill",
      name: "multi word",
    });
  });
  test.each([
    ["thread://same", { threadId: "same" }],
    [
      "thread://same?hostId=remote-ssh%3Ahost",
      { threadId: "same", explicitHostId: "remote-ssh:host" },
    ],
    ["thread://same?hostId=remote%252Fhost", null],
    ["thread://same?hostId=remote%2Fhost", null],
    ["thread://same?hostId=remote&other=x", null],
    ["thread://same/extra", null],
    ["thread://same?hostId=", null],
    ["thread://same?hostId=bad%ZZ", null],
  ] as const)("interprets only the typed thread URI grammar: %s", (href, expected) => {
    expect(resolveConversationThreadLink(href)).toEqual(expected);
  });
  test("citations decode once and preserve endpoint order while dropping nonpositive reveal positions", () => {
    expect(readConversationFileCitation("【F:src/a%2520b.ts†L8-L2】")).toEqual({
      raw: "【F:src/a%2520b.ts†L8-L2】",
      reference: { path: "src/a%20b.ts", line: 8, endLine: 2 },
    });
    expect(readConversationFileCitation("【F:src/a.ts†L0-L2】")?.reference).toEqual({
      path: "src/a.ts",
      endLine: 2,
    });
    expect(readConversationFileCitation("【src/a.ts†L2】")).toBeNull();
    expect(readConversationFileCitation("【F:src/a.ts†L2-x】")).toBeNull();
    expect(readConversationFileCitation("【/tmp/a%ZZ.ts†L2】")?.reference.path).toBe(
      "/tmp/a%ZZ.ts",
    );
  });
  test("a unique Skill catalog result does not grant remote or ambiguous definition interaction", () => {
    const skill: CodexComposerSkill = {
      name: "edit",
      displayName: "Edit files",
      description: "Edit",
      iconUrl: null,
      brandColor: null,
      path: "/skills/edit/SKILL.md",
      scope: "user",
    };
    const target = { kind: "skill", name: "edit", label: "$edit" } as const;
    expect(resolveConversationSkill(target, [], "local").reference).toBeNull();
    expect(
      resolveConversationSkill(target, [skill, { ...skill, path: "/other/SKILL.md" }], "local")
        .reference,
    ).toBeNull();
    expect(resolveConversationSkill(target, [skill], "remote")).toMatchObject({
      label: "Edit files",
      reference: null,
    });
    expect(resolveConversationSkill(target, [skill], null).reference).toBeNull();
    expect(resolveConversationSkill(target, [skill], "local").reference).toEqual({
      path: skill.path,
    });
    expect(
      resolveConversationSkill({ ...target, href: "/SKILLS/EDIT/SKILL.md" }, [skill], "local")
        .reference,
    ).toEqual({ path: "/SKILLS/EDIT/SKILL.md" });
  });
  test("limits color swatches to full six-digit values outside issue and numeric PR contexts", () => {
    expect(readConversationTextDecorations("Use $edit at @src/file.ts and #a1b2c3")).toEqual([
      { index: 4, content: "$edit", type: "mention" },
      { index: 13, content: "@src/file.ts", type: "mention" },
      { index: 30, content: "#a1b2c3", type: "color" },
    ]);
    expect(readConversationTextDecorations("issue #a1b2c3")).toEqual([]);
    expect(readConversationTextDecorations("PRs #123456 and #a1b2c3")).toEqual([
      { index: 16, content: "#a1b2c3", type: "color" },
    ]);
    expect(readConversationTextDecorations("#a1b2c3", "prefix")).toEqual([]);
    expect(readConversationTextDecorations("#abcd12x")).toEqual([]);
  });
});
