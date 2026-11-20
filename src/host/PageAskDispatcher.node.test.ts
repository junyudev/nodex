import { assert, it } from "@effect/vitest";
import type { components } from "@nodex/core-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AgentRuntimeApplication } from "../main/agent-runtime/AgentRuntimeApplication";
import { CoreModules } from "../main/core-runtime/CoreModules";
import { ApplicationSettings } from "../main/settings/ApplicationSettings";
import { make } from "./PageAskDispatcher";
import { pageAskConversationTitle } from "../shared/page-ask";

type Schemas = components["schemas"];
type Command = Schemas["DiscussionCommand"];
const sessionId = "01a19858-ef05-7cd4-8579-e051afee244d";
const messageId = "page-ask:attempt";
const runId = "run:accepted";
const member = { type: "member", member_id: "jun" } as const;
const agent = { providerInstanceId: "openai", model: "available", options: { reasoning: "high" } };
const comment = {
  id: "ask",
  discussionId: "discussion",
  author: member,
  createdAt: "2026-01-01T00:00:00Z",
  body: "Can you check this?",
  mentions: [],
  toNodex: true,
  ask: {
    kind: "check",
    state: "working",
    requesterId: "jun",
    sessionId,
    agent,
    dispatch: { messageId, agent, stopRequested: false },
  },
} as const satisfies Schemas["DiscussionComment"];

it.effect(
  "continues an admitted Ask after restart without sending it again, and stops its own Run",
  () =>
    Effect.gen(function* () {
      let item: Schemas["DiscussionComment"] = comment;
      let phase: "waiting" | "done" = "waiting";
      let admission = false;
      let stops = 0;
      const sent: Parameters<AgentRuntimeApplication["Service"]["sendMessage"]>[0][] = [];
      const commands: Command[] = [];
      const detail = {
        id: "discussion",
        pageId: "page",
        quote: "42 occurrences",
        anchor: { kind: "page" },
        comments: [comment],
      } as const;
      const runtime = Layer.mock(AgentRuntimeApplication, {
        worktreeChats: {} as AgentRuntimeApplication["Service"]["worktreeChats"],
        messageAdmission: () =>
          Effect.succeed(admission ? ({ status: "accepted" } as never) : null),
        sendMessage: (input) =>
          Effect.sync(() => {
            sent.push(input);
            admission = true;
            return { sessionId, runId } as never;
          }),
        promptTurns: () => Effect.succeed([{ phase, messageId, runId, reply: null }]),
        stopHostInput: (input) =>
          Effect.sync(() => {
            assert.equal(input.sessionId, sessionId);
            assert.equal(input.messageId, messageId);
            stops++;
            return undefined;
          }),
      });
      const library: CoreModules["Service"]["library"] = {
        read: (read) =>
          Effect.sync(
            () =>
              ({
                value:
                  read.kind === "discussion_ask_context"
                    ? {
                        kind: read.kind,
                        value: {
                          detail,
                          title: "Counts",
                          canDispatch: true,
                          markdown: "There were 42 occurrences.",
                        },
                      }
                    : {
                        kind: "queued_discussion_asks",
                        value: {
                          items: [{ comment: item, pageId: "page", queuedAt: comment.createdAt }],
                        },
                      },
              }) as never,
          ),
        apply: (input) =>
          Effect.sync(() => {
            if (input.intent.kind !== "discussion") throw new Error("Expected Discussion intent");
            const command = input.intent.command;
            commands.push(command);
            if (command.kind === "observe_ask") {
              item = {
                ...item,
                ask: { ...comment.ask, runId, state: command.waiting ? "needs_you" : "working" },
              };
            }
            return { outcome: { discussion: { kind: "comment", value: item } } } as never;
          }),
      };
      const core = Layer.succeed(CoreModules, { library } as CoreModules["Service"]);
      const services = Layer.mergeAll(runtime, core, Layer.mock(ApplicationSettings, {}));
      const scan = yield* make.pipe(Effect.provide(services));
      yield* scan;
      assert.lengthOf(sent, 1);
      assert.include(sent[0]?.message.text, "Ask from Page «Counts»");
      assert.equal(sent[0]?.mode, "queue");
      assert.equal(sent[0]?.message.modelSelection?.instanceId, "codex");
      assert.match(sent[0]!.messageFingerprint!, /^[a-f0-9]{64}$/u);
      assert.deepEqual(sent[0]?.message.agentConfigs, [
        { provider: "openai", model: "available", reasoning: "high" },
      ]);

      const recovered = yield* make.pipe(Effect.provide(services));
      yield* recovered;
      assert.lengthOf(sent, 1);
      assert.deepInclude(commands, {
        kind: "observe_ask",
        commentId: comment.id,
        messageId,
        runId,
        waiting: true,
      });

      item = {
        ...comment,
        ask: { ...comment.ask, runId, dispatch: { ...comment.ask.dispatch, stopRequested: true } },
      };
      phase = "done";
      yield* recovered;
      assert.equal(stops, 1);
      assert.include(commands.at(-1), { kind: "settle_ask", state: "stopped", runId });
      assert.include(
        (commands.at(-1) as Extract<Command, { kind: "settle_ask" }>).fallback,
        `<nodex://sessions/${sessionId}>`,
      );
    }),
);

it("names an Ask's conversation after the request's first line", () => {
  assert.equal(
    pageAskConversationTitle("**Is this true?**\nMore detail", "Ask from Page «Review»"),
    "Is this true?",
  );
  assert.equal(
    pageAskConversationTitle("\n\n", "Ask from Page «Review»"),
    "Ask from Page «Review»",
  );
  assert.equal(pageAskConversationTitle("x".repeat(120), "fallback").length, 80);
});
