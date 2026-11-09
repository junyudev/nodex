import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { components } from "@nodex/core-protocol";
import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
import type {
  ProjectWorkspaceApplyInput,
  ProjectWorkspaceRead,
  DatabaseRead,
import { make as makeScheduler } from "./WorkScheduler";
import { make as makeDelivery } from "./WorkDispatchRuntime";

type Launch = components["schemas"]["PageWorkLaunch"];
const selection = { instanceId: "codex", model: "model", effort: null };
const context: components["schemas"]["PageWorkContext"] = {
  page: { page_id: "dependent", page_key: "NODEX-2", title: "Dependent", status: "plan" },
  project_id: "project",
  prerequisites: [
    {
      page: {
        page_id: "prerequisite",
        page_key: "NODEX-1",
        title: "Prerequisite",
      },
      satisfied: true,
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
  () =>
    Effect.gen(function* () {
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
                          ? [
                              {
                                page_id: "dependent",
                                project_id: "project",
                                prerequisites: [
                                  {
                                    page_id: "prerequisite",
                                    satisfied: true,
                                  },
                                ],
                              },
                            ]
                          : [],
                    },
            }),
        },
        library: {
        },
        workspace: {
          read: (read: ProjectWorkspaceRead) =>
            Effect.sync(() => ({
              value:
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
                outbox.set(intent.launch_id, {
                  ...intent,
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
          Effect.gen(function* () {
            launches++;
            assert.equal(input.projectId, "project");
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
      yield* (yield* scheduler).sweep;
      yield* (yield* scheduler).sweep;
      assert.equal(outbox.size, 1);
      yield* application.startWork({
        pageId: "dependent",
        launchId: [...outbox.keys()][0]!,
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
                ],
              },
            }),
        },
        workspace: {
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
      yield* (yield* owner).sweep;
      assert.equal(events.size, 2);
      assert.deepEqual([...events.values()][0], {
        prerequisites: [],
        readiness_epoch: "page:zero",
      });
    }),
);
it("renders prerequisite Status and latest reports beside the canonical Page body", () => {
  assert.include(brief, "Latest report (ready):\nImplemented and tested.");
  assert.include(brief, "**Exact body**");
});

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
                        prerequisites: [],
                        readiness_epoch: "z:empty",
                      },
                    ]
                  : Array.from({ length: 100 }, (_, index) => ({
                      page_id: `a${String(index).padStart(3, "0")}`,
                      prerequisites: [],
                      readiness_epoch: `ask:${index}`,
                    })),
              },
            };
          }),
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
