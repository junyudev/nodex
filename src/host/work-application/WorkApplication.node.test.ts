import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { components } from "@nodex/core-protocol";
import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
} from "../../main/agent-runtime/AgentRuntimeApplication";
import { CoreModules } from "../../main/core-runtime/CoreModules";
import type {
  ProjectWorkspaceApplyInput,
  ProjectWorkspaceRead,
  DatabaseRead,
} from "../../main/core-client/types";
import { ApplicationSettings } from "../../main/settings/ApplicationSettings";
import {
  WorkApplication,
  briefOwnerName,
  make as makeApplication,
  renderWorkBrief,
} from "./WorkApplication";
import { make as makeScheduler } from "./WorkScheduler";
import { make as makeDelivery } from "./WorkDispatchRuntime";

const member = (id: string, display_name: string): components["schemas"]["Member"] => ({
  id,
  library_id: "library",
  display_name,
  lifecycle: "active",
  role: id === "member" ? "owner" : "member",
  revision: 1,
});
/** Core's Library reads for a work start: the Page body, and the Space's Members. */
const libraryRead =
  (body: string, members = [member("member", "Alice")]) =>
  (read: { readonly kind: string }) =>
    Effect.succeed({
      value:
        read.kind === "members"
          ? { kind: "members", items: members }
          : { kind: "page_content", value: { body_markdown: body } },
    });

type Launch = components["schemas"]["PageWorkLaunch"];
const selection = { instanceId: "codex", model: "model", effort: null };
const context: components["schemas"]["PageWorkContext"] = {
  turn: {
    page_id: "page",
    actor: { kind: "member", member_id: "member" },
    reason: "ready_to_start",
    since: "now",
    episode: "episode",
  },
  active_chat: null,
  page: { page_id: "dependent", page_key: "NODEX-2", title: "Dependent", status: "plan" },
  project_id: "project",
  page_work: {
    owner: "member",
    assignee: {
      kind: "agent",
      instance_id: selection.instanceId,
      model: selection.model,
      effort: selection.effort,
    },
    auto_start: true,
  },
  prerequisites: [
    {
      page: {
        page_id: "prerequisite",
        page_key: "NODEX-1",
        title: "Prerequisite",
        status: "done",
      },
      satisfied: true,
      satisfying_revision: "status:membership:2",
      latest_report: {
        outcome: "ready",
        summary: "Implemented and tested.",
        at: "2026-11-03T00:00:00.000Z",
        revision: 1,
      },
    },
  ],
};

