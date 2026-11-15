import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import { AgentRuntimeSessionActivity } from "../../main/agent-runtime/AgentRuntimeSessionActivity";
import { CodexGitProbe } from "../../main/codex-application/CodexGitProbe";
import { CoreModules } from "../../main/core-runtime/CoreModules";
import { ProjectWorkspace } from "../../main/project-application/ProjectWorkspace";
import { ApplicationSettings } from "../../main/settings/ApplicationSettings";
import { InboxApplication } from "../inbox-application/InboxApplication";
import { makeMobileCatalog } from "./catalog";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { agentRuntimeProviderFixture } from "../../shared/testing/agent-runtime-snapshot";
import { DEFAULT_INBOX_SETTINGS, resolveInboxModel } from "../../shared/inbox";
import { projectAgentCatalog, projectChatRow, rankedChatPage, unreadChats } from "./catalog";

test("chat search continuations preserve rank and reject a different search or missing anchor", () => {
  const ranked = ["third", "first", "second"];
  const page = rankedChatPage(ranked, "query", undefined, 2);
  expect(page?.sessionIds).toEqual(["third", "first"]);
  expect(rankedChatPage(ranked, "query", page?.nextCursor, 2)).toEqual({
    sessionIds: ["second"],
    nextCursor: null,
  });
  expect(rankedChatPage(ranked, "another query", page?.nextCursor, 2)).toBeNull();
  expect(rankedChatPage(["second", "third"], "query", page?.nextCursor, 2)).toBeNull();
});

it.effect("answers which asked-about chats the chat list still shows as unread", () =>
  Effect.gen(function* () {
    const reads: unknown[] = [];
    const core = {
      workspace: {
        read: (input: unknown) => {
          reads.push(input);
          return Effect.succeed({
            value: {
              kind: "session_window",
              sessions: {
                items: [
                  { task: { session: { id: "unread", unread: true } } },
                  { task: { session: { id: "read", unread: false } } },
                ],
              },
            },
          });
        },
      },
    } as unknown as CoreModules["Service"];
    const unread = unreadChats(core);
    // An archived or hidden chat is absent from the chat list, so it is not unread either.
    expect(yield* unread({ sessionIds: ["unread", "read", "archived", "unread"] })).toEqual({
      sessionIds: ["unread"],
    });
    expect(reads).toEqual([
      {
        kind: "session_window",
        archived: false,
        order: "identity",
        session_ids: ["unread", "read", "archived"],
        window: { first: 100 },
      },
    ]);
    expect(yield* unread({ sessionIds: [] })).toEqual({ sessionIds: [] });
    expect(reads).toHaveLength(1);
  }),
);

const provider = agentRuntimeProviderFixture({
  models: [
    {
      slug: "model",
      name: "Model Name",
      isCustom: false,
      isDefault: true,
      capabilities: {
        optionDescriptors: [
          {
            type: "select",
            id: "reasoningEffort",
            label: "Reasoning",
            currentValue: "medium",
            options: [
              { id: "high", label: "High", isDefault: true },
              { id: "medium", label: "Medium" },
              { id: "low", label: "Low" },
            ],
          },
        ],
      },
    },
    { slug: "plain", name: "Plain Model", isCustom: false, capabilities: {} },
  ],
});

test.each([
  [null, null, "medium"],
  ["model", "high", "high"],
  ["model", "unoffered", "medium"],
  ["plain", "high", null],
  ["missing", "high", "medium"],
] as const)(
  "projects offered efforts and the default chat choice (%s, %s)",
  (model, reasoningEffort, expected) => {
    const preference = { ...DEFAULT_INBOX_SETTINGS.chatAgent, model, reasoningEffort };
    const catalog = projectAgentCatalog([provider], preference);
    expect(catalog.providers[0]?.models).toEqual([
      {
        id: "model",
        label: "Model Name",
        efforts: [
          { id: "high", label: "High" },
          { id: "medium", label: "Medium" },
          { id: "low", label: "Low" },
        ],
        defaultEffort: "medium",
      },
      { id: "plain", label: "Plain Model", efforts: [], defaultEffort: null },
    ]);
    expect(catalog.defaultChoice).toEqual({
      providerInstanceId: "codex",
      model: model === "plain" ? "plain" : "model",
      reasoningEffort: expected,
    });
  },
);

