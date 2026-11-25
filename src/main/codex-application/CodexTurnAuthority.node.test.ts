import { describe, expect, test } from "vite-plus/test";
import type { components } from "@nodex/core-protocol";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type {
  ProjectWorkspaceApplyInput,
  ProjectWorkspaceReadSnapshot,
} from "../core-client/types";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { CodexConversationContext } from "./CodexConversationContext";
import { make } from "./CodexTurnAuthority";
import { produce, type Draft } from "immer";
import { make as makeCodexMainConversationSettings } from "./CodexMainConversationSettings";
import {
  CodexMainConversationManagers,
  type MainConversationManager,
} from "./CodexMainConversationManagers";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { conversationFixture } from "./conversation-test-fixture";
import { mutateCanonicalThreadSettingsPatch } from "../../shared/codex-conversation-state/codex-thread-settings-update";
import type { CodexExecutionProfile } from "../../shared/codex-execution-profile";
import { requireExactThreadStartProfile } from "./codex-thread-start-profile";

describe("CodexTurnAuthority", () => {
  type Authority = components["schemas"]["ProjectWorkspaceTurnAuthority"];
  type Admit = Extract<
    ProjectWorkspaceApplyInput["intent"],
    { readonly kind: "admit_turn_authority" }
  >;

  const harness = () => {
    const persisted = new Map<string, { authority: Authority }>();
    const writes: Array<{ intent: Admit; projectId: string | null | undefined }> = [];
    const identity = { profileId: "profile", libraryId: "library", storeEpoch: "epoch" };
    const workspace: CoreModules["Service"]["workspace"] = {
      admitToolOperation: () => Effect.die("Unexpected application tool admission"),
      recordAgentRun: () => Effect.die("Unexpected Agent attribution"),
      read: (read, _options, projectId) =>
        Effect.sync(() => {
          if (read.kind !== "turn_authority")
            throw new Error("Projectless authority must not look up a Project");
          assert.strictEqual(projectId, null);
          const row = persisted.get(`${read.thread_id}:${read.turn_id}`);
          return {
            value: {
              kind: "turn_authority",
              resolution: {
                authority: row?.authority ?? null,
                persisted: row !== undefined,
                admitted_at_ms: row ? 1_788_825_600_000 : null,
              },
            },
          } as ProjectWorkspaceReadSnapshot;
        }),
      apply: (input, _options, projectId) =>
        Effect.sync(() => {
          if (input.intent.kind !== "admit_turn_authority")
            throw new Error("Unexpected authority mutation");
          const intent = input.intent;
          writes.push({ intent, projectId });
          persisted.set(`${intent.thread_id}:${intent.turn_id}`, {
            authority: {
              thread_id: intent.thread_id,
              turn_id: intent.turn_id,
              root_thread_id: intent.root_thread_id,
              actor_project_id: intent.actor_project_id,
              library_id: identity.libraryId,
              store_epoch: identity.storeEpoch,
            },
          });
          return {} as never;
        }),
    };
    const build = make.pipe(
      Effect.provideService(CoreModules, { workspace } as never),
      Effect.provideService(CoreAuthority, { identity } as never),
      Effect.provideService(CodexConversationContext, {
        read: (threadId) =>
          Effect.succeed({
            threadId,
            projectId: null,
            parentThreadId: null,
            rootThreadId: threadId,
            cwd: null,
            writableRoots: [],
          }),
      }),
    );
    return { build, writes };
  };

  it.effect(
    "binds and recaptures projectless execution identity without looking up or borrowing a Project",
    () =>
      Effect.gen(function* () {
        const fixture = harness();
        const authority = yield* fixture.build;
        assert.isNull(yield* authority.capture("thread:root", "unrecorded"));
        assert.deepEqual(fixture.writes, []);

        const launch = yield* authority.begin("thread:root");
        assert.isNotNull(launch);
        const frozen = yield* authority.capture("thread:root", "turn:root");
        assert.strictEqual(frozen?.actorProjectId, null);
        assert.strictEqual(fixture.writes.length, 1);
        assert.strictEqual(fixture.writes[0]?.projectId, null);
        assert.strictEqual(fixture.writes[0]?.intent.actor_project_id, null);
        assert.strictEqual(launch?.boundTurnId, "turn:root");

        const nextLaunch = yield* authority.begin("thread:root");
        assert.deepEqual(yield* authority.capture("thread:root", "turn:root"), frozen);
        assert.strictEqual(nextLaunch?.boundTurnId, null);
        assert.strictEqual(fixture.writes.length, 1);
        yield* authority.observeStarted("thread:root", "turn:next");
        assert.strictEqual(nextLaunch?.boundTurnId, "turn:next");
        assert.strictEqual(
          (yield* authority.capture("thread:root", "turn:root"))?.turnId,
          "turn:root",
        );
        assert.strictEqual(fixture.writes.length, 2);

        const recreated = yield* fixture.build;
        assert.deepEqual(yield* recreated.capture("thread:root", "turn:root"), frozen);
        assert.strictEqual(fixture.writes.length, 2);
      }),
  );
});