it.effect(
  "starts automatic work once after acceptance and reconciles lost admission across restart",
  () =>
    Effect.gen(function* () {
      let acceptedPrerequisite = false;
      let linked = false;
      let launches = 0;
      let accepted = false;
      const outbox = new Map<string, Launch>();
      const events = new Set<string>();
      const core = {
        database: {
          read: (read: DatabaseRead) =>
            Effect.succeed({
              value:
                read.kind === "work_context"
                  ? { kind: read.kind, value: context }
                  : {
                      kind: "ready_work",
                      pages:
                        acceptedPrerequisite && !linked
                          ? [
                              {
                                page_id: "dependent",
                                project_id: "project",
                                page_work: context.page_work!,
                                prerequisites: [
                                  {
                                    page_id: "prerequisite",
                                    satisfied: true,
                                    satisfying_revision: "status:membership:2",
                                  },
                                ],
                                readiness_epoch: "dependent:done:2",
                              },
                            ]
                          : [],
                    },
            }),
        },
        library: {
          read: libraryRead("Do the dependent work."),
        },
        workspace: {
          read: (read: ProjectWorkspaceRead) =>
            Effect.sync(() => ({
              value:
                read.kind === "sources"
                  ? { kind: "sources", value: { kind: "page_follows", follows: [] } }
                  : read.kind === "effective_execution_hold"
                    ? { kind: read.kind, holds: [] }
                    : read.kind === "page_work_launch"
                      ? { kind: read.kind, launch: outbox.get(read.launch_id) ?? null }
                      : read.kind === "session"
                        ? {
                            kind: read.kind,
                            session: {
                              project_id: "project",
                              archived: false,
                              display_title: "Dependent",
                            },
                          }
                        : {
                            kind: "page_work_outbox",
                            launches: [...outbox.values()].filter((l) => !l.accepted_at),
                          },
            })),
          apply: (input: ProjectWorkspaceApplyInput) =>
            Effect.sync(() => {
              const intent = input.intent;
              if (intent.kind === "start_page_work")
                assert.deepEqual(
                  Object.keys(intent).sort(),
                  [
                    "kind",
                    "page_id",
                    "selection",
                    "session_id",
                    "launch_id",
                    "message_id",
                    "brief",
                    "again",
                    "expected_readiness_epoch",
                  ].sort(),
                );
              if (intent.kind === "start_page_work" && !outbox.has(intent.launch_id)) {
                assert.equal(intent.expected_readiness_epoch, "dependent:done:2");
                outbox.set(intent.launch_id, {
                  ...intent,
                  status_fence: 0,
                  status_moved: true,
                  project_id: "project",
                  selection: intent.selection!,
                  created_at: "2026-11-03T00:00:00.000Z",
                  accepted_at: null,
                  rejection: null,
                });
                linked = true;
              }
              if (intent.kind === "settle_page_work_launch") {
                const launch = outbox.get(intent.launch_id)!;
                outbox.set(intent.launch_id, {
                  ...launch,
                  accepted_at: intent.accepted_at ?? null,
                  rejection: intent.rejection ?? null,
                });
              }
              if (intent.kind === "record_work_events")
                for (const event of intent.events) events.add(event.dedupe_key);
              return { receipt: { duplicate: false } };
            }),
        },
      };
      const runtime = {
        catalog: () =>
          Effect.succeed([
            {
              instanceId: "codex",
              driver: "codex",
              enabled: true,
              installed: true,
              status: "ready",
              availability: "available",
              models: [{ slug: "model", capabilities: { optionDescriptors: [] } }],
            },
          ]),
        messageAdmission: () =>
          Effect.succeed(accepted ? { status: "accepted", threadId: "thread" } : null),
        launch: (input: Parameters<AgentRuntimeApplication["Service"]["launch"]>[0]) =>
          Effect.gen(function* () {
            launches++;
            assert.equal(input.projectId, "project");
            assert.deepEqual(input.workPage, { pageId: "dependent" });
            assert.deepEqual(input.modelSelection, { instanceId: "codex", model: "model" });
            assert.include(input.message.text, "NODEX-2 · Dependent");
            assert.include(input.message.text, "Do the dependent work.");
            assert.include(input.message.text, "NODEX-1 · Prerequisite");
            assert.include(input.message.text, "Implemented and tested.");
            accepted = true;
            return yield* new AgentRuntimeApplicationError({
              operation: "launch",
              message: "Reply lost",
            });
          }),
      };
      const provide = <A, E, R>(task: Effect.Effect<A, E, R>) =>
        task.pipe(
          Effect.provideService(CoreModules, core as never),
          Effect.provideService(AgentRuntimeApplication, runtime as never),
          Effect.provideService(ApplicationSettings, {} as never),
        );
      const application = yield* provide(makeApplication);
      const scheduler = makeScheduler.pipe(
        Effect.provideService(WorkApplication, application),
        Effect.provideService(CoreModules, core as never),
      );
      yield* (yield* scheduler).sweep;
      assert.equal(outbox.size, 0);
      acceptedPrerequisite = true;
      yield* (yield* scheduler).sweep;
      yield* (yield* scheduler).sweep;
      assert.equal(outbox.size, 1);
      yield* application.startWork({
        pageId: "dependent",
        launchId: [...outbox.keys()][0]!,
        readinessEpoch: "dependent:done:2",
      });
      assert.equal(outbox.size, 1);
      const delivery = provide(makeDelivery);
      yield* (yield* delivery).drain;
      // Restart every Main owner while keeping only Core and Runtime's durable state.
      const restarted = yield* provide(makeApplication);
      yield* (yield* makeScheduler.pipe(
        Effect.provideService(WorkApplication, restarted),
        Effect.provideService(CoreModules, core as never),
      )).sweep;
      yield* (yield* delivery).drain;
      assert.equal(launches, 1);
      assert.equal([...outbox.values()].filter((l) => l.accepted_at).length, 1);
      assert.equal(events.size, 0);
    }),
);

