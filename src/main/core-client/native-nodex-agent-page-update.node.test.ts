import { describe, expect, test } from "vite-plus/test";
import type { components } from "@nodex/core-protocol";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import { UpdatePageV3InputSchema } from "../../shared/nodex-agent-tools/v3-write-schemas";
import { appContentResults } from "../../shared/nodex-app-tools/content-results";
import { createUuidV7 } from "../../shared/uuid-v7";
import { CoreClient } from "./core-client";
import {
  toCoreAgentExecutionAuthorization,
  toCoreAgentTurnProvenance,
} from "./core-agent-execution-authorization";
import {
  applyNativeNodexAgentPageUpdate,
  prepareNativeNodexAgentPageUpdate,
} from "./native-nodex-agent-page-update";
import { it } from "vitest";
import { BlockIdSchema } from "../../shared/nodex-agent-tools/base-schemas";
import type { NativeNodexAgentCore } from "./native-nodex-agent-core";
import {
  readNativeFetch,
  readNativeFetchObservation,
  type NativeNodexAgentFetchRequest,
} from "./native-nodex-agent-fetch";
import { FakeCoreClient } from "./testing/fake-core-client";
import { AGENT_CLI_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/agent-cli-workflow";
import {
  createBoundedOperationId,
  isBoundedOperationId,
  OPERATION_IDENTITY_WINDOW_MS,
} from "../../shared/operation-identity";
import type { AppToolOperationRequest } from "./types";

describe("native-nodex-agent-page-update", () => {
  type CoreScenarioContext = Parameters<Parameters<typeof withCoreScenario>[1]>[0];

  /** The scenario's meeting Page with the given body, and an admitted Agent Turn that may edit it. */
  async function agentPage(context: CoreScenarioContext, key: string, markdown: string) {
    const { runtime, manifest } = context;
    const projectId = manifest.projectId;
    const pageId = manifest.pageIdsByKey.meeting;
    const client = runtime.clientForProject(projectId);
    const threadId = `thread:${key}`;
    const turnId = `turn:${key}`;
    await context.seed.replaceOwnedDocument({
      projectId,
      pageId,
      markdown,
      operationId: createUuidV7(),
      mutationId: createUuidV7(),
      clientSessionId: `${key}-seed`,
    });
    await client.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "create_session",
        session_id: `session:${key}`,
        project_id: projectId,
        title: key,
        initial_page_ids: [pageId],
      },
    });
    await client.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "upsert_thread",
        thread_id: threadId,
        patch: {
          project_id: projectId,
          thread_name: key,
          created_at: 1,
          updated_at: 1,
          linked_at: new Date().toISOString(),
        },
      },
    });
    await client.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "mutate_session",
        session_id: `session:${key}`,
        intent: {
          kind: "link_thread",
          thread_id: threadId,
          expected_project_id: projectId,
        },
      },
    });
    await client.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "admit_turn_authority",

        thread_id: threadId,
        turn_id: turnId,
        root_thread_id: threadId,
        actor_project_id: projectId,
      },
    });
    const frozen = await client.workspaceRead({
      kind: "turn_authority",
      thread_id: threadId,
      turn_id: turnId,
      root_thread_id: threadId,
      actor_project_id: projectId,
    });
    if (frozen.value.kind !== "turn_authority" || !frozen.value.resolution.admitted_at_ms) {
      throw new Error("Expected persisted Turn authority");
    }
    const authority: NodexAgentTurnContext = {
      threadId,
      turnId,
      rootThreadId: threadId,
      actorProjectId: projectId,
      libraryId: runtime.identity.libraryId,
      storeEpoch: runtime.identity.storeEpoch,
      admittedAtMs: frozen.value.resolution.admitted_at_ms,
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
    const update = async (body: unknown) => {
      const prepared = await prepareNativeNodexAgentPageUpdate(runtime, {
        projectId,
        threadId,
        callId: createUuidV7(),
        authority,
        tool: "update_page",
        input: UpdatePageV3InputSchema.parse({ pageId, body }),
      });
      if (
        prepared.transition.kind !== "retain" ||
        !prepared.result.result.ok ||
        prepared.result.result.value.kind !== "prepared"
      )
        throw new Error(`Expected Page preparation: ${JSON.stringify(prepared.result)}`);
      return applyNativeNodexAgentPageUpdate(
        runtime,
        prepared.transition.pending,
        prepared.result.result.value.mutation,
      );
    };
    return { runtime, projectId, pageId, documentId, authority, threadId, read, update };
  }

  test("guarded Page patches preserve their observed body through native preparation and commit", async () => {
    await withCoreScenario({ scenarioId: "agent/cli-workflow" }, async (context) => {
      const { runtime, projectId, pageId, documentId, authority, threadId, read } = await agentPage(
        context,
        "guarded-page-patch",
        "Release date: Friday.\n\n- Keep **rollback** checklist.\n  - Verify backups.",
      );
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
      expect(after.markdown).toBe(
        beforeRacingApply.markdown.replace("Release date: Friday.", "Release date: Monday."),
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
      expect(updated?.content).toEqual([
        { type: "text", text: "Release date: Monday.", styles: {} },
      ]);
      expect(ready.result.result.value.effects).toMatchObject({
        createdBlockIds: [],
        deletedBlockIds: [],
        updatedBlockIds: [target.block_id],
      });
    });
  });

  test("an Agent inserts and replaces Page content with Nodex Markdown", async () => {
    await withCoreScenario({ scenarioId: "agent/cli-workflow" }, async (context) => {
      const { read, update } = await agentPage(
        context,
        "markdown-page-write",
        "Existing paragraph",
      );

      const inserted = await update({
        kind: "insert",
        at: { kind: "end" },
        markdown: "- Plan\n  - nested\n\n> [!NOTE]\n> Rollback is a flag flip.",
      });
      expect(inserted.result, JSON.stringify(inserted.result)).toMatchObject({ ok: true });
      expect((await read()).markdown).toBe(
        "Existing paragraph\n\n- Plan\n  - nested\n\n> [!NOTE]\n> Rollback is a flag flip.",
      );

      const replaced = await update({
        kind: "replace",
        ifMatch: (await read()).body_etag,
        markdown: "## Steps\n\n1. Export\n2. Import\n\nCosts $5.",
      });
      expect(replaced.result, JSON.stringify(replaced.result)).toMatchObject({ ok: true });
      expect((await read()).markdown).toBe("## Steps\n\n1. Export\n2. Import\n\nCosts $5.");
    });
  });

  test("an admitted update_page commits body and Property values together and replays the receipt", async () => {
    await withCoreScenario({ scenarioId: "agent/cli-workflow" }, async (context) => {
      const { runtime, projectId, pageId, threadId, authority, read } = await agentPage(
        context,
        "retry-page-values",
        "Original body",
      );
      const client = runtime.clientForProject(projectId);
      const input = UpdatePageV3InputSchema.parse({
        pageId,
        body: { kind: "replace", ifMatch: (await read()).body_etag, markdown: "Revised body" },
        return: ["markdown"],
        values: [{ propertyId: "Status", value: "done" }],
      });
      const { operation_id: operationId } = await client.admitAppToolOperation({
        tool_name: "update_page",
        idempotency_key: "retry-page-values",
        request_hash: "a".repeat(64),
        provenance: toCoreAgentTurnProvenance(runtime.identity.profileId, authority),
      });
      const prepare = () =>
        prepareNativeNodexAgentPageUpdate(runtime, {
          projectId,
          threadId,
          callId: createUuidV7(),
          authority,
          operationId,
          tool: "update_page",
          input,
        });
      const first = await prepare();
      if (
        !first.result.result.ok ||
        first.result.result.value.kind !== "prepared" ||
        first.transition.kind !== "retain"
      )
        throw new Error(`Expected Page preparation: ${JSON.stringify(first.result)}`);
      const applied = await applyNativeNodexAgentPageUpdate(
        runtime,
        first.transition.pending,
        first.result.result.value.mutation,
      );
      if (!applied.result.ok || applied.transition.kind !== "retain")
        throw new Error(`Expected committed Page values: ${JSON.stringify(applied.result)}`);
      expect((await read()).markdown).toBe("Revised body");
      const replay = (await prepare()).result.result;
      expect(replay).toMatchObject({
        ok: true,
        value: {
          kind: "completed",
          output: {
            data: {
              body: { markdown: "Revised body" },
              values: [{ propertyId: "status", after: "done" }],
            },
          },
        },
      });
    });
  });
});

