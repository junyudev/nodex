import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vitest";
import {
  AutomationApplication,
  AutomationApplicationError,
} from "../../host/automation-application/AutomationApplication";
import type {
  AutomationInput,
  AutomationIntent,
} from "../../shared/core-modules/automation-module";
import type { NativeAutomationCandidate } from "../../shared/native-automation-import";
import type { Automation, AutomationRun, Project, ProjectSession } from "../../shared/types";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { testLayer } from "../app/MainConfig";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { ClaudeNativeCatalog } from "./claude/ClaudeNativeCatalog";
import {
  live,
  NativeAutomationImport,
  nativeAutomationImportBlocker,
  recentNativeAutomationRuns,
} from "./NativeAutomationImport";
import { NativeSessionCatalog } from "./NativeSessionCatalog";

const DAY = 24 * 60 * 60 * 1000;
const pathRoot = process.platform === "win32" ? "C:/work" : "/work";
const runNativeId = "019abcde-1234-7000-8000-123456789abc";
const heartbeatNativeId = "019abcde-1234-7000-8000-123456789abd";
const files = new URL("../platform/node/native-automations/fixtures/", import.meta.url);

type HistoricalRun = Extract<AutomationIntent, { kind: "record_historical_run" }>["run"];

it("selects at most 20 non-archived runs in the last 30 days by activity", () => {
  const now = 100 * DAY;
  const runs = Array.from({ length: 22 }, (_, i) => ({
    nativeSessionId: `run-${i}`,
    createdAt: i,
    updatedAt: now - i * DAY,
    archived: i === 0,
  }));
  const selected = recentNativeAutomationRuns(
    [
      ...runs,
      {
        nativeSessionId: "too-old",
        createdAt: 0,
        updatedAt: now - 31 * DAY,
        archived: false,
      },
    ],
    now,
  );
  expect(selected.map(({ nativeSessionId }) => nativeSessionId)).toEqual(
    Array.from({ length: 20 }, (_, i) => `run-${i + 1}`),
  );
  expect(
    recentNativeAutomationRuns(
      [
        { ...runs[1]!, updatedAt: now - 30 * DAY },
        { ...runs[2]!, updatedAt: now - 30 * DAY - 1 },
      ],
      now,
    ).map(({ nativeSessionId }) => nativeSessionId),
  ).toEqual(["run-1"]);
});

it("reports why a task is unavailable before attempting to create its destination", () => {
  const task: NativeAutomationCandidate = {
    agent: "claude",
    kind: "cron",
    sourceHome: pathRoot,
    sourceAutomationId: "task",
    conversationSource: { backendKind: "claude", nativeHome: pathRoot },
    sourceStatus: "active",
    name: "Check builds",
    prompt: "Check builds.",
    folders: [pathRoot],
    executionEnvironment: "local",
    runs: [],
    schedule: { kind: "rrule", rrule: "FREQ=DAILY;BYHOUR=9" },
  };
  const placement = { kind: "project" as const, name: "Work", projectId: "work" };
  expect(nativeAutomationImportBlocker(task, placement, task.folders)).toBe("no-claude-profile");
  const matched = {
    ...task,
    conversationSource: { ...task.conversationSource, instanceConfigId: "claude" },
  };
  expect(nativeAutomationImportBlocker(matched, { kind: "missing" }, task.folders)).toBe(
    "missing-folder",
  );
  for (const reason of ["manual", "one-shot", "cron-day-or", "invalid"] as const) {
    expect(
      nativeAutomationImportBlocker(
        {
          ...task,
          schedule: { kind: "unsupported", reason },
        },
        placement,
        task.folders,
      ),
    ).toBe(reason);
  }
});

