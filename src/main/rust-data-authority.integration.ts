import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { DynamicToolCallResponse } from "@nodex/codex-app-server-protocol/v2/DynamicToolCallResponse";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Y from "yjs";

import { initializeStandaloneDataAuthority } from "./core-client/standalone-data-authority";
import type { RustDataAuthorityRuntime } from "./core-client/desktop-data-authority";
import {
  createCoreCanvasSceneAdapter,
  mapCanvasLiveEnvelope,
} from "./core-client/core-canvas-scene-adapter";
import { createCoreLibraryModuleAdapter } from "./core-client/library-module-adapter";
import {
  createCoreDatabaseModuleAdapter,
  createCoreLibraryDatabaseModuleAdapter,
} from "./core-client/database-module-adapter";
import { createCoreDocumentSyncAdapter } from "./core-client/document-sync-adapter";
import { makeDesktopDocumentSessionHarness } from "./core-client/testing/desktop-document-session-harness.test-support";
import { createCoreBlockTransferAdapter } from "./core-client/block-transfer-adapter";
import type { CoreEventEnvelope } from "./core-client/types";
import { NodexYProvider } from "../renderer/lib/nodex-y-provider";
import { parseDataSourcePropertyId } from "../shared/database-identities";
import { NODEX_APP_TOOL_NAMESPACE, NODEX_APP_TOOLSET_REVISION } from "../shared/nodex-agent-tools";
import { CreatePagesV6OutputSchema } from "../shared/nodex-agent-tools/v6-schemas";
import { primaryCanvasDocumentId, type CanvasSceneRealtimeEvent } from "../shared/block-documents";
import {
  CoreAuthority,
  CoreSessionAccess,
  type CoreAuthorityState,
} from "./core-runtime/CoreAuthority";
import { CoreModules, live as coreModulesLive } from "./core-runtime/CoreModules";
import { classifyCoreOperationFailure } from "./core-runtime/CoreRuntimeError";
import {
  AutomationRoutingIndex,
  live as automationRoutingIndexLive,
} from "./core-runtime/AutomationRoutingIndex";
import {
  AutomationApplication,
  make as makeAutomationApplication,
} from "./automation-application/AutomationApplication";
import {
  make as makeProjectWorkspace,
  ProjectWorkspace,
} from "./project-application/ProjectWorkspace";
import { DatabaseModule, live as databaseModuleLive } from "./database-application/DatabaseModule";
import {
  NodexAgentApplication,
  live as nodexAgentApplicationLive,
} from "./nodex-agent-application/NodexAgentApplication";
import {
  NodexAgentDynamicTools,
  live as nodexAgentDynamicToolsLive,
} from "./nodex-agent-application/NodexAgentDynamicTools";
import {
  NodexAgentResourceAccess,
  live as nodexAgentResourceAccessLive,
} from "./nodex-agent-application/NodexAgentResourceAccess";
import {
  CodexConversationContext,
  make as makeCodexConversationContext,
} from "./codex-application/CodexConversationContext";
import {
  CodexTurnAuthority,
  make as makeCodexTurnAuthority,
} from "./codex-application/CodexTurnAuthority";
import {
  ConversationEntityMap,
  live as conversationEntityMapLive,
} from "./codex-application/internal/ConversationEntityMap";

const CORE_BINARY = path.resolve("target/debug/nodex-core");
const temporaryDirectories: string[] = [];

const withFinalDataApplications = <A, E>(
  runtime: RustDataAuthorityRuntime,
  use: (services: {
    readonly automation: AutomationApplication["Service"];
    readonly database: DatabaseModule["Service"];
    readonly dynamicTools: NodexAgentDynamicTools["Service"];
    readonly resourceAccess: NodexAgentResourceAccess["Service"];
    readonly turnAuthority: CodexTurnAuthority["Service"];
    readonly workspace: ProjectWorkspace["Service"];
  }) => Effect.Effect<A, E>,
): Promise<A> => {
  const access = CoreSessionAccess.of({
    handshake: Effect.succeed(runtime.rootClient.handshake),
    use: (operationName, operation, options) =>
      Effect.tryPromise({
        try: (signal) =>
          operation(
            options?.projectId ? runtime.clientForProject(options.projectId) : runtime.rootClient,
            signal,
          ),
        catch: (cause) =>
          classifyCoreOperationFailure(
            operationName,
            cause,
            runtime.rootClient.handshake.generation.start_nonce,
          ),
      }),
  });
  const accessLayer = Layer.succeed(CoreSessionAccess, access);
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const state = yield* SubscriptionRef.make<CoreAuthorityState>({
          kind: "ready" as const,
          generation: runtime.rootClient.handshake.generation.start_nonce,
        });
        const authority = CoreAuthority.of({
          identity: runtime.identity,
          initialLaunch: {
            executablePath: runtime.launch.executablePath,
            startedProcessId: runtime.launch.startedProcessId,
            timings: runtime.launch.timings,
          },
          state,
          retry: Effect.void,
          requestRelaunch: Effect.void,
          failApplication: () => Effect.succeed(true),
        });
        const authorityLayer = Layer.succeed(CoreAuthority, authority);
        const coreContext = yield* Layer.build(coreModulesLive.pipe(Layer.provide(accessLayer)));
        const core = Context.get(coreContext, CoreModules);
        const routingContext = yield* Layer.build(
          automationRoutingIndexLive.pipe(Layer.provide(Layer.succeed(CoreModules, core))),
        );
        const automation = yield* makeAutomationApplication.pipe(
          Effect.provideService(CoreModules, core),
          Effect.provideService(
            AutomationRoutingIndex,
            Context.get(routingContext, AutomationRoutingIndex),
          ),
        );
        const workspace = yield* makeProjectWorkspace.pipe(
          Effect.provideService(CoreModules, core),
        );
        const conversationRuntimeContext = yield* Layer.build(conversationEntityMapLive);
        const conversationContext = yield* makeCodexConversationContext.pipe(
          Effect.provideService(
            ConversationEntityMap,
            Context.get(conversationRuntimeContext, ConversationEntityMap),
          ),
          Effect.provideService(CoreModules, core),
        );
        const turnAuthority = yield* makeCodexTurnAuthority.pipe(
          Effect.provideService(CodexConversationContext, conversationContext),
          Effect.provideService(CoreAuthority, authority),
          Effect.provideService(CoreModules, core),
        );
        const databaseContext = yield* Layer.build(
          databaseModuleLive.pipe(Layer.provide(Layer.merge(authorityLayer, accessLayer))),
        );
        const database = Context.get(databaseContext, DatabaseModule);
        const agentContext = yield* Layer.build(
          nodexAgentApplicationLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                authorityLayer,
                accessLayer,
                Layer.succeed(CoreModules, core),
                Layer.succeed(DatabaseModule, database),
              ),
            ),
          ),
        );
        const agent = Context.get(agentContext, NodexAgentApplication);
        const resourceAccessContext = yield* Layer.build(
          nodexAgentResourceAccessLive.pipe(
            Layer.provide(Layer.merge(authorityLayer, Layer.succeed(CoreModules, core))),
          ),
        );
        const dynamicToolsContext = yield* Layer.build(
          nodexAgentDynamicToolsLive.pipe(
            Layer.provide(Layer.succeed(NodexAgentApplication, agent)),
          ),
        );
        return yield* use({
          automation,
          database,
          dynamicTools: Context.get(dynamicToolsContext, NodexAgentDynamicTools),
          resourceAccess: Context.get(resourceAccessContext, NodexAgentResourceAccess),
          turnAuthority,
          workspace,
        });
      }),
    ),
  );
};

const parseDynamicToolOutput = (response: DynamicToolCallResponse): unknown => {
  if (!response.success) {
    throw new Error(`Nodex dynamic tool failed: ${JSON.stringify(response.contentItems)}`);
  }
  const item = response.contentItems[0];
  if (item?.type !== "inputText") {
    throw new Error("Nodex dynamic tool returned no JSON output");
  }
  return JSON.parse(item.text) as unknown;
};

const waitUntil = async (predicate: () => boolean, message: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
};

const listCurrentProcessFiles = (): string => {
  if (process.platform !== "darwin") return "";
  return execFileSync("/usr/sbin/lsof", ["-a", "-p", String(process.pid), "-Fn"], {
    encoding: "utf8",
  });
};

