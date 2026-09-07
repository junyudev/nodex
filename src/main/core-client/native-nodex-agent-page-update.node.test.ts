import type { components } from "@nodex/core-protocol";
import { expect, test } from "vite-plus/test";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import { UpdatePageV3InputSchema } from "../../shared/nodex-agent-tools/v3-write-schemas";
import { createUuidV7 } from "../../shared/uuid-v7";
import { CoreClient } from "./core-client";
import { toCoreAgentExecutionAuthorization } from "./core-agent-execution-authorization";
import {
  applyNativeNodexAgentPageUpdate,
  prepareNativeNodexAgentPageUpdate,
} from "./native-nodex-agent-page-update";

test("guarded Page patches preserve their observed body through native preparation and commit", async () => {
  await withCoreScenario({ scenarioId: "agent/cli-workflow" }, async (context) => {
    const { runtime, manifest } = context;
    const projectId = manifest.projectId;
    const pageId = manifest.pageIdsByKey.meeting;
    const client = runtime.clientForProject(projectId);
    const threadId = "thread:guarded-page-patch";
    const turnId = "turn:guarded-page-patch";
    await context.seed.replaceOwnedDocument({
      projectId,
      pageId,
      nfm: "Release date: Friday.\n\n- Keep **rollback** checklist.\n\t- Verify backups.",
      operationId: createUuidV7(),
      mutationId: createUuidV7(),
      clientSessionId: "guarded-patch-seed",
    });
    await client.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "upsert_thread",
        thread_id: threadId,
        patch: {
          project_id: projectId,
          thread_name: "Guarded Page patch",
          created_at: 1,
          updated_at: 1,
          linked_at: new Date().toISOString(),
        },
      },
    });
    await client.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "freeze_turn_authority",
        read_only: false,
        thread_id: threadId,
        turn_id: turnId,
        root_thread_id: threadId,
        actor_project_id: projectId,
        source: "project_turn",
      },
    });
    const frozen = await client.workspaceRead({
      kind: "turn_authority",
      thread_id: threadId,
      turn_id: turnId,
      root_thread_id: threadId,
      actor_project_id: projectId,
    });
    if (frozen.value.kind !== "turn_authority" || !frozen.value.resolution.frozen_at_ms) {
      throw new Error("Expected persisted Turn authority");
    }
    const authority: FrozenNodexAgentTurnAuthority = {
      threadId,
      turnId,
      rootThreadId: threadId,
      actorProjectId: projectId,
      libraryId: runtime.identity.libraryId,
      storeEpoch: runtime.identity.storeEpoch,
      frozenAtMs: frozen.value.resolution.frozen_at_ms,
      readOnly: false,
      scope: "project",
      source: "project_turn",
    };
    const content = await runtime.rootClient.libraryRead({ kind: "page_content", page_id: pageId });
    if (content.value.kind !== "page_content") throw new Error("Expected Page content");
    const documentId = content.value.value.document_id;
    const read = async () => {
      const result = await client.documentRead(`nodex-agent:${threadId}`, {
        kind: "agent_semantic_snapshot",
        store_epoch: authority.storeEpoch,
        authorization: toCoreAgentExecutionAuthorization(
          runtime.identity.profileId,
          authority,
          createUuidV7(),
        ),
        document_id: documentId,
        target_block_id: pageId,
        prepare_title: true,
        prepare_body: true,
        block_guards: [],
      });
      if (result.value.kind !== "agent_semantic_snapshot") {
        throw new Error("Expected semantic Page snapshot");
      }
      const snapshot = result.value.snapshot;
      if (!snapshot.body_etag || !snapshot.title_etag) throw new Error("Expected Page ETags");
      expect(snapshot.has_more).toBe(false);
      return { ...snapshot, body_etag: snapshot.body_etag, title_etag: snapshot.title_etag };
    };
    const writer = await CoreClient.connect({
      nodexHome: context.profile.nodexHome,
      clientKind: "native_cli",
      buildId: "guarded-patch-writer",
      projectId,
    });
    const write = async (command: components["schemas"]["DocumentSemanticCommand"]) => {
      const current = await read();
      return writer.documentApply({
        operationId: createUuidV7(),
        clientSessionId: "guarded-patch-writer",
        intent: {
          kind: "apply_semantic_mutation",
          document_id: documentId,
          generation: current.generation,
          expected_head_seq: current.head_seq,
          commands: [command],
        },
      });
    };
    const prepare = (ifMatch: string) =>
      prepareNativeNodexAgentPageUpdate(runtime, {
        projectId,
        threadId,
        callId: createUuidV7(),
        authority,
        tool: "update_page",
        input: UpdatePageV3InputSchema.parse({
          pageId,
          body: {
            kind: "patch",
            ifMatch,
            patches: [
              { oldMarkdown: "Release date: Friday.", newMarkdown: "Release date: Monday." },
            ],
          },
        }),
      });

    const observed = await read();
    await write({
      kind: "patch_body",
      old_fragment: "Verify backups.",
      new_fragment: "Verify backups twice.",
    });
    const beforeStalePrepare = await read();
    expect(beforeStalePrepare.head_seq).toBeGreaterThan(observed.head_seq);
    const stale = await prepare(observed.body_etag);
    expect(stale.result.result).toMatchObject({
      ok: false,
      error: {
        code: "conflict",
        recovery: "fetch_again",
        details: { domainCode: "revision_conflict" },
      },
    });
    expect(await read()).toEqual(beforeStalePrepare);

    const racing = await prepare(beforeStalePrepare.body_etag);
    if (
      racing.transition.kind !== "retain" ||
      !racing.result.result.ok ||
      racing.result.result.value.kind !== "prepared"
    )
      throw new Error("Expected guarded Page preparation");
    await write({
      kind: "patch_body",
      old_fragment: "Verify backups twice.",
      new_fragment: "Verify backups three times.",
    });
    const beforeRacingApply = await read();
    const raced = await applyNativeNodexAgentPageUpdate(
      runtime,
      racing.transition.pending,
      racing.result.result.value.mutation,
    );
    expect(raced.result).toMatchObject({ ok: false, error: { code: "document_head_conflict" } });
    expect(await read()).toEqual(beforeRacingApply);

    await write({
      kind: "set_title",
      inline_markdown: "Concurrent **title**",
      expected_etag: beforeRacingApply.title_etag,
    });
    const titleChanged = await read();
    expect(titleChanged.body_etag).toBe(beforeRacingApply.body_etag);
    const ready = await prepare(beforeRacingApply.body_etag);
    if (
      ready.transition.kind !== "retain" ||
      !ready.result.result.ok ||
      ready.result.result.value.kind !== "prepared"
    )
      throw new Error("Expected fresh guarded Page preparation");
    const applied = await applyNativeNodexAgentPageUpdate(
      runtime,
      ready.transition.pending,
      ready.result.result.value.mutation,
    );
    expect(applied.result, JSON.stringify(applied.result)).toMatchObject({ ok: true });
    const after = await read();
    expect(after.title).toBe("Concurrent title");
    expect(after.rich_title).toEqual(titleChanged.rich_title);
    expect(after.nested_markdown).toBe(
      beforeRacingApply.nested_markdown.replace("Release date: Friday.", "Release date: Monday."),
    );
    const target = beforeRacingApply.blocks.find((block) =>
      JSON.stringify(block.content).includes("Release date: Friday."),
    );
    if (!target) throw new Error("Expected the release date Block");
    expect(after.blocks.map((block) => block.block_id)).toEqual(
      beforeRacingApply.blocks.map((block) => block.block_id),
    );
    expect(after.blocks.filter((block) => block.block_id !== target.block_id)).toEqual(
      beforeRacingApply.blocks.filter((block) => block.block_id !== target.block_id),
    );
    const updated = after.blocks.find((block) => block.block_id === target.block_id);
    expect(updated).toEqual({ ...target, content: updated?.content });
    expect(updated?.content).toEqual([{ type: "text", text: "Release date: Monday.", styles: {} }]);
    expect(ready.result.result.value.effects).toMatchObject({
      createdBlockIds: [],
      deletedBlockIds: [],
      updatedBlockIds: [target.block_id],
    });
  });
});
