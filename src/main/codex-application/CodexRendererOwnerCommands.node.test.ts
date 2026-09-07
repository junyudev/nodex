import { CodexTurnPresentation } from "./CodexTurnPresentation";
import {
  makeTestTurnPresentation,
  testSubmitPresentation,
} from "./CodexTurnPresentation.test-support";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ConversationCommands } from "./ConversationCommands";
import { CodexConversationFork, type CodexConversationForkInput } from "./CodexConversationFork";
import { CodexFreshThreadLaunchRuntime } from "./CodexFreshThreadLaunchRuntime";
import { CodexManualCompactionRuntime } from "./CodexManualCompactionRuntime";
import {
  CodexRendererConversationRegistry,
  makeCodexRendererConversationRegistryState,
} from "./CodexRendererConversationRegistry";
import { make } from "./CodexRendererOwnerCommands";
import { CodexThreadGoalRuntime } from "./CodexThreadGoalRuntime";
import { CodexThreadRollbackCommands } from "./CodexThreadRollbackCommands";
import { CodexThreadSettingsRuntime } from "./CodexThreadSettingsRuntime";
import { CodexTurnCommands, type CodexTurnStartOverrides } from "./CodexTurnCommands";

const threadId = "thread-owner-command";
const childThreadId = "thread-owner-command-fork";
const ownerClientId = "renderer-owner";

const makeHarness = (presentation?: CodexTurnPresentation["Service"]) => {
  const starts: (CodexTurnStartOverrides | undefined)[] = [];
  const forks: CodexConversationForkInput[] = [];
  const rendererConversations = makeCodexRendererConversationRegistryState();
  rendererConversations.setOwner(threadId, ownerClientId);
  const commands = make.pipe(
    Effect.provideServiceEffect(
      CodexTurnPresentation,
      presentation ? Effect.succeed(presentation) : makeTestTurnPresentation,
    ),
    Effect.provideService(
      CodexConversationFork,
      CodexConversationFork.of({
        fork: (input) =>
          Effect.sync(() => {
            forks.push(input);
            return {
              threadId: childThreadId,
              session: { id: "session-fork", thread: { threadId: childThreadId } },
              conversation: { threadId: childThreadId },
              composerIntent: { prompt: "", focusNonce: 42 },
            } as never;
          }),
      }),
    ),
    Effect.provideService(CodexRendererConversationRegistry, rendererConversations),
    Effect.provideService(
      CodexFreshThreadLaunchRuntime,
      CodexFreshThreadLaunchRuntime.of({ start: () => Effect.die("unused") } as never),
    ),
    Effect.provideService(
      CodexManualCompactionRuntime,
      CodexManualCompactionRuntime.of({ start: () => Effect.die("unused") } as never),
    ),
    Effect.provideService(
      CodexThreadGoalRuntime,
      CodexThreadGoalRuntime.of({ set: () => Effect.die("unused") } as never),
    ),
    Effect.provideService(
      CodexThreadSettingsRuntime,
      CodexThreadSettingsRuntime.of({ update: () => Effect.die("unused") } as never),
    ),
    Effect.provideService(
      CodexThreadRollbackCommands,
      CodexThreadRollbackCommands.of({ revertLatestForEdit: () => Effect.die("unused") }),
    ),
    Effect.provideService(
      CodexTurnCommands,
      CodexTurnCommands.of({
        startRendererOwned: (
          _threadId: string,
          _prompt: string,
          overrides?: CodexTurnStartOverrides,
        ) =>
          Effect.sync(() => {
            starts.push(overrides);
            return { turn: { id: "accepted" } };
          }),
      } as never),
    ),
    Effect.provideService(
      ConversationCommands,
      ConversationCommands.of({ setMemoryMode: () => Effect.die("unused") } as never),
    ),
  );
  return { commands, forks, starts };
};

it.effect("rejects a non-owner before entering the conversation fork capability", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { commands, forks } = makeHarness();
      const service = yield* commands;
      const exit = yield* Effect.exit(
        service.execute("renderer-follower", {
          conversationId: threadId,
          request: {
            method: "thread/fork",
            params: { threadId, turnId: "turn-a", message: "edit" },
          },
        }),
      );

      assert.strictEqual(exit._tag, "Failure");
      assert.deepEqual(forks, []);
    }),
  ),
);

it.effect("routes an exact owner fork through the canonical conversation capability", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { commands, forks } = makeHarness();
      const service = yield* commands;
      const result = (yield* service.execute(ownerClientId, {
        conversationId: threadId,
        request: {
          method: "thread/fork",
          params: { threadId, turnId: "turn-a", message: "must not prefill" },
        },
      })) as { readonly threadId: string; readonly composerIntent?: { readonly prompt: string } };

      assert.strictEqual(result.threadId, childThreadId);
      assert.strictEqual(result.composerIntent?.prompt, "");
      assert.deepEqual(forks, [
        {
          sourceThreadId: threadId,
          lastTurnId: "turn-a",
          threadSource: "user",
          ownerClientId,
        },
      ]);
    }),
  ),
);

it.effect(
  "the executing owner keeps the originating ticket and cannot supply its own Main claim",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const presentation = yield* makeTestTurnPresentation;
        const ticket = yield* presentation.capture(11, {
          target: { kind: "thread", threadId },
          presentation: testSubmitPresentation,
        });
        const harness = makeHarness(presentation);
        const commands = yield* harness.commands;
        yield* commands.execute(ownerClientId, {
          conversationId: threadId,
          request: {
            method: "turn/resume-interrupted",
            params: { threadId, clientUserMessageId: "origin-message", presentationTicket: ticket },
          },
        });
        const claim = harness.starts[0]?.presentationClaim;
        assert.deepEqual(claim, { ticketId: ticket.ticketId, submissionId: "origin-message" });
        const launch = yield* presentation.begin(claim, threadId);
        yield* presentation.bind(launch, "accepted");
        assert.equal(presentation.read(threadId, "accepted")?.windowSessionId, "window-a");
        yield* commands.execute(ownerClientId, {
          conversationId: threadId,
          request: {
            method: "turn/resume-interrupted",
            params: {
              threadId,
              clientUserMessageId: "unanchored",
              opts: { presentationClaim: claim } as CodexTurnStartOverrides,
            },
          },
        });
        assert.isUndefined(harness.starts[1]?.presentationClaim);
      }),
    ),
);
