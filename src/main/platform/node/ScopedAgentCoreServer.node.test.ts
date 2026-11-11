/* @effect-diagnostics asyncFunction:off globalFetch:off preferSchemaOverJson:off -- Exercises real Native CLI, Core and bounded HTTP admission. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { expect, test, vi } from "vite-plus/test";
import { CORE_CLIENT_REQUIREMENTS } from "@nodex/core-protocol";
import { withCoreScenario } from "../../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../../scripts/scenarios/scenarios/document-sync-recovery";
import { requiredNativeExecutable } from "../../../../scripts/testing/native-artifacts";
import { CoreClient } from "../../core-client/core-client";
import { LocalHttpTransport } from "../../core-client/local-http";
import { readCoreRuntimeConnection } from "../../core-client/runtime-descriptor";
import { createBoundedOperationId } from "../../../shared/operation-identity";
import { openScopedAgentCore } from "./ScopedAgentCoreServer";
import { bindNodexCliShell, nodexCliShellPaths, prepareNodexCliShell } from "./NodexCliShell";

const exec = promisify(execFile);

test("the Agent CLI retains live Run attribution across Core restarts and wrapper reuse", async () => {
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
    const attribution = {
      session_id: sessionId,
      backend: "codex",
      run_id: "run:one",
    } as const;
    let active = true;
    const server = await openScopedAgentCore(scenario.profile.nodexHome);
    try {
      const issue = (runId = "run:one", session = sessionId) =>
        server.issue({
          owner: "thread:scoped-content",
          projectId: scenario.manifest.projectId,
          attribution: { ...attribution, session_id: session, run_id: runId },
          identity: scenario.runtime.identity,
          authorize: async () => (active ? "allowed" : "turn_ended"),
        });
      let connection = await issue();
      const env = {
        PATH: process.env.PATH,
        NODEX_AGENT_ENDPOINT: connection.endpoint,
        NODEX_AGENT_CREDENTIAL: connection.credential,
      };
      const binary = requiredNativeExecutable("cli");
      const cli = (args: readonly string[], overrides?: NodeJS.ProcessEnv) =>
        exec(binary, args, { env: { ...env, ...overrides }, timeout: 10_000 });
      const assertRefusal = async (
        code: string,
        recovery: string,
        override?: NodeJS.ProcessEnv,
      ) => {
        const result = await cli(["--json", "context"], override).then(
          () => {
            throw new Error("Expected CLI refusal");
          },
          (error: { code: number; stdout: string; stderr: string }) => error,
        );
        expect(result.code).toBe(2);
        for (const output of [result.stdout, result.stderr]) {
          expect(JSON.parse(output)).toMatchObject({
            ok: false,
            error: { code, message: expect.stringContaining(recovery) },
          });
        }
      };
      const taskId = "scoped-cli-fixture";
      await prepareNodexCliShell(scenario.profile.nodexHome);
      const bind = (scopedConnection: typeof connection, turnId: string) =>
        bindNodexCliShell({
          nodexHome: scenario.profile.nodexHome,
          threadId: taskId,
          executable: binary,
          scopedConnection,
          turnId,
        });
      await bind(connection, "run:one");
      const wrapperDir = scenario.profile.runRoot;
      const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
      const prefix = process.platform === "win32" ? ["/d", "/c"] : [];
      const wrapper = process.platform === "win32" ? "nx.cmd" : "./nx.sh";
      await writeFile(
        join(wrapperDir, wrapper),
        process.platform === "win32" ? "@nodex %*\r\n" : '#!/bin/sh\nexec nodex "$@"\n',
        { mode: 0o700 },
      );
      const viaWrapper = (args: readonly string[], turn: string) =>
        exec(
          process.platform === "win32" ? shell : join(wrapperDir, wrapper),
          process.platform === "win32" ? [...prefix, wrapper, ...args] : args,
          {
            cwd: wrapperDir,
            env: {
              ...process.env,
              PATH: [nodexCliShellPaths(scenario.profile.nodexHome).bin, process.env.PATH].join(
                delimiter,
              ),
              NODEX_HOME: scenario.profile.nodexHome,
              NODEX_CLI_TASK_ID: taskId,
              NODEX_CLI_TURN_ID: turn,
            },
            timeout: 10_000,
          },
        );
      const context = JSON.parse((await viaWrapper(["--json", "context"], "run:one")).stdout);
      expect(context.result).toMatchObject({
        actor: {
          type: "agent",
          session_id: sessionId,
          run_id: "run:one",
          on_behalf_of: expect.any(String),
        },
        profile: { id: host.handshake.generation.profile_id, source: "host_binding" },
        project: { id: scenario.manifest.projectId },
        project_source: "host_binding",
      });
      const transport = () => {
        const { descriptor, authCapability } = readCoreRuntimeConnection(
          scenario.profile.nodexHome,
        );
        return new LocalHttpTransport(descriptor.endpoint, authCapability);
      };
      const issueAttribution = vi.spyOn(CoreClient.prototype, "issueAgentAttribution");
      // Exercise the real Core response for a reclaimed registration without sleeping
      // through Core's idle lifetime. The following issuance must re-handshake.
      issueAttribution.mockImplementationOnce((input) =>
        transport().requestJson("POST", "/core/v1/agent-attributions", input, {
          "x-nodex-connection-id": randomUUID(),
          "x-nodex-connection-binding": "reclaimed-registration",
        }),
      );
      try {
        const renewed = await issue("run:renewed");
        const output = await cli(["--json", "context"], {
          NODEX_AGENT_CREDENTIAL: renewed.credential,
        });
        expect(JSON.parse(output.stdout).result.actor.run_id).toBe("run:renewed");
        expect(issueAttribution).toHaveBeenCalledTimes(2);
      } finally {
        issueAttribution.mockRestore();
      }
      // Restore the wrapper's first Turn before exercising its other commands.
      connection = await issue();
      env.NODEX_AGENT_CREDENTIAL = connection.credential;
      await bind(connection, "run:one");
      const explicit = JSON.parse(
        (
          await cli([
            "--json",
            "--expect-profile",
            host.handshake.generation.profile_id,
            "--project",
            scenario.manifest.projectId,
            "context",
          ])
        ).stdout,
      );
      expect(explicit.result.project_source).toBe("flag");
      await expect(
        cli(["--json", "--expect-profile", "foreign-profile", "context"]),
      ).rejects.toMatchObject({
        code: 2,
        stdout: expect.stringContaining("PROFILE_MISMATCH"),
        stderr: expect.stringContaining(host.handshake.generation.profile_id),
      });
      const read = JSON.parse(
        (await cli(["--json", "read", scenario.manifest.pageIdsByKey.other!])).stdout,
      );
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
      const fetchContext = () =>
        fetch(`${connection.endpoint}/agent/context`, { headers: authorization });
      const bootstrap = await (await fetchContext()).text();
      const nonce = JSON.parse(bootstrap).descriptor.start_nonce;
      const headers = { ...authorization, "x-nodex-agent-core-generation": nonce };
      expect(bootstrap.includes(scenario.profile.nodexHome)).toBe(false);
      await expect(cli(["--json", "space", "devices"])).rejects.toMatchObject({
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
          headers: { ...headers, "content-type": "application/json" },
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
          ...headers,
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
      await scenario.withStoppedCore(async () => {
        await assertRefusal("CORE_UNAVAILABLE", "Core reconnects");
      });
      expect(JSON.parse((await cli(["--json", "context"])).stdout).result.actor.run_id).toBe(
        "run:one",
      );
      const retired = await fetch(`${connection.endpoint}/core/v1/identity`, { headers });
      expect(await retired.json()).toMatchObject({
        status: "error",
        payload: { code: "agent_generation_changed" },
      });
      active = false;
      await assertRefusal("AGENT_TURN_ENDED", "active Turn");
      await expect(cli(["--output-format", "text", "context"])).rejects.toMatchObject({
        code: 2,
        stdout: "",
        stderr: expect.stringContaining("AGENT_TURN_ENDED"),
      });
      active = true;
      const replacement = await issue("run:two");
      await bind(replacement, "run:two");
      await expect(viaWrapper(["--json", "context"], "run:one")).rejects.toMatchObject({
        code: 2,
        stdout: expect.stringContaining("AGENT_TURN_ENDED"),
      });
      const otherProject = await scenario.seed.createProject({ name: "CLI override", sources: [] });
      const selected = await viaWrapper(
        [
          "--json",
          "--expect-profile",
          scenario.runtime.identity.profileId,
          "--project",
          otherProject.id,
          "context",
        ],
        "run:two",
      );
      expect(JSON.parse(selected.stdout).result).toMatchObject({
        project: { id: otherProject.id },
        project_source: "flag",
        actor: { type: "agent", session_id: sessionId, run_id: "run:two" },
      });
      const pageId = scenario.manifest.pageIdsByKey.other!;
      await writeFile(join(wrapperDir, "report.txt"), "A report from the second Turn.\n");
      const readInventory = async () => {
        const result = await scenario.runtime.rootClient
          .forProject(scenario.manifest.projectId)
          .libraryRead({ kind: "page_file_inventory", page_id: pageId, limit: 100 });
        if (result.value.kind !== "page_file_inventory")
          throw new Error("Core returned the wrong Page File inventory");
        return result.value.value;
      };
      const { revision } = await readInventory();
      await viaWrapper(
        [
          "--json",
          "page",
          "file",
          "put",
          pageId,
          "--path",
          "report.txt",
          "--from",
          "report.txt",
          "--if-manifest",
          String(revision),
        ],
        "run:two",
      );
      const inventory = await readInventory();
      expect(
        inventory.files.find((item) => item.logical_path === "report.txt")?.attachment,
      ).toMatchObject({
        attached_by: {
          type: "agent",
          session_id: sessionId,
          run_id: "run:two",
          on_behalf_of: expect.any(String),
        },
      });
      await assertRefusal("AGENT_BINDING_MALFORMED", "plain nodex", {
        NODEX_AGENT_CREDENTIAL: "malformed",
      });
      await assertRefusal("AGENT_GENERATION_CHANGED", "nodex context", {
        NODEX_AGENT_CREDENTIAL: `0000000000000000.${replacement.credential.split(".")[1]}`,
      });
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
      const activeClients = async () =>
        (
          await transport().requestJson<{ metrics: { active_clients: number } }>(
            "GET",
            "/core/v1/health",
          )
        ).metrics.active_clients;
      const beforeRefusals = await activeClients();
      const missing = await issue("run:missing", randomUUID());
      for (let attempt = 0; attempt < 4; attempt++) {
        await assertRefusal("AGENT_SESSION_UNAVAILABLE", "Reopen", {
          NODEX_AGENT_CREDENTIAL: missing.credential,
        });
      }
      expect(await activeClients()).toBe(beforeRefusals);
    } finally {
      await server.close();
    }
  });
});