describe("CodexMainConversationSettings", () => {
  const make = makeCodexMainConversationSettings;
  it.effect(
    "Main owner applies model controls, preserves native notifications and ignores historical policy",
    () =>
      Effect.gen(function* () {
        let state = conversationFixture("thread");
        const calls: { method: string; params: unknown }[] = [];
        const manager = {
          hostId: "local",
          generation: 1,
          assertCurrent: () => {},
          stream: { getRole: () => ({ role: "owner" }) },
        } as unknown as MainConversationManager;
        const service = yield* make.pipe(
          Effect.provideService(CodexMainConversationManagers, {
            get: () => Effect.succeed(manager),
          } as unknown as CodexMainConversationManagers["Service"]),
          Effect.provideService(ConversationEntityMap, {
            current: () => ({
              readCanonicalState: () => state,
              mutateCanonicalState: (recipe: (draft: Draft<typeof state>) => void) => {
                state = produce(state, recipe);
              },
            }),
          } as unknown as ConversationEntityMap["Service"]),
          Effect.provideService(CodexGateway, {
            requestOnHost: (_host: string, method: string, params: unknown) =>
              Effect.sync(() => {
                calls.push({ method, params });
                if (method === "thread/settings/update")
                  state = produce(state, (draft) =>
                    mutateCanonicalThreadSettingsPatch(draft, { model: "notification" }),
                  );
                return {};
              }),
          } as unknown as CodexGateway["Service"]),
        );
        const historicalPayload = {
          model: "requested",
          approvalPolicy: "on-request" as const,
          approvalsReviewer: "guardian_subagent" as const,
          sandboxPolicy: { type: "readOnly" as const, networkAccess: false },
          permissions: "old-restricted-profile",
        };
        assert.strictEqual(yield* service.update("local", "thread", historicalPayload), true);
        assert.strictEqual(state.latestModel, "notification");
        assert.deepEqual(calls, [
          { method: "thread/settings/update", params: { threadId: "thread", model: "requested" } },
        ]);
        assert.strictEqual(
          yield* service.update("local", "thread", { model: "ignored" }, { ifEffortEquals: "low" }),
          false,
        );
        assert.strictEqual(calls.length, 1);
      }),
  );
});

describe("codex-thread-start-profile", () => {
  const profile: CodexExecutionProfile = {
    modelId: "gpt-5.6-luna",
    reasoningEffort: "max",
    serviceTier: null,
  };

  const response = (overrides: Record<string, unknown> = {}) =>
    ({
      thread: { id: "thread-a" },
      model: profile.modelId,
      modelProvider: "openai",
      reasoningEffort: profile.reasoningEffort,
      serviceTier: profile.serviceTier,
      ...overrides,
    }) as never;

  describe("Thread start execution profiles", () => {
    test("accepts the exact Codex response", () => {
      expect(() => requireExactThreadStartProfile(response(), profile)).not.toThrow();
    });

    test("accepts the app-server Standard sentinel as the domain null tier", () => {
      expect(() =>
        requireExactThreadStartProfile(response({ serviceTier: "default" }), profile),
      ).not.toThrow();
    });

    test("rejects model fallback before first-Turn admission", () => {
      expect(() =>
        requireExactThreadStartProfile(response({ model: "gpt-5.6-sol" }), profile),
      ).toThrow("modelId");
    });

    test("rejects a real service-tier substitution", () => {
      expect(() =>
        requireExactThreadStartProfile(response({ serviceTier: "priority" }), profile),
      ).toThrow("serviceTier");
    });

    test("does not treat the Standard sentinel as a named tier", () => {
      expect(() =>
        requireExactThreadStartProfile(response({ serviceTier: "default" }), {
          ...profile,
          serviceTier: "priority",
        }),
      ).toThrow("serviceTier");
    });

    test("leaves legacy scalar launches unchanged", () => {
      expect(() =>
        requireExactThreadStartProfile(response({ model: "fallback" }), null),
      ).not.toThrow();
    });
  });
});
