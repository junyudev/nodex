import { expect, test } from "vitest";
import { assessEvaluation, inspectRoute, type RouteEvidence, type RouteReview } from "./assessment";
import type { CaseVerification } from "./contracts";

const prompt = "Create a filtered View.";
const repository = "/repo/nodex";
const sha256 = "a".repeat(64);
const verification: CaseVerification = {
  passed: true,
  assertions: [
    { category: "objective", name: "Exact View rows", passed: true },
    { category: "preservation", name: "Original data", passed: true },
  ],
};
const user = (text: string) => ({
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
});
const completed = (item: unknown) => ({
  type: "event_msg",
  payload: { type: "item_completed", item },
});
const archive = (...records: unknown[]) =>
  records.map((entry, ordinal) => JSON.stringify({ ordinal, ...(entry as object) })).join("\n");
const inspect = (...records: unknown[]) =>
  inspectRoute(archive(user(prompt), ...records), { prompt, repository });
const review: RouteReview = {
  conversationSha256: sha256,
  decision: "compliant",
  note: "Reviewed all command and tool inputs in the archived attempt.",
};
const assess = (
  evidence: RouteEvidence,
  overrides: Partial<Parameters<typeof assessEvaluation>[0]> = {},
) =>
  assessEvaluation({
    status: "completed",
    verification,
    evidence,
    conversationSha256: sha256,
    ...overrides,
  });

test("ordinary shell success needs route review; a checksum-bound review can qualify it", () => {
  const evidence = inspect(
    completed({
      type: "CommandExecution",
      id: "cmd",
      cwd: "file:///workspace",
      command: [
        "/bin/sh",
        "-c",
        "nodex sql query 'SELECT page_id FROM pages' | python3 summarize.py",
      ],
    }),
  );
  expect(evidence.commands).toEqual([
    {
      line: 2,
      ordinal: 1,
      cwd: "/workspace",
      command: [
        "/bin/sh",
        "-c",
        "nodex sql query 'SELECT page_id FROM pages' | python3 summarize.py",
      ],
    },
  ]);
  expect(assess(evidence)).toMatchObject({
    outcome: "needs_review",
    passed: false,
    route: "needs_review",
  });
  expect(assess(evidence, { review })).toMatchObject({
    outcome: "passed",
    passed: true,
    route: "compliant",
  });
  expect(() =>
    assess(evidence, { review: { ...review, conversationSha256: "b".repeat(64) } }),
  ).toThrow("exact conversation checksum");
});

test("nested external tool events require review of their purpose even when the outer tool is exec", () => {
  const tool = completed({
    type: "McpToolCall",
    id: "mcp1",
    server: "node_repl",
    tool: "js",
    arguments: { code: 'sky.get_app_state({app:"Nodex"})' },
  });
  const evidence = inspect(
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        input: "await tools.mcp__node_repl__js(...);",
      },
    },
    tool,
    tool,
  );
  expect(evidence.findings).toEqual([
    { line: 3, ordinal: 2, kind: "external_tool", detail: "McpToolCall:node_repl:js" },
  ]);
  expect(evidence.calls.at(-1)).toEqual({
    line: 3,
    ordinal: 2,
    name: "McpToolCall:node_repl:js",
    input: JSON.stringify({ code: 'sky.get_app_state({app:"Nodex"})' }),
  });
  expect(assess(evidence)).toMatchObject({ outcome: "needs_review", passed: false });
  expect(
    assess(evidence, {
      review: {
        ...review,
        decision: "violated",
        note: "The nested call actually inspected a Nodex window via computer-use.",
      },
    }),
  ).toMatchObject({
    outcome: "failed",
    route: "violated",
    objective: { passed: true },
    preservation: { passed: true },
  });
});

test("an external computation tool is not a route violation solely because it uses MCP", () => {
  const evidence = inspect(
    completed({
      type: "McpToolCall",
      id: "compute",
      server: "node_repl",
      tool: "js",
      arguments: { code: "nodeRepl.write(1 + 1)" },
    }),
  );
  expect(assess(evidence).outcome).toBe("needs_review");
  expect(
    assess(evidence, {
      review: {
        ...review,
        note: "The external call only computed over public CLI output; no alternate content interface was used.",
      },
    }).outcome,
  ).toBe("passed");
});

test("executed repository reads differ from reading the published Skill or quoted output", () => {
  const read = (id: string, path: string) =>
    completed({
      type: "CommandExecution",
      id,
      cwd: "file:///repo/nodex",
      command: ["cat", path],
      parsed_cmd: [{ type: "read", path }],
    });
  const evidence = inspect(
    read("skill", "/repo/nodex/.generated/official-agent-skills/skills/nodex/SKILL.md"),
    read("source", "crates/nodex-core/src/database.rs"),
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        output: [{ text: "McpToolCall sky.get_app_state cat /repo/nodex/private.rs" }],
      },
    },
  );
  expect(evidence.findings).toEqual([
    {
      line: 3,
      ordinal: 2,
      kind: "repository_access",
      detail: "/repo/nodex/crates/nodex-core/src/database.rs",
    },
  ]);
  expect(assess(evidence).passed).toBe(false);
});

test("user corrections and Stop invalidate an unaided result, while initial context is not intervention", () => {
  const evidence = inspectRoute(
    archive(
      user("<environment_context>workspace</environment_context>"),
      user(prompt),
      user("Do not read source."),
      user("<turn_aborted>Stopped by user</turn_aborted>"),
    ),
    { prompt, repository },
  );
  expect(evidence.interventions.map((item) => item.ordinal)).toEqual([2, 3]);
  expect(assess(evidence, { status: "interrupted", review })).toMatchObject({
    outcome: "failed",
    runtimeStatus: "interrupted",
    interventionCount: 2,
  });
  expect(assess(evidence, { review }).passed).toBe(false);
});

test("preservation cannot substitute for a failed goal and inconsistent summary flags cannot pass", () => {
  const assertions = verification.assertions.map((item) =>
    item.category === "objective" ? { ...item, passed: false } : item,
  );
  expect(assess(inspect(), { verification: { passed: true, assertions }, review })).toMatchObject({
    outcome: "failed",
    objective: { passed: false },
    preservation: { passed: true },
  });
  expect(
    assess(inspect(), {
      verification: {
        passed: true,
        assertions: verification.assertions.filter((item) => item.category === "preservation"),
      },
      review,
    }).passed,
  ).toBe(false);
});

test("missing or damaged native evidence remains review-required, never an inferred clean pass", () => {
  const malformed = inspectRoute(`${archive(user(prompt))}\n{"unfinished":`, {
    prompt,
    repository,
  });
  expect(malformed.issues).toHaveLength(1);
  expect(assess(malformed, { review }).outcome).toBe("needs_review");
  const missing = inspectRoute(archive(user("different prompt")), { prompt, repository });
  expect(assess(missing, { review }).outcome).toBe("needs_review");
});

test("a reviewer can reject a private-endpoint shell workaround that static indexing cannot establish", () => {
  const evidence = inspect(
    completed({
      type: "CommandExecution",
      id: "cmd",
      cwd: "/workspace",
      command: ["python3", "workaround.py"],
    }),
  );
  expect(evidence.findings).toEqual([]);
  expect(
    assess(evidence, {
      review: {
        ...review,
        decision: "violated",
        note: "The script accessed an internal endpoint.",
      },
    }),
  ).toMatchObject({ passed: false, route: "violated", outcome: "failed" });
});