it.effect(
  "records ask once per epoch across duplicate sweeps and restart, including no prerequisites",
  () =>
    Effect.gen(function* () {
      let epoch = "page:zero";
      const events = new Map<string, unknown>();
      let starts = 0;
      const core = {
        database: {
          read: () =>
            Effect.succeed({
              value: {
                kind: "ready_work",
                pages: [
                  {
                    page_id: "page",
                    page_work: { ...context.page_work!, auto_start: false },
                    prerequisites: [],
                    readiness_epoch: epoch,
                  },
                ],
              },
            }),
        },
        workspace: {
          read: (input: ProjectWorkspaceRead) =>
            Effect.succeed({ value: { kind: input.kind, holds: [] } }),
          apply: (input: ProjectWorkspaceApplyInput) =>
            Effect.sync(() => {
              if (input.intent.kind === "record_work_events")
                for (const e of input.intent.events) events.set(e.dedupe_key, e.payload);
              return {};
            }),
        },
      };
      const owner = makeScheduler.pipe(
        Effect.provideService(CoreModules, core as never),
        Effect.provideService(WorkApplication, {
          startWork: () =>
            Effect.sync(() => {
              starts++;
            }),
        } as never),
      );
      const first = yield* owner;
      yield* first.sweep;
      yield* first.sweep;
      yield* (yield* owner).sweep;
      assert.equal(events.size, 1);
      assert.equal(starts, 0);
      epoch = "page:prerequisite-done-2";
      yield* (yield* owner).sweep;
      assert.equal(events.size, 2);
      assert.deepEqual([...events.values()][0], {
        prerequisites: [],
        readiness_epoch: "page:zero",
      });
    }),
);
const follows: components["schemas"]["PageThreadFollow"][] = [
  {
    page_id: context.page.page_id,
    role: "context",
    provenance: "managed_chat_verified_url",
    created_at: "2026-11-06T00:00:00Z",
    thread: {
      id: "github:github.com:10:42",
      host: "github.com",
      repository_id: "10",
      repository: "owner/repo",
      number: 42,
      kind: "pull_request",
      url: "https://github.com/owner/repo/pull/42",
      title: "Review",
      state: "open",
    },
  },
];
it("renders prerequisite Status and latest reports beside the canonical Page body", () => {
  const brief = renderWorkBrief(context, "**Exact body**", follows, "Alice");
  assert.include(brief, `Page ID: ${context.page.page_id} · Owner: Alice`);
  assert.include(brief, "PR #42 · owner/repo · context · https://github.com/owner/repo/pull/42");
  assert.include(brief, "Status: done");
  assert.include(brief, "Latest report (ready):\nImplemented and tested.");
  assert.include(brief, "**Exact body**");
});

