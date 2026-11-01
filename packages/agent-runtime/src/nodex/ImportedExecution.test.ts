import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EventId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderSessionId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as StoreCoordinate from "./StoreCoordinate.ts";
import { consume } from "./ImportedExecution.ts";

const stores = Layer.mergeAll(ProjectionStore.layer, EventStore.layer, EffectOutbox.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const sink = EventSink.layer.pipe(Layer.provideMerge(stores));
const layer = ProjectionMaintenance.layer.pipe(
  Layer.provideMerge(sink),
  Layer.provideMerge(NodeServices.layer),
);

it.live(
  "relocates schema-owned paths, detaches native state through events, and survives replay and commit-before-removal reruns",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const events = yield* EventSink.EventSinkV2;
      const projection = yield* ProjectionStore.ProjectionStoreV2;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-execution-import-" });
      const runtimeHome = path.join(home, "agent-runtime");
      yield* fs.makeDirectory(runtimeHome);
      const source = "/source/profile";
      const marker = JSON.stringify({
        version: 1,
        sourceProfileHome: source,
        importedAt: "2026-11-01T00:00:00.123456789+00:00",
      });
      const markerPath = path.join(runtimeHome, "imported-execution.json");
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:import");
      const providerId = ProviderInstanceId.make("codex");
      const driver = ProviderDriverKind.make("codex");
      const nativeThreadId = ProviderThreadId.make("provider:import");
      const nativeSessionId = ProviderSessionId.make("session:import");
      const location = {
        hostId: "local",
        cwd: `${source}/tasks/work`,
        workspaceRoots: [`${source}/tasks`, "/external/repo"],
        managedWorktreePath: `${source}/tasks/work`,
        projectId: null,
        projectlessOutputDirectory: source,
        projectlessWorkspaceBrowserRoot: "/source/profile-other/tasks",
      };
      const thread: OrchestrationV2AppThread = {
        id: threadId,
        projectId: ProjectId.make("project"),
        title: "Imported",
        providerInstanceId: providerId,
        modelSelection: { instanceId: providerId, model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: `${source}/tasks/work`,
        executionLocation: location,
        executionHandoff: {
          operationId: "workspace-op",
          recoveryRequired: true,
          sourceLocation: location,
        },
        activeProviderThreadId: nativeThreadId,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
        createdBy: "user",
        creationSource: "web",
      };
      const provider: OrchestrationV2ProviderThread = {
        id: nativeThreadId,
        driver,
        providerInstanceId: providerId,
        providerSessionId: nativeSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "native-id-unchanged-in-history", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        contextUsage: null,
        goal: null,
        createdAt: now,
        updatedAt: now,
      };
      yield* events.write({
        events: [
          {
            id: EventId.make("create"),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: thread,
          },
          {
            id: EventId.make("native-session"),
            type: "provider-session.attached",
            threadId,
            occurredAt: now,
            payload: {
              id: nativeSessionId,
              driver,
              providerInstanceId: providerId,
              status: "ready",
              cwd: `${source}/tasks/work`,
              model: null,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
          },
          {
            id: EventId.make("native-thread"),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: provider,
          },
          {
            id: EventId.make("native-child"),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: {
              ...provider,
              id: ProviderThreadId.make("provider:child"),
              appThreadId: null,
              nativeThreadRef: { driver, nativeId: "native-child", strength: "strong" },
            },
          },
          {
            id: EventId.make("closed-native-thread"),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: {
              ...provider,
              id: ProviderThreadId.make("provider:closed"),
              status: "closed",
              nativeThreadRef: { driver, nativeId: "closed-native", strength: "strong" },
            },
          },
          {
            id: EventId.make("message"),
            type: "message.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: MessageId.make("message"),
              threadId,
              runId: null,
              nodeId: null,
              role: "user",
              text: `${source}/do-not-change`,
              attachments: [],
              streaming: false,
              createdBy: "user",
              creationSource: "web",
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
      // Storage fixtures cover the legacy/schema columns that remain available for lazy history import.
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at,favicon_path)
      VALUES ('project','Project','/external/repo','[]','now','now',${source + "/icon.png"})`;
      yield* StoreCoordinate.record("profile:epoch:old");
      yield* fs.writeFileString(markerPath, marker);
      yield* consume(runtimeHome);
      expect(yield* fs.exists(markerPath)).toBe(false);
      expect(yield* StoreCoordinate.read).toEqual({ coordinate: null });
      const read = yield* projection.getThreadRecords(threadId, [
        "providerThreads",
        "providerSessions",
        "messages",
      ]);
      expect(read.thread.worktreePath).toBe(`${home}/tasks/work`);
      expect(read.thread.executionLocation).toEqual({
        ...location,
        cwd: `${home}/tasks/work`,
        workspaceRoots: [`${home}/tasks`, "/external/repo"],
        managedWorktreePath: `${home}/tasks/work`,
        projectlessOutputDirectory: home,
      });
      expect(read.thread.executionHandoff?.sourceLocation).toEqual(read.thread.executionLocation);
      expect(read.providerThreads[0]).toMatchObject({
        nativeThreadRef: null,
        providerSessionId: null,
        contextHandoffRequired: true,
        contextUsage: null,
      });
      expect(read.providerSessions).toHaveLength(0);
      expect(read.providerThreads.find((thread) => thread.id === "provider:closed")).toMatchObject({
        status: "closed",
        nativeThreadRef: null,
        contextHandoffRequired: true,
      });
      expect(
        yield* sql`SELECT json_extract(payload_json, '$.nativeThreadRef') AS native_ref FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = 'provider:child'`,
      ).toEqual([{ native_ref: null }]);
      expect(read.messages[0]?.text).toBe(`${source}/do-not-change`);
      expect(yield* sql`SELECT workspace_root, favicon_path FROM projection_projects`).toEqual([
        { workspace_root: "/external/repo", favicon_path: `${home}/icon.png` },
      ]);
      const [historicalNative] = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_events WHERE event_id = 'native-thread'`;
      expect(JSON.parse(historicalNative!.payload_json).nativeThreadRef.nativeId).toBe(
        "native-id-unchanged-in-history",
      );
      const [before] = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM orchestration_events`;
      // Model a crash after commit but before marker unlink, even after another host recorded its coordinate.
      yield* StoreCoordinate.record("profile:epoch:new");
      yield* fs.writeFileString(markerPath, marker);
      yield* consume(runtimeHome);
      expect(yield* StoreCoordinate.read).toEqual({ coordinate: "profile:epoch:new" });
      expect(yield* sql`SELECT count(*) AS count FROM orchestration_events`).toEqual([before]);
      yield* events.write({
        events: [
          {
            id: EventId.make("late-native-thread"),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: { ...provider, id: ProviderThreadId.make("provider:closed"), status: "idle" },
          },
        ],
      });
      expect((yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild).valid).toBe(
        true,
      );
      const replayed = yield* projection.getThreadRecords(threadId, [
        "providerThreads",
        "providerSessions",
        "messages",
      ]);
      expect(replayed.thread.executionLocation).toEqual(read.thread.executionLocation);
      expect(replayed.providerThreads).toEqual(read.providerThreads);
      expect(replayed.providerSessions).toHaveLength(0);
      expect(replayed.messages).toEqual(read.messages);
    }).pipe(Effect.provide(layer)),
);
