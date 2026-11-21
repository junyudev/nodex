import { expect, test } from "vite-plus/test";
import {
  boundGitDraftDiff,
  GIT_DRAFT_LIMITS,
  parseGitDraftOutput,
  prepareGitDraftGeneration,
} from "./GitDraft.ts";

test("keeps whole text lines and skips Git's binary payload", () => {
  const sample = [
    "diff --git a/public.bin b/public.bin",
    "GIT binary patch",
    "literal 4",
    "encoded blob",
    "",
    "diff --git a/forced.bin b/forced.bin",
    "@@ -1 +1,2 @@",
    "+payload prefix",
    "+raw\0bytes",
    "diff --git a/app.ts b/app.ts",
    "@@ -1 +1 @@",
    "-const attempts = 9;",
    "+const attempts = 3;",
  ].join("\n");
  const result = boundGitDraftDiff(sample);
  expect(result).not.toContain("encoded blob");
  expect(result).not.toContain("payload prefix");
  expect(result).not.toContain("\0");
  expect(result).toContain("diff --git a/public.bin b/public.bin");
  expect(result).toContain("+const attempts = 3;");
});

test.each(["+你".repeat(30_000), "+line\n".repeat(2_000)])(
  "caps UTF-8 bytes and line counts deterministically",
  (large) => {
    const diff = "+important first line\n" + large + "\n+end";
    const bounded = boundGitDraftDiff(diff);
    expect(bounded).toContain("+important first line");
    expect(bounded).toMatch(/\n\[Remaining diff omitted\.\]$/u);
    expect(boundGitDraftDiff(bounded)).toBe(bounded);
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(GIT_DRAFT_LIMITS.diffBytes);
    expect(bounded.split("\n").length).toBeLessThanOrEqual(GIT_DRAFT_LIMITS.diffLines);
  },
);

test("passes repository and draft details as JSON alongside a typed output schema", () => {
  const draft = {
    kind: "pull-request" as const,
    changes: '+console.log("Hello");',
    recentSubjects: ["fix: log failures"],
    instructions: "Include context",
    headBranch: "fix-log",
    baseBranch: "main",
    title: "Keep my title",
    body: "",
  };
  const request = prepareGitDraftGeneration(draft);
  const { kind: _kind, ...evidence } = draft;
  expect(JSON.parse(request.prompt.split("Context (JSON):\n")[1]!)).toEqual(evidence);
  expect(request.outputSchema.required).toEqual(["title", "body"]);
  expect(parseGitDraftOutput("pull-request", { title: draft.title, body: "" })).toBeNull();
  expect(parseGitDraftOutput("commit", { subject: "   Fix logs  ", body: " " })).toEqual({
    subject: "Fix logs",
    body: "",
  });
  expect(
    parseGitDraftOutput("commit", { subject: "Fix logs\nSecond subject", body: "" }),
  ).toBeNull();
});