it.effect("starts the assigned Agent and freezes an explicit replacement in the work brief", () =>
  Effect.gen(function* () {
    const starts: Extract<ProjectWorkspaceApplyInput["intent"], { kind: "start_page_work" }>[] = [];
    const core = {
      database: { read: () => Effect.succeed({ value: { kind: "work_context", value: context } }) },
      library: {
        read: libraryRead("Work body"),
      },
      workspace: {
        read: (read: ProjectWorkspaceRead) =>
          Effect.succeed({
            value:
              read.kind === "sources"
                ? { kind: "sources", value: { kind: "page_follows", follows } }
                : { kind: "page_work_launch", launch: null },
          }),
        apply: (input: ProjectWorkspaceApplyInput) =>
          Effect.sync(() => {
            if (input.intent.kind === "start_page_work") starts.push(input.intent);
            return {};
          }),
      },
    };
    const runtime = {
      catalog: () =>
        Effect.succeed([
          {
            instanceId: "codex",
            driver: "codex",
            enabled: true,
            installed: true,
            status: "ready",
            availability: "available",
            models: ["model", "other"].map((slug) => ({
              slug,
              capabilities: { optionDescriptors: [] },
            })),
          },
        ]),
    };
    const app = yield* makeApplication.pipe(
      Effect.provideService(CoreModules, core as never),
      Effect.provideService(AgentRuntimeApplication, runtime as never),
    );
    yield* app.startWork({ pageId: "dependent" });
    yield* app.startWork({ pageId: "dependent", selection: { ...selection, model: "other" } });
    assert.deepEqual(
      starts.map((start) => start.selection?.model),
      ["model", "other"],
    );
    // One person needs no attribution; the chat itself names the Agent.
    assert.notInclude(starts[1]!.brief, "Owner:");
    assert.include(
      starts[1]!.brief,
      "PR #42 · owner/repo · context · https://github.com/owner/repo/pull/42",
    );
  }),
);

it.effect("requires an Agent Assignee when no explicit Agent is supplied", () =>
  Effect.gen(function* () {
    let admissions = 0;
    const core = {
      database: {
        read: () =>
          Effect.succeed({
            value: {
              kind: "work_context",
              value: {
                ...context,
                page_work: {
                  ...context.page_work!,
                  assignee: { kind: "member", member_id: "member" },
                  auto_start: false,
                },
              },
            },
          }),
      },
      library: {
        read: libraryRead("Work body"),
      },
      workspace: {
        read: () => Effect.succeed({ value: { kind: "page_work_launch", launch: null } }),
      },
    };
    const app = yield* makeApplication.pipe(
      Effect.provideService(CoreModules, core as never),
      Effect.provideService(AgentRuntimeApplication, {
        catalog: () =>
          Effect.sync(() => {
            admissions++;
            return [];
          }),
      } as never),
    );
    const error = yield* app.startWork({ pageId: "dependent" }).pipe(Effect.flip);
    assert.include(error.message, "Assign this Page to an Agent");
    assert.equal(admissions, 0);
  }),
);

it.effect("reaches automatic work without prerequisites beyond a full batch of ask Pages", () =>
  Effect.gen(function* () {
    const pageId = "z".repeat(512);
    const reads: (string | null | undefined)[] = [];
    const started: string[] = [];
    const core = {
      database: {
        read: (input: Extract<DatabaseRead, { kind: "ready_work" }>) =>
          Effect.sync(() => {
            reads.push(input.after_page_id);
            return {
              value: {
                kind: "ready_work",
                pages: input.after_page_id
                  ? [
                      {
                        page_id: pageId,
                        page_work: context.page_work!,
                        prerequisites: [],
                        readiness_epoch: "z:empty",
                      },
                    ]
                  : Array.from({ length: 100 }, (_, index) => ({
                      page_id: `a${String(index).padStart(3, "0")}`,
                      page_work: { ...context.page_work!, auto_start: false },
                      prerequisites: [],
                      readiness_epoch: `ask:${index}`,
                    })),
              },
            };
          }),
      },
      workspace: {
        read: (input: ProjectWorkspaceRead) =>
          Effect.succeed({ value: { kind: input.kind, holds: [] } }),
        apply: () => Effect.succeed({}),
      },
    };
    const scheduler = yield* makeScheduler.pipe(
      Effect.provideService(CoreModules, core as never),
      Effect.provideService(WorkApplication, {
        startWork: (input: { pageId: string; launchId: string }) =>
          Effect.sync(() => {
            assert.isAtMost(input.launchId.length, 512);
            started.push(input.pageId);
          }),
      } as never),
    );
    yield* scheduler.sweep;
    yield* scheduler.sweep;
    assert.deepEqual(reads, [null, "a099"]);
    assert.deepEqual(started, [pageId]);
  }),
);

