import { runWithScenarioCore } from "../../../scripts/scenarios/adapters/core-client-seed-runtime";
import { expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { components } from "@nodex/core-protocol";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { prepareSeededAutomationCheck } from "../../../scripts/scenarios/seed/automation-event";
import { createUuidV7 } from "../../shared/uuid-v7";
import { createHostedAppToolCaller } from "../app-tools/AppToolCaller";
import { hostToolTestServices } from "../app-tools/host-tools.test-support";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import type { ProjectWorkspaceRead, ProjectWorkspaceApplyInput } from "../core-client/types";
import { CoreModules } from "../core-runtime/CoreModules";
import { AgentRuntimeApplication } from "./AgentRuntimeApplication";
import { make } from "./AgentRuntimeHostTools";

type Model = components["schemas"];
test("Coordinator Host replies queue a Channel outbox item and read/submit settle an Automation assessment", async () => {
  await withCoreScenario(
    { scenarioId: "automations/events" },
    async ({ client, manifest, runtime }) => {
      const coordinator = manifest.entityIdsByKey!.eventCoordinator!;
      const { provenance, command } = await prepareSeededAutomationCheck(client, coordinator, 2);
      const a = provenance.authority;
      const authority = {
        threadId: a.thread_id,
        rootThreadId: a.root_thread_id,
        turnId: a.turn_id,
        actorProjectId: a.actor_project_id,
        libraryId: a.library_id,
        storeEpoch: a.store_epoch,
        admittedAtMs: Date.now(),
        runtime: {
          sessionId: coordinator,
          runtimeId: a.runtime!.runtime_id,
          turnKind: "run" as const,
        },
      };
      const services = Layer.mergeAll(
        hostToolTestServices,
        Layer.mock(CoreAuthority, { identity: { profileId: provenance.profile_id } } as never),
        Layer.mock(CoreModules, {
          workspace: {
            read: (read: ProjectWorkspaceRead) =>
              Effect.tryPromise(() => client.workspaceRead(read)),
            apply: (input: ProjectWorkspaceApplyInput) =>
              Effect.tryPromise(() => client.workspaceApply(input)),
        } as never),
        Layer.mock(AgentRuntimeApplication, { runOutcome: () => Effect.succeed(null) } as never),
      );
      const call = (name: string, input: Record<string, unknown>) =>
        runWithScenarioCore(
          Effect.gen(function* () {
            const execute = yield* make.pipe(Effect.provide(services));
            return yield* execute(
              createHostedAppToolCaller({
                backend: "codex",
                authority,
                callId: createUuidV7(),
                generation: 1,
                isActive: () => true,
                capture: Effect.succeed(authority),
      const read = await call("automation_assessment_read", {
        request_id: command.request_id,
        generation: command.generation,
        resource: "triggers",
      });
      expect(read.isError, JSON.stringify(read)).toBeUndefined();
      expect(read.structuredContent).toMatchObject({
        kind: "resource",
        value: {
          request_id: command.request_id,
          items: command.automation_assessments[0]!.evidence_ids.map((id) =>
            expect.objectContaining({ id, kind: "check" }),
          ),
        },
      const { kind: _, ...submission } = command;
      expect(await call("automation_assessment_submit", submission)).toMatchObject({
        structuredContent: { recorded: true, requeued: false },
        await client.workspaceRead({
          kind: "automation_assessments",
          read: { kind: "request", request_id: command.request_id },
      ).toMatchObject({ value: { value: { request: null } } });
      // An independently discovered issue enters Inbox through the public Source boundary.
      const source = await client.workspaceRead({
        kind: "sources",
        read: { kind: "sources", after_id: null, limit: 100 },
      if (source.value.kind !== "sources" || source.value.value.kind !== "sources")
        throw new Error("Missing Source");
      const s = source.value.value.sources.find((s) => s.id === "github:automation-events")!;
      const applySource = (command: Model["SourceCommand"]) =>
        client.workspaceApply({ operationId: createUuidV7(), intent: { kind: "source", command } });
      const revision = s.revision + 1;
      await applySource({
        kind: "configure_source",
        source_id: s.id,
        expected_revision: s.revision,
        enabled: true,
        config: { ...s.config, discovery: { ...s.config.discovery, assigned: true } },
      const token = createUuidV7();
      await applySource({
        kind: "claim_source_partition",
        source_id: s.id,
        config_revision: revision,
        partition: "repo:10",
        lease_token: token,
        lease_duration_ms: 120000,
      const positions = await client.workspaceRead({
        kind: "sources",
        read: { kind: "positions", source_id: s.id, after_partition: null, limit: 1 },
      if (positions.value.kind !== "sources" || positions.value.value.kind !== "positions")
        throw new Error("Missing position");
      const position = positions.value.value.positions[0]!;
      const thread: Model["ExternalThread"] = {
        id: "github:github.com:10:778",
        host: "github.com",
        repository_id: "10",
        repository: "nodex/scenario",
        number: 778,
        kind: "issue",
        url: "https://github.com/nodex/scenario/issues/778",
        title: "Fix docs",
        state: "open",
        observation_revision: 0,
        observations: {},
      await applySource({
        kind: "ingest_source_batch",
        source_id: s.id,
        config_revision: revision,
        partition: "repo:10",
        expected_position: position.revision,
        lease_token: token,
        threads: [thread],
        triggers: [
            semantic_key: "github:github.com:10:assigned:778",
            kind: "discovery_assigned",
            occurred_at_ms: Date.now(),
            actor_login: "person",
            actor_class: "person",
            thread_id: thread.id,
            text: "Please fix the docs",
            metadata: {},
            url: thread.url,
        next_position: position.cursor,
        next_poll_at_ms: 0,
        quarantine: [],
      const inbox = await client.workspaceRead({
        kind: "inbox_window",
        scope: { kind: "library" },
        filter: "inbox",
        window: { after: null, first: 100 },
      if (inbox.value.kind !== "inbox_window") throw new Error("Missing Inbox");
      const entry = inbox.value.items.items.find((item) => item.source.kind === "github")!;
      expect(entry).toBeDefined();
      await client.workspaceApply({
        operationId: createUuidV7(),
        intent: {
          kind: "dispatch_inbox_entries",
          proposal_id: createUuidV7(),
          page_ids: [entry.page_id],
          basis: [entry.basis],
          expected_store_epoch: client.handshake.store_epoch,
          action: {
            type: "new_chat",
            project_id: manifest.projectId,
            prompt: "Fix the docs",
            additions: [],
            agent: null,
          execution_selection: {
            model_selection: { instanceId: "codex", model: "model" },
            interaction_mode: "default",
          session_id: createUuidV7(),
        },
      });
      const reply = await call("reply_to_origin", {
        pageId: entry.page_id,
        body: "I have started on this request.",
      });
      expect(reply, JSON.stringify(reply)).toMatchObject({
        structuredContent: { pageId: entry.page_id, queued: true },
      });
      const outbox = await client.workspaceRead({
        kind: "sources",
        read: { kind: "channel_outbox", limit: 100, after_id: null, include_terminal: false },
      expect(outbox).toMatchObject({
        value: {
          kind: "sources",
            kind: "channel_outbox",
            items: [expect.objectContaining({ page_id: entry.page_id })],
        },
    },
  );
});
