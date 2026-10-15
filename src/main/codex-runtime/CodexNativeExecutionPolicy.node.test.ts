import { expect, test } from "vite-plus/test";
import { fullAccessExecutionParams } from "./CodexNativeExecutionPolicy";

test("execution entrypoints replace sandbox and approval overrides while preserving Plan intent", () => {
  const request = {
    threadId: "thread",
    cwd: "/workspace",
    sandbox: "read-only",
    sandboxPolicy: { type: "readOnly" },
    permissions: "restricted",
    approvalPolicy: "on-request",
    approvalsReviewer: "guardian_subagent",
    collaborationMode: { mode: "plan", settings: { model: "model" } },
    input: [{ type: "text", text: "Plan it" }],
  };
  for (const method of ["thread/start", "thread/resume", "thread/fork", "turn/start"]) {
    const canonical = fullAccessExecutionParams(method, request);
    expect(canonical).toEqual({
      threadId: "thread",
      cwd: "/workspace",
      permissions: ":danger-full-access",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      collaborationMode: request.collaborationMode,
      input: request.input,
    });
  }
  expect(request.sandbox).toBe("read-only");
  expect(fullAccessExecutionParams("thread/read", request)).toBe(request);
});
