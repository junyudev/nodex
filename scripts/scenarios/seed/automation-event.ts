import type { CoreClient } from "../../../src/main/core-client/core-client";
import type { components } from "@nodex/core-protocol";
import { createUuidV7 } from "../../../src/shared/uuid-v7";

type Model = components["schemas"];
/** A current-schema check failure crosses the same atomic Source ingestion boundary as polling. */
export async function prepareSeededAutomationCheck(
  client: Pick<CoreClient, "workspaceRead" | "workspaceApply" | "handshake">,
  coordinatorSessionId: string,
  sequence: number,
) {
  const sourceId = "github:automation-events";
  const read = await client.workspaceRead({
    kind: "sources",
    read: { kind: "sources", after_id: null, limit: 100 },
  });
  const source =
    read.value.kind === "sources" && read.value.value.kind === "sources"
      ? read.value.value.sources.find((s) => s.id === sourceId)
      : null;
  const config: Model["GitHubSourceConfig"] = {
    host: "github.com",
    account_id: "1",
    account_login: "scenario",
    credential_ref: "gh:github.com:scenario",
    repositories: [{ id: "10", name: "nodex/scenario", enabled: true }],
    discovery: { assigned: false, mentions: false, review_requests: false },
  };
  const apply = (command: Model["SourceCommand"]) =>
    client.workspaceApply({ operationId: createUuidV7(), intent: { kind: "source", command } });
  const revision = (source?.revision ?? 0) + 1;
  await apply({
    kind: "configure_source",
    source_id: sourceId,
    expected_revision: source?.revision ?? 0,
    enabled: true,
    config,
  });
  const token = createUuidV7();
  await apply({
    kind: "claim_source_partition",
    source_id: sourceId,
    config_revision: revision,
    partition: "repo:10",
    lease_token: token,
    lease_duration_ms: 120000,
  });
  const positions = await client.workspaceRead({
    kind: "sources",
    read: { kind: "positions", source_id: sourceId, after_partition: null, limit: 1 },
  });
  if (positions.value.kind !== "sources" || positions.value.value.kind !== "positions")
    throw new Error("Missing Source position");
  const position = positions.value.value.positions[0]!;
  const known = await client.workspaceRead({
    kind: "sources",
    read: { kind: "threads", host: "github.com", repository_id: "10", after_id: null, limit: 100 },
  });
  const observed =
    known.value.kind === "sources" && known.value.value.kind === "threads"
      ? known.value.value.threads.find((t) => t.id === "github:github.com:10:777")
      : null;
  const thread: Model["ExternalThread"] = {
    id: "github:github.com:10:777",
    host: "github.com",
    repository_id: "10",
    repository: "nodex/scenario",
    number: 777,
    kind: "pull_request",
    url: "https://github.com/nodex/scenario/pull/777",
    title: "Restore the failing build",
    state: "open",
    observation_revision: observed?.observation_revision ?? 0,
    observations: {},
  };
  await apply({
    kind: "ingest_source_batch",
    source_id: sourceId,
    config_revision: revision,
    partition: "repo:10",
    expected_position: position.revision,
    lease_token: token,
    threads: [thread],
    triggers: [
      {
        semantic_key: `github:github.com:10:check:seed:${sequence}:failure`,
        kind: "check",
        occurred_at_ms: Date.now(),
        actor_login: "github-actions",
        actor_class: "ci",
        thread_id: thread.id,
        text: "Build failed: the typecheck found a missing export.",
        metadata: { state: "failure" },
        url: thread.url,
      },
    ],
    next_position: position.cursor,
    next_poll_at_ms: Date.now() + 86_400_000,
    quarantine: [],
  });
  await apply({
    kind: "configure_source",
    source_id: sourceId,
    expected_revision: revision,
    enabled: false,
    config,
  });
  const pending = await client.workspaceRead({
    kind: "automation_assessments",
    read: { kind: "pending", limit: 8 },
  });
  if (pending.value.kind !== "automation_assessments" || pending.value.value.kind !== "pending")
    throw new Error("Missing assessment queue");
  let request = pending.value.value.requests.find((r) => r.thread_id === thread.id);
  if (!request) throw new Error("Check failure did not request an Automation assessment");
  const command = (command: Model["AutomationAssessmentCommand"]) =>
    client.workspaceApply({
      operationId: createUuidV7(),
      intent: { kind: "automation_assessment", command },
    });
  await command({
    kind: "begin",
    request_id: request.request_id,
    generation: request.generation,
    coordinator_session_id: coordinatorSessionId,
  });
  await command({
    kind: "start_run",
    request_id: request.request_id,
    generation: request.generation,
    coordinator_session_id: coordinatorSessionId,
    started_at_ms: Date.now(),
  });
  const binding = await client.workspaceRead({
    kind: "agent_runtime_session_binding",
    session_id: coordinatorSessionId,
  });
  if (binding.value.kind !== "agent_runtime_session_binding" || !binding.value.binding)
    throw new Error("Missing Coordinator binding");
  const b = binding.value.binding;
  return {
    provenance: {
      profile_id: client.handshake.generation.profile_id,
      authority: {
        thread_id: b.runtime_thread_id,
        root_thread_id: b.runtime_thread_id,
        turn_id: `scenario:assessment:${sequence}`,
        actor_project_id: null,
        library_id: client.handshake.library_id,
        store_epoch: client.handshake.store_epoch,
        runtime: { session_id: coordinatorSessionId, runtime_id: b.runtime_id, turn_kind: "run" },
      },
    } satisfies Model["AgentTurnProvenance"],
    command: {
      kind: "submit",
      request_id: request.request_id,
      generation: request.generation,
      policy_hash: request.policy_hash,
      automation_assessments: request.automations.map((automation) => ({
        automation_id: automation.automation_id,
        revision: automation.automation_revision,
        matched: true,
        reason: "The seeded CI check failed in this Project's repository.",
        evidence_ids: [...request!.trigger_ids],
      })),
      proposed_actions: request.automations.map((automation) => ({
        automation_ids: [automation.automation_id],
        scope: { kind: "project", project_id: automation.project_id! },
        title: "Investigate the failing build",
        body: "Investigate the failing typecheck and propose a fix.",
        execution_target: {
          instanceId: "codex",
          model: automation.model!,
          effort: automation.reasoning_effort ?? null,
        },
        thread_id: thread.id,
      })),
    } satisfies Extract<Model["AutomationAssessmentCommand"], { kind: "submit" }>,
  };
}

export async function assessSeededAutomationCheck(
  client: Pick<CoreClient, "workspaceRead" | "workspaceApply" | "handshake">,
  coordinatorSessionId: string,
  sequence: number,
) {
  const { provenance, command } = await prepareSeededAutomationCheck(
    client,
    coordinatorSessionId,
    sequence,
  );
  await client.workspaceApply({
    operationId: createUuidV7(),
    intent: {
      kind: "agent_command",
      provenance,
      intent: { kind: "automation_assessment", command },
    },
  });
}
