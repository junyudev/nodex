import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import * as AcpAgent from "../../src/agent.ts";

if (process.env.ACP_MOCK_STDOUT_PREFIX !== undefined) {
  process.stdout.write(process.env.ACP_MOCK_STDOUT_PREFIX);
}

if (process.env.ACP_MOCK_MALFORMED_OUTPUT === "1") {
  process.stdout.write("{not-json}\n");
  process.exit(Number(process.env.ACP_MOCK_MALFORMED_OUTPUT_EXIT_CODE ?? "0"));
}

if (process.env.ACP_MOCK_EXIT_IMMEDIATELY_CODE !== undefined) {
  process.exit(Number(process.env.ACP_MOCK_EXIT_IMMEDIATELY_CODE));
}

const sessionId = "mock-session-1";
const v2Management = process.env.ACP_MOCK_V2_MANAGEMENT === "1";
const unknownVariants = process.env.ACP_MOCK_UNKNOWN_VARIANTS === "1";
const childSessions = process.env.ACP_MOCK_CHILD_SESSIONS === "1";

const program = Effect.gen(function* () {
  const agent = yield* AcpAgent.AcpAgent;

  yield* agent.handleInitialize(() =>
    Effect.succeed({
      protocolVersion: 2,
      capabilities: {
        session: {
          ...(v2Management ? { delete: {} } : {}),
        },
        ...(v2Management ? { providers: {} } : {}),
      },
      info: {
        name: "mock-agent",
        version: "0.0.0",
      },
      ...(process.env.ACP_MOCK_CUSTOM_AUTH === "1"
        ? { authMethods: [{ type: "custom_future", methodId: "custom", name: "Future auth" }] }
        : {}),
      ...(process.env.ACP_MOCK_ENV_VAR_AUTH === "1"
        ? {
            authMethods: [
              {
                type: "env_var",
                methodId: "api_key",
                name: "API key",
                vars: [{ name: "MOCK_API_KEY", label: "Mock API key" }],
                link: "https://example.test/keys",
              },
            ],
          }
        : {}),
    }),
  );

  yield* agent.handleAuthenticate(() => Effect.succeed({}));
  yield* agent.handleLogout(() => Effect.succeed({}));
  yield* agent.handleCreateSession(() =>
    Effect.succeed({
      sessionId,
      availableCommands: [
        {
          type: "command",
          name: "review",
          description: "Review the change",
          input: { type: "text", hint: "What to focus on" },
        },
        { type: "skill", name: "release-notes", description: "Draft release notes" },
      ],
    }),
  );
  yield* agent.handleLoadSession(() => Effect.succeed({}));
  yield* agent.handleListSessions(() =>
    Effect.succeed({
      sessions: [
        {
          sessionId,
          cwd: process.cwd(),
        },
      ],
    }),
  );
  yield* agent.handleDeleteSession(() => Effect.succeed({}));
  yield* agent.handleListProviders(() =>
    Effect.succeed({
      providers: [
        {
          providerId: "mock-provider",
          supported: ["openai"],
          required: false,
          current: null,
        },
      ],
    }),
  );
  yield* agent.handleSetProvider(() => Effect.succeed({}));
  yield* agent.handleDisableProvider(() => Effect.succeed({}));

  yield* agent.handlePrompt(() =>
    Effect.gen(function* () {
      if (unknownVariants) {
        yield* agent.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "future-content",
            content: { type: "chart", points: [] },
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "timeline_update", entries: [] },
        });
      }

      if (childSessions) {
        for (const state of [
          { state: "running" },
          {
            state: "idle",
            stopReason: "error",
            error: { code: -32603, message: "Child failed" },
          },
          { state: "dormant" },
        ] as const) {
          yield* agent.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "subagent_update",
              sessionId: "child-1",
              title: "Research",
              state,
            },
          });
        }
        yield* agent.client.sessionUpdate({
          sessionId: "child-1",
          update: {
            sessionUpdate: "session_message",
            messageId: "delegation-1",
            senderSessionId: sessionId,
            content: [{ type: "text", text: "Find the failing test" }],
          },
        });
        yield* agent.client.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "replay_complete" },
        });
        yield* agent.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "cursor_update",
            cursorId: "before:user-message-1",
            capabilities: { fork: {} },
            anchor: { type: "user_message", messageId: "user-message-1", position: "before" },
          },
        });
      }

      yield* agent.client.requestPermission({
        sessionId,
        title: "Read project files",
        options: [
          {
            optionId: "allow",
            name: "Allow",
            kind: "allow_once",
          },
        ],
        subject: {
          type: "tool_call",
          toolCall: {
            toolCallId: "tool-1",
            title: "Read project files",
          },
        },
      });

      yield* agent.client.elicit({
        sessionId,
        message: "Need confirmation before continuing.",
        mode: "form",
        requestedSchema: {
          type: "object",
          title: "Need confirmation",
          properties: {
            approved: {
              type: "boolean",
              title: "Approved",
            },
          },
          required: ["approved"],
        },
      });

      yield* agent.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "plan_update",
          plan: {
            type: "items",
            planId: "mock-plan",
            entries: [
              {
                content: "Inspect the repository",
                priority: "high",
                status: "in_progress",
              },
            ],
          },
        },
      });

      if (process.env.ACP_MOCK_V2_DIFF === "1") {
        yield* agent.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-diff",
            content: [
              {
                type: "diff",
                changes: [
                  {
                    operation: "move",
                    oldPath: "/workspace/old.ts",
                    path: "/workspace/new.ts",
                    fileType: "text",
                    mimeType: "text/typescript",
                  },
                ],
                patch: {
                  format: "git_patch",
                  text: "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n",
                },
              },
            ],
          },
        });
      }

      yield* agent.client.elicitationComplete({
        elicitationId: "elicitation-1",
      });

      yield* agent.client.extRequest("x/typed_request", {
        message: process.env.ACP_MOCK_BAD_TYPED_REQUEST === "1" ? 123 : "hello from typed request",
      });

      yield* agent.client.extNotification("x/typed_notification", {
        count: 2,
      });

      yield* agent.client.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
      });
      return { messageId: "user-message-1" };
    }),
  );

  yield* agent.handleUnknownExtRequest((method, params) =>
    Effect.succeed({
      echoedMethod: method,
      echoedParams: params ?? null,
    }),
  );

  return yield* Effect.never;
});

program.pipe(
  Effect.provide(Layer.provide(AcpAgent.layerStdio(), NodeServices.layer)),
  NodeRuntime.runMain,
);
