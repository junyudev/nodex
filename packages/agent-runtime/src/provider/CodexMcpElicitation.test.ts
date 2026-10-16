import { assert, describe, it } from "@effect/vitest";
import type * as CodexSchema from "effect-codex-app-server/schema";
import {
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