afterEach(() => {
  delete process.env.NODEX_CORE_EXECUTABLE;
  delete process.env.NODEX_HOME;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Electron native data authority", () => {
  test("starts Core without opening the Profile database in Electron", async () => {
    expect(process.versions.electron).toBeTruthy();
    expect(existsSync(CORE_BINARY), "build nodex-core before this test").toBe(true);
    const nodexHome = mkdtempSync(path.join(tmpdir(), "nodex-rust-authority-"));
    temporaryDirectories.push(nodexHome);
    process.env.NODEX_CORE_EXECUTABLE = CORE_BINARY;
    process.env.NODEX_HOME = nodexHome;
    let runtime: RustDataAuthorityRuntime | null = null;

    try {
      const selected = await initializeStandaloneDataAuthority({
        buildId: "electron-authority-integration-test",
        isPackaged: false,
        nodexHome,
      });
      expect(selected.backend).toBe("rust");
      if (selected.backend !== "rust") throw new Error("Expected Rust authority");
      const authorityRuntime = selected;
      runtime = authorityRuntime;

      const databasePath = path.join(nodexHome, "nodex.db");
      expect(existsSync(databasePath)).toBe(true);
      expect(listCurrentProcessFiles()).not.toContain(databasePath);

      const projectId = await withFinalDataApplications(runtime, ({ workspace }) =>
        Effect.gen(function* () {
          expect(yield* workspace.readProjectBootstrap).toEqual({ status: "empty" });
          const initialProject = yield* workspace.createInitialProject({
            operationId: randomUUID(),
            projectId: randomUUID(),
            name: "Electron authority",
            description: "",
            sources: [nodexHome],
            starterPage: {
              pageId: randomUUID(),
              documentId: randomUUID(),
              titleMarkdown: "Welcome to Nodex",
              nfm: "Welcome to Nodex.",
            },
          });
          expect(yield* workspace.listProjects).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: initialProject.project.id })]),
          );
          return initialProject.project.id;
        }),
      );
      expect(listCurrentProcessFiles()).not.toContain(databasePath);
      const database = createCoreDatabaseModuleAdapter({
        client: runtime.clientForProject(projectId),
        projectId,
        libraryId: runtime.rootClient.handshake.library_id,
        storeEpoch: runtime.rootClient.handshake.store_epoch,
      });
      const databaseCatalog = await database.read({
        projectId,
        read: { target: { kind: "project_default" }, mode: "database" },
      });
      expect(databaseCatalog).toMatchObject({
        ok: true,
        value: {
          projectId,
          libraryId: runtime.rootClient.handshake.library_id,
          value: { kind: "database" },
        },
      });
      if (!databaseCatalog.ok || databaseCatalog.value.value.kind !== "database") {
        throw new Error("Expected Core Database descriptor");
      }
      const primaryDatabase = databaseCatalog.value.value.value;
      const primaryDataSource = primaryDatabase?.dataSources[0];
      const primaryView = primaryDatabase?.views.find(
        (view) => view.dataSourceId === primaryDataSource?.dataSourceId,
      );
      if (!primaryDatabase || !primaryDataSource || !primaryView) {
        throw new Error("Core Database catalog omitted its primary authority");
      }
      const nativePropertyId = parseDataSourcePropertyId("p_rustcore");
      const databaseWrite = {
        operationId: "electron-database-adapter-put-property",
        projectId,
        storeEpoch: runtime.rootClient.handshake.store_epoch,
        actor: {
          kind: "electron_renderer",
          clientId: "renderer:electron-database-adapter",
        },
        operations: [
          {
            kind: "put_property",
            dataSourceId: primaryDataSource.dataSourceId,
            propertyId: nativePropertyId,
            expectedDataSourceRevision: primaryDataSource.schemaRevision,
            expectedPropertyRevision: 0,
            name: "Native Core",
            schema: { kind: "text" },
          },
        ],
      } as const;
      const databaseEvents: CoreEventEnvelope[] = [];
      const databaseEventSubscription = await runtime.rootClient.openEventStream(
        runtime.rootClient.handshake.commit_head,
        (event) => databaseEvents.push(event),
        () => undefined,
      );
      const databaseWriteResult = await database.apply(databaseWrite);
      expect(databaseWriteResult).toMatchObject({
        ok: true,
        value: {
          operationId: databaseWrite.operationId,
          duplicate: false,
          operationKinds: ["put_property"],
          affectedDataSourceIds: [primaryDataSource.dataSourceId],
          committedRevisions: {
            [`property:${primaryDataSource.dataSourceId}:${nativePropertyId}`]: 1,
          },
        },
      });
      await waitUntil(
        () =>
          databaseEvents.some(
            (event) => event.packet.manifest.operation_id === databaseWrite.operationId,
          ),
        "Core Database event was not published",
      );
      expect(
        databaseEvents.find(
          (event) => event.packet.manifest.operation_id === databaseWrite.operationId,
        ),
      ).toMatchObject({
        packet: {
          atoms: expect.arrayContaining([
            expect.objectContaining({
              descriptor: expect.objectContaining({
                kind: "database_changed",
              }),
              payload: expect.objectContaining({
                module: "database",
                event: expect.objectContaining({ project_id: projectId }),
              }),
            }),
          ]),
        },
      });
      await expect(database.apply(databaseWrite)).resolves.toMatchObject({
        ok: true,
        value: {
          operationId: databaseWrite.operationId,
          duplicate: true,
          operationKinds: ["put_property"],
        },
      });
      const updatedDataSource = await database.read({
        projectId,
        read: {
          target: {
            kind: "data_source",
            dataSourceId: primaryDataSource.dataSourceId,
          },
          mode: "data_source",
        },
      });
      if (!updatedDataSource.ok || updatedDataSource.value.value.kind !== "data_source") {
        throw new Error("Expected updated Core Data Source descriptor");
      }
      expect(updatedDataSource.value.value.value.properties).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            propertyId: nativePropertyId,
            name: "Native Core",
            revision: 1,
          }),
        ]),
      );
      const libraryDatabase = createCoreLibraryDatabaseModuleAdapter({
        client: runtime.rootClient,
        libraryId: runtime.rootClient.handshake.library_id,
        storeEpoch: runtime.rootClient.handshake.store_epoch,
      });
      const libraryDataSource = await libraryDatabase.read({
        read: {
          target: {
            kind: "data_source",
            dataSourceId: primaryDataSource.dataSourceId,
          },
          mode: "data_source",
        },
      });
      if (!libraryDataSource.ok || libraryDataSource.value.value.kind !== "data_source") {
        throw new Error("Expected trusted Library Database read");
      }
      expect("projectId" in libraryDataSource.value).toBe(false);
      const libraryPropertyId = parseDataSourcePropertyId("p_libcore1");
      const libraryDatabaseWrite = await libraryDatabase.apply({
        operationId: "electron-library-database-put-property",
        storeEpoch: runtime.rootClient.handshake.store_epoch,
        operations: [
          {
            kind: "put_property",
            dataSourceId: primaryDataSource.dataSourceId,
            propertyId: libraryPropertyId,
            expectedDataSourceRevision:
              libraryDataSource.value.value.value.dataSource.schemaRevision,
            expectedPropertyRevision: 0,
            name: "Library Core",
            schema: { kind: "text" },
          },
        ],
      });
      expect(libraryDatabaseWrite).toMatchObject({
        ok: true,
        value: {
          accessContext: { kind: "library" },
          libraryId: runtime.rootClient.handshake.library_id,
          operationId: "electron-library-database-put-property",
          operationKinds: ["put_property"],
        },
      });
      if (!libraryDatabaseWrite.ok) {
        throw new Error("Expected trusted Library Database write");
      }
      expect("projectId" in libraryDatabaseWrite.value).toBe(false);
      await waitUntil(
        () =>
          databaseEvents.some(
            (event) =>
              event.packet.manifest.operation_id === "electron-library-database-put-property",
          ),
        "Core Library Database event was not published",
      );
      expect(
        databaseEvents.find(
          (event) =>
            event.packet.manifest.operation_id === "electron-library-database-put-property",
        ),
      ).toMatchObject({
        packet: {
          atoms: expect.arrayContaining([
            expect.objectContaining({
              descriptor: expect.objectContaining({
                kind: "database_changed",
              }),
              payload: expect.objectContaining({
                module: "database",
                event: expect.objectContaining({ project_id: null }),
              }),
            }),
          ]),
        },
      });
      const projectDocuments = createCoreDocumentSyncAdapter(runtime.clientForProject(projectId));
      const nativeSourceBlockId = "01981e00-0000-7000-8000-000000000001";
      const nativeSourceDocumentId = "01981e00-0000-7000-8000-000000000002";
      const nativeContentBlockId = "01981e00-0000-7000-8000-000000000003";
      const nativeEmptyBlockId = "01981e00-0000-7000-8000-000000000004";
      const createSyncedSource = {
        operationId: "electron-document-create-synced-source",
        projectId,
        storeEpoch: runtime.rootClient.handshake.store_epoch,
        clientSessionId: "renderer:electron-document-owner",
        actor: {
          kind: "electron_renderer",
          clientId: "renderer:electron-document-owner",
        },
        coordination: { kind: "fifo_only" as const },
        operation: {
          kind: "create_synced_source" as const,
          sourceBlockId: nativeSourceBlockId,
          documentId: nativeSourceDocumentId,
          initialBlocks: [
            {
              id: nativeContentBlockId,
              type: "paragraph",
              props: {},
              content: [
                {
                  type: "text",
                  text: "Native Additional Document command",
                  styles: {},
                },
              ],
              children: [],
            },
            {
              id: nativeEmptyBlockId,
              type: "paragraph",
              props: {},
              content: [],
              children: [],
            },
          ],
          placement: { kind: "library" as const },
        },
      };
      const createdSyncedSource =
        await projectDocuments.applyAdditionalDocumentCommand(createSyncedSource);
      if (!createdSyncedSource.ok) {
        throw new Error(
          `Core Additional Document command failed: ${createdSyncedSource.error.code}: ${createdSyncedSource.error.message}`,
        );
      }
      expect(createdSyncedSource).toMatchObject({
        ok: true,
        value: {
          operationId: createSyncedSource.operationId,
          projectId,
          duplicate: false,
          effect: {
            createdBlockIds: expect.arrayContaining([nativeSourceBlockId, nativeContentBlockId]),
            documentHeads: [
              {
                documentId: nativeSourceDocumentId,
                generation: 1,
                headSeq: 1,
              },
            ],
          },
        },
      });
      await expect(
        projectDocuments.readDescriptor({
          ownerBlockId: nativeSourceBlockId,
          clientSessionId: "electron:owned-document:descriptor",
        }),
      ).resolves.toMatchObject({
        documentId: nativeSourceDocumentId,
        generation: 1,
        headSeq: 1,
      });
      await expect(
        projectDocuments.applyAdditionalDocumentCommand(createSyncedSource),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          operationId: createSyncedSource.operationId,
          duplicate: true,
        },
      });
      const checkpointRequest = {
        projectId,
        storeEpoch: runtime.rootClient.handshake.store_epoch,
        documentId: nativeSourceDocumentId,
        expectedGeneration: 1,
        expectedHeadSeq: 1,
        cause: "manual",
        label: "Native history checkpoint",
        actor: {
          kind: "electron_renderer",
          clientId: "renderer:electron-document-owner",
        },
        revisionKind: "manual" as const,
      };
      const checkpoint = await projectDocuments.createCheckpoint(checkpointRequest);
      if (!checkpoint.ok) {
        throw new Error(
          `Core Document checkpoint failed: ${checkpoint.error.code}: ${checkpoint.error.message}`,
        );
      }
      expect(checkpoint).toMatchObject({
        ok: true,
        value: {
          duplicate: false,
          checkpoint: {
            projectId,
            documentId: nativeSourceDocumentId,
            generation: 1,
            baseHeadSeq: 1,
            actor: checkpointRequest.actor,
            revisionKind: "manual",
            materializationKind: "synced_block",
          },
        },
      });
      await expect(projectDocuments.createCheckpoint(checkpointRequest)).resolves.toMatchObject({
        ok: true,
        value: { duplicate: true },
      });
      const listedVersions = await projectDocuments.listVersions({
        projectId,
        documentId: nativeSourceDocumentId,
        limit: 20,
      });
      expect(listedVersions).toMatchObject({
        ok: true,
        value: [{ versionId: checkpoint.value.checkpoint.versionId }],
      });
      const versionDetail = await projectDocuments.getVersion({
        projectId,
        documentId: nativeSourceDocumentId,
        versionId: checkpoint.value.checkpoint.versionId,
      });
      expect(versionDetail).toMatchObject({
        ok: true,
        value: {
          summary: { versionId: checkpoint.value.checkpoint.versionId },
          materialization: {
            kind: "synced_block",
            preview: "Native Additional Document command",
          },
        },
      });
      if (!versionDetail.ok || versionDetail.value.materialization.kind !== "synced_block") {
        throw new Error("Expected native Synced Block version detail");
      }
      const changeRequest = {
        mutationId: "electron-document-history-change",
        projectId,
        storeEpoch: runtime.rootClient.handshake.store_epoch,
        documentId: nativeSourceDocumentId,
        generation: 1,
        expectedHeadSeq: 1,
        clientSessionId: "renderer:electron-document-history",
        actor: {
          kind: "electron_renderer",
          clientId: "renderer:electron-document-history",
        },
        operations: [
          {
            kind: "delete_block" as const,
            blockId: nativeContentBlockId,
          },
        ],
      };
      const changed = await projectDocuments.applyDocumentMutation(changeRequest);
      expect(changed).toMatchObject({
        ok: true,
        value: {
          mutationId: changeRequest.mutationId,
          headSeq: 2,
          deletedBlockIds: [nativeContentBlockId],
          coordination: "write_fence",
        },
      });
      const restoreRequest = {
        mutationId: "electron-document-history-restore",
        projectId,
        storeEpoch: runtime.rootClient.handshake.store_epoch,
        documentId: nativeSourceDocumentId,
        versionId: checkpoint.value.checkpoint.versionId,
        generation: 1,
        expectedHeadSeq: 2,
        clientSessionId: "renderer:electron-document-history",
        actor: {
          kind: "electron_renderer",
          clientId: "renderer:electron-document-history",
        },
      };
      const restored = await projectDocuments.restoreVersion(restoreRequest);
      if (!restored.ok) {
        throw new Error(
          `Core Document restore failed: ${restored.error.code}: ${restored.error.message}`,
        );
      }
      expect(restored).toMatchObject({
        ok: true,
        value: {
          mutationId: restoreRequest.mutationId,
          projectId,
          documentId: nativeSourceDocumentId,
          baseHeadSeq: 2,
          headSeq: 3,
          coordination: "write_fence",
          duplicate: false,
        },
      });
      await expect(projectDocuments.restoreVersion(restoreRequest)).resolves.toMatchObject({
        ok: true,
        value: {
          mutationId: restoreRequest.mutationId,
          headSeq: 3,
          duplicate: true,
        },
      });
      const restoredVersions = await projectDocuments.listVersions({
        projectId,
        documentId: nativeSourceDocumentId,
        limit: 20,
      });
      if (!restoredVersions.ok) {
        throw new Error(`Core restored history list failed: ${restoredVersions.error.message}`);
      }
      expect(restoredVersions.value).toHaveLength(4);
      expect(restoredVersions.value).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            baseHeadSeq: 2,
            revisionKind: "operation",
            sourceMutationId: changeRequest.mutationId,
          }),
        ]),
      );
      const restoredVersion = restoredVersions.value.find(
        (version) =>
          version.baseHeadSeq === 3 &&
          version.revisionKind === "restore" &&
          version.sourceMutationId === restoreRequest.mutationId,
      );
      if (!restoredVersion) {
        throw new Error("Core history omitted the post-restore checkpoint");
      }
      await expect(
        projectDocuments.getVersion({
          projectId,
          documentId: nativeSourceDocumentId,
          versionId: restoredVersion.versionId,
        }),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          summary: {
            versionId: restoredVersion.versionId,
            sourceMutationId: restoreRequest.mutationId,
          },
          materialization: {
            kind: "synced_block",
            preview: "Native Additional Document command",
          },
        },
      });
      const nativeTargetSourceBlockId = "01981e00-0000-7000-8000-000000000005";
      const nativeTargetDocumentId = "01981e00-0000-7000-8000-000000000006";
      const nativeTargetAnchorBlockId = "01981e00-0000-7000-8000-000000000007";
      const createdTransferTarget = await projectDocuments.applyAdditionalDocumentCommand({
        operationId: "electron-block-transfer-create-target",
        projectId,
        storeEpoch: runtime.rootClient.handshake.store_epoch,
        clientSessionId: "renderer:electron-block-transfer",
        actor: {
          kind: "electron_renderer",
          clientId: "renderer:electron-block-transfer",
        },
        coordination: { kind: "fifo_only" },
        operation: {
          kind: "create_synced_source",
          sourceBlockId: nativeTargetSourceBlockId,
          documentId: nativeTargetDocumentId,
          initialBlocks: [
            {
              id: nativeTargetAnchorBlockId,
              type: "paragraph",
              props: {},
              content: [],
              children: [],
            },
          ],
          placement: { kind: "library" },
        },
      });
      if (!createdTransferTarget.ok) {
        throw new Error(
          `Core Block transfer target creation failed: ${createdTransferTarget.error.message}`,
        );
      }
      const transferAdapter = createCoreBlockTransferAdapter({
        client: runtime.clientForProject(projectId),
        libraryId: runtime.rootClient.handshake.library_id,
        projectId,
        storeEpoch: runtime.rootClient.handshake.store_epoch,
      });
      const transferIntent = {
        operationId: "electron-native-block-transfer",
        projectId,
        storeEpoch: runtime.rootClient.handshake.store_epoch,
        clientSessionId: "renderer:electron-block-transfer",
        actor: {
          kind: "electron_renderer",
          clientId: "renderer:electron-block-transfer",
        },
        mode: "move" as const,
        rootBlockIds: [nativeContentBlockId],
        causalDependencies: [],
        source: {
          kind: "document" as const,
          documentId: nativeSourceDocumentId,
        },
        target: {
          kind: "document" as const,
          documentId: nativeTargetDocumentId,
          beforeBlockId: nativeTargetAnchorBlockId,
        },
        promotionPolicy: "literal" as const,
      };
      const transferred = await transferAdapter.commit(transferIntent);
      if (!transferred.ok) {
        throw new Error(
          `Core Block transfer failed: ${transferred.error.code}: ${transferred.error.message}`,
        );
      }
      expect(transferred.value).toMatchObject({
        operationId: transferIntent.operationId,
        duplicate: false,
        resultRootBlockIds: [nativeContentBlockId],
        finalLocations: {
          [nativeContentBlockId]: {
            kind: "document",
            documentId: nativeTargetDocumentId,
          },
        },
        // Delete, snapshot reattachment, and this transfer each advance the
        // canonical placement revision after its genesis revision.
        finalLocationRevisions: { [nativeContentBlockId]: 4 },
        documentCommits: expect.arrayContaining([
          expect.objectContaining({
            documentId: nativeSourceDocumentId,
            baseHeadSeq: 3,
            headSeq: 4,
          }),
          expect.objectContaining({
            documentId: nativeTargetDocumentId,
            baseHeadSeq: 1,
            headSeq: 2,
          }),
        ]),
      });
      await expect(transferAdapter.commit(transferIntent)).resolves.toMatchObject({
        ok: true,
        value: {
          operationId: transferIntent.operationId,
          duplicate: true,
          finalLocationRevisions: { [nativeContentBlockId]: 4 },
        },
      });
      const promoteToLibraryIntent = {
        ...transferIntent,
        operationId: "electron-native-block-transfer-promote-to-library",
        source: {
          kind: "document" as const,
          documentId: nativeTargetDocumentId,
        },
        target: {
          kind: "library" as const,
          libraryId: runtime.rootClient.handshake.library_id,
        },
      };
      const promotedToLibrary = await transferAdapter.commit(promoteToLibraryIntent);
      if (!promotedToLibrary.ok) {
        throw new Error(
          `Core Library promotion failed: ${promotedToLibrary.error.code}: ${promotedToLibrary.error.message}`,
        );
      }
      expect(promotedToLibrary.value).toMatchObject({
        operationId: promoteToLibraryIntent.operationId,
        duplicate: false,
        resultRootBlockIds: [nativeContentBlockId],
        transformationEvidence: [
          {
            sourceBlockId: nativeContentBlockId,
            resultPageId: nativeContentBlockId,
            kind: "promote",
            sourceBlockType: "paragraph",
            consumedPropertyKeys: [],
            bodyRootBlockIds: [expect.any(String)],
            sourceToResultBlockIds: {
              [nativeContentBlockId]: nativeContentBlockId,
            },
          },
        ],
        finalLocations: {
          [nativeContentBlockId]: {
            kind: "library",
            libraryId: runtime.rootClient.handshake.library_id,
            rankKey: expect.any(String),
          },
        },
        finalLocationRevisions: { [nativeContentBlockId]: 5 },
        documentCommits: expect.arrayContaining([
          expect.objectContaining({
            documentId: nativeTargetDocumentId,
            baseHeadSeq: 2,
            headSeq: 3,
          }),
          expect.objectContaining({
            baseHeadSeq: 0,
            headSeq: 1,
          }),
        ]),
      });
      const copyToDataSourceIntent = {
        ...transferIntent,
        operationId: "electron-native-block-transfer-copy-to-data-source",
        mode: "copy" as const,
        rootBlockIds: [nativeTargetAnchorBlockId],
        source: {
          kind: "document" as const,
          documentId: nativeTargetDocumentId,
        },
        target: {
          kind: "data_source" as const,
          dataSourceId: primaryDataSource.dataSourceId,
          placement: {
            kind: "direct" as const,
            viewId: primaryView.viewId,
            preferencesOverride: { rulesOverride: {}, presentationOverride: {} },
            groupKey: "ship",
          },
        },
      };
      const copiedToDataSource = await transferAdapter.commit(copyToDataSourceIntent);
      if (!copiedToDataSource.ok) {
        throw new Error(
          `Core Data Source copy failed: ${copiedToDataSource.error.code}: ${copiedToDataSource.error.message}`,
        );
      }
      const copiedDataSourcePageId = copiedToDataSource.value.resultRootBlockIds[0];
      if (!copiedDataSourcePageId) {
        throw new Error("Core Data Source copy omitted its Page root");
      }
      expect(copiedToDataSource.value).toMatchObject({
        operationId: copyToDataSourceIntent.operationId,
        duplicate: false,
        transformationEvidence: [
          {
            sourceBlockId: nativeTargetAnchorBlockId,
            resultPageId: copiedDataSourcePageId,
            kind: "promote",
          },
        ],
        finalLocations: {
          [copiedDataSourcePageId]: {
            kind: "data_source",
            databaseBlockId: primaryDatabase.database.databaseId,
            dataSourceId: primaryDataSource.dataSourceId,
          },
        },
        finalLocationRevisions: { [copiedDataSourcePageId]: 2 },
        affectedDatabaseBlockIds: [primaryDatabase.database.databaseId],
      });
      const finalApplications = await withFinalDataApplications(
        authorityRuntime,
        ({ database: databaseApplication, dynamicTools }) =>
          Effect.gen(function* () {
            const agentContext = yield* dynamicTools.execute(
              {
                threadId: "thread-native-context",
                turnId: "turn-native-context",
                callId: "call-native-context",
                namespace: NODEX_APP_TOOL_NAMESPACE,
                tool: "get_context",
                arguments: { include: { databases: true } },
              },
              {
                toolsetRevision: NODEX_APP_TOOLSET_REVISION,
                authority: {
                  threadId: "thread-native-context",
                  turnId: "turn-native-context",
                  rootThreadId: "thread-native-context",
                  actorProjectId: projectId,
                  libraryId: authorityRuntime.rootClient.handshake.library_id,
                  storeEpoch: authorityRuntime.rootClient.handshake.store_epoch,
                  frozenAtMs: 1_785_491_085_000,
                  scope: "project",
                  source: "project_turn",
                },
                access: {
                  read: "allowed",
                  write: "consent_required",
                  domains: ["document", "placement", "database"],
                },
                resolveResourceAccess: () => Effect.succeed({ kind: "authorized" }),
                authorize: () => Effect.succeed("deny"),
              },
            );
            const nativeWindow = yield* databaseApplication.viewWindow(
              { kind: "project", projectId },
              { first: 200 },
            );
            const scopedWindow = yield* databaseApplication.viewWindow(
              { kind: "project", projectId },
              {
                first: 200,
                groupScope: { kind: "path", groupKey: "ship", subgroupKey: null },
              },
            );
            const nativeGroups = yield* databaseApplication.viewGroups(
              { kind: "project", projectId },
              {},
            );
            const row = yield* databaseApplication.readRowPage({
              projectId,
              pageId: copiedDataSourcePageId,
              status: "ship",
            });
            return { agentContext, nativeWindow, scopedWindow, nativeGroups, row };
          }),
      );
      expect(finalApplications.agentContext.success).toBe(true);
      const agentContextItem = finalApplications.agentContext.contentItems[0];
      const nativeAgentContext = JSON.parse(
        agentContextItem?.type === "inputText" ? agentContextItem.text : "null",
      ) as unknown;
      expect(nativeAgentContext).toMatchObject({
        data: {
          project: {
            projectId,
            libraryId: runtime.rootClient.handshake.library_id,
          },
          databases: expect.arrayContaining([
            expect.objectContaining({
              databaseId: primaryDatabase.database.databaseId,
              isBound: true,
            }),
          ]),
        },
      });
      const { nativeWindow, scopedWindow, nativeGroups } = finalApplications;
      expect(nativeWindow.board.columns.find((column) => column.id === "ship")?.cards).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: copiedDataSourcePageId,
            status: "ship",
            hasDescription: false,
          }),
        ]),
      );
      expect(scopedWindow.rows.length).toBeGreaterThan(0);
      expect(scopedWindow.rows.every((row) => row.groupKey === "ship")).toBe(true);
      expect(nativeGroups.grouped).toBe(true);
      expect(nativeGroups.totalRows).toBeGreaterThan(0);
      expect(nativeGroups.groups.find((group) => group.groupKey === "ship")?.totalRows).toBe(
        scopedWindow.rows.length,
      );
      expect(finalApplications.row).toMatchObject({
        id: copiedDataSourcePageId,
        status: "ship",
        order: 1,
      });
      const lifecycleLibrary = createCoreLibraryModuleAdapter({
        client: runtime.clientForProject(projectId),
        libraryId: runtime.rootClient.handshake.library_id,
        profileId: runtime.rootClient.handshake.generation.profile_id,
        storeEpoch: runtime.rootClient.handshake.store_epoch,
      });
      const lifecyclePreflight = await lifecycleLibrary.readPageLifecyclePreflight(
        projectId,
        copiedDataSourcePageId,
      );
      if (!lifecyclePreflight.ok) {
        throw new Error(
          `Core Page lifecycle preflight failed: ${lifecyclePreflight.error.code}: ${lifecyclePreflight.error.message}`,
        );
      }
      expect(lifecyclePreflight).toMatchObject({
        ok: true,
        value: {
          projectId,
          value: {
            tagsProperty: { propertyId: "tags" },
            page: {
              pageId: copiedDataSourcePageId,
              lifecycle: "active",
              parent: {
                kind: "data_source",
                dataSourceId: primaryDataSource.dataSourceId,
              },
              membership: {
                status: "ship",
                viewId: primaryView.viewId,
                position: { rankKey: expect.any(String), revision: 1 },
              },
            },
          },
        },
      });
      const initialLifecyclePage = lifecyclePreflight.value.value.page;
      if (!initialLifecyclePage) {
        throw new Error("Expected native Page lifecycle authority");
      }
      const lifecycleRequestBase = {
        projectId,
        storeEpoch: runtime.rootClient.handshake.store_epoch,
        actor: { kind: "electron_renderer", clientId: "rust-authority-test" },
      };
      const databasePropertyMutation = await database.apply({
        operationId: "electron-page-property-database",
        projectId,
        storeEpoch: runtime.rootClient.handshake.store_epoch,
        actor: lifecycleRequestBase.actor,
        operations: [
          {
            kind: "edit_property_values",
            edits: [
              {
                pageId: copiedDataSourcePageId,
                dataSourceId: primaryDataSource.dataSourceId,
                propertyId: parseDataSourcePropertyId("assignee"),
                edit: {
                  kind: "replace",
                  expectedValueRevision: 1,
                  value: { kind: "text", value: "native-core" },
                },
              },
            ],
          },
        ],
      });
      if (!databasePropertyMutation.ok) {
        throw new Error(databasePropertyMutation.error.message);
      }
      const propertyMutation = await lifecycleLibrary.applyBlockPropertyMutation({
        mutationId: "electron-page-property-mixed",
        projectId,
        storeEpoch: runtime.rootClient.handshake.store_epoch,
        clientSessionId: "rust-authority-test",
        actor: lifecycleRequestBase.actor,
        fields: [
          {
            scope: "intrinsic",
            blockId: copiedDataSourcePageId,
            propertyKey: "run.target",
            operation: "set",
            expectedRevision: 1,
            value: "cloud",
          },
        ],
      });
      if (!propertyMutation.ok) {
        throw new Error(
          `Core Page Property mutation failed: ${propertyMutation.error.code}: ${propertyMutation.error.message}`,
        );
      }
      expect(propertyMutation).toMatchObject({
        ok: true,
        value: {
          duplicate: false,
          fields: [{ scope: "intrinsic", propertyKey: "run.target", revision: 2 }],
        },
      });
      await expect(
        database.apply({
          operationId: "electron-page-property-database",
          projectId,
          storeEpoch: runtime.rootClient.handshake.store_epoch,
          actor: lifecycleRequestBase.actor,
          operations: [
            {
              kind: "edit_property_values",
              edits: [
                {
                  pageId: copiedDataSourcePageId,
                  dataSourceId: primaryDataSource.dataSourceId,
                  propertyId: parseDataSourcePropertyId("assignee"),
                  edit: {
                    kind: "replace",
                    expectedValueRevision: 1,
                    value: { kind: "text", value: "native-core" },
                  },
                },
              ],
            },
          ],
        }),
      ).resolves.toMatchObject({ ok: true, value: { duplicate: true } });
      const propertyReplay = await lifecycleLibrary.applyBlockPropertyMutation({
        mutationId: "electron-page-property-mixed",
        projectId,
        storeEpoch: runtime.rootClient.handshake.store_epoch,
        clientSessionId: "rust-authority-test",
        actor: lifecycleRequestBase.actor,
        fields: [
          {
            scope: "intrinsic",
            blockId: copiedDataSourcePageId,
            propertyKey: "run.target",
            operation: "set",
            expectedRevision: 1,
            value: "cloud",
          },
        ],
      });
      expect(propertyReplay).toMatchObject({
        ok: true,
        value: { duplicate: true },
      });
      const archived = await lifecycleLibrary.applyPageLifecycleMutation({
        ...lifecycleRequestBase,
        operationId: "electron-page-lifecycle-archive",
        operation: {
          kind: "archive_page",
          pageId: copiedDataSourcePageId,
          expectedMetadataRevision:
            propertyMutation.value.blockMetadataRevisions[copiedDataSourcePageId],
        },
      });
      expect(archived).toMatchObject({
        ok: true,
        value: { lifecycle: "archived", duplicate: false },
      });
      if (!archived.ok) throw new Error(archived.error.message);
      await expect(
        withFinalDataApplications(authorityRuntime, ({ database }) =>
          database.readRowPage({
            projectId,
            pageId: copiedDataSourcePageId,
            status: "ship",
          }),
        ),
      ).resolves.toMatchObject({ archived: true });
      const unarchived = await lifecycleLibrary.applyPageLifecycleMutation({
        ...lifecycleRequestBase,
        operationId: "electron-page-lifecycle-unarchive",
        operation: {
          kind: "unarchive_page",
          pageId: copiedDataSourcePageId,
          expectedMetadataRevision: archived.value.metadataRevision,
        },
      });
      expect(unarchived).toMatchObject({
        ok: true,
        value: { lifecycle: "active" },
      });
      if (!unarchived.ok) throw new Error(unarchived.error.message);
      const deleteRequest = {
        ...lifecycleRequestBase,
        operationId: "electron-page-lifecycle-delete",
        operation: {
          kind: "delete_page" as const,
          pageId: copiedDataSourcePageId,
          expectedMetadataRevision: unarchived.value.metadataRevision,
          expectedParentRevision: unarchived.value.parentRevision,
        },
      };
      const deleted = await lifecycleLibrary.applyPageLifecycleMutation(deleteRequest);
      expect(deleted).toMatchObject({
        ok: true,
        value: { lifecycle: "deleted" },
      });
      if (!deleted.ok) throw new Error(deleted.error.message);
      const deletedPreflight = await lifecycleLibrary.readPageLifecyclePreflight(
        projectId,
        copiedDataSourcePageId,
      );
      if (!deletedPreflight.ok) {
        throw new Error(deletedPreflight.error.message);
      }
      const restoreEvidence = deletedPreflight.value.value.page?.restoreEvidence;
      if (!restoreEvidence) {
        throw new Error("Native delete receipt did not compile restore evidence");
      }
      const lifecycleRestored = await lifecycleLibrary.applyPageLifecycleMutation({
        ...lifecycleRequestBase,
        operationId: "electron-page-lifecycle-restore",
        operation: {
          kind: "restore_page",
          pageId: copiedDataSourcePageId,
          deleteOperationId: restoreEvidence.deleteOperationId,
          expectedMetadataRevision: deleted.value.metadataRevision,
          expectedParentRevision: deleted.value.parentRevision,
          membership: restoreEvidence.membership,
        },
      });
      expect(lifecycleRestored).toMatchObject({
        ok: true,
        value: {
          lifecycle: "active",
          membershipId: restoreEvidence.membership?.membershipId,
        },
      });
      const replayedDelete = await lifecycleLibrary.applyPageLifecycleMutation(deleteRequest);
      expect(replayedDelete).toMatchObject({
        ok: true,
        value: { lifecycle: "deleted", duplicate: true },
      });
      const afterDeleteReplay = await lifecycleLibrary.readPageLifecyclePreflight(
        projectId,
        copiedDataSourcePageId,
      );
      if (!afterDeleteReplay.ok) {
        throw new Error(afterDeleteReplay.error.message);
      }
      const restoredMembershipRevision =
        afterDeleteReplay.value.value.page?.membership?.membershipRevision;
      const restoredParentRevision = afterDeleteReplay.value.value.page?.parentRevision;
      expect(afterDeleteReplay).toMatchObject({
        ok: true,
        value: {
          value: {
            page: {
              lifecycle: "active",
              membership: {
                membershipId: restoreEvidence.membership?.membershipId,
                membershipRevision: 3,
                position: { rankKey: expect.any(String) },
              },
            },
          },
        },
      });
      if (!restoredMembershipRevision || !restoredParentRevision) {
        throw new Error("Restored Page has no durable parent or membership revision");
      }
      await expect(
        withFinalDataApplications(authorityRuntime, ({ database }) =>
          database.readRowPage({
            projectId,
            pageId: copiedDataSourcePageId,
            status: "ship",
          }),
        ),
      ).resolves.toMatchObject({ archived: false });
      expect(listCurrentProcessFiles()).not.toContain(databasePath);
      const moveDataSourcePageToLibraryIntent = {
        ...transferIntent,
        operationId: "electron-native-page-transfer-to-library",
        mode: "move" as const,
        rootBlockIds: [copiedDataSourcePageId],
        source: {
          kind: "data_source" as const,
          dataSourceId: primaryDataSource.dataSourceId,
        },
        target: {
          kind: "library" as const,
          libraryId: runtime.rootClient.handshake.library_id,
        },
      };
      const movedPageToLibrary = await transferAdapter.commit(moveDataSourcePageToLibraryIntent);
      if (!movedPageToLibrary.ok) {
        throw new Error(
          `Core Data Source Page move failed: ${movedPageToLibrary.error.code}: ${movedPageToLibrary.error.message}`,
        );
      }
      expect(movedPageToLibrary.value).toMatchObject({
        resultRootBlockIds: [copiedDataSourcePageId],
        finalLocations: {
          [copiedDataSourcePageId]: {
            kind: "library",
            libraryId: runtime.rootClient.handshake.library_id,
          },
        },
        finalLocationRevisions: {
          [copiedDataSourcePageId]: restoredParentRevision + 1,
        },
        documentCommits: [],
        affectedDatabaseBlockIds: [primaryDatabase.database.databaseId],
      });
      const moveLibraryPageToDataSourceIntent = {
        ...moveDataSourcePageToLibraryIntent,
        operationId: "electron-native-page-transfer-to-data-source",
        source: {
          kind: "library" as const,
          libraryId: runtime.rootClient.handshake.library_id,
        },
        target: {
          kind: "data_source" as const,
          dataSourceId: primaryDataSource.dataSourceId,
          placement: {
            kind: "direct" as const,
            viewId: primaryView.viewId,
            preferencesOverride: { rulesOverride: {}, presentationOverride: {} },
            groupKey: "ship",
          },
        },
      };
      const returnedPageToDataSource = await transferAdapter.commit(
        moveLibraryPageToDataSourceIntent,
      );
      if (!returnedPageToDataSource.ok) {
        throw new Error(
          `Core Library Page move failed: ${returnedPageToDataSource.error.code}: ${returnedPageToDataSource.error.message}`,
        );
      }
      expect(returnedPageToDataSource.value).toMatchObject({
        finalLocations: {
          [copiedDataSourcePageId]: {
            kind: "data_source",
            databaseBlockId: primaryDatabase.database.databaseId,
            dataSourceId: primaryDataSource.dataSourceId,
          },
        },
        finalLocationRevisions: {
          [copiedDataSourcePageId]: restoredParentRevision + 2,
        },
        documentCommits: [],
      });
      const moveDataSourcePageIntoPageIntent = {
        ...moveLibraryPageToDataSourceIntent,
        operationId: "electron-native-page-transfer-into-page",
        source: {
          kind: "data_source" as const,
          dataSourceId: primaryDataSource.dataSourceId,
        },
        target: {
          kind: "page" as const,
          pageId: nativeContentBlockId,
        },
      };
      const nestedPage = await transferAdapter.commit(moveDataSourcePageIntoPageIntent);
      if (!nestedPage.ok) {
        throw new Error(
          `Core Page nesting failed: ${nestedPage.error.code}: ${nestedPage.error.message}`,
        );
      }
      expect(nestedPage.value).toMatchObject({
        finalLocations: {
          [copiedDataSourcePageId]: {
            kind: "document",
            documentId: expect.any(String),
          },
        },
        finalLocationRevisions: {
          [copiedDataSourcePageId]: restoredParentRevision + 3,
        },
        documentCommits: [{ documentId: expect.any(String) }],
      });
      const copyRecursivePageIntent = {
        ...moveDataSourcePageIntoPageIntent,
        operationId: "electron-native-recursive-page-copy-to-library",
        mode: "copy" as const,
        rootBlockIds: [nativeContentBlockId],
        source: {
          kind: "library" as const,
          libraryId: runtime.rootClient.handshake.library_id,
        },
        target: {
          kind: "library" as const,
          libraryId: runtime.rootClient.handshake.library_id,
        },
      };
      const copiedRecursivePage = await transferAdapter.commit(copyRecursivePageIntent);
      if (!copiedRecursivePage.ok) {
        throw new Error(
          `Core recursive Page copy failed: ${copiedRecursivePage.error.code}: ${copiedRecursivePage.error.message}`,
        );
      }
      const copiedRecursiveRootId = copiedRecursivePage.value.copiedBlockIds[nativeContentBlockId];
      const copiedRecursiveChildId =
        copiedRecursivePage.value.copiedBlockIds[copiedDataSourcePageId];
      if (!copiedRecursiveRootId || !copiedRecursiveChildId) {
        throw new Error("Core recursive Page copy omitted ownership mappings");
      }
      expect(copiedRecursivePage.value).toMatchObject({
        resultRootBlockIds: [copiedRecursiveRootId],
        finalLocations: {
          [copiedRecursiveRootId]: {
            kind: "library",
            libraryId: runtime.rootClient.handshake.library_id,
          },
        },
        copiedBlockIds: {
          [nativeContentBlockId]: copiedRecursiveRootId,
          [copiedDataSourcePageId]: copiedRecursiveChildId,
        },
      });
      expect(copiedRecursivePage.value.documentCommits.length).toBeGreaterThanOrEqual(2);
      const sourceBodyRootId =
        promotedToLibrary.value.transformationEvidence[0]?.bodyRootBlockIds[0];
      const nestedCopyParentBlockId = sourceBodyRootId
        ? copiedRecursivePage.value.copiedBlockIds[sourceBodyRootId]
        : undefined;
      if (!nestedCopyParentBlockId) {
        throw new Error("Core recursive Page copy omitted its target body root mapping");
      }
      const nestedMultiPageCopyIntent = {
        ...copyRecursivePageIntent,
        operationId: "electron-native-nested-multi-page-copy",
        rootBlockIds: [nativeContentBlockId, copiedRecursiveRootId],
        target: {
          kind: "page" as const,
          pageId: copiedRecursiveRootId,
          parentBlockId: nestedCopyParentBlockId,
        },
      };
      const nestedMultiPageCopy = await transferAdapter.commit(nestedMultiPageCopyIntent);
      if (!nestedMultiPageCopy.ok) {
        throw new Error(
          `Core nested multi-Page copy failed: ${nestedMultiPageCopy.error.code}: ${nestedMultiPageCopy.error.message}`,
        );
      }
      expect(nestedMultiPageCopy.value.resultRootBlockIds).toHaveLength(2);
      const nestedCopyTarget =
        nestedMultiPageCopy.value.finalLocations[nestedMultiPageCopy.value.resultRootBlockIds[0]!];
      if (nestedCopyTarget?.kind !== "document") {
        throw new Error("Core nested multi-Page copy omitted its target Document");
      }
      for (const resultPageId of nestedMultiPageCopy.value.resultRootBlockIds) {
        expect(nestedMultiPageCopy.value.finalLocations[resultPageId]).toEqual({
          kind: "document",
          documentId: nestedCopyTarget.documentId,
        });
      }
      expect(
        nestedMultiPageCopy.value.documentCommits.filter(
          (commit) => commit.documentId === nestedCopyTarget.documentId,
        ),
      ).toHaveLength(1);
      const moveNestedPageToLibraryIntent = {
        ...moveDataSourcePageIntoPageIntent,
        operationId: "electron-native-nested-page-transfer-to-library",
        source: {
          kind: "page" as const,
          pageId: nativeContentBlockId,
        },
        target: {
          kind: "library" as const,
          libraryId: runtime.rootClient.handshake.library_id,
        },
      };
      const returnedNestedPage = await transferAdapter.commit(moveNestedPageToLibraryIntent);
      if (!returnedNestedPage.ok) {
        throw new Error(
          `Core nested Page return failed: ${returnedNestedPage.error.code}: ${returnedNestedPage.error.message}`,
        );
      }
      expect(returnedNestedPage.value).toMatchObject({
        finalLocations: {
          [copiedDataSourcePageId]: {
            kind: "library",
            libraryId: runtime.rootClient.handshake.library_id,
          },
        },
        finalLocationRevisions: {
          [copiedDataSourcePageId]: restoredParentRevision + 4,
        },
        documentCommits: [{ documentId: expect.any(String) }],
      });
      databaseEventSubscription.close();
      expect(listCurrentProcessFiles()).not.toContain(databasePath);
      const { createdProject, frozenAuthority } = await withFinalDataApplications(
        runtime,
        ({ turnAuthority, workspace }) =>
          Effect.gen(function* () {
            const project = yield* workspace.createProject({
              name: "Electron Workspace Module",
              sources: [nodexHome],
            });
            const session = yield* workspace.createProjectSession({
              projectId: project.id,
              noThreadFallbackTitle: "Electron Session",
              initialPageIds: [],
            });
            const threadTimestamp = Date.now();
            yield* workspace.upsertProjectSessionThreadLink({
              sessionId: session.id,
              projectId: project.id,
              threadId: "thread:electron-session",
              threadSource: "user",
              serviceName: "electron-session",
              agentNickname: "@Session",
              agentRole: "launcher",
              agentPath: "agents/session-launcher",
              threadName: "Electron linked Thread",
              threadPreview: "Native Session attach",
              modelProvider: "openai",
              cwd: nodexHome,
              statusType: "idle",
              statusActiveFlags: [],
              createdAt: threadTimestamp,
              updatedAt: threadTimestamp,
            });
            expect(
              yield* workspace.readThreadExecutionContext("thread:electron-session"),
            ).toMatchObject({
              threadId: "thread:electron-session",
              projectId: project.id,
            });
            const authorityLaunch = yield* turnAuthority.begin("thread:electron-session", false);
            yield* turnAuthority.bind(
              "thread:electron-session",
              authorityLaunch,
              "turn:electron-session",
            );
            const frozenAuthority = yield* turnAuthority.capture(
              "thread:electron-session",
              "turn:electron-session",
            );
            if (!frozenAuthority) {
              return yield* Effect.die(new Error("Core did not freeze the Agent Turn authority"));
            }
            return { createdProject: project, frozenAuthority };
          }),
      );
      expect(frozenAuthority).toMatchObject({
        threadId: "thread:electron-session",
        turnId: "turn:electron-session",
        rootThreadId: "thread:electron-session",
        actorProjectId: createdProject.id,
        scope: "project",
        source: "project_turn",
      });
      expect(frozenAuthority).toMatchObject({
        storeEpoch: runtime.rootClient.handshake.store_epoch,
        libraryId: runtime.rootClient.handshake.library_id,
      });
      const agentResources = await withFinalDataApplications(runtime, ({ resourceAccess }) =>
        Effect.succeed(resourceAccess),
      );
      const planAgentResources = (input: Parameters<typeof agentResources.plan>[0]) =>
        Effect.runPromise(agentResources.plan(input));
      const persistAgentProjectGrants = (
        input: Parameters<typeof agentResources.persistProjectGrants>[0],
      ) => Effect.runPromise(agentResources.persistProjectGrants(input));
      const consentPlan = await planAgentResources({
        authority: frozenAuthority,
        callId: "call:electron-session",
        intents: [
          {
            target: { kind: "page", pageId: copiedDataSourcePageId },
            action: "write",
          },
        ],
      });
      expect(consentPlan).toMatchObject({
        kind: "consent_required",
        requirements: [
          {
            grant: {
              root: { kind: "page", pageId: copiedDataSourcePageId },
              access: "read_write",
            },
            persistable: true,
          },
        ],
      });
      if (consentPlan.kind !== "consent_required") {
        throw new Error("Foreign Page did not require Project consent");
      }
      await persistAgentProjectGrants({
        operationId: "electron-agent-project-grants",
        authority: frozenAuthority,
        grants: consentPlan.requirements.map((requirement) => requirement.grant),
      });
      await expect(
        planAgentResources({
          authority: frozenAuthority,
          callId: "call:electron-session-after-grant",
          intents: [
            {
              target: { kind: "page", pageId: copiedDataSourcePageId },
              action: "write",
            },
          ],
        }),
      ).resolves.toEqual({ kind: "authorized" });
      const nativeDuplicateContext = {
        toolsetRevision: NODEX_APP_TOOLSET_REVISION,
        authority: frozenAuthority,
        access: {
          read: "allowed" as const,
          write: "consent_required" as const,
          domains: ["document", "placement", "database"] as (
            | "document"
            | "placement"
            | "database"
          )[],
        },
        resolveResourceAccess: (intents: Parameters<typeof agentResources.plan>[0]["intents"]) =>
          agentResources
            .plan({
              authority: frozenAuthority,
              callId: "call:electron-native-duplicate",
              intents,
            })
            .pipe(Effect.orDie),
        authorize: () => Effect.succeed("deny" as const),
      };
      const nativeCreateContext = {
        ...nativeDuplicateContext,
        resolveResourceAccess: (intents: Parameters<typeof agentResources.plan>[0]["intents"]) =>
          agentResources
            .plan({
              authority: frozenAuthority,
              callId: "call:electron-native-create-pages",
              intents,
            })
            .pipe(Effect.orDie),
      };
      const nativeCreateInput = {
        destination: {
          kind: "page" as const,
          pageId: copiedDataSourcePageId,
          at: { kind: "end" as const },
        },
        pages: [
          {
            title: "**Native first**",
            markdown: "First native body",
          },
          {
            title: "Native second",
            markdown: "Second native body",
          },
        ],
        return: ["block_ids" as const, "etags" as const],
      };
      const nativeCreated = CreatePagesV6OutputSchema.parse(
        parseDynamicToolOutput(
          await withFinalDataApplications(authorityRuntime, ({ dynamicTools }) =>
            dynamicTools.execute(
              {
                threadId: frozenAuthority.threadId,
                turnId: frozenAuthority.turnId,
                callId: "call:electron-native-create-pages",
                namespace: NODEX_APP_TOOL_NAMESPACE,
                tool: "create_pages",
                arguments: nativeCreateInput,
              },
              nativeCreateContext,
            ),
          ),
        ),
      );
      expect(nativeCreated).toMatchObject({
        data: {
          created: 2,
          pages: [
            {
              pageId: expect.any(String),
              location: { kind: "page", pageId: copiedDataSourcePageId },
              bodyBlocksCreated: 1,
              blockIds: [expect.any(String)],
              etags: {
                title: expect.stringMatching(/^nxe1\./u),
                body: expect.stringMatching(/^nxe1\./u),
              },
            },
            {
              pageId: expect.any(String),
              location: { kind: "page", pageId: copiedDataSourcePageId },
              bodyBlocksCreated: 1,
              blockIds: [expect.any(String)],
              etags: {
                title: expect.stringMatching(/^nxe1\./u),
                body: expect.stringMatching(/^nxe1\./u),
              },
            },
          ],
        },
      });
      const nativeCreatedReplay = CreatePagesV6OutputSchema.parse(
        parseDynamicToolOutput(
          await withFinalDataApplications(authorityRuntime, ({ dynamicTools }) =>
            dynamicTools.execute(
              {
                threadId: frozenAuthority.threadId,
                turnId: frozenAuthority.turnId,
                callId: "call:electron-native-create-pages",
                namespace: NODEX_APP_TOOL_NAMESPACE,
                tool: "create_pages",
                arguments: nativeCreateInput,
              },
              nativeCreateContext,
            ),
          ),
        ),
      );
      expect(nativeCreatedReplay).toEqual(nativeCreated);
      const nativeMoveContext = {
        ...nativeDuplicateContext,
        resolveResourceAccess: (intents: Parameters<typeof agentResources.plan>[0]["intents"]) =>
          agentResources
            .plan({
              authority: frozenAuthority,
              callId: "call:electron-native-move-pages",
              intents,
            })
            .pipe(Effect.orDie),
      };
      const moveTargetConsent = await planAgentResources({
        authority: frozenAuthority,
        callId: "call:electron-native-move-target-consent",
        intents: [
          {
            target: { kind: "page", pageId: nativeContentBlockId },
            action: "create_child",
          },
        ],
      });
      if (moveTargetConsent.kind === "consent_required") {
        await persistAgentProjectGrants({
          operationId: "electron-agent-move-target-grant",
          authority: frozenAuthority,
          grants: moveTargetConsent.requirements.map((requirement) => requirement.grant),
        });
      } else if (moveTargetConsent.kind !== "authorized") {
        throw new Error("Native Agent Page-move target was not grantable");
      }
      const createdPageIds = nativeCreated.data.pages.map((page) => page.pageId).reverse();
      const nativeMoveInput = {
        pageIds: createdPageIds,
        destination: {
          kind: "page" as const,
          pageId: nativeContentBlockId,
          at: { kind: "start" as const },
        },
      };
      const nativeMoved = parseDynamicToolOutput(
        await withFinalDataApplications(authorityRuntime, ({ dynamicTools }) =>
          dynamicTools.execute(
            {
              threadId: frozenAuthority.threadId,
              turnId: frozenAuthority.turnId,
              callId: "call:electron-native-move-pages",
              namespace: NODEX_APP_TOOL_NAMESPACE,
              tool: "move_pages",
              arguments: nativeMoveInput,
            },
            nativeMoveContext,
          ),
        ),
      );
      expect(nativeMoved).toMatchObject({
        data: {
          moved: 2,
          pages: [
            {
              pageId: createdPageIds[0],
              location: { kind: "page", pageId: nativeContentBlockId },
            },
            {
              pageId: createdPageIds[1],
              location: { kind: "page", pageId: nativeContentBlockId },
            },
          ],
        },
      });
      const nativeMovedReplay = parseDynamicToolOutput(
        await withFinalDataApplications(authorityRuntime, ({ dynamicTools }) =>
          dynamicTools.execute(
            {
              threadId: frozenAuthority.threadId,
              turnId: frozenAuthority.turnId,
              callId: "call:electron-native-move-pages",
              namespace: NODEX_APP_TOOL_NAMESPACE,
              tool: "move_pages",
              arguments: nativeMoveInput,
            },
            nativeMoveContext,
          ),
        ),
      );
      expect(nativeMovedReplay).toEqual(nativeMoved);
      const nativeDuplicateInput = {
        pageId: copiedDataSourcePageId,
        destination: {
          kind: "page" as const,
          pageId: copiedDataSourcePageId,
          at: { kind: "end" as const },
        },
        return: ["block_map" as const, "etags" as const],
      };
      const nativeDuplicate = parseDynamicToolOutput(
        await withFinalDataApplications(authorityRuntime, ({ dynamicTools }) =>
          dynamicTools.execute(
            {
              threadId: frozenAuthority.threadId,
              turnId: frozenAuthority.turnId,
              callId: "call:electron-native-duplicate",
              namespace: NODEX_APP_TOOL_NAMESPACE,
              tool: "duplicate_page",
              arguments: nativeDuplicateInput,
            },
            nativeDuplicateContext,
          ),
        ),
      );
      expect(nativeDuplicate).toMatchObject({
        data: {
          sourcePageId: copiedDataSourcePageId,
          pageId: expect.any(String),
          location: { kind: "page", pageId: copiedDataSourcePageId },
          bodyBlocksCreated: expect.any(Number),
          blockMap: expect.objectContaining({
            [copiedDataSourcePageId]: expect.any(String),
          }),
          etags: {
            title: expect.stringMatching(/^nxe1\./u),
            body: expect.stringMatching(/^nxe1\./u),
          },
        },
      });
      const nativeDuplicateReplay = parseDynamicToolOutput(
        await withFinalDataApplications(authorityRuntime, ({ dynamicTools }) =>
          dynamicTools.execute(
            {
              threadId: frozenAuthority.threadId,
              turnId: frozenAuthority.turnId,
              callId: "call:electron-native-duplicate",
              namespace: NODEX_APP_TOOL_NAMESPACE,
              tool: "duplicate_page",
              arguments: nativeDuplicateInput,
            },
            nativeDuplicateContext,
          ),
        ),
      );
      expect(nativeDuplicateReplay).toEqual(nativeDuplicate);
      expect(listCurrentProcessFiles()).not.toContain(databasePath);
      await withFinalDataApplications(runtime, ({ automation }) =>
        Effect.gen(function* () {
          const definition = yield* automation.definitions.create({
            kind: "cron",
            name: "Electron Automation Application",
            prompt: "Exercise the native Automation boundary.",
            rrule: "FREQ=DAILY;BYHOUR=9",
            cwds: [nodexHome],
            executionEnvironment: "worktree",
          });
          expect(definition).toMatchObject({
            id: "electron-automation-application",
            status: "ACTIVE",
            prompt: "Exercise the native Automation boundary.",
          });
          expect(yield* automation.definitions.list()).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: definition.id })]),
          );
          expect(yield* automation.definitions.dispatchNow(definition.id)).toMatchObject({
            id: definition.id,
            lastRunAt: expect.any(Number),
          });
          expect(
            yield* automation.runs.begin({
              threadId: "thread:electron-session",
              automationId: definition.id,
              threadTitle: "Electron Automation run",
              sourceCwd: nodexHome,
            }),
          ).toBe(true);
          expect(
            yield* automation.runs.completeForReview({
              threadId: "thread:electron-session",
              inboxTitle: "Native report ready",
              inboxSummary: "Review the native Automation run.",
            }),
          ).toBe(true);
          expect(yield* automation.inbox.read(10)).toMatchObject({
            items: [
              {
                automationId: definition.id,
                threadId: "thread:electron-session",
                description: "Review the native Automation run.",
              },
            ],
            unreadRunCounts: { total: 1 },
          });
          expect(
            yield* automation.inbox.setReadState({
              threadId: "thread:electron-session",
              readAt: Date.now(),
            }),
          ).toMatchObject({
            threadId: "thread:electron-session",
            readAt: expect.any(Number),
          });
          expect(
            yield* automation.runs.archive({
              threadId: "thread:electron-session",
              archivedReason: "manual",
              archivedUserMessage: "Run the native report.",
              archivedAssistantMessage: "Native report complete.",
            }),
          ).toBe(true);
          expect(yield* automation.runs.get("thread:electron-session")).toMatchObject({
            status: "ARCHIVED",
            archivedUserMessage: "Run the native report.",
            archivedAssistantMessage: "Native report complete.",
            archivedReason: "manual",
          });
          expect(yield* automation.runs.unarchive("thread:electron-session")).toBe(true);
          expect(yield* automation.runs.delete("thread:electron-session")).toBe(true);
          expect(
            yield* automation.occurrences.list({
              projectId: createdProject.id,
              windowStart: new Date("2026-07-19T00:00:00.000Z"),
              windowEnd: new Date("2026-07-21T00:00:00.000Z"),
            }),
          ).toEqual({ items: [], nextCursor: null });
          expect(yield* automation.reminders.planDue).toEqual({
            dueNow: false,
            nextWakeAt: null,
            workToken: null,
          });
          expect(yield* automation.definitions.delete(definition.id)).toMatchObject({
            success: true,
            status: "deleted",
            deletedRunCount: 0,
          });
        }),
      );
      const createdBackup = await runtime.rootClient.administrationApply({
        operationId: randomUUID(),
        intent: {
          kind: "create_backup",
          trigger: "manual",
          label: "Electron native authority",
          include_assets: true,
        },
      });
      const nativeBackupId = createdBackup.outcome.backup_id;
      if (!nativeBackupId) throw new Error("Core Backup commit omitted its Backup identity");
      const nativeBackups = await runtime.rootClient.administrationRead({
        kind: "backups",
        window: { after: null, first: 200 },
      });
      if (nativeBackups.value.kind !== "backups") {
        throw new Error("Core returned a non-Backup Store Administration read");
      }
      expect(nativeBackups.value.backups.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            backup_id: nativeBackupId,
            trigger: "manual",
            label: "Electron native authority",
            includes_assets: true,
            db_bytes: expect.any(Number),
          }),
        ]),
      );
      await runtime.rootClient.administrationApply({
        operationId: randomUUID(),
        intent: {
          kind: "run_maintenance",
          tasks: [
            "document_revision_finalize",
            "document_compaction",
            "history_retention",
            "block_retention",
          ],
          block_retention_count: 0,
        },
      });
      const deletedBackup = await runtime.rootClient.administrationApply({
        operationId: randomUUID(),
        intent: { kind: "delete_backup", backup_id: nativeBackupId },
      });
      expect(deletedBackup.status).toBe("committed");
      expect(listCurrentProcessFiles()).not.toContain(databasePath);
      await expect(
        runtime.clientForProject(projectId).databaseRead({
          kind: "catalog_window",
          window: { after: null, first: 10 },
        }),
      ).resolves.toMatchObject({ value: { kind: "catalog_window" } });

      const canvasDocumentId = primaryCanvasDocumentId(projectId);
      const canvasAccessContext = { kind: "project", projectId } as const;
      const canvasBinding = {
        libraryId: runtime.identity.libraryId,
        accessContext: canvasAccessContext,
      };
      const firstCanvasClient = runtime.clientForProject(projectId);
      const firstCanvas = createCoreCanvasSceneAdapter(firstCanvasClient, canvasBinding);
      const secondCanvasClient = runtime.clientForProject(projectId);
      const secondCanvas = createCoreCanvasSceneAdapter(secondCanvasClient, canvasBinding);
      const firstCanvasRequest = {
        accessContext: canvasAccessContext,
        documentId: canvasDocumentId,
        clientSessionId: "renderer:electron-canvas:first",
      } as const;
      const secondCanvasRequest = {
        ...firstCanvasRequest,
        clientSessionId: "renderer:electron-canvas:second",
      } as const;
      const secondCanvasEvents: CanvasSceneRealtimeEvent[] = [];
      const firstCanvasSubscription = await firstCanvasClient.openDocumentEventStream(
        {
          documentId: firstCanvasRequest.documentId,
          clientSessionId: firstCanvasRequest.clientSessionId,
        },
        () => undefined,
        () => undefined,
        () => undefined,
      );
      const secondCanvasSubscription = await secondCanvasClient.openDocumentEventStream(
        {
          documentId: secondCanvasRequest.documentId,
          clientSessionId: secondCanvasRequest.clientSessionId,
        },
        (envelope) => {
          const event = mapCanvasLiveEnvelope(canvasBinding, secondCanvasRequest, envelope);
          if (event) secondCanvasEvents.push(event);
        },
        (repair) => {
          secondCanvasEvents.push({
            type: "canvas_scene_resync_required",
            libraryId: canvasBinding.libraryId,
            accessContext: canvasBinding.accessContext,
            documentId: repair.document_id,
            storeEpoch: repair.store_epoch,
            generation: repair.document_generation,
            headSeq: repair.head_seq,
          });
        },
        () => undefined,
      );
      try {
        const firstCanvasSync = await firstCanvas.sync({
          ...firstCanvasRequest,
          syncRequestId: "sync:electron:first",
        });
        if (!firstCanvasSync.ok) {
          throw new Error(
            `Core Canvas sync failed: ${firstCanvasSync.error.code}: ${firstCanvasSync.error.message}`,
          );
        }
        if (firstCanvasSync.value.kind !== "snapshot") {
          throw new Error("Initial Core Canvas sync did not return a snapshot");
        }
        const currentGridMode = firstCanvasSync.value.scene.appState.gridModeEnabled;
        const nextGridMode = currentGridMode !== true;
        const mutationId = "electron-canvas-mutation:one";
        const canvasMutation = await firstCanvas.applyMutation({
          ...firstCanvasRequest,
          mutationId,
          storeEpoch: firstCanvasSync.value.storeEpoch,
          generation: firstCanvasSync.value.generation,
          baseHeadSeq: firstCanvasSync.value.headSeq,
          elementCandidates: [],
          appStateIntents: {
            gridModeEnabled: {
              expected: Object.prototype.hasOwnProperty.call(
                firstCanvasSync.value.scene.appState,
                "gridModeEnabled",
              )
                ? { kind: "value", value: currentGridMode }
                : { kind: "absent" },
              value: { kind: "value", value: nextGridMode },
            },
          },
          fileAdditions: {},
        });
        if (!canvasMutation.ok) {
          throw new Error(
            `Core Canvas mutation failed: ${canvasMutation.error.code}: ${canvasMutation.error.message}`,
          );
        }
        await waitUntil(
          () =>
            secondCanvasEvents.some(
              (event) => event.type === "canvas_scene_committed" && event.mutationId === mutationId,
            ),
          "Second Canvas subscriber did not receive the durable mutation",
        );
        const secondCanvasSync = await secondCanvas.sync({
          ...secondCanvasRequest,
          syncRequestId: "sync:electron:second",
        });
        if (!secondCanvasSync.ok) {
          throw new Error(
            `Second Core Canvas sync failed: ${secondCanvasSync.error.code}: ${secondCanvasSync.error.message}`,
          );
        }
        if (secondCanvasSync.value.kind !== "snapshot") {
          throw new Error("Second Core Canvas sync did not return a snapshot");
        }
        expect(secondCanvasSync.value.scene.appState.gridModeEnabled).toBe(nextGridMode);
        const corruptCanvasSync = await secondCanvas.sync({
          ...secondCanvasRequest,
          syncRequestId: "sync:electron:wrong-hash",
          knownStoreEpoch: secondCanvasSync.value.storeEpoch,
          knownGeneration: secondCanvasSync.value.generation,
          knownHeadSeq: secondCanvasSync.value.headSeq,
          knownSceneHash: "0".repeat(64),
        });
        expect(corruptCanvasSync).toMatchObject({
          ok: false,
          error: { code: "canvas_scene_corrupt", retryable: false },
        });
        const currentCanvasSync = await secondCanvas.sync({
          ...secondCanvasRequest,
          syncRequestId: "sync:electron:current",
          knownStoreEpoch: secondCanvasSync.value.storeEpoch,
          knownGeneration: secondCanvasSync.value.generation,
          knownHeadSeq: secondCanvasSync.value.headSeq,
          knownSceneHash: secondCanvasSync.value.sceneHash,
        });
        expect(currentCanvasSync).toMatchObject({
          ok: true,
          value: {
            kind: "up_to_date",
            syncRequestId: "sync:electron:current",
            headSeq: secondCanvasSync.value.headSeq,
          },
        });
        expect(listCurrentProcessFiles()).not.toContain(databasePath);
      } finally {
        firstCanvasSubscription.close();
        secondCanvasSubscription.close();
      }

      const library = createCoreLibraryModuleAdapter({
        client: runtime.clientForProject(projectId),
        libraryId: runtime.rootClient.handshake.library_id,
        profileId: runtime.rootClient.handshake.generation.profile_id,
        storeEpoch: runtime.rootClient.handshake.store_epoch,
      });
      await expect(
        library.read({
          read: { mode: "metadata" },
        }),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          libraryId: runtime.rootClient.handshake.library_id,
          storeEpoch: runtime.rootClient.handshake.store_epoch,
        },
      });
      const createdPage = await library.apply({
        operationId: "electron-library-adapter-create",
        storeEpoch: runtime.rootClient.handshake.store_epoch,
        operation: {
          kind: "create_page",
          pageId: "page:electron-library-adapter",
          documentId: "document:electron-library-adapter",
          title: "Electron Library Adapter",
          parent: { kind: "library" },
        },
      });
      if (!createdPage.ok) {
        throw new Error(
          `Core Library Adapter create failed: ${createdPage.error.code}: ${createdPage.error.message}`,
        );
      }
      expect(createdPage).toMatchObject({
        ok: true,
        value: {
          createdTarget: {
            kind: "page",
            pageId: "page:electron-library-adapter",
          },
          duplicate: false,
        },
      });
      await expect(
        library.apply({
          operationId: "electron-library-adapter-grant",
          storeEpoch: runtime.rootClient.handshake.store_epoch,
          operation: {
            kind: "grant_project_access",
            projectId,
            target: {
              kind: "page",
              pageId: "page:electron-library-adapter",
            },
            access: "read_write",
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          operationKind: "grant_project_access",
          // A Project-created Library-root Page grants its creator read/write
          // access atomically; repeating that grant is a semantic no-op.
          didMutate: false,
        },
      });
      await expect(
        library.readProjectPageDetail(projectId, "page:electron-library-adapter"),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          projectId,
          libraryId: runtime.rootClient.handshake.library_id,
          page: {
            pageId: "page:electron-library-adapter",
            title: "Electron Library Adapter",
          },
          document: { readiness: "ready" },
        },
      });
      await expect(
        library.resolvePageTarget({
          accessContext: { kind: "project", projectId },
          targetPageId: "page:electron-library-adapter",
        }),
      ).resolves.toMatchObject({
        status: "available",
        targetPageId: "page:electron-library-adapter",
        page: {
          pageId: "page:electron-library-adapter",
          title: "Electron Library Adapter",
        },
        document: { readiness: "ready" },
      });
      await expect(
        library.resolvePageTarget({
          accessContext: { kind: "library" },
          targetPageId: "page:electron-library-adapter",
        }),
      ).resolves.toMatchObject({
        status: "available",
        targetPageId: "page:electron-library-adapter",
        page: {
          pageId: "page:electron-library-adapter",
          title: "Electron Library Adapter",
        },
        document: { readiness: "ready" },
      });
      await expect(
        library.resolvePageOwnershipPath({
          accessContext: { kind: "project", projectId },
          targetPageId: "page:electron-library-adapter",
        }),
      ).resolves.toMatchObject({
        libraryId: runtime.rootClient.handshake.library_id,
        storeEpoch: runtime.rootClient.handshake.store_epoch,
        commitSeq: expect.any(Number),
        status: "available",
        targetPageId: "page:electron-library-adapter",
        ancestors: [],
      });
      await expect(
        library.resolvePageOwnershipPath({
          accessContext: { kind: "library" },
          targetPageId: "page:electron-library-adapter",
        }),
      ).resolves.toMatchObject({
        libraryId: runtime.rootClient.handshake.library_id,
        storeEpoch: runtime.rootClient.handshake.store_epoch,
        commitSeq: expect.any(Number),
        status: "available",
        targetPageId: "page:electron-library-adapter",
        ancestors: [],
      });
      await expect(
        library.listPageHistory({
          requestingProjectId: projectId,
          pageId: "page:electron-library-adapter",
          pageSize: 10,
        }),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          libraryId: runtime.rootClient.handshake.library_id,
          pageId: "page:electron-library-adapter",
          documentId: "document:electron-library-adapter",
        },
      });
      const rootLibrary = createCoreLibraryModuleAdapter({
        client: runtime.rootClient,
        libraryId: runtime.rootClient.handshake.library_id,
        profileId: runtime.rootClient.handshake.generation.profile_id,
        storeEpoch: runtime.rootClient.handshake.store_epoch,
      });
      const rootCreatedPage = await rootLibrary.apply({
        operationId: "electron-root-library-create",
        storeEpoch: runtime.rootClient.handshake.store_epoch,
        operation: {
          kind: "create_page",
          pageId: "page:electron-root-library",
          documentId: "document:electron-root-library",
          title: "Root Library Page",
          parent: { kind: "library" },
        },
      });
      if (!rootCreatedPage.ok) {
        throw new Error(
          `Root Library create failed: ${rootCreatedPage.error.code}: ${rootCreatedPage.error.message}`,
        );
      }
      expect(rootCreatedPage).toMatchObject({
        ok: true,
        value: {
          createdTarget: {
            kind: "page",
            pageId: "page:electron-root-library",
          },
        },
      });
      await expect(rootLibrary.findPageLocation("page:electron-library-adapter")).resolves.toEqual({
        pageId: "page:electron-library-adapter",
        projectId,
      });
      const libraryPageDetail = await rootLibrary.readLibraryPageDetail(
        "page:electron-library-adapter",
      );
      expect(libraryPageDetail).toMatchObject({
        ok: true,
        value: {
          accessContext: { kind: "library" },
          page: { pageId: "page:electron-library-adapter" },
        },
      });
      if (!libraryPageDetail.ok) throw new Error("Expected Library Page Detail");
      expect("projectId" in libraryPageDetail.value).toBe(false);
      await expect(
        libraryDatabase.apply({
          operationId: "electron-library-page-enter-database",
          storeEpoch: runtime.rootClient.handshake.store_epoch,
          operations: [
            {
              kind: "transfer_page",
              pageId: "page:electron-library-adapter",
              expectedParentRevision: libraryPageDetail.value.page.parentRevision,
              expectedActiveMembershipRevision: 0,
              target: {
                kind: "data_source",
                dataSourceId: primaryDataSource.dataSourceId,
              },
            },
          ],
        }),
      ).resolves.toMatchObject({
        ok: true,
        value: {
          accessContext: { kind: "library" },
          operationKinds: ["transfer_page"],
        },
      });
      await expect(
        rootLibrary.searchPages({
          projectIds: [projectId],
          query: "Electron Library Adapter",
          limit: 10,
        }),
      ).resolves.toMatchObject({
        results: [
          expect.objectContaining({
            projectId,
            pageId: "page:electron-library-adapter",
            status: "triage",
          }),
        ],
      });
      const libraryDocuments = createCoreDocumentSyncAdapter(runtime.rootClient);
      const preparedLibraryDocument = await libraryDocuments.prepareOwner({
        ownerBlockId: "page:electron-library-adapter",
        operationId: "electron-library-owner-prepare",
        clientSessionId: "renderer:electron-library-owner-prepare",
      });
      if (!preparedLibraryDocument.ok) {
        throw new Error(
          `Core Library Document preparation failed: ${preparedLibraryDocument.error.code}: ${preparedLibraryDocument.error.message}`,
        );
      }
      expect(preparedLibraryDocument.value).toMatchObject({
        ownerBlockId: "page:electron-library-adapter",
        documentId: "document:electron-library-adapter",
        ownerType: "page",
        readiness: "ready",
        sync: { kind: "yjs" },
      });
      const firstDocument = new Y.Doc({
        guid: "document:electron-library-adapter",
      });
      const libraryDocumentScope = await Effect.runPromise(Scope.make());
      const libraryRendererAdapter = await Effect.runPromise(
        makeDesktopDocumentSessionHarness(runtime.rootClient, { kind: "library" }).pipe(
          Effect.provideService(Scope.Scope, libraryDocumentScope),
        ),
      );
      // Library providers intentionally use the unscoped root client. Core binds
      // that transport to its trusted local Library capability instead of
      // accepting an Adapter-selected content owner.
      const firstProvider = new NodexYProvider({
        documentId: firstDocument.guid,
        document: firstDocument,
        adapter: libraryRendererAdapter,
        clientSessionId: "renderer:electron-authority:first",
        autoConnect: false,
        localCheckpointStore: null,
      });
      const secondDocument = new Y.Doc({
        guid: "document:electron-library-adapter",
      });
      const secondProvider = new NodexYProvider({
        documentId: secondDocument.guid,
        document: secondDocument,
        adapter: libraryRendererAdapter,
        clientSessionId: "renderer:electron-authority:second",
        autoConnect: false,
        localCheckpointStore: null,
      });
      try {
        await firstProvider.connect();
        expect(firstProvider.getStatus().phase).toBe("synced");
        firstDocument.transact(() => {
          const title = firstDocument.getText("title");
          title.delete(0, title.length);
          title.insert(0, "Electron native Document sync");
        });
        await firstProvider.flush();
        await secondProvider.connect();
        expect(secondDocument.getText("title").toString()).toBe("Electron native Document sync");
        expect(listCurrentProcessFiles()).not.toContain(databasePath);
      } finally {
        firstProvider.destroy();
        secondProvider.destroy();
        firstDocument.destroy();
        secondDocument.destroy();
        await Effect.runPromise(Scope.close(libraryDocumentScope, Exit.void));
      }
    } finally {
      if (runtime) {
        await runtime.rootClient.shutdown().catch(() => undefined);
        const socketPath = path.join(nodexHome, "run/core/core.sock");
        await waitUntil(
          () => !existsSync(socketPath),
          "Core runtime socket remained after authority test shutdown",
        );
      }
    }
  });
});
