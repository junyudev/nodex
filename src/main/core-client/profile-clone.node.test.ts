import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, toNamespacedPath } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { components } from "@nodex/core-protocol";
import { expect, test } from "vite-plus/test";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { waitForCoreRuntimeRemoval } from "../../../scripts/scenarios/profile/isolated-profile";
import { AUTOMATION_EVENTS_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/automation-events";
import { prepareSeededAutomationCheck } from "../../../scripts/scenarios/seed/automation-event";
import { requiredNativeExecutable } from "../../../scripts/testing/native-artifacts";
import { parseProfileExecutionSnapshot } from "../../../scripts/profile-execution-snapshot";
import { inboxNewChatAction } from "../../shared/inbox";
import { createUuidV7 } from "../../shared/uuid-v7";
import { initializeStandaloneDataAuthority } from "./index";
import { inboxDispatchActionToCore } from "./inbox-adapter";

const exec = promisify(execFile);
const python = process.platform === "win32" ? "python" : "python3";
// Each child process ends with its test, whose signal stops it on timeout or cancellation.
// A shorter kill budget of its own would only time interpreter startup on a loaded runner.

// Execution schema and pressure are the subject here; Core content uses public operations.
const writerProgram = `
import json, pathlib, sqlite3, sys, time
home = pathlib.Path(sys.argv[1])
db = sqlite3.connect(home / 'agent-runtime.sqlite')
db.executescript('PRAGMA journal_mode=WAL; CREATE TABLE watermark(value INTEGER); INSERT INTO watermark VALUES(0); CREATE TABLE history(id INTEGER PRIMARY KEY, value INTEGER); INSERT INTO history VALUES(1,0),(2,0); CREATE TABLE payload(body BLOB); INSERT INTO payload VALUES(zeroblob(33554432)); CREATE TABLE runs(state TEXT); INSERT INTO runs VALUES("running");')
print('ready', flush=True)
while not (home / 'stop').exists():
    with db:
        db.execute('UPDATE watermark SET value=value+1')
        db.execute('UPDATE history SET value=(SELECT value FROM watermark)')
    time.sleep(0.001)
db.close()
`;
/** The writer owns readiness only after its complete SQLite schema and payload are committed. */
const awaitExecutionWriterReady = async (
  writing: ReturnType<typeof exec>,
  signal: AbortSignal,
): Promise<void> => {
  const output = writing.child.stdout;
  if (!output) throw new Error("Execution writer has no readiness stream");
  const lines = createInterface({ input: output });
  const reading = new AbortController();
  try {
    const [message] = await Promise.race([
      once(lines, "line", { signal: AbortSignal.any([signal, reading.signal]) }),
      writing.then(() => {
        throw new Error("Execution writer exited before acknowledging readiness");
      }),
    ]);
    if (message !== "ready") throw new Error("Execution writer sent an invalid readiness message");
  } finally {
    reading.abort();
    lines.close();
  }
};

const withExecutionWriter = async (
  writing: ReturnType<typeof exec>,
  operation: () => Promise<void>,
  stop: () => void | Promise<void>,
  readiness?: Promise<void>,
): Promise<void> => {
  const body = await Promise.allSettled([Promise.resolve().then(operation)]);
  const cleanup = await Promise.allSettled([
    Promise.resolve().then(stop),
    writing,
    ...(readiness ? [readiness] : []),
  ]);
  const failures = [
    ...new Set(
      [...body, ...cleanup].flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      ),
    ),
  ];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Execution writer operation and cleanup failed");
  }
  if (failures.length === 1) throw failures[0];
};

const readDatabase = async (path: string, signal: AbortSignal) => {
  const { stdout } = await exec(
    python,
    [
      "-c",
      `
import json, sqlite3, sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
print(json.dumps({'integrity':c.execute('PRAGMA integrity_check').fetchone()[0], 'sequence':c.execute('SELECT value FROM watermark').fetchone()[0], 'values':[r[0] for r in c.execute('SELECT value FROM history ORDER BY id')]}))
`,
      path,
    ],
    { signal },
  );
  return JSON.parse(stdout) as { integrity: string; sequence: number; values: number[] };
};

