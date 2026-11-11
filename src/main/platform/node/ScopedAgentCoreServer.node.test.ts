/* @effect-diagnostics asyncFunction:off globalFetch:off preferSchemaOverJson:off -- Exercises real Native CLI, Core and bounded HTTP admission. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";
import { CORE_CLIENT_REQUIREMENTS } from "@nodex/core-protocol";
import { withCoreScenario } from "../../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../../scripts/scenarios/scenarios/document-sync-recovery";
import { requiredNativeExecutable } from "../../../../scripts/testing/native-artifacts";
import { CoreClient } from "../../core-client/core-client";
import { createBoundedOperationId } from "../../../shared/operation-identity";
import { openScopedAgentCore } from "./ScopedAgentCoreServer";

const exec = promisify(execFile);

test("a scoped Agent CLI reads content without Core paths and cannot use Host administration", async () => {
  await withCoreScenario({ scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID }, async (scenario) => {
    const host = await CoreClient.connect({
      nodexHome: scenario.profile.nodexHome,
      clientKind: "electron_host",
      buildId: "scoped-agent-test",
    });
    const sessionId = randomUUID();
    await host.forProject(scenario.manifest.projectId).workspaceApply({
      operationId: createBoundedOperationId("test.agent-content.session"),
      intent: {
        kind: "create_agent_runtime_session",
        session_id: sessionId,
        project_id: scenario.manifest.projectId,
        title: "Scoped content",
        initial_page_ids: [],
        runtime_id: "runtime:scoped-content",
        runtime_thread_id: "thread:scoped-content",
        launch_request_id: "launch:scoped-content",
      },
    });
    const attribution = await host.issueAgentAttribution({
      session_id: sessionId,
      backend: "codex",
    });
    let active = true;
    const server = await openScopedAgentCore(scenario.profile.nodexHome);
    try {
      const issue = () =>
        server.issue({
          owner: "thread:scoped-content",
          projectId: scenario.manifest.projectId,
          attribution,
          authorize: async () => active,
        });
      const connection = await issue();
      const env = {
        PATH: process.env.PATH,
        NODEX_AGENT_ENDPOINT: connection.endpoint,
        NODEX_AGENT_CREDENTIAL: connection.credential,
      };
      const cli = (args: readonly string[]) =>
        exec(
          requiredNativeExecutable("cli"),
          [
            "--json",
            "--expect-profile",
            host.handshake.generation.profile_id,
            "--project",
            scenario.manifest.projectId,
            ...args,
          ],
          { env, timeout: 10_000 },
        );
      const context = JSON.parse((await cli(["context"])).stdout);
      expect(context.result.profile.id).toBe(host.handshake.generation.profile_id);
      const read = JSON.parse((await cli(["read", scenario.manifest.pageIdsByKey.other!])).stdout);
      expect(read.result.content).toBe("This document remains independent.\n");
      const rename = [
        "page",
        "rename",
        scenario.manifest.pageIdsByKey.other!,
        "Retried Page",
        "--if-match",
        read.result.validators.title_etag,
        "--idempotency-key",
        "scoped/rename:1",
      ];
      const firstRename = JSON.parse((await cli(rename)).stdout).result;
      const retryRename = JSON.parse((await cli(rename)).stdout).result;
      expect(retryRename).toMatchObject({
        duplicate: true,
        page_id: firstRename.page_id,
        head_seq: firstRename.head_seq,
      });
      const authorization = { authorization: `Bearer ${connection.credential}` };
      const bootstrap = await fetch(`${connection.endpoint}/agent/context`, {
        headers: authorization,
      }).then((response) => response.text());
      expect(bootstrap.includes(scenario.profile.nodexHome)).toBe(false);
      await expect(cli(["space", "devices"])).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining("Host administration is unavailable"),
      });
      await expect(cli(["service", "status"])).rejects.toMatchObject({ code: 2 });
      for (const path of [
        "/core/v1/admin/space/invite",
        "/core/v1/shutdown",
        "/core/v1/agent-attributions",
        "/core/v1/modules/administration/read",
        "/core/v1/handshake",
      ]) {
        const response = await fetch(`${connection.endpoint}${path}`, {
          method: "POST",
          headers: { ...authorization, "content-type": "application/json" },
          body: "{}",
        });
        expect(response.status).toBe(403);
        await response.arrayBuffer();
      }
      // Headers supplied by the Agent cannot turn a content request into a command that stays
      // the person's own, such as whether Nodex may start their requests.
      const workspaceContract = CORE_CLIENT_REQUIREMENTS.modules.find(
        (module) => module.module === "project_workspace",
      )!.contract_version;
      const forged = await fetch(`${connection.endpoint}/core/v1/modules/workspace/apply`, {
        method: "POST",
        headers: {
          ...authorization,
          "content-type": "application/json",
          "x-nodex-agent-attribution": "forged",
          "x-nodex-connection-id": "fake-host",
          "x-nodex-connection-binding": host.handshake.connection_binding,
        },
        body: JSON.stringify({
          contract_version: workspaceContract,
          operation_id: createBoundedOperationId("test.agent-content.routing-consent"),
          store_epoch: host.handshake.store_epoch,
          intent: {
            kind: "set_inbox_routing_consent",
            start_my_requests: true,
            initialize_only: false,
          },
        }),
      }).then((response) => response.json());
      expect(forged).toMatchObject({ status: "error", payload: { code: "unauthorized" } });
      active = false;
      await expect(cli(["context"])).rejects.toMatchObject({ code: 2 });
      active = true;
      const replacement = await issue();
      expect(
        (await fetch(`${connection.endpoint}/agent/context`, { headers: authorization })).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${replacement.endpoint}/agent/context`, {
            headers: { authorization: `Bearer ${replacement.credential}` },
          })
        ).status,
      ).toBe(200);
    } finally {
      await server.close();
    }
  });
});
