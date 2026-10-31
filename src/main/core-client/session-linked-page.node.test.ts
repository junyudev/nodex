import { expect, test } from "vite-plus/test";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import { createUuidV7 } from "../../shared/uuid-v7";
import type { ProjectSessionsChangeEvent } from "../../shared/ipc-api";
import type { ProjectionCursor, ProjectionStreamMessage } from "../../shared/projection-stream";
import { projectionMessageFromDelivery } from "../../shared/local-commit-delivery";
import { createSessionLinkedPageStore } from "../../renderer/lib/session-linked-page";
import { ProjectionInvalidationRegistry } from "../../renderer/lib/projection-invalidation-registry";
import { projectCoreProjectWorkspaceEvent } from "../core-runtime/CoreApplicationEventProjection";
import { planCoreWorkspaceNotifications } from "./core-project-workspace-invalidation";
import { projectWorkspaceSessionLinkedPageSummaryFromCore } from "./project-workspace-adapter";
import { CoreClient } from "./core-client";
import { applyResultCursor, type CoreClientPort } from "./types";

test("Status edits, renamed options and link changes refresh independent Session Linked Page recipients", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (ctx) => {
    const projectId = ctx.manifest.projectId;
    const pageId = ctx.manifest.pageIdsByKey.source!;
    const sessionId = createUuidV7();
    const client = ctx.client.forProject(projectId);
    const view = await client.databaseRead({ kind: "view", view_id: ctx.manifest.databaseViewId! });
    if (view.value.kind !== "view") throw new Error("Missing View");
    const dataSourceId = view.value.value.data_source_id;
    await client.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "create_session",
        session_id: sessionId,
        project_id: projectId,
        title: "Linked Page proof",
        initial_page_ids: [pageId],
      },
    });
    const peer = await CoreClient.connect({
      nodexHome: ctx.profile.nodexHome,
      clientKind: "electron_host",
      buildId: "session-linked-page-recipient",
    });
    const scope = { kind: "library" as const, libraryId: ctx.runtime.identity.libraryId };
    const repairs: unknown[] = [];
    const recipient = async (broker: Pick<CoreClientPort, "openProjectionEventStream">) => {
      const projections = new Set<(message: ProjectionStreamMessage) => void>();
      const sessions = new Set<(event: ProjectSessionsChangeEvent) => void>();
      let latest: ProjectionCursor | null = null;
      let lastReadCommitHead = 0;
      const stream = await broker.openProjectionEventStream(
        [scope],
        (event) => {
          latest = {
            storeEpoch: event.packet.manifest.identity.store_epoch,
            commitSeq: event.packet.manifest.identity.commit_seq,
          };
          for (const effect of event.packet.projection_effects) {
            const message = projectionMessageFromDelivery(event.packet, effect, scope);
            for (const listener of projections) listener(message);
          }
          for (const atom of event.packet.atoms) {
            const workspace = projectCoreProjectWorkspaceEvent(atom);
            if (!workspace) continue;
            const event = planCoreWorkspaceNotifications(workspace).sessions;
            if (!event) continue;
            for (const listener of sessions) listener(event);
          }
        },
        (repair) => repairs.push(repair),
      );
      latest ??= { storeEpoch: stream.barrier.store_epoch, commitSeq: stream.barrier.commit_head };
      const registry = new ProjectionInvalidationRegistry({
        subscribeProjection: (_scope, listener) => {
          projections.add(listener);
          listener({ version: 2, kind: "checkpoint", scope, stream: latest! });
          return () => projections.delete(listener);
        },
      });
      const store = createSessionLinkedPageStore({
        read: async (input) => {
          const snapshot = await client.workspaceRead({
            kind: "session_linked_page_summaries",
            session_ids: input.sessionIds,
          });
          if (snapshot.value.kind !== "session_linked_page_summaries")
            throw new Error("Missing Session Linked Pages");
          lastReadCommitHead = snapshot.commit_head;
          return {
            summaries: snapshot.value.summaries.map(
              projectWorkspaceSessionLinkedPageSummaryFromCore,
            ),
            libraryId: snapshot.value.library_id,
            storeEpoch: snapshot.store_epoch,
            projectionRevision: snapshot.value.projection_revision,
          };
        },
        subscribeSessions: (listener) => {
          sessions.add(listener);
          return () => sessions.delete(listener);
        },
        registerProjection: (registration) => registry.register(registration),
      });
      const release = store.subscribeSession(sessionId, () => {});
      return {
        store,
        readCommitHead: () => lastReadCommitHead,
        close: () => {
          release();
          registry.dispose();
          stream.close();
        },
      };
    };
    const left = await recipient(ctx.runtime.rootClient);
    let right: Awaited<ReturnType<typeof recipient>> | undefined;
    try {
      right = await recipient(peer);
      const recipients = [left, right];
      const stores = [left.store, right.store];
      await expect
        .poll(() => stores.map((store) => store.read(sessionId)?.status?.optionId))
        .toEqual(["build", "build"]);
      const row = await client.databaseRead({ kind: "row_detail", page_id: pageId });
      if (row.value.kind !== "row_detail") throw new Error("Missing row");
      const changed = await client.databaseApply({
        operationId: createUuidV7(),
        intent: [
          {
            kind: "edit_property_values",
            edits: [
              {
                address: { page_id: pageId, data_source_id: dataSourceId, property_id: "status" },
                edit: {
                  kind: "replace",
                  expected_value_revision: row.value.value.summary.database_value_revisions.status!,
                  value: { kind: "select", option_id: "review" },
                },
              },
            ],
          },
        ],
      });
      await expect
        .poll(() => stores.map((store) => store.read(sessionId)?.status?.optionId))
        .toEqual(["review", "review"]);
      const properties = await client.databaseRead({
        kind: "property_window",
        data_source_id: dataSourceId,
        window: { after: null, first: 50 },
      });
      if (properties.value.kind !== "property_window") throw new Error("Missing Properties");
      const status = properties.value.properties.items.find(
        (property) => property.property_id === "status",
      );
      if (!status) throw new Error("Missing Status Property");
      await client.databaseApply({
        operationId: createUuidV7(),
        intent: [
          {
            kind: "put_option",
            data_source_id: dataSourceId,
            property_id: "status",
            option_id: "review",
            name: "Ready for review",
            color: null,
            expected_property_revision: status.revision,
          },
        ],
      });
      await expect
        .poll(() => stores.map((store) => store.read(sessionId)?.status?.label))
        .toEqual(["Ready for review", "Ready for review"]);
      const notesPageId = createUuidV7();
      await ctx.seed.createStandalonePage({
        pageId: notesPageId,
        documentId: createUuidV7(),
        operationId: createUuidV7(),
        projectId,
        title: "Research notes",
      });
      const linkedNotes = await client.workspaceApply({
        operationId: createUuidV7(),
        intent: {
          kind: "mutate_session",
          session_id: sessionId,
          intent: { kind: "link_page", page_id: notesPageId },
        },
      });
      await expect
        .poll(() =>
          recipients.every(
            (recipient) => recipient.readCommitHead() >= applyResultCursor(linkedNotes),
          ),
        )
        .toBe(true);
      await expect
        .poll(() => stores.map((store) => store.read(sessionId)?.status?.label))
        .toEqual(["Ready for review", "Ready for review"]);
      await client.workspaceApply({
        operationId: createUuidV7(),
        intent: {
          kind: "mutate_session",
          session_id: sessionId,
          intent: { kind: "unlink_page", page_id: pageId },
        },
      });
      await expect
        .poll(() => stores.map((store) => store.read(sessionId)))
        .toEqual(
          stores.map(() => ({
            pageId: notesPageId,
            pageKey: null,
            title: "Research notes",
            status: null,
          })),
        );
      const relinkedWork = await client.workspaceApply({
        operationId: createUuidV7(),
        intent: {
          kind: "mutate_session",
          session_id: sessionId,
          intent: { kind: "link_page", page_id: pageId },
        },
      });
      await expect
        .poll(() =>
          recipients.every(
            (recipient) => recipient.readCommitHead() >= applyResultCursor(relinkedWork),
          ),
        )
        .toBe(true);
      await expect
        .poll(() => stores.map((store) => store.read(sessionId)?.pageId))
        .toEqual([notesPageId, notesPageId]);
      expect(stores.map((store) => store.read(sessionId)?.status)).toEqual([null, null]);
      await client.workspaceApply({
        operationId: createUuidV7(),
        intent: {
          kind: "mutate_session",
          session_id: sessionId,
          intent: { kind: "unlink_page", page_id: notesPageId },
        },
      });
      await expect
        .poll(() => stores.map((store) => store.read(sessionId)?.pageId))
        .toEqual([pageId, pageId]);
      expect(applyResultCursor(changed)).toBeGreaterThan(row.commit_head);
      expect(repairs).toEqual([]);
    } finally {
      left.close();
      right?.close();
    }
  });
});
