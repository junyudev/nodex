import { assert, describe, it } from "@effect/vitest";
import type * as CodexSchema from "effect-codex-app-server/schema";
import {
  codexMcpApprovalOptions,
  codexMcpApprovalResponse,
  codexMcpElicitationQuestions,
  codexMcpElicitationResponse,
  isCodexMcpPermissionRequest,
} from "./CodexMcpElicitation.ts";

const form: CodexSchema.McpServerElicitationRequestParams = {
  serverName: "connected-app",
  threadId: "native-thread",
  turnId: "native-turn",
  mode: "form",
  message: "Complete the requested details",
  requestedSchema: {
    type: "object",
    properties: {
      destination: { type: "string", title: "Destination", enum: ["Paris", "Oslo"] },
      passengers: { type: "integer", title: "Passengers" },
      returnTrip: { type: "boolean" },
    },
    required: ["destination", "passengers", "returnTrip"],
  },
};

describe("native MCP information requests", () => {
  it("declines native verification challenges without treating them as tool permission", () => {
    const challenge: CodexSchema.McpServerElicitationRequestParams = {
      serverName: "connected-app",
      threadId: "native-thread",
      turnId: "native-turn",
      mode: "openai/userVerification",
      _meta: { codex_approval_kind: "mcp_tool_call" },
      title: "Verify your identity",
      description: "Confirm this request in the native verification flow",
      challenge: "verification-token",
    };
    assert.isFalse(isCodexMcpPermissionRequest(challenge));
    assert.deepEqual(codexMcpElicitationQuestions(challenge), []);
    assert.deepEqual(codexMcpElicitationResponse(challenge, {}), { action: "decline" });
  });

  it("preserves genuine form questions and encodes only validated requested fields", () => {
    assert.isFalse(isCodexMcpPermissionRequest(form));
    assert.deepEqual(
      codexMcpElicitationQuestions(form).map((question) => ({
        id: question.id,
        options: question.options?.map((option) => option.label),
      })),
      [
        { id: "destination", options: ["Paris", "Oslo"] },
        { id: "passengers", options: [] },
        { id: "returnTrip", options: ["true", "false"] },
      ],
    );
    assert.deepEqual(
      codexMcpElicitationResponse(form, {
        destination: "Oslo",
        passengers: "2",
        returnTrip: "false",
        unrequested: "discard",
      }),
      { action: "accept", content: { destination: "Oslo", passengers: 2, returnTrip: false } },
    );
    for (const answers of [
      { destination: "Berlin", passengers: 2, returnTrip: true },
      { destination: "Paris", passengers: "2.5", returnTrip: true },
      { destination: "Paris", passengers: 2 },
      { destination: "Paris", passengers: "", returnTrip: true },
    ]) {
      assert.deepEqual(codexMcpElicitationResponse(form, answers), { action: "decline" });
    }
  });
  it("recognizes native permission metadata without treating connection prompts as authorization", () => {
    assert.isTrue(
      isCodexMcpPermissionRequest({ ...form, _meta: { codex_approval_kind: "mcp_tool_call" } }),
    );
    assert.isFalse(
      isCodexMcpPermissionRequest({ ...form, _meta: { codex_approval_kind: "browser_auth" } }),
    );
  });
  it("retains user participation for native connection URLs", () => {
    const payload: CodexSchema.McpServerElicitationRequestParams = {
      serverName: "connected-app",
      threadId: "native-thread",
      mode: "url",
      message: "Connect your account",
      elicitationId: "connection-1",
      url: "https://app.example/connect",
    };
    assert.deepEqual(
      codexMcpElicitationQuestions(payload)[0]?.question,
      "Connect your account\nhttps://app.example/connect",
    );
    assert.deepEqual(codexMcpElicitationResponse(payload, { connection: "Done" }), {
      action: "accept",
    });
    assert.deepEqual(codexMcpElicitationResponse(payload, { connection: "Cancel" }), {
      action: "cancel",
    });
  });
});

describe("native MCP tool approval responses", () => {
  const approval = {
    ...form,
    mode: "openai/form" as const,
    _meta: { codex_approval_kind: "mcp_tool_call" },
    requestedSchema: {
      properties: {
        scope: {
          type: "string",
          oneOf: [
            { const: "once", title: "This call" },
            { const: "session", title: "This session" },
            { const: "always", title: "Always" },
          ],
        },
      },
      required: ["scope"],
    },
  };
  it("keeps provider session options and sends native scope without offering standing grants", () => {
    assert.deepEqual(
      codexMcpApprovalOptions(approval).map((option) => option.decision),
      ["accept", "acceptForSession", "decline", "cancel"],
    );
    assert.equal(codexMcpApprovalOptions(approval)[0]?.label, "This call");
    assert.equal(codexMcpApprovalOptions(approval)[1]?.label, "This session");
    assert.deepEqual(codexMcpApprovalResponse(approval, "accept"), {
      action: "accept",
      content: { scope: "once" },
    });
    assert.deepEqual(codexMcpApprovalResponse(approval, "acceptForSession"), {
      action: "accept",
      content: { scope: "session" },
      _meta: { persist: "session" },
    });
    assert.deepEqual(codexMcpApprovalResponse(approval, "decline"), { action: "decline" });
    assert.deepEqual(codexMcpApprovalResponse(approval, "cancel"), { action: "cancel" });
  });
  it("offers only decisions the native form can encode", () => {
    const unsupported = {
      ...approval,
      requestedSchema: { properties: { unknown: { type: "string" } }, required: ["unknown"] },
    };
    assert.deepEqual(
      codexMcpApprovalOptions(unsupported).map((option) => option.decision),
      ["decline", "cancel"],
    );
    assert.deepEqual(codexMcpApprovalResponse(unsupported, "accept"), { action: "decline" });
    assert.deepEqual(
      codexMcpApprovalResponse({ ...approval, requestedSchema: { type: "object" } }, "accept"),
      { action: "accept", content: {} },
    );
    assert.deepEqual(
      codexMcpApprovalOptions({ ...approval, requestedSchema: { properties: {} } }).map(
        (option) => option.decision,
      ),
      ["accept", "decline", "cancel"],
    );
  });
});

it("uses the chat label for a native session grant without a scope label", () => {
  const approval = {
    ...form,
    _meta: { codex_approval_kind: "mcp_tool_call", persist: "session" },
    requestedSchema: { type: "object", properties: {}, required: [] },
  } satisfies CodexSchema.McpServerElicitationRequestParams;
  assert.equal(
    codexMcpApprovalOptions(approval).find((option) => option.decision === "acceptForSession")
      ?.label,
    "Allow for this chat",
  );
});
