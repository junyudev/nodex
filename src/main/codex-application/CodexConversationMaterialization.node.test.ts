import type { Thread } from "@nodex/codex-app-server-protocol/v2";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createCodexCanonicalHydratedConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";
import { CodexConversationMaterialization, make } from "./CodexConversationMaterialization";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { makeConversationEntityStateRegistry } from "./internal/ConversationEntityState";

const threadId = "thread-materialization";

const thread: Thread = {
  id: threadId,
  extra: null,
  sessionId: "session-materialization",
  forkedFromId: null,
  parentThreadId: null,
  preview: "",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "paginated",
  modelProvider: "openai",
  createdAt: 1,
  updatedAt: 1,
  recencyAt: 1,
  status: { type: "idle" },
  path: null,
  cwd: "/workspace",
  cliVersion: "test",
  source: "appServer",
  canAcceptDirectInput: true,
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  turns: [],
};

const canonical = createCodexCanonicalHydratedConversationState(thread, {
  model: "gpt-test",
  reasoningEffort: "high",
  cwd: "/workspace",
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandboxPolicy: { type: "readOnly", networkAccess: false },
  activePermissionProfile: null,
  runtimeWorkspaceRoots: ["/workspace"],
});

it.effect("materializes through the Directory's non-reentrant current-lane seam", () =>
  Effect.gen(function* () {
    const aggregates = makeConversationEntityStateRegistry();
    const conversations = ConversationEntityMap.of({
      entity: aggregates.acquire,
      current: aggregates.current,
    } as unknown as ConversationEntityMap["Service"]);
    let currentLaneCalls = 0;
    let resolveCalls = 0;
    const directory = CodexThreadDirectory.of({
      materializeInCurrentLane: (input: { readonly threadId: string; readonly hostId?: string }) =>
        Effect.sync(() => {
          currentLaneCalls += 1;
          assert.strictEqual(input.threadId, threadId);
          conversations.entity(threadId).acceptCanonicalState(canonical);
          return { canonical } as never;
        }),
      resolve: () => {
        resolveCalls += 1;
        return Effect.die("re-entered Thread lane");
      },
    } as unknown as CodexThreadDirectory["Service"]);
    const materialization: CodexConversationMaterialization["Service"] = yield* make.pipe(
      Effect.provideService(CodexThreadDirectory, directory),
      Effect.provideService(ConversationEntityMap, conversations),
    );

    yield* materialization.ensure(threadId);
    yield* materialization.ensure(threadId);
    yield* materialization.reload(threadId);

    assert.strictEqual(currentLaneCalls, 2);
    assert.strictEqual(resolveCalls, 0);
  }),
);