describe("native-nodex-agent-fetch", () => {
  const pageId = "01980000-0000-7000-8000-000000000001";
  const documentId = "01980000-0000-7000-8000-000000000002";
  const etag = `nxe2.${"a".repeat(43)}`;
  const authority: NodexAgentTurnContext = {
    threadId: "thread:actor",
    turnId: "turn:actor",
    rootThreadId: "thread:actor",
    actorProjectId: "project:actor",
    libraryId: "library:current",
    storeEpoch: "epoch:current",

    admittedAtMs: 1,
  };
  const request: NativeNodexAgentFetchRequest = {
    tool: "fetch",
    projectId: authority.actorProjectId,
    authority,
    callId: "call:exact",
    input: {
      id: BlockIdSchema.parse(pageId),
      format: "markdown",
      includeDataSource: false,
      prepareFor: [{ kind: "title" }, { kind: "body" }],
    },
  };

  const fixture = (
    snapshotEpoch = authority.storeEpoch,
    intake?: components["schemas"]["CompactPageIntake"],
  ) => {
    const client = new FakeCoreClient();
    client.enqueueRead({
      contract_version: 52,
      store_epoch: authority.storeEpoch,
      commit_head: 8,
      value: {
        kind: "agent_block_target",
        value: {
          block_id: pageId,
          block_type: "page",
          lifecycle: "active",
          owner_page_id: pageId,
          document_id: documentId,
          document_generation: 2,
          ...(intake ? { intake } : {}),
          owner_page: {
            page: {
              title: "Old detail title",
              parent: { kind: "library", libraryId: authority.libraryId },
            },
            data_source_context: { kind: "standalone" },
            intrinsic_properties: [],
          },
        },
      },
    } as never);
    client.enqueueDocumentRead({
      contract_version: 14,
      store_epoch: snapshotEpoch,
      commit_head: 12,
      value: {
        kind: "agent_semantic_snapshot",
        snapshot: {
          document_id: documentId,
          owner_block_id: pageId,
          target_block_id: pageId,
          generation: 2,
          head_seq: 11,
          rich_title: [{ type: "text", text: "Current title", styles: {} }],
          markdown: "- Current paragraph\n",
          plain_text: "Current paragraph",
          blocks: [],
          title_etag: etag,
          body_etag: etag,
          has_more: false,
          next_cursor: null,
        },
      },
    } as never);
    const projects: string[] = [];
    const runtime = {
      identity: { profileId: "profile:current" },
      rootClient: client,
      clientForProject: (projectId: string) => {
        projects.push(projectId);
        return client;
      },
    } as unknown as NativeNodexAgentCore;
    return { runtime, client, projects };
  };

  describe("canonical Page observations", () => {
    it("retains the title/body validators and fence from the same semantic snapshot", async () => {
      const { runtime, client, projects } = fixture();
      const controller = new AbortController();
      const result = await readNativeFetchObservation(request, runtime, controller.signal);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document).toEqual({
        documentId,
        ownerPageId: pageId,
        targetBlockId: pageId,
        storeEpoch: authority.storeEpoch,
        generation: 2,
        headSeq: 11,
        commitHead: 12,
      });
      expect(result.validators).toEqual({ title: etag, body: etag });
      expect(result.output.data.resource.title).toEqual({ markdown: "Current title", etag });
      expect(result.output.data.content).toMatchObject({
        format: "markdown",
        markdown: "- Current paragraph\n",
        etag,
      });
      expect(projects).toEqual([authority.actorProjectId]);
      expect(client.documentReads[0]?.read).toMatchObject({
        kind: "agent_semantic_snapshot",
        document_id: documentId,
        target_block_id: pageId,
        prepare_title: true,
        prepare_body: true,
      });
      expect(client.documentReadOptions[0]?.signal).toBe(controller.signal);
    });

    it("keeps ordinary fetch output unchanged and rejects a different Store epoch", async () => {
      const observed = await readNativeFetchObservation(request, fixture().runtime);
      const fetched = await readNativeFetch(request, fixture().runtime);
      expect(observed.ok).toBe(true);
      if (!observed.ok) return;
      expect(fetched).toEqual({ ok: true, tool: "fetch", output: observed.output });
      const summary = await readNativeFetchObservation(
        { ...request, input: { ...request.input, format: "summary", prepareFor: undefined } },
        fixture().runtime,
      );
      expect(summary.ok && summary.validators).toEqual({ title: etag, body: etag });
      expect((await readNativeFetchObservation(request, fixture("epoch:other").runtime)).ok).toBe(
        false,
      );
    });
  });

  it("preserves compact Inbox routing on the Page fetch resource", async () => {
    const intake = {
      source: { kind: "agent", label: "Release chat" },
      waiting: false,
      suggestion: null,
      handoff: {
        session_id: "session:destination",
        decided_at: "2026-11-26T00:00:00Z",
        confirmed_by: "user",
      },
    } as const;
    const result = await readNativeFetch(request, fixture(authority.storeEpoch, intake).runtime);
    expect(result.ok).toBe(true);
    if (!result.ok || result.tool !== "fetch") return;
    const published = appContentResults.fetch.serializeOutput(result.output);
    expect(published.success && published.data.data.resource.intake).toEqual(intake);

    const regular = await readNativeFetch(request, fixture().runtime);
    expect(
      regular.ok && regular.tool === "fetch" && regular.output.data.resource.intake,
    ).toBeUndefined();
  });

  it("reads projectless content through the unbound client with exact Library provenance", async () => {
    const { runtime, client, projects } = fixture();
    const projectless: NodexAgentTurnContext = {
      ...authority,

      actorProjectId: null,
    };
    const observed = await readNativeFetchObservation(
      { ...request, projectId: null, authority: projectless },
      runtime,
    );
    expect(observed.ok).toBe(true);
    expect(projects).toEqual([]);
    expect(client.documentReads[0]?.read).toMatchObject({});
  });
});

