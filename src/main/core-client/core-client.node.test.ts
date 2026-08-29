import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, test } from "vite-plus/test";
import { CORE_CLIENT_REQUIREMENTS, type components } from "@nodex/core-protocol";

import { CoreClient, CoreModuleResponseError } from "./core-client";
import { readCoreRuntimeConnection } from "./runtime-descriptor";
import { CoreEventCompatibilityError } from "./uds-http";
import type {
  CoreEventEnvelope,
  CoreEventSubscription,
  CoreRuntimeDescriptor,
  DocumentLiveRepair,
} from "./types";
import { applyResultCursor, applyResultDelivery, applyResultStoreEpoch } from "./types";

const CORE_BINARY = path.resolve("target/debug/nodex-core");
const CORE_STDERR_LIMIT = 16 * 1024;
const CORE_STARTUP_TIMEOUT_MS = 35_000;
const coreStderr = new WeakMap<ChildProcessWithoutNullStreams, string>();

const spawnCore = (nodexHome: string): ChildProcessWithoutNullStreams => {
  const child = spawn(CORE_BINARY, ["--home", nodexHome], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    coreStderr.set(child, `${coreStderr.get(child) ?? ""}${chunk}`.slice(-CORE_STDERR_LIMIT));
  });
  return child;
};

const readDescriptor = (child: ChildProcessWithoutNullStreams): Promise<CoreRuntimeDescriptor> =>
  new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const failure = (message: string): Error => {
      const stderr = coreStderr.get(child)?.trim();
      return new Error(stderr ? `${message}: ${stderr}` : message);
    };
    const timeout = setTimeout(() => {
      lines.close();
      reject(failure("Core did not publish a runtime descriptor"));
    }, CORE_STARTUP_TIMEOUT_MS);
    lines.once("line", (line) => {
      clearTimeout(timeout);
      lines.close();
      resolve((JSON.parse(line) as components["schemas"]["CoreSelectionResult"]).descriptor);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      lines.close();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      lines.close();
      reject(
        failure(
          `Core exited before publishing a runtime descriptor (code ${String(code)}, signal ${String(signal)})`,
        ),
      );
    });
  });

