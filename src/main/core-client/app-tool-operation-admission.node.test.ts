import { expect, test } from "vite-plus/test";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import {
  createBoundedOperationId,
  isBoundedOperationId,
  OPERATION_IDENTITY_WINDOW_MS,
} from "../../shared/operation-identity";
import type { AppToolOperationRequest } from "./types";

test("application retry admission is atomic and restart-stable over the authenticated Core transport", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (scenario) => {
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
    if (prepared.kind !== "agent_create_pages_preparation") throw new Error("Expected preparation");
    const committed = await client.libraryApply({
      operationId: pageOperation.operation_id,
      intent: {
        kind: "execute_prepared_agent_create_pages",
        authorization: { authorization, token: prepared.value.preparation.token },
        request: pageRequest,
      },
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
    const replay = (await preparePage(reopened, { provenance: later, call_id: "call:two" })).value;
    if (replay.kind !== "agent_create_pages_preparation") throw new Error("Expected replay");
    expect(replay.value.preparation.state).toBe("committed_replay");
    expect(replay.value.committed?.outcome.agent_create_pages).toEqual(
      committed.outcome.agent_create_pages,
    );
  });
});