const clone = async (source: string, target: string, signal: AbortSignal) => {
  // Both clone cases are local administration of the disposable source Profile.
  const { stdout } = await exec(
    requiredNativeExecutable("cli"),
    ["--json", "profile", "clone", "--from", source, "--to", target],
    { signal, maxBuffer: 1024 * 1024, env: { ...process.env, NODEX_HOME: source } },
  );
  return JSON.parse(stdout).result;
};

test("waits for the execution writer's readiness before continuing", async ({ signal }) => {
  const writing = exec(
    python,
    [
      "-u",
      "-c",
      `
import sys
sys.stdin.readline()
print('ready', flush=True)
sys.stdin.readline()
`,
    ],
    { signal },
  );
  let ready = false;
  const readiness = awaitExecutionWriterReady(writing, signal).then(() => {
    ready = true;
  });
  await withExecutionWriter(
    writing,
    async () => {
      await once(writing.child, "spawn", { signal });
      expect(ready).toBe(false);
      writing.child.stdin!.write("initialize\n");
      await readiness;
      expect(ready).toBe(true);
    },
    () => {
      writing.child.stdin!.end("stop\nstop\n");
    },
    readiness,
  );
});

test("retains both an operation failure and the execution writer's cleanup failure", async ({
  signal,
}) => {
  const original = new Error("Execution assertion failed");
  const writing = exec(
    python,
    ["-c", "import sys; sys.stdin.readline(); raise RuntimeError('writer shutdown failed')"],
    { signal },
  );
  await expect(
    withExecutionWriter(
      writing,
      async () => {
        await once(writing.child, "spawn", { signal });
        throw original;
      },
      () => {
        writing.child.stdin!.end("stop\n");
      },
    ),
  ).rejects.toMatchObject({
    name: "AggregateError",
    errors: [
      original,
      expect.objectContaining({
        code: 1,
        stderr: expect.stringContaining("writer shutdown failed"),
      }),
    ],
  });
  expect(writing.child.exitCode).toBe(1);
});

test("retains an execution writer's startup failure instead of reading a partial schema", async ({
  signal,
}) => {
  const writing = exec(python, ["-c", "raise RuntimeError('writer initialization failed')"], {
    signal,
  });
  await expect(awaitExecutionWriterReady(writing, signal)).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("writer initialization failed"),
  });
});