it.effect(
  "imports each Project once, resumes history, moves old run copies and reuses heartbeat chats",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.sync(() => realpathSync(mkdtempSync(join(tmpdir(), "nodex-import-tasks-")))),
          (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
        );
        const [a, b, codexHome] = ["a", "b", "codex"].map((name) => join(root, name)) as [
          string,
          string,
          string,
        ];
        const now = 100 * DAY;
        yield* TestClock.setTime(now);
        yield* Effect.sync(() => {
          mkdirSync(a);
          mkdirSync(b);
          mkdirSync(join(codexHome, "sqlite"), { recursive: true });
          mkdirSync(join(codexHome, "automations", "daily"), { recursive: true });
          writeFileSync(
            join(codexHome, "automations", "daily", "memory.md"),
            "Remember the checkpoint.",
          );
          using db = new DatabaseSync(join(codexHome, "sqlite", "codex.db"));
          db.exec(readFileSync(new URL("codex.sql", files), "utf8"));
          db.prepare("UPDATE automations SET cwds=? WHERE id='daily'").run(JSON.stringify([a, b]));
          db.prepare("UPDATE automations SET target_thread_id=? WHERE id='beat'").run(
            heartbeatNativeId,
          );
          db.prepare(
            "INSERT INTO automation_runs VALUES (?, 'daily', 'ACCEPTED', 'Build report', ?, ?, ?)",
          ).run(runNativeId, b, now - 2 * DAY, now - DAY);
        });

        const placements = [
          [a, "A"],
          [b, "B"],
        ].map(([folder, id]) => ({
          id,
          name: id,
          sources: [{ kind: "directory", path: folder }],
          lifecycle: "active",
        })) as Project[];
        const sessions = new Map<
          string,
          Pick<ProjectSession, "id" | "projectId" | "displayTitle" | "archived">
        >([
          [
            "earlier-run",
            { id: "earlier-run", projectId: "A", displayTitle: "Older title", archived: false },
          ],
          [
            "heartbeat",
            { id: "heartbeat", projectId: "A", displayTitle: "Pulse", archived: false },
          ],
        ]);
        const moves: string[] = [];
        const created: AutomationInput[] = [];
        const definitions: Automation[] = [];
        const history = new Map<string, HistoricalRun>();
        let runFailure = true;
        const service = yield* NativeAutomationImport.pipe(
          Effect.provide(
            live.pipe(
              Layer.provide([
                testLayer({ homeDirectory: root, isolatedRunId: "synthetic" }),
                Layer.mock(ApplicationSettings, {
                  snapshot: () =>
                    Effect.succeed({
                      codexHome: { activeHomePath: codexHome },
                      agentProfiles: [],
                    } as never),
                }),
                Layer.mock(ClaudeNativeCatalog, {}),
                Layer.mock(NativeSessionCatalog, {
                  previewImport: ({ reference }) =>
                    Effect.succeed({
                      matches: [
                        {
                          backendKind: "codex",
                          nativeSessionId: reference,
                          nativeHome: codexHome,
                          title: "Pulse",
                          cwd: a,
                          cwdAvailable: true,
                          updatedAt: now,
                        },
                      ],
                    }),
                }),
                Layer.mock(ProjectWorkspace, {
                  listProjectWindow: () =>
                    Effect.succeed({
                      items: placements,
                      nextCursor: null,
                      hasMore: false,
                      storeEpoch: "synthetic",
                      projectionRevision: 1,
                    }),
                  getProjectSession: (id) =>
                    Effect.succeed((sessions.get(id) ?? null) as ProjectSession | null),
                }),
                Layer.mock(AgentRuntimeApplication, {
                  worktreeChats: {} as AgentRuntimeApplication["Service"]["worktreeChats"],
                  findNativeImports: ({ nativeThreadIds }) =>
                    Effect.succeed(
                      nativeThreadIds.flatMap((id) => {
                        const sessionId =
                          id === runNativeId
                            ? "earlier-run"
                            : id === heartbeatNativeId
                              ? "heartbeat"
                              : null;
                        return sessionId
                          ? [
                              {
                                nativeSessionId: id,
                                importedSessionId: sessionId,
                                importedThreadId: sessionId,
                              },
                            ]
                          : [];
                      }),
                    ),
                  moveSession: ({ sessionId, projectId }) =>
                    Effect.sync(() => {
                      const session = sessions.get(sessionId);
                      if (session) session.projectId = projectId;
                      moves.push(sessionId);
                      return { sessionId, projectId };
                    }),
                  submitNativeImport: () => Effect.die("Existing copies must be reused"),
                }),
                Layer.mock(AutomationApplication, {
                  inbox: {} as AutomationApplication["Service"]["inbox"],
                  occurrences: {} as AutomationApplication["Service"]["occurrences"],
                  reminders: {} as AutomationApplication["Service"]["reminders"],
                  automations: {
                    list: () => Effect.succeed([...definitions]),
                    importDefinition: (draft: AutomationInput) =>
                      Effect.sync(() => {
                        created.push(draft);
                        const definition = {
                          id: `automation-${created.length}`,
                          status: "PAUSED",
                          importOrigin: draft.import_origin,
                          scope: {
                            kind: "project",
                            projectId:
                              draft.scope?.kind === "project" ? draft.scope.project_id : "",
                          },
                        } as Automation;
                        definitions.push(definition);
                        return definition;
                      }),
                  } as unknown as AutomationApplication["Service"]["automations"],
                  runs: {
                    get: (id: string) =>
                      Effect.succeed(history.has(id) ? ({ runId: id } as AutomationRun) : null),
                    recordHistorical: (run: HistoricalRun) =>
                      Effect.suspend(() => {
                        if (runFailure) {
                          runFailure = false;
                          return Effect.fail(
                            new AutomationApplicationError({
                              operation: "record-historical-run",
                              cause: new Error("Test run recording failure"),
                            }),
                          );
                        }
                        return Effect.sync(() => {
                          history.set(run.run_id, run);
                        });
                      }),
                  } as unknown as AutomationApplication["Service"]["runs"],
                }),
              ]),
            ),
          ),
        );
        const catalog = yield* service.catalog;
        const groups = catalog.rows.filter(({ name }) => name === "Database task");
        expect(
          groups.map(({ placement, runCount }) => [
            placement.kind === "project" ? placement.projectId : null,
            runCount,
          ]),
        ).toEqual([
          ["A", 0],
          ["B", 1],
        ]);
        expect(catalog.cronConversationKeys.join()).toContain(runNativeId);
        expect(catalog.cronConversationKeys.join()).not.toContain(heartbeatNativeId);
        const [first, second] = groups;
        const heartbeat = catalog.rows.find(({ kind }) => kind === "heartbeat");
        if (!first || !second || !heartbeat) throw new Error("Expected import rows");
        expect((yield* service.importSelection(first.selection)).kind).toBe("imported");
        expect((yield* service.importSelection(second.selection)).kind).toBe("failed");
        expect((yield* service.importSelection(second.selection)).kind).toBe("imported");
        expect(yield* service.importSelection(second.selection)).toEqual({
          kind: "imported",
          automationIds: ["automation-2"],
        });
        expect((yield* service.importSelection(heartbeat.selection)).kind).toBe("imported");
        expect((yield* service.importSelection(heartbeat.selection)).kind).toBe("imported");
        expect(moves).toEqual(["earlier-run"]);
        expect(created.map(({ name }) => name)).toEqual([
          "Database task",
          "Database task",
          "Heartbeat",
        ]);
        expect(created[0]).toMatchObject({
          mode: "run",
          initial_status: "paused",
          cwds: [a],
          import_runbook_markdown: "Remember the checkpoint.",
        });
        expect(created[1]).toMatchObject({ cwds: [b], import_origin: created[0]?.import_origin });
        expect(created[2]).toMatchObject({ target_session_id: "heartbeat" });
        expect([...history.values()]).toMatchObject([
          {
            automation_id: "automation-2",
            session_id: "earlier-run",
            session_title: "Build report",
            source_cwd: b,
            created_at_ms: now - 2 * DAY,
            updated_at_ms: now - DAY,
          },
        ]);
      }),
    ),
);