it.effect("effective holds suppress both readiness wakes and outbox launches until resume", () =>
  Effect.gen(function* () {
    let held = true;
    let accepted = false;
    let starts = 0;
    let deliveries = 0;
    const events: string[] = [];
    const launch: Launch = {
      page_id: "automatic",
      project_id: "project",
      session_id: "session",
      launch_id: "launch",
      message_id: "message",
      selection,
      brief: "Work",
      again: false,
      created_at: "2026-11-05T00:00:00.000Z",
      accepted_at: null,
      rejection: null,
      status_fence: 0,
      status_moved: false,
    };
    const core = {
      database: {
        read: () =>
          Effect.succeed({
            value: {
              kind: "ready_work",
              pages: [
                {
                  page_id: "automatic",
                  page_work: context.page_work,
                  readiness_epoch: "auto",
                  prerequisites: [],
                },
                {
                  page_id: "ask",
                  page_work: { ...context.page_work, auto_start: false },
                  readiness_epoch: "ask",
                  prerequisites: [],
                },
              ],
            },
          }),
      },
      workspace: {
        read: (input: ProjectWorkspaceRead) =>
          Effect.succeed({
            value:
              input.kind === "effective_execution_hold"
                ? {
                    kind: input.kind,
                    holds: held ? [{ scope: { kind: "space" }, revision: 1 }] : [],
                  }
                : input.kind === "page_work_outbox"
                  ? { kind: input.kind, launches: accepted ? [] : [launch] }
                  : {
                      kind: "session",
                      session: { project_id: "project", archived: false, display_title: "Work" },
                    },
          }),
        apply: (input: ProjectWorkspaceApplyInput) =>
          Effect.sync(() => {
            if (input.intent.kind === "record_work_events")
              events.push(...input.intent.events.map((e) => e.dedupe_key));
            if (input.intent.kind === "settle_page_work_launch") accepted = true;
            return {};
          }),
      },
    };
    const scheduler = yield* makeScheduler.pipe(
      Effect.provideService(CoreModules, core as never),
      Effect.provideService(WorkApplication, {
        startWork: () =>
          Effect.sync(() => {
            starts++;
          }),
      } as never),
    );
    const runtime = {
      catalog: () =>
        Effect.succeed([
          {
            instanceId: "codex",
            enabled: true,
            installed: true,
            status: "ready",
            auth: { status: "authenticated" },
            models: [{ slug: "model", isDefault: true, capabilities: {} }],
          },
        ]),
      messageAdmission: () =>
        Effect.succeed(deliveries ? { status: "accepted", threadId: "thread" } : null),
      launch: () =>
        Effect.sync(() => {
          deliveries++;
          return { threadId: "thread" };
        }),
    };
    const delivery = yield* makeDelivery.pipe(
      Effect.provideService(CoreModules, core as never),
      Effect.provideService(AgentRuntimeApplication, runtime as never),
    );
    yield* scheduler.sweep;
    yield* delivery.drain;
    assert.equal(starts, 0);
    assert.isEmpty(events);
    assert.equal(deliveries, 0);
    held = false;
    yield* scheduler.sweep;
    yield* delivery.drain;
    yield* delivery.drain;
    assert.equal(starts, 1);
    assert.equal(events.length, 1);
    assert.equal(deliveries, 1);
    assert.isTrue(accepted);
  }),
);
it("names the Owner only when the Space has several people", () => {
  const alice = member("member", "Alice");
  assert.isNull(briefOwnerName([alice], "member"));
  assert.equal(briefOwnerName([alice, member("bob", "Bob")], "member"), "Alice");
  assert.isNull(
    briefOwnerName([alice, { ...member("bob", "Bob"), lifecycle: "removed" }], "member"),
  );
});