test("clones online execution while its owner keeps writing, without reading provider homes", async ({
  signal,
}) => {
  await withCoreScenario(
    { scenarioId: "nfm-code-block-actions", signal },
    async ({ client, profile }) => {
      await client.administrationApply({
        operationId: randomUUID(),
        intent: {
          kind: "create_backup",
          label: "Clone source",
          include_assets: true,
          trigger: "manual",
        },
      });
      const execution = join(profile.nodexHome, "agent-runtime");
      await mkdir(join(execution, "userdata/attachments/images"), { recursive: true });
      await mkdir(join(execution, ".writer.lock"));
      await writeFile(join(execution, "userdata/environment-id"), "runtime:test\n");
      await writeFile(join(execution, "userdata/attachments/images/a.png"), "immutable image");
      await writeFile(join(execution, "provider-catalog.json"), "unreadable provider catalog");
      await rm(profile.codexHome, { recursive: true, force: true });
      await symlink(
        join(profile.runRoot, "missing-native-provider-home"),
        profile.codexHome,
        process.platform === "win32" ? "junction" : "dir",
      );
      const writing = exec(python, ["-u", "-c", writerProgram, execution], { signal });
      await withExecutionWriter(
        writing,
        async () => {
          await awaitExecutionWriterReady(writing, signal);
          const sourceDatabase = join(execution, "agent-runtime.sqlite");
          const before = await readDatabase(sourceDatabase, signal);
          const target = join(profile.runRoot, "cloned-profile");
          const receipt = await clone(profile.nodexHome, target, signal);
          const after = await readDatabase(sourceDatabase, signal);
          expect(after.sequence).toBeGreaterThan(before.sequence);
          const captured = await readDatabase(
            join(target, "agent-runtime/agent-runtime.sqlite"),
            signal,
          );
          expect(captured.integrity).toBe("ok");
          expect(captured.sequence).toBeGreaterThanOrEqual(before.sequence);
          expect(captured.sequence).toBeLessThanOrEqual(after.sequence);
          expect(captured.values).toEqual([captured.sequence, captured.sequence]);
          const evidence = parseProfileExecutionSnapshot(receipt.execution)!;
          expect(evidence.databaseBytes).toBe(
            (await stat(join(target, "agent-runtime/agent-runtime.sqlite"))).size,
          );
          expect(evidence.attachmentFiles).toBe(1);
          expect(evidence.attachmentBytes).toBe(Buffer.byteLength("immutable image"));
          expect(
            await readFile(join(target, "agent-runtime/userdata/attachments/images/a.png"), "utf8"),
          ).toBe("immutable image");
          expect(
            await readFile(join(target, "agent-runtime/userdata/environment-id"), "utf8"),
          ).toBe("runtime:test\n");
          const marker = JSON.parse(
            await readFile(join(target, "agent-runtime/imported-execution.json"), "utf8"),
          );
          expect(marker).toEqual({
            version: 1,
            sourceProfileHome: toNamespacedPath(profile.nodexHome),
            importedAt: expect.any(String),
          });
          expect(Number.isFinite(Date.parse(marker.importedAt))).toBe(true);
          const published = JSON.parse(
            await readFile(join(target, "profile-snapshot.json"), "utf8"),
          );
          expect(published.execution).toEqual(receipt.execution);
          await expect(stat(join(target, "agent"))).rejects.toMatchObject({ code: "ENOENT" });
          await expect(
            stat(join(target, "agent-runtime/provider-catalog.json")),
          ).rejects.toMatchObject({ code: "ENOENT" });
        },
        () => writeFile(join(execution, "stop"), "stop"),
      );
    },
  );
});

