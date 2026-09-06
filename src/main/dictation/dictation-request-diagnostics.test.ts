import { expect, it } from "vitest";
import { DictationRequestDiagnostics } from "./dictation-request-diagnostics";

it("separates response-header wait from body consumption and selects only safe request headers", () => {
  let now = 10;
  const diagnostics = new DictationRequestDiagnostics(
    "cleanup",
    "4ee71509-91df-4ebe-adef-9cc41b200af1",
    () => now,
  );
  diagnostics.sentHeaders(
    new Headers({
      authorization: "Bearer secret-token",
      "chatgpt-account-id": "private-account",
      originator: "Codex Desktop",
      "user-agent": "Codex Desktop/test",
      cookie: "private-cookie",
    }),
  );
  now = 110;
  diagnostics.response(new Response(null, { headers: { "x-request-id": "req_123" } }));
  now = 160;
  expect(diagnostics.finish("completed")).toEqual({
    operation: "cleanup",
    requestId: "4ee71509-91df-4ebe-adef-9cc41b200af1",
    endpoint: "/codex/responses",
    model: "gpt-5.6-luna",
    outcome: "completed",
    totalMs: 150,
    headersMs: 100,
    bodyMs: 50,
    status: 200,
    attempts: 1,
    responseId: "req_123",
    headers: {
      originator: "Codex Desktop",
      userAgent: "Codex Desktop/test",
      authorizationPresent: true,
      accountHeaderPresent: true,
    },
  });
});

it("retains failed request elapsed time without inventing an HTTP status", () => {
  let now = 0;
  const diagnostics = new DictationRequestDiagnostics(
    "transcription",
    "4ee71509-91df-4ebe-adef-9cc41b200af1",
    () => now,
  );
  now = 250;
  expect(diagnostics.finish("failed")).toMatchObject({
    outcome: "failed",
    totalMs: 250,
    attempts: 0,
  });
  expect(diagnostics.finish("failed").status).toBeUndefined();
});