const waitForExit = (child: ChildProcessWithoutNullStreams): Promise<number | null> => {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Core process ${child.pid} did not exit`));
    }, 5_000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
};

const withTimeout = async <Value>(promise: Promise<Value>, message: string): Promise<Value> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 5_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

async function createInitialProject(client: CoreClient, nodexHome: string): Promise<number> {
  const source = path.join(nodexHome, "workspace");
  const committed = await client.workspaceApply({
    operationId: "node-initial-project",
    intent: {
      kind: "create_initial_project",
      project_id: "project:default",
      name: "My Project",
      description: "",
      appearance: null,
      source_roots: [source],
      starter_page: {
        page_id: "page:getting-started",
        document_id: "document:getting-started",
        title_markdown: "Welcome to Nodex",
        nfm: "Welcome to Nodex.",
      },
    },
  });
  return applyResultCursor(committed);
}

describe("CoreClient over a Unix socket", () => {
  test("closing one Document stream preserves sibling subscriptions on the connection", async () => {
    const nodexHome = mkdtempSync(path.join(tmpdir(), "nodex-core-client-stream-"));
    const child = spawnCore(nodexHome);
    let firstSubscription: CoreEventSubscription | undefined;
    let secondSubscription: CoreEventSubscription | undefined;

    try {
      await readDescriptor(child);
      const rootClient = await CoreClient.connect({
        nodexHome,
        clientKind: "test",
        buildId: "node-document-stream-lifecycle-test",
      });
      await createInitialProject(rootClient, nodexHome);
      const client = rootClient.forProject("project:default");
      const documentId = "document:stream-lifecycle";
      const created = await client.libraryApply({
        operationId: "node-document-stream-lifecycle-page",
        intent: {
          kind: "create_page",
          page_id: "page:stream-lifecycle",
          document_id: documentId,
          title: "Stream lifecycle",
          parent: { kind: "library", before: null },
        },
      });

      const firstEvents: CoreEventEnvelope[] = [];

      const openedFirstSubscription = await client.openDocumentEventStream(
        {
          documentId,
          clientSessionId: "session:stream-lifecycle:first",
        },
        (event) => firstEvents.push(event),
        () => undefined,
        () => undefined,
      );
      firstSubscription = openedFirstSubscription;
      expect(openedFirstSubscription.barrier.commit_head).toBeGreaterThanOrEqual(
        applyResultCursor(created),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(firstEvents).toEqual([]);
      secondSubscription = await client.openDocumentEventStream(
        {
          documentId,
          clientSessionId: "session:stream-lifecycle:second",
        },
        () => undefined,
        () => undefined,
        () => undefined,
      );

      firstSubscription.close();
      await firstSubscription.done;
      firstSubscription = undefined;

      await expect(
        client.documentSync({
          documentId,
          clientSessionId: "session:stream-lifecycle:second",
          stateVector: new Uint8Array(),
        }),
      ).resolves.toMatchObject({
        documentId,
        generation: 1,
        headSeq: 1,
      });

      secondSubscription.close();
      await secondSubscription.done;
      secondSubscription = undefined;
      await expect(client.shutdown()).resolves.toEqual({ status: "draining" });
      await expect(waitForExit(child)).resolves.toBe(0);
    } finally {
      firstSubscription?.close();
      secondSubscription?.close();
      if (child.exitCode === null) child.kill();
      await waitForExit(child).catch(() => null);
      rmSync(nodexHome, { recursive: true, force: true });
    }
  });

  test("reuses one daemon and completes handshake, read, apply, event, and shutdown", async () => {
    expect(existsSync(CORE_BINARY), "run pnpm run core:test:client").toBe(true);
    const nodexHome = mkdtempSync(path.join(tmpdir(), "nodex-core-client-"));
    const children = [spawnCore(nodexHome), spawnCore(nodexHome)];
    let subscription: CoreEventSubscription | undefined;
    let documentSubscription: CoreEventSubscription | undefined;
    let restartedSubscription: CoreEventSubscription | undefined;

    try {
      const descriptors = await Promise.all(children.map(readDescriptor));
      expect(descriptors[0]?.pid).toBe(descriptors[1]?.pid);
      expect(descriptors[0]?.start_nonce).toBe(descriptors[1]?.start_nonce);
      const winnerPid = descriptors[0]?.pid;
      expect(children.some((child) => child.pid === winnerPid)).toBe(true);

      const rootClient = await CoreClient.connect({
        nodexHome,
        clientKind: "test",
        buildId: "node-integration-test",
      });
      const snapshot = await rootClient.libraryRead({ kind: "metadata" });
      expect(snapshot.commit_head).toBe(0);
      expect(snapshot.value).toMatchObject({
        kind: "metadata",
        library_id: rootClient.handshake.library_id,
      });
      const initialProjectEventSequence = await createInitialProject(rootClient, nodexHome);
      const client = rootClient.forProject("project:default");
      expect(client.handshake.generation.pid).toBe(winnerPid);

      const descriptorPath = path.join(nodexHome, "run/core/core.json");
      chmodSync(descriptorPath, 0o644);
      try {
        expect(() => readCoreRuntimeConnection(nodexHome)).toThrow(
          "Core runtime descriptor has mode 644; expected 600",
        );
      } finally {
        chmodSync(descriptorPath, 0o600);
      }

      let resolveEvent: ((event: CoreEventEnvelope) => void) | undefined;
      const observedEvent = new Promise<CoreEventEnvelope>((resolve) => {
        resolveEvent = resolve;
      });
      subscription = await client.openEventStream(
        initialProjectEventSequence,
        (event) => resolveEvent?.(event),
        () => undefined,
      );
      await expect(
        client.openEventStream(
          initialProjectEventSequence,
          () => undefined,
          () => undefined,
        ),
      ).rejects.toMatchObject({ status: 409 });

      const applyInput = {
        operationId: "node-operation-1",
        intent: {
          kind: "create_page" as const,
          page_id: "page:node-integration",
          document_id: "document:node-integration",
          title: "Node integration",
          parent: { kind: "library" as const, before: null },
        },
      };
      const committed = await client.libraryApply(applyInput);
      expect(applyResultCursor(committed)).toBeGreaterThanOrEqual(1);
      expect(committed.receipt.duplicate).toBe(false);
      expect(applyResultDelivery(committed)?.manifest.identity.commit_seq).toBe(
        applyResultCursor(committed),
      );

      const event = await withTimeout(observedEvent, "Core Module event was not observed");
      expect(event.packet.manifest.identity.commit_seq).toBe(applyResultCursor(committed));
      expect(event.packet.atoms.map((atom) => atom.payload)).toContainEqual(
        expect.objectContaining({
          module: "library",
          event: expect.objectContaining({
            kind: "library_changed",
            page_ids: ["page:node-integration"],
          }),
        }),
      );

      const replay = await client.libraryApply(applyInput);
      expect(applyResultCursor(replay)).toBe(applyResultCursor(committed));
      expect(applyResultDelivery(replay)?.manifest.identity).toEqual(
        applyResultDelivery(committed)?.manifest.identity,
      );
      expect(replay.receipt.duplicate).toBe(true);

      const projects = await client.workspaceRead({
        kind: "project_window",
        include_archived: false,
        window: { first: 50 },
      });
      expect(projects.value).toMatchObject({
        kind: "project_window",
        projects: {
          items: [{ id: "project:default", database_id: expect.any(String) }],
        },
      });
      const threadInput = {
        operationId: "node-workspace-thread-1",
        intent: {
          kind: "upsert_thread" as const,
          thread_id: "thread:node-integration",
          patch: {
            project_id: "project:default",
            thread_name: "Node integration thread",
            thread_source: "appServer",
            thread_preview: "Persisted by native Workspace",
            model_provider: "openai",
            cwd: path.join(nodexHome, "workspace"),
            status: {
              status_type: "active" as const,
              active_flags: ["waitingOnApproval" as const],
            },
            created_at: 100,
            updated_at: 200,
            linked_at: "2026-07-19T06:00:00.000Z",
          },
        },
      };
      const threadCommitted = await client.workspaceApply(threadInput);
      const threadReplay = await client.workspaceApply(threadInput);
      expect(applyResultCursor(threadReplay)).toBe(applyResultCursor(threadCommitted));
      expect(threadReplay.receipt.duplicate).toBe(true);
      await client.workspaceApply({
        operationId: "node-workspace-thread-catalogs-1",
        intent: {
          kind: "replace_thread_dynamic_tool_catalogs",
          thread_id: "thread:node-integration",
          catalogs: [{ namespace: "nodex_app", toolset_revision: 5 }],
        },
      });
      await client.workspaceApply({
        operationId: "node-workspace-thread-permission-1",
        intent: {
          kind: "set_project_permission_mode",
          project_id: "project:default",
          mode: "guardian-approvals",
        },
      });
      const executionContext = await client.workspaceRead({
        kind: "execution_context",
        thread_id: "thread:node-integration",
      });
      expect(executionContext.value).toMatchObject({
        kind: "execution_context",
        context: {
          permission_mode: "guardian-approvals",
          project: { id: "project:default" },
          thread: {
            thread_id: "thread:node-integration",
            project_id: "project:default",
            thread_name: "Node integration thread",
            status: {
              status_type: "active",
              active_flags: ["waitingOnApproval"],
            },
            dynamic_tool_catalogs: [{ namespace: "nodex_app", toolset_revision: 5 }],
          },
        },
      });
      await client.workspaceApply({
        operationId: "node-workspace-turn-authority-1",
        intent: {
          kind: "freeze_turn_authority",
          thread_id: "thread:node-integration",
          turn_id: "turn:node-integration",
          root_thread_id: "thread:node-integration",
          actor_project_id: "project:default",
          source: "project_turn",
          inherited_from: null,
        },
      });
      const agentProvenance = {
        profile_id: client.handshake.generation.profile_id,
        authority: {
          thread_id: "thread:node-integration",
          turn_id: "turn:node-integration",
          root_thread_id: "thread:node-integration",
          actor_project_id: "project:default",
          library_id: client.handshake.library_id,
          store_epoch: client.handshake.store_epoch,
          scope: "project" as const,
          source: "project_turn" as const,
        },
      };
      await client.libraryApply({
        operationId: "node-agent-search-grant-1",
        intent: {
          kind: "persist_agent_project_resource_grants",
          provenance: agentProvenance,
          grants: [
            {
              root: { kind: "page", page_id: "page:node-integration" },
              access: "read",
              library_actions: [],
            },
          ],
        },
      });
      const agentSearch = await client.libraryRead({
        kind: "agent_search",
        authorization: {
          provenance: agentProvenance,
          call_id: "call:node-agent-search",
        },
        query: "integraton",
        target: "pages",
        scope: { kind: "library" },
        block_types: null,
        include_archived: false,
        cursor: null,
        limit: 1,
      });
      expect(agentSearch.value).toMatchObject({
        kind: "agent_search",
        has_more: false,
        next_cursor: null,
        items: [
          {
            kind: "page",
            id: "page:node-integration",
            matches: [{ source: "title", quality: "fuzzy" }],
          },
        ],
      });
      const databaseCatalog = await client.databaseRead({
        kind: "catalog_window",
        window: { after: null, first: 10 },
      });
      if (databaseCatalog.value.kind !== "catalog_window") {
        throw new Error("Expected native Database catalog");
      }
      const databaseId = databaseCatalog.value.databases.items[0]?.database.database_id;
      if (!databaseId) throw new Error("Initial Project has no Database");
      const dataSources = await client.databaseRead({
        kind: "data_source_window",
        database_id: databaseId,
        window: { after: null, first: 10 },
      });
      if (dataSources.value.kind !== "data_source_window") {
        throw new Error("Expected native Data Source window");
      }
      const dataSourceId = dataSources.value.data_sources.items[0]?.data_source_id;
      if (!dataSourceId) throw new Error("Initial Project has no Data Source");
      const agentDatabaseQuery = await client.databaseRead({
        kind: "agent_data_source_query",
        data_source_id: dataSourceId,
        query: {
          authorization: {
            provenance: agentProvenance,
            call_id: "call:node-database-query",
          },
          cursor: null,
          limit: 1,
          projection_property_ids: null,
          filter: { kind: "group", operator: "and", children: [] },
          sort: [],
        },
      });
      expect(agentDatabaseQuery.value).toMatchObject({
        kind: "agent_data_source_query",
        value: {
          data_source_id: dataSourceId,
          rows: {
            items: [
              {
                page_id: "page:getting-started",
                title: "Welcome to Nodex",
                database_values: {
                  status: "triage",
                },
              },
            ],
            next_cursor: null,
          },
        },
      });
      const automationInput = {
        operationId: "node-automation-create-1",
        intent: {
          kind: "create_definition" as const,
          automation_id: "node-daily-report",
          definition: {
            kind: "cron" as const,
            name: "Node daily report",
            prompt: "Prepare the report",
            rrule: "FREQ=MINUTELY;INTERVAL=5",
            cwds: [path.join(nodexHome, "workspace")],
            execution_environment: "worktree" as const,
          },
        },
      };
      const automationCommitted = await client.automationApply(automationInput);
      expect(automationCommitted.outcome.definitions).toMatchObject([
        {
          automation_id: "node-daily-report",
          definition_revision: 1,
          status: "ACTIVE",
          next_run_at_ms: expect.any(Number),
        },
      ]);
      const automationReplay = await client.automationApply(automationInput);
      expect(applyResultCursor(automationReplay)).toBe(applyResultCursor(automationCommitted));
      expect(automationReplay.receipt.duplicate).toBe(true);
      const automations = await client.automationRead({
        kind: "definitions",
        include_deleted: false,
        window: { after: null, first: 10 },
      });
      expect(automations.value).toMatchObject({
        kind: "definitions",
        window: {
          items: [{ automation_id: "node-daily-report" }],
          next_cursor: null,
        },
      });
      const noDueWork = await client.automationRead({
        kind: "due_work",
        lane: "definitions",
      });
      expect(noDueWork.value).toEqual({
        kind: "due_work",
        plan: {
          due_now: false,
          next_wake_at_ms: expect.any(Number),
          work_token: null,
        },
      });
      const noScheduledOccurrences = await client.automationRead({
        kind: "occurrences",
        window_start_ms: Date.now() - 60_000,
        window_end_ms: Date.now() + 60_000,
        search_query: null,
        window: { after: null, first: 10 },
      });
      expect(noScheduledOccurrences.value).toMatchObject({
        kind: "occurrences",
        window: { items: [], next_cursor: null },
      });
      const noDueReminders = await client.automationRead({
        kind: "due_work",
        lane: "reminders",
      });
      expect(noDueReminders.value).toEqual({
        kind: "due_work",
        plan: {
          due_now: false,
          next_wake_at_ms: null,
          work_token: null,
        },
      });
      const reminderLeases = await client.automationRead({
        kind: "reminder_leases",
        include_settled: true,
        window: { after: null, first: 10 },
      });
      expect(reminderLeases.value).toMatchObject({
        kind: "reminder_leases",
        window: { items: [], next_cursor: null },
      });
      const reminderSnoozes = await client.automationRead({
        kind: "reminder_snoozes",
        include_consumed: true,
        window: { after: null, first: 10 },
      });
      expect(reminderSnoozes.value).toMatchObject({
        kind: "reminder_snoozes",
        window: { items: [], next_cursor: null },
      });
      const begunRun = await client.automationApply({
        operationId: "node-automation-run-begin-1",
        intent: {
          kind: "begin_run",
          thread_id: "pending:node-automation-run",
          automation_id: "node-daily-report",
          thread_title: "Node daily report",
          source_cwd: path.join(nodexHome, "workspace"),
        },
      });
      expect(begunRun.outcome.runs).toMatchObject([
        {
          thread_id: "pending:node-automation-run",
          run_revision: 1,
          status: "IN_PROGRESS",
        },
      ]);
      const replacedRun = await client.automationApply({
        operationId: "node-automation-run-replace-1",
        intent: {
          kind: "replace_pending_run_thread",
          pending_thread_id: "pending:node-automation-run",
          thread_id: "thread:node-integration",
          expected_revision: 1,
        },
      });
      expect(replacedRun.outcome.runs[0]).toMatchObject({
        thread_id: "thread:node-integration",
        run_revision: 2,
      });
      const completedRun = await client.automationApply({
        operationId: "node-automation-run-complete-1",
        intent: {
          kind: "complete_run_for_review",
          thread_id: "thread:node-integration",
          expected_revision: 2,
          inbox_title: "Report ready",
          inbox_summary: "Review the native run.",
        },
      });
      expect(completedRun.outcome.runs[0]).toMatchObject({
        run_revision: 3,
        status: "PENDING_REVIEW",
      });
      const runInbox = await client.automationRead({
        kind: "inbox",
        window: { after: null, first: 10 },
      });
      expect(runInbox.value).toMatchObject({
        kind: "inbox",
        window: {
          items: [
            {
              thread_id: "thread:node-integration",
              title: "Node daily report",
              description: "Review the native run.",
            },
          ],
          next_cursor: null,
        },
        unread_counts: { total: 1 },
      });
      const readRun = await client.automationApply({
        operationId: "node-automation-run-read-1",
        intent: {
          kind: "set_run_read_state",
          thread_id: "thread:node-integration",
          expected_revision: 3,
          read: true,
        },
      });
      expect(readRun.outcome.runs[0]).toMatchObject({
        run_revision: 4,
        read_at_ms: expect.any(Number),
      });
      const nativeCli = await CoreClient.connect({
        nodexHome,
        clientKind: "native_cli",
        buildId: "node-native-cli-test",
        projectId: "project:default",
      });
      const missingOccurrenceInput = {
        operationId: "node-occurrence-missing-1",
        intent: {
          kind: "update_page_occurrence" as const,
          page_id: "page:missing-occurrence",
          occurrence_start_ms: Date.UTC(2026, 6, 18, 9),
          scope: "all" as const,
          updates: { is_all_day: false },
        },
      };
      const missingOccurrence = await client.automationApply(missingOccurrenceInput);
      expect(missingOccurrence.outcome.page_occurrence_mutation).toMatchObject({
        success: false,
        duplicate: false,
        commit_seq: null,
        code: "page_not_found",
      });
      const missingOccurrenceReplay = await nativeCli.automationApply(missingOccurrenceInput);
      expect(applyResultCursor(missingOccurrenceReplay)).toBe(applyResultCursor(missingOccurrence));
      expect(missingOccurrenceReplay.outcome.page_occurrence_mutation).toMatchObject({
        success: false,
        duplicate: true,
        code: "page_not_found",
      });
      const unauthorizedClaim = nativeCli.automationApply({
        operationId: "node-native-cli-automation-claim-1",
        intent: {
          kind: "claim_due",
          work_token: "automation-due:test",
          limit: 1,
          lease_duration_ms: 60_000,
        },
      });
      await expect(unauthorizedClaim).rejects.toBeInstanceOf(CoreModuleResponseError);
      await expect(unauthorizedClaim).rejects.toMatchObject({
        coreError: { code: "unauthorized" },
      });
      const unauthorizedReminderClaim = nativeCli.automationApply({
        operationId: "node-native-cli-reminder-claim-1",
        intent: {
          kind: "claim_due_reminders",
          work_token: "reminder-due:test",
          limit: 1,
          lease_duration_ms: 60_000,
        },
      });
      await expect(unauthorizedReminderClaim).rejects.toMatchObject({
        coreError: { code: "unauthorized" },
      });
      const administrationStatus = await client.administrationRead({ kind: "status" });
      expect(administrationStatus.value).toEqual({
        kind: "status",
        readiness: "ready",
        schema_version: CORE_CLIENT_REQUIREMENTS.accepted_store_formats[0]?.version,
        schema_owner: "rust",
        integrity: "unknown",
      });
      const backupInput = {
        operationId: "node-administration-backup-1",
        intent: {
          kind: "create_backup" as const,
          label: "Node integration backup",
          include_assets: false,
          trigger: "manual" as const,
        },
      };
      const backupCommitted = await nativeCli.administrationApply(backupInput);
      expect(backupCommitted.outcome.backup_id).toEqual(expect.any(String));
      expect(backupCommitted.receipt.duplicate).toBe(false);
      const backupReplay = await client.administrationApply(backupInput);
      expect(backupReplay.outcome.backup_id).toBe(backupCommitted.outcome.backup_id);
      expect(applyResultCursor(backupReplay)).toBe(applyResultCursor(backupCommitted));
      expect(backupReplay.receipt.duplicate).toBe(true);
      const backups = await client.administrationRead({
        kind: "backups",
        window: { after: null, first: 200 },
      });
      expect(backups.value).toMatchObject({
        kind: "backups",
        backups: {
          items: [
            {
              backup_id: backupCommitted.outcome.backup_id,
              label: "Node integration backup",
              byte_length: expect.any(Number),
            },
          ],
          next_cursor: null,
        },
      });
      const workspaceInput = {
        operationId: "node-workspace-create-1",
        intent: {
          kind: "create_project" as const,
          project_id: "project:node-integration",
          name: "Node workspace",
          description: "Created through the generated client",
          icon: "🧭",
          source_roots: [path.join(nodexHome, "workspace")],
        },
      };
      const workspaceCommitted = await client.workspaceApply(workspaceInput);
      expect(applyResultCursor(workspaceCommitted)).toBeGreaterThan(applyResultCursor(committed));
      expect(workspaceCommitted.receipt.duplicate).toBe(false);
      expect(workspaceCommitted.outcome.affected_project_ids).toEqual(["project:node-integration"]);
      const workspaceReplay = await client.workspaceApply(workspaceInput);
      expect(applyResultCursor(workspaceReplay)).toBe(applyResultCursor(workspaceCommitted));
      expect(workspaceReplay.receipt.duplicate).toBe(true);
      const createdProject = await client.workspaceRead({
        kind: "project",
        project_id: "project:node-integration",
      });
      expect(createdProject.value).toMatchObject({
        kind: "project",
        project: {
          id: "project:node-integration",
          name: "Node workspace",
          primary_workspace_root: path.join(nodexHome, "workspace"),
        },
      });

      const documentRepairs: DocumentLiveRepair[] = [];
      documentSubscription = await client.openDocumentEventStream(
        {
          documentId: "document:node-integration",
          clientSessionId: "session:before-store-restore",
        },
        () => undefined,
        (repair) => documentRepairs.push(repair),
        () => undefined,
      );
      const restoreInput = {
        operationId: "node-administration-restore-1",
        intent: {
          kind: "restore_backup" as const,
          backup_id: backupCommitted.outcome.backup_id!,
          create_safety_backup: true,
        },
      };
      const staleEventStream = subscription.done.catch((error: unknown) => error);
      const staleDocumentEventStream = documentSubscription.done.catch((error: unknown) => error);
      const restored = await client.administrationApply(restoreInput);
      expect(restored.receipt.duplicate).toBe(false);
      expect(restored.outcome.backup_id).toBe(backupCommitted.outcome.backup_id);
      expect(restored.outcome.safety_backup_id).toEqual(expect.any(String));
      expect(applyResultStoreEpoch(restored)).not.toBe(client.handshake.store_epoch);
      await expect(staleEventStream).resolves.toBeInstanceOf(CoreEventCompatibilityError);
      subscription = undefined;
      await expect(staleDocumentEventStream).resolves.toBeUndefined();
      expect(documentRepairs).toEqual([
        expect.objectContaining({
          document_id: "document:node-integration",
          reason: "identity_changed",
          store_epoch: applyResultStoreEpoch(restored),
        }),
      ]);
      documentSubscription = undefined;

      const replacedConnection = readCoreRuntimeConnection(nodexHome);
      expect(replacedConnection.descriptor.store_epoch).toBe(applyResultStoreEpoch(restored));
      expect(replacedConnection.descriptor.readiness_generation).toBe(2);
      const reconnected = await CoreClient.connect({
        nodexHome,
        clientKind: "test",
        buildId: "node-restored-client-test",
        projectId: "project:default",
      });
      expect(reconnected.handshake.store_epoch).toBe(applyResultStoreEpoch(restored));

      await expect(
        client.libraryApply({
          operationId: "node-old-epoch-after-restore",
          intent: {
            kind: "create_page",
            page_id: "page:stale-after-restore",
            document_id: "document:stale-after-restore",
            title: "Stale",
            parent: { kind: "library", before: null },
          },
        }),
      ).rejects.toMatchObject({ coreError: { code: "stale_store_epoch" } });
      await expect(
        client.documentSync({
          documentId: "document:node-integration",
          clientSessionId: "session:before-store-restore",
          stateVector: new Uint8Array(),
        }),
      ).rejects.toMatchObject({ coreError: { code: "unauthorized" } });
      const restoreReplay = await client.administrationApply(restoreInput);
      expect(restoreReplay.receipt.duplicate).toBe(true);
      expect(applyResultStoreEpoch(restoreReplay)).toBe(applyResultStoreEpoch(restored));
      await expect(
        reconnected.workspaceRead({
          kind: "project",
          project_id: "project:node-integration",
        }),
      ).rejects.toMatchObject({ coreError: { code: "not_found" } });
      const postRestoreInput = {
        operationId: "node-post-restore-replay-1",
        intent: {
          kind: "create_page" as const,
          page_id: "page:post-restore-replay",
          document_id: "document:post-restore-replay",
          title: "Post-restore replay",
          parent: { kind: "library" as const, before: null },
        },
      };
      const postRestoreCommitted = await reconnected.libraryApply(postRestoreInput);

      await expect(client.shutdown()).resolves.toEqual({ status: "draining" });
      const exitCodes = await Promise.all(children.map(waitForExit));
      expect(exitCodes).toEqual([0, 0]);
      expect(existsSync(path.join(nodexHome, "run/core/core.sock"))).toBe(false);
      expect(existsSync(path.join(nodexHome, "run/core/core.json"))).toBe(false);
      expect(existsSync(path.join(nodexHome, "run/core/core.auth"))).toBe(false);

      const restartedChild = spawnCore(nodexHome);
      children.push(restartedChild);
      const restartedDescriptor = await readDescriptor(restartedChild);
      expect(restartedDescriptor.start_nonce).not.toBe(descriptors[0]?.start_nonce);
      const restartedClient = await CoreClient.connect({
        nodexHome,
        clientKind: "test",
        buildId: "node-restart-replay-test",
        projectId: "project:default",
      });
      let resolveReplayedEvent: ((event: CoreEventEnvelope) => void) | undefined;
      const replayedEvent = new Promise<CoreEventEnvelope>((resolve) => {
        resolveReplayedEvent = resolve;
      });
      restartedSubscription = await restartedClient.openEventStream(
        applyResultCursor(postRestoreCommitted) - 1,
        (candidate) => {
          if (candidate.packet.manifest.operation_id !== postRestoreInput.operationId) return;
          resolveReplayedEvent?.(candidate);
        },
        () => undefined,
      );
      const replayed = await withTimeout(
        replayedEvent,
        "Core did not replay a durable event after restart",
      );
      expect(replayed).toMatchObject({
        packet: {
          manifest: {
            identity: { commit_seq: applyResultCursor(postRestoreCommitted) },
            operation_id: postRestoreInput.operationId,
          },
        },
      });
      expect(replayed.packet.atoms.map((atom) => atom.payload)).toContainEqual(
        expect.objectContaining({
          module: "library",
          event: expect.objectContaining({ kind: "library_changed" }),
        }),
      );
      expect(event.packet.manifest.event_version).toBe(CORE_CLIENT_REQUIREMENTS.event_version);
      expect(replayed.packet.manifest.event_version).toBe(CORE_CLIENT_REQUIREMENTS.event_version);
      expect(replayed.packet.projection_effects.length).toBeGreaterThan(0);
      restartedSubscription.close();
      await restartedSubscription.done;
      restartedSubscription = undefined;
      await expect(restartedClient.shutdown()).resolves.toEqual({ status: "draining" });
      await expect(waitForExit(restartedChild)).resolves.toBe(0);
      expect(existsSync(path.join(nodexHome, "run/core/core.sock"))).toBe(false);
      expect(existsSync(path.join(nodexHome, "run/core/core.json"))).toBe(false);
      expect(existsSync(path.join(nodexHome, "run/core/core.auth"))).toBe(false);
    } finally {
      restartedSubscription?.close();
      documentSubscription?.close();
      subscription?.close();
      for (const child of children) {
        if (child.exitCode === null) child.kill();
      }
      await Promise.all(children.map((child) => waitForExit(child).catch(() => null)));
      rmSync(nodexHome, { recursive: true, force: true });
    }
  });
});
