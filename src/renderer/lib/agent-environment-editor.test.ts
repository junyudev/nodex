import { describe, expect, it } from "vite-plus/test";
import {
  CLAUDE_ENVIRONMENT_POLICY,
  OPENCODE_ENVIRONMENT_POLICY,
} from "./agent-environment-policies";
import {
  environmentDraftInput,
  environmentAssignmentPaste,
  mergeEnvironmentPaste,
  parseEnvironmentAssignments,
  validateEnvironmentDraft,
} from "./agent-environment-editor";

describe("Claude environment assignments", () => {
  it("keeps a single pasted token containing equals signs as a value", () => {
    expect(environmentAssignmentPaste("eyJhbGciOiJIUzI1NiJ9==", false)).toBe(false);
    expect(environmentAssignmentPaste('export TOKEN="value"', false)).toBe(true);
    expect(environmentAssignmentPaste("KEY=value", true)).toBe(true);
  });
  it("imports exports, quotes, comments, URLs and explicit empty values", () => {
    expect(
      parseEnvironmentAssignments(
        [
          'export ANTHROPIC_BASE_URL="https://router.example/v1?a=b&c=d"',
          "export ANTHROPIC_AUTH_TOKEN='literal $token `text`' # private",
          'ANTHROPIC_API_KEY=""',
          "# comment",
          "KEEP_SPACES='  a b  '",
          "EMPTY=",
        ].join("\r\n"),
        CLAUDE_ENVIRONMENT_POLICY,
      ),
    ).toEqual({
      variables: [
        {
          name: "ANTHROPIC_BASE_URL",
          value: "https://router.example/v1?a=b&c=d",
          sensitive: false,
        },
        { name: "ANTHROPIC_AUTH_TOKEN", value: "literal $token `text`", sensitive: true },
        { name: "ANTHROPIC_API_KEY", value: "", sensitive: true },
        { name: "KEEP_SPACES", value: "  a b  ", sensitive: true },
        { name: "EMPTY", value: "", sensitive: true },
      ],
    });
  });
  it.each([
    "KEY=$(cat private)",
    'KEY="$TOKEN"',
    "KEY=`command`",
    "KEY=hello;command",
    'KEY="unfinished',
    "export NOT AN ASSIGNMENT",
    "KEY=x\nKEY=y",
    "HOME=/other",
    "CLAUDE_CONFIG_DIR=/other",
    "KEY=\0",
  ])("rejects unsupported or ambiguous assignments without echoing values: %s", (text) => {
    const result = parseEnvironmentAssignments(text, CLAUDE_ENVIRONMENT_POLICY);
    expect(result.error).toBeTruthy();
    expect(result.variables).toBeUndefined();
    expect(result.error).not.toContain(text);
  });
  it("merges pasted names while preserving unrelated saved secrets and explicit empties", () => {
    const saved = { id: "saved", name: "TOKEN", value: null, sensitive: true };
    const rows = mergeEnvironmentPaste(
      [
        saved,
        { id: "url", name: "BASE_URL", value: "old", sensitive: false },
        { id: "blank", name: "", value: "", sensitive: true },
      ],
      [
        { name: "BASE_URL", value: "new", sensitive: false },
        { name: "EMPTY", value: "", sensitive: false },
      ],
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual(saved);
    expect(rows[1]).toEqual({ id: "url", name: "BASE_URL", value: "new", sensitive: false });
    expect(environmentDraftInput(rows, CLAUDE_ENVIRONMENT_POLICY)).toEqual([
      { name: "TOKEN", value: null, sensitive: true },
      { name: "BASE_URL", value: "new", sensitive: false },
      { name: "EMPTY", value: "", sensitive: false },
    ]);
    expect(validateEnvironmentDraft(rows, CLAUDE_ENVIRONMENT_POLICY)).toBeNull();
    expect(
      validateEnvironmentDraft([...rows, { ...saved, id: "duplicate" }], CLAUDE_ENVIRONMENT_POLICY),
    ).toBe("Each environment variable name must be unique.");
  });
});

describe("OpenCode environment assignments", () => {
  it("uses OpenCode profile ownership without borrowing Claude's reserved names", () => {
    expect(
      parseEnvironmentAssignments("CLAUDE_CONFIG_DIR=/external", OPENCODE_ENVIRONMENT_POLICY),
    ).toEqual({
      variables: [{ name: "CLAUDE_CONFIG_DIR", value: "/external", sensitive: true }],
    });
    expect(
      parseEnvironmentAssignments("XDG_DATA_HOME=/external", OPENCODE_ENVIRONMENT_POLICY).error,
    ).toBe("Line 1: XDG_DATA_HOME is managed by the OpenCode profile.");
  });
});