test("projects the first marked default when the model has no current effort", () => {
  const model = provider.models[0]!;
  const descriptor = model.capabilities!.optionDescriptors![0]!;
  const { currentValue: _current, ...withoutCurrent } = descriptor;
  const catalog = projectAgentCatalog(
    [
      {
        ...provider,
        models: [{ ...model, capabilities: { optionDescriptors: [withoutCurrent] } }],
      },
    ],
    DEFAULT_INBOX_SETTINGS.chatAgent,
  );
  expect(catalog.providers[0]?.models[0]?.defaultEffort).toBe("high");
  expect(catalog.defaultChoice?.reasoningEffort).toBe("high");
});

test("chat rows use the exact Agent instance's model name and fall back to slugs", () => {
  expect(projectChatRow(row, metadata, undefined, [provider]).agentLabel).toBe("Model Name");
  expect(projectChatRow(row, metadata, undefined).agentLabel).toBe("model");
  expect(
    projectChatRow(row, { ...metadata!, providerInstanceId: "another" }, undefined, [provider])
      .agentLabel,
  ).toBe("model");
});

const row = {
  project: null,
  task: {
    session: {
      id: "chat",
      display_title: "Chat",
      execution_ref: { runtime_id: "runtime", thread_id: "thread" },
      created_at: "2026-11-04T12:00:00Z",
      activity_at: 1,
      can_manage: true,
    },
    thread: null,
  },
} as unknown as Parameters<typeof projectChatRow>[0];
const metadata = {
  threadId: "thread",
  providerInstanceId: "codex",
  model: "model",
  title: "Chat",
  status: "idle",
  activeFlags: [],
  preview: "",
  pendingRequestCount: 0,
  worktreePath: null,
  branch: null,
} as unknown as Parameters<typeof projectChatRow>[1];

it.effect(
  "uses the same default when starting and reads model names once per chat list, with catalog fallback",
  () =>
    Effect.gen(function* () {
      let preference = {
        ...DEFAULT_INBOX_SETTINGS.chatAgent,
        model: "model",
        reasoningEffort: "high",
        serviceTier: "fast",
      };
      let failCatalog = false;
      let reads = 0;
      const catalog = yield* makeMobileCatalog.pipe(
        Effect.provideService(AgentRuntimeApplication, {
          catalog: () =>
            Effect.suspend(() => {
              reads++;
              return failCatalog
                ? Effect.fail(new Error("Catalog unavailable"))
                : Effect.succeed([provider]);
            }),
          sessionMetadata: () => Effect.succeed([metadata]),
        } as unknown as AgentRuntimeApplication["Service"]),
        Effect.provideService(AgentRuntimeSessionActivity, {
          read: Effect.succeed({ items: [] }),
        } as unknown as AgentRuntimeSessionActivity["Service"]),
        Effect.provideService(CoreModules, {
          workspace: {
            read: () =>
              Effect.succeed({
                value: {
                  kind: "session_window",
                  sessions: {
                    items: [
                      row,
                      {
                        ...row,
                        task: { ...row.task, session: { ...row.task.session, id: "second" } },
                      },
                    ],
                    next_cursor: null,
                  },
                },
              }),
          },
        } as unknown as CoreModules["Service"]),
        Effect.provideService(ApplicationSettings, {
          snapshot: () =>
            Effect.sync(() => ({ inbox: { ...DEFAULT_INBOX_SETTINGS, chatAgent: preference } })),
        } as unknown as ApplicationSettings["Service"]),
        Effect.provideService(ProjectWorkspace, {} as ProjectWorkspace["Service"]),
        Effect.provideService(InboxApplication, {} as InboxApplication["Service"]),
        Effect.provideService(CodexGitProbe, {} as CodexGitProbe["Service"]),
      );
      const preferred = yield* catalog.agentChoice(null);
      expect(preferred).toEqual(preference);
      expect((yield* catalog.agents({})).defaultChoice?.reasoningEffort).toBe("high");
      preference = { ...preference, model: "missing" };
      const fallback = yield* catalog.agentChoice(null);
      expect(fallback).toEqual({
        instanceId: "codex",
        model: "model",
        reasoningEffort: null,
        serviceTier: null,
      });
      const resolved = resolveInboxModel([provider], fallback, "chat");
      expect(resolved).toMatchObject({
        kind: "ready",
        selection: { instanceId: "codex", model: "model" },
      });
      expect((yield* catalog.agents({})).defaultChoice?.reasoningEffort).toBe("medium");

      reads = 0;
      expect((yield* catalog.chats({})).items.map((item) => item.agentLabel)).toEqual([
        "Model Name",
        "Model Name",
      ]);
      expect(reads).toBe(1);
      failCatalog = true;
      expect((yield* catalog.chats({})).items.map((item) => item.agentLabel)).toEqual([
        "model",
        "model",
      ]);
      expect(reads).toBe(2);
    }),
);