describe("app-tool-operation-admission", () => {
  test("application retry admission is atomic and restart-stable over the authenticated Core transport", async () => {
    await withCoreScenario({ scenarioId: AGENT_CLI_SCENARIO_ID }, async (scenario) => {
      const client = scenario.runtime.clientForProject(scenario.manifest.projectId);
      await client.workspaceApply({
        operationId: createBoundedOperationId("test.caller.create"),
        intent: {
          kind: "create_agent_runtime_session",
          session_id: "session:retry-caller",
          project_id: scenario.manifest.projectId,
          title: "Retry caller",
          initial_page_ids: [],
          runtime_id: "runtime:retry-contract",
          runtime_thread_id: "thread:retry-root",
          launch_request_id: "launch:retry-caller",
        },
      });
      const request = {
        tool_name: "send_message_to_session",
        idempotency_key: "06d6709c-45e7-4b37-8c26-74e9d64c5aa1",
        request_hash: "a".repeat(64),
        provenance: {
          profile_id: client.handshake.generation.profile_id,
          authority: {
            thread_id: "thread:retry-root",
            root_thread_id: "thread:retry-root",
            turn_id: "run:one",
            actor_project_id: scenario.manifest.projectId,
            library_id: client.handshake.library_id,
            store_epoch: client.handshake.store_epoch,
            runtime: {
              session_id: "session:retry-caller",
              runtime_id: "runtime:retry-contract",
              turn_kind: "run",
            },
          },
        },
      } satisfies AppToolOperationRequest;
      const [first, duplicate] = await Promise.all([
        client.admitAppToolOperation(request),
        client.admitAppToolOperation(request),
      ]);
      expect(duplicate).toEqual(first);
      expect(isBoundedOperationId(first.operation_id)).toBe(true);
      expect(first.accepted_at_ms).toBeGreaterThan(0);
      expect(first.expires_at_ms - first.accepted_at_ms).toBe(OPERATION_IDENTITY_WINDOW_MS);
      await expect(
        client.admitAppToolOperation({ ...request, request_hash: "b".repeat(64) }),
      ).rejects.toMatchObject({
        coreError: { code: "idempotency_key_reused" },
      });
      const pageRetry = { ...request, tool_name: "create_pages" };
      const pageOperation = await client.admitAppToolOperation(pageRetry);
      const pageRequest = {
        destination: { kind: "library" as const },
        pages: [{ title_markdown: "Retry receipt", markdown: "", values: [] }],
        include_block_ids: false,
        include_etags: false,
      };
      const authorization = { provenance: request.provenance, call_id: "call:one" };
      const preparePage = (core: typeof client, execution: typeof authorization) =>
        core.libraryRead({
          kind: "prepare_agent_create_pages",
          operation_id: pageOperation.operation_id,
          store_epoch: core.handshake.store_epoch,
          authorization: execution,
          request: pageRequest,
        });
      const prepared = (await preparePage(client, authorization)).value;
      if (prepared.kind !== "agent_create_pages_preparation")
        throw new Error("Expected preparation");
      const committed = await client.libraryApply({
        operationId: pageOperation.operation_id,
        intent: {
          kind: "execute_prepared_agent_create_pages",
          authorization: { authorization, token: prepared.value.preparation.token },
          request: pageRequest,
        },
      });
      const propertyRetry = {
        ...request,
        tool_name: "set_page_properties",
        idempotency_key: "triage1111-done-first",
      };
      const propertyOperation = await client.admitAppToolOperation(propertyRetry);
      const setStatus = (
        core: typeof client,
        execution: typeof authorization,
        value: string | null,
        operationId = propertyOperation.operation_id,
      ) =>
        core.databaseApply({
          operationId,
          intent: [
            {
              kind: "set_page_properties",
              authorization: execution,
              updates: [
                {
                  page_ids: [scenario.manifest.pageIdsByKey.meeting!],
                  values: [{ property_id: "Status", value }],
                },
              ],
            },
          ],
        });
      const set = await setStatus(client, authorization, "done");
      expect(set.receipt.page_properties?.[0]?.values[0]?.after).toBe("done");
      await expect(
        setStatus(client, authorization, null, createBoundedOperationId("test.clear.status")),
      ).rejects.toMatchObject({
        coreError: { code: "invalid_input", message: expect.stringContaining("plan (Todo)") },
      });
      await scenario.withStoppedCore(async () => {});
      const reopened = scenario.runtime.clientForProject(scenario.manifest.projectId);
      const retry = await reopened.admitAppToolOperation({
        ...request,
        provenance: {
          ...request.provenance,
          authority: { ...request.provenance.authority, turn_id: "run:later" },
        },
      });
      expect(retry).toEqual(first);
      const later = {
        ...request.provenance,
        authority: { ...request.provenance.authority, turn_id: "run:later" },
      };
      expect(await reopened.admitAppToolOperation({ ...pageRetry, provenance: later })).toEqual(
        pageOperation,
      );
      expect(await reopened.admitAppToolOperation({ ...propertyRetry, provenance: later })).toEqual(
        propertyOperation,
      );
      const repeated = await setStatus(
        reopened,
        { provenance: later, call_id: "call:two" },
        "done",
      );
      expect(repeated.receipt.duplicate).toBe(true);
      expect(repeated.receipt.page_properties).toEqual(set.receipt.page_properties);
      const replay = (await preparePage(reopened, { provenance: later, call_id: "call:two" }))
        .value;
      if (replay.kind !== "agent_create_pages_preparation") throw new Error("Expected replay");
      expect(replay.value.preparation.state).toBe("committed_replay");
      expect(replay.value.committed?.outcome.agent_create_pages).toEqual(
        committed.outcome.agent_create_pages,
      );
    });
  });
});