test("clones content when the source has never opened an execution store", async ({ signal }) => {
  await withCoreScenario(
    { scenarioId: "nfm-code-block-actions", signal },
    async ({ client, profile }) => {
      await client.administrationApply({
        operationId: randomUUID(),
        intent: { kind: "create_backup", label: null, include_assets: true, trigger: "manual" },
      });
      const target = join(profile.runRoot, "content-profile");
      expect((await clone(profile.nodexHome, target, signal)).execution).toBeNull();
      await expect(
        stat(join(target, "agent-runtime/imported-execution.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

test("starts a clone with copied standing grants paused and dispatch queues settled", async ({
  signal,
}) => {
  await withCoreScenario(
    { scenarioId: AUTOMATION_EVENTS_SCENARIO_ID, signal },
    async ({ client, manifest, profile, seed }) => {
      const projectId = manifest.projectId;
      const workspace = (intent: components["schemas"]["ProjectWorkspaceIntent"]) =>
        client.workspaceApply({ operationId: createUuidV7(), intent });
      const automate = (intent: components["schemas"]["AutomationIntent"]) =>
        client.automationApply({ operationId: createUuidV7(), intent });
      const sessionId = createUuidV7();
      await workspace({
        kind: "create_session",
        session_id: sessionId,
        project_id: projectId,
        title: "Continued chat",
        initial_page_ids: [],
      });
      await seed.setSessionManaged(sessionId, true);
      await workspace({
        kind: "set_queued_message_state",
        state: {
          "synthetic-native-thread": [
            { id: createUuidV7(), cwd: null, context: { prompt: "Queued native follow-up" } },
          ],
        },
      });
      const heartbeat = {
        kind: "heartbeat",
        name: "Heartbeat",
        prompt: "Check for progress",
        mode: "run",
        trigger: { kind: "clock", rrule: "FREQ=MINUTELY;INTERVAL=5" },
        target_session_id: sessionId,
      } satisfies components["schemas"]["AutomationInput"];
      const heartbeatId = createUuidV7();
      await automate({
        kind: "create_automation",
        automation_id: heartbeatId,
        automation: heartbeat,
      });
      await automate({
        kind: "reschedule_automation",
        automation_id: heartbeatId,
        expected_revision: 1,
        not_before_ms: null,
        retry_within_ms: 0,
      });
      const dueRead = { kind: "due_work", lane: "automations" } as const;
      const due = await client.automationRead(dueRead);
      if (due.value.kind !== "due_work" || !due.value.plan.work_token)
        throw new Error("The Run heartbeat must be due in the source");
      const claimed = await automate({
        kind: "claim_due",
        work_token: due.value.plan.work_token,
        limit: 1,
        lease_duration_ms: 120_000,
      });
      expect(claimed.outcome.claimed_leases).toMatchObject([{ automation_id: heartbeatId }]);

      // An admitted manual occurrence remains eligible even after an ordinary pause.
      const clockId = manifest.entityIdsByKey!.securityCheck!;
      await automate({ kind: "dispatch_now", automation_id: clockId });
      const clock = (await client.automationRead({ kind: "automation", automation_id: clockId }))
        .value;
      if (clock.kind !== "automation" || !clock.item) throw new Error("Missing clock Automation");
      await automate({
        kind: "set_automation_status",
        automation_id: clockId,
        expected_revision: clock.item.automation_revision,
        status: "PAUSED",
      });
      expect((await client.automationRead(dueRead)).value).toMatchObject({
        plan: { due_now: true },
      });
      const { id: eventId } = await seed.createAutomation({
        kind: "cron",
        name: "GitHub check failed",
        conditionText: "When a GitHub check fails",
        prompt: "Inspect the failed check",
        mode: "run",
        model: "synthetic",
        projectId,
        cwds: [profile.projectsDirectory],
        executionEnvironment: "local",
        trigger: {
          kind: "event",
          filter: {
            sourceId: null,
            repositories: ["nodex/scenario"],
            events: ["check_failed"],
            labels: [],
            actorClass: "any",
          },
        },
      });
      const coordinatorId = manifest.entityIdsByKey!.eventCoordinator!;
      await prepareSeededAutomationCheck(client, coordinatorId, 2);
      const sourcesRead = {
        kind: "sources",
        read: { kind: "sources", limit: 8 },
      } as const;
      const sources = (await client.workspaceRead(sourcesRead)).value;
      if (sources.kind !== "sources" || sources.value.kind !== "sources")
        throw new Error("Missing Source list");
      const source = sources.value.sources[0]!;
      await workspace({
        kind: "source",
        command: {
          kind: "configure_source",
          source_id: source.id,
          expected_revision: source.revision,
          enabled: true,
          config: source.config,
        },
      });

      const sent = await seed.sendInboxMessage("Open a synthetic development chat.");
      const inboxRead = {
        kind: "inbox_window",
        scope: { kind: "library" },
        filter: "inbox",
        window: { first: 20 },
      } as const;
      const inbox = await client.workspaceRead(inboxRead);
      const item =
        inbox.value.kind === "inbox_window"
          ? inbox.value.items.items.find((entry) => entry.page_id === sent.pageId)
          : null;
      if (!item) throw new Error("Missing Inbox item to dispatch");
      const inboxDispatch = createUuidV7();
      const inboxSession = createUuidV7();
      await workspace({
        kind: "dispatch_inbox_entries",
        proposal_id: inboxDispatch,
        page_ids: [sent.pageId],
        basis: [item.basis],
        expected_store_epoch: inbox.store_epoch,
        execution_selection: {
          model_selection: { instanceId: "codex", model: "synthetic" },
          interaction_mode: "default",
        },
        action: inboxDispatchActionToCore(inboxNewChatAction(projectId, "Open a chat.")),
        session_id: inboxSession,
      });
      const waiting = await seed.sendInboxMessage("Route this synthetic Inbox message.");
      await workspace({
        kind: "prepare_inbox_suggestions",
        request_id: createUuidV7(),
        limit: 8,
        automatic: true,
      });
      await seed.setInboxRoutingConsent(true);

      const pageId = manifest.pageIdsByKey.dependencyPolicy!;
      await seed.setPageWork(projectId, pageId, {
        assignee: { kind: "agent", instance_id: "codex", model: "synthetic" },
        auto_start: true,
      });
      const launchId = createUuidV7();
      await workspace({
        kind: "start_page_work",
        launch_id: launchId,
        message_id: createUuidV7(),
        session_id: createUuidV7(),
        page_id: pageId,
        brief: "Synthetic Page work",
        again: false,
        selection: { instanceId: "codex", model: "synthetic", effort: null },
      });
      await workspace({
        kind: "record_work_events",
        observed: [],
        events: [
          {
            kind: "report",
            page_id: pageId,
            session_id: sessionId,
            dedupe_key: "clone:report",
            payload: { outcome: "ready" },
          },
        ],
      });
      const events = await client.workspaceRead({ kind: "read_pending_work_events", limit: 20 });
      if (events.value.kind !== "read_pending_work_events" || events.value.events.length === 0)
        throw new Error("Missing queued Coordinator events");
      await workspace({
        kind: "create_event_batch",
        batch_id: createUuidV7(),
        coordinator_session_id: coordinatorId,
        event_ids: events.value.events.map((event) => event.event_id),
        message_id: createUuidV7(),
        body: "Synthetic Coordinator batch",
        fingerprint: "0".repeat(64),
      });
      await workspace({
        kind: "mutate_session",
        session_id: sessionId,
        intent: { kind: "set_snooze", snoozed_until: new Date(Date.now() + 60_000).toISOString() },
      });

      const listAutomations = async (core: typeof client) => {
        const definitions = (
          await core.automationRead({
            kind: "automations",
            include_deleted: false,
            window: { first: 20 },
          })
        ).value;
        if (definitions.kind !== "automations") throw new Error("Missing Automation inventory");
        return definitions.window.items;
      };
      const sourceDefinitions = await listAutomations(client);
      expect(sourceDefinitions.map(({ automation_id }) => automation_id)).toEqual(
        expect.arrayContaining([heartbeatId, clockId, eventId]),
      );
      const expectedDefinitions = new Map(
        sourceDefinitions.map(({ automation_id, trigger }) => [
          automation_id,
          {
            status: "PAUSED",
            trigger: trigger.kind === "clock" ? { ...trigger, next_run_at_ms: null } : trigger,
          },
        ]),
      );

      await client.administrationApply({
        operationId: randomUUID(),
        intent: { kind: "create_backup", label: null, include_assets: true, trigger: "manual" },
      });
      const target = join(profile.runRoot, "inert-profile");
      await clone(profile.nodexHome, target, signal);
      const startClone = () =>
        initializeStandaloneDataAuthority({
          buildId: "scenario:inert-profile",
          isPackaged: false,
          nodexHome: target,
          signal,
        });
      const stopClone = async (runtime: Awaited<ReturnType<typeof startClone>>) => {
        await runtime.rootClient.shutdown();
        await waitForCoreRuntimeRemoval(target);
      };
      const cloned = await startClone();
      try {
        const core = cloned.rootClient;
        const definitions = await listAutomations(core);
        expect(
          new Map(
            definitions.map(({ automation_id, status, trigger }) => [
              automation_id,
              { status, trigger },
            ]),
          ),
        ).toEqual(expectedDefinitions);
        expect((await core.automationRead(dueRead)).value).toMatchObject({
          plan: { due_now: false, work_token: null, next_wake_at_ms: null },
        });
        expect(
          (
            await core.automationRead({
              kind: "leases",
              automation_id: heartbeatId,
              include_settled: true,
              window: { first: 20 },
            })
          ).value,
        ).toMatchObject({
          window: {
            items: expect.arrayContaining([
              expect.objectContaining({ automation_id: heartbeatId, status: "cancelled" }),
            ]),
          },
        });
        expect(
          (
            await core.automationRead({
              kind: "automation_decisions",
              automation_id: clockId,
              window: { first: 20 },
            })
          ).value,
        ).toMatchObject({ window: { items: [{ status: "withdrawn" }] } });

        const read = async (input: Parameters<typeof core.workspaceRead>[0]) =>
          (await core.workspaceRead(input)).value;
        expect(await read(sourcesRead)).toMatchObject({ value: { sources: [{ enabled: false }] } });
        expect(
          await read({
            kind: "automation_assessments",
            read: { kind: "pending", limit: 8 },
          }),
        ).toMatchObject({ value: { requests: [] } });
        expect(await read({ kind: "inbox_dispatch_outbox", limit: 8 })).toMatchObject({
          dispatches: [],
        });
        expect(await read({ kind: "inbox_suggestion_requests", limit: 8 })).toMatchObject({
          requests: [],
        });
        expect(await read({ kind: "inbox_routing_consent" })).toMatchObject({
          start_my_requests: false,
        });
        expect(await read(inboxRead)).toMatchObject({
          items: {
            items: expect.arrayContaining([
              expect.objectContaining({ page_id: waiting.pageId, suggestion_state: "none" }),
            ]),
          },
        });
        expect(await read({ kind: "session_start", session_id: inboxSession })).toMatchObject({
          start: {
            proposal_id: inboxDispatch,
            state: "failed",
            retryable: false,
            failure_message: expect.stringContaining("Cancelled when this Profile was cloned"),
          },
        });
        expect(await read({ kind: "page_work_outbox", limit: 8 })).toMatchObject({ launches: [] });
        expect(await read({ kind: "page_work_launch", launch_id: launchId })).toMatchObject({
          launch: { rejection: "Cancelled when this Profile was cloned" },
        });
        expect(
          await read({
            kind: "effective_execution_hold",
            target: { kind: "page", page_id: pageId },
          }),
        ).toMatchObject({ holds: [{ scope: { kind: "page", page_id: pageId } }] });
        expect(await read({ kind: "read_managed_sessions", limit: 8 })).toMatchObject({
          sessions: [],
        });
        expect(await read({ kind: "read_open_event_batches", limit: 8 })).toMatchObject({
          batches: [],
        });
        expect(await read({ kind: "read_pending_work_events", limit: 8 })).toMatchObject({
          events: [],
        });
        expect(await read({ kind: "next_session_snooze" })).toMatchObject({
          next_wake_at: null,
          delivery: null,
        });
        expect(await read({ kind: "queued_message_state" })).toMatchObject({
          state: {
            "synthetic-native-thread": [
              {
                context: { prompt: "Queued native follow-up" },
                pausedReason: "Paused when this Profile was cloned",
              },
            ],
          },
        });

        // Resuming starts a new cadence. Reopening the Profile must retain that choice.
        const definition = definitions.find((item) => item.automation_id === heartbeatId)!;
        await core.automationApply({
          operationId: createUuidV7(),
          intent: {
            kind: "set_automation_status",
            automation_id: heartbeatId,
            expected_revision: definition.automation_revision,
            status: "ACTIVE",
          },
        });
      } finally {
        await stopClone(cloned);
      }
      const reopened = await startClone();
      try {
        expect(
          (
            await reopened.rootClient.automationRead({
              kind: "automation",
              automation_id: heartbeatId,
            })
          ).value,
        ).toMatchObject({ item: { status: "ACTIVE" } });
      } finally {
        await stopClone(reopened);
      }
    },
  );
});
