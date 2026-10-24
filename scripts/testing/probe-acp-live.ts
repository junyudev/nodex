import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication, Page } from "playwright";
import type { IpcApi } from "../../src/shared/ipc-api";
import type { AcpOperations } from "../../src/shared/acp-api";
import { agentRuntimeProviderId } from "../../src/shared/agent-runtime-provider";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import { createBoundedOperationId } from "../../src/shared/operation-identity";
import { acquireIsolatedRunLease } from "../../src/main/core-client/isolated-run-ownership";
import { openDevelopmentEnvironmentHome } from "../development-environment-home";
import { cleanupIsolatedCore } from "../isolated-core-cleanup";
import {
  launchNodexElectronApplication,
  stopNodexElectronApplication,
  waitForNodexApplicationWindow,
  waitForNodexWindowInitialization,
} from "../scenarios/harness/electron-e2e-harness";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type Operation = AcpOperations["acp.operation.read"]["output"];
type Check = {
  status: "verified" | "failed" | "blocked" | "unsupported" | "not-run";
  detail?: unknown;
};
const invoke = async <Channel extends keyof IpcApi>(
  page: Page,
  channel: Channel,
  ...args: IpcApi[Channel]["args"]
): Promise<IpcApi[Channel]["result"]> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request = page.evaluate(
    async ({ channel, encodedArgs }) => {
      const api = (
        window as unknown as {
          api: { invoke(channel: string, ...args: unknown[]): Promise<unknown> };
        }
      ).api;
      return await api.invoke(channel, ...JSON.parse(encodedArgs));
    },
    { channel, encodedArgs: JSON.stringify(args) },
  ) as Promise<IpcApi[Channel]["result"]>;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Main IPC ${channel} exceeded 60 seconds.`)),
          60_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Live evidence always crosses the same Main IPC boundary as the product. No host login is copied. */
async function main() {
  const root = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
  if ((await realpath(process.cwd())) !== root)
    throw new Error("Run this probe from its own worktree.");
  const args = process.argv.slice(2);
  const value = (name: string) => args[args.indexOf(name) + 1];
  const homePath = args.includes("--home") ? value("--home") : undefined;
  const agentId = args.includes("--agent") ? value("--agent") : undefined;
  if (!homePath || !path.isAbsolute(homePath) || !agentId)
    throw new Error(
      "Pass --home <absolute development home> --agent <Registry ID> [--exercise --model <ID>] [--authenticate --hold].",
    );
  const home = await openDevelopmentEnvironmentHome({ repositoryRoot: root, home: homePath });
  const reportPath = path.join(home.artifacts, `acp-live-${agentId}.json`);
  const checks: Record<string, Check> = Object.fromEntries(
    [
      "registry",
      "install",
      "connection",
      "authentication",
      "text",
      "fileTool",
      "stop",
      "continue",
      "restart",
      "nativeRecovery",
      "nativeSessions",
    ].map((name) => [name, { status: "not-run" }]),
  );
  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    boundary: "development-Electron-Main-IPC",
    repository: root,
    home: home.root,
    environmentId: home.manifest.environmentId,
    agentId,
    checks,
    runtimeEntrySha256: createHash("sha256")
      .update(await readFile(path.join(root, "out/agent-runtime/entry.mjs")))
      .digest("hex"),
  };
  const save = () => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const isolatedHome = path.join(home.root, "host");
  const credentialHome = path.join(home.root, `credentials-${agentId}`);
  await Promise.all([
    mkdir(isolatedHome, { recursive: true }),
    mkdir(credentialHome, { recursive: true }),
  ]);
  if (home.wasCreated) {
    // Avoid even passive access to native host accounts before the first IPC request.
    await writeFile(
      path.join(home.nodexHome, "config.toml"),
      '[[server.claude_agent_instances]]\nid = "claude-default"\ndisplayName = "Claude Code"\nbinaryPath = "claude"\nconfigDirectory = ""\nenabled = false\nenvironment = []\n\n[[server.opencode_agent_instances]]\nid = "opencode-default"\ndisplayName = "OpenCode"\nbinaryPath = "opencode"\nenabled = false\nenvironment = []\n',
      { mode: 0o600 },
    );
  }
  const runId = randomUUID();
  const lease = acquireIsolatedRunLease({
    nodexHome: home.nodexHome,
    runId,
    supervisorPid: process.pid,
  });
  let app: ElectronApplication | undefined;
  const launch = async () => {
    app = await launchNodexElectronApplication({
      nodexHome: home.nodexHome,
      codexHome: home.codexHome,
      claudeConfigHome: path.join(isolatedHome, ".claude"),
      isolatedHostHome: isolatedHome,
      initialProjectsDirectory: home.workspace,
      runId,
      cwd: root,
      windows: args.includes("--hold") ? "foreground" : "background",
      environment: {
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        NODEX_TEST_AGENT_RUNTIME_NODE_EXECUTABLE: process.execPath,
      },
    });
    return await waitForNodexWindowInitialization(await waitForNodexApplicationWindow(app));
  };
  let page: Page;
  let conversationTarget: { sessionId: string; threadId: string } | undefined;
  const waitOperation = async (started: Operation) => {
    let operation = started;
    const deadline = Date.now() + 10 * 60_000;
    while (operation.phase === "running" && Date.now() < deadline) {
      await delay(300);
      operation = await invoke(page, "acp:operation:read", { operationId: operation.operationId });
    }
    if (operation.phase === "running") {
      await invoke(page, "acp:operation:cancel", { operationId: operation.operationId });
      throw new Error("ACP operation exceeded the ten-minute deadline.");
    }
    return operation;
  };
  try {
    page = await launch();
    const registry = await invoke(page, "acp:registry:search", { query: agentId });
    const agent = registry.agents.find((entry) => entry.id === agentId);
    if (!agent) throw new Error(`Registry does not contain exact Agent ID ${agentId}.`);
    report.agent = agent;
    checks.registry = { status: "verified" };
    await save();
    const instanceId = `live-${agentId}`;
    const existing = await invoke(page, "settings:acp-agents:get");
    const saved = existing.instances.find((entry) => entry.id === instanceId);
    if (saved) {
      if (
        saved.credentials.kind !== "isolated-home" ||
        saved.credentials.home !== credentialHome ||
        saved.agentDefinitionId !== agentId ||
        saved.source.kind !== "registry" ||
        saved.source.agentId !== agentId
      )
        throw new Error("The existing instance does not belong to this isolated live probe.");
      const inspection = await invoke(page, "acp:inspect", { instanceId });
      checks.install = {
        status: inspection.status === "ready" ? "verified" : "failed",
        detail: inspection,
      };
      report.installationId = saved.source.installationId;
      if (inspection.status !== "ready")
        throw new Error("The pinned Agent installation is unavailable.");
    } else {
      const installed = await waitOperation(
        await invoke(page, "acp:install:start", { operationId: randomUUID(), agentId }),
      );
      checks.install = {
        status: installed.phase === "succeeded" ? "verified" : "failed",
        detail: installed.result ?? installed.error,
      };
      await save();
      if (installed.phase !== "succeeded" || !installed.result || !("prepared" in installed.result))
        throw new Error("Registry installation did not succeed; see the report.");
      await invoke(page, "settings:acp-agents:update", {
        instances: [
          ...existing.instances,
          {
            id: instanceId,
            agentDefinitionId: agentId,
            displayName: `Live ${agent.name}`,
            enabled: true,
            source: {
              kind: "registry",
              agentId,
              distribution: installed.result.distribution,
              installationId: installed.result.installationId,
            },
            credentials: { kind: "isolated-home", home: credentialHome },
            proxy: "inherit-host",
            environment: [],
            customModels: [],
          },
        ],
      });
    }
    const connect = async () =>
      await waitOperation(
        await invoke(page, "acp:connection:start", { instanceId, operationId: randomUUID() }),
      );
    let connected = await connect();
    checks.connection = {
      status: connected.phase === "succeeded" ? "verified" : "failed",
      detail: connected.result ?? connected.error,
    };
    let auth = await invoke(page, "acp:auth:read", { instanceId });
    report.authenticationPhase = auth.phase;
    report.authenticationMethods = auth.methods?.map(({ id, name, type }) => ({ id, name, type }));
    if (args.includes("--authenticate"))
      auth = await invoke(page, "acp:auth:start", { instanceId });
    if (auth.phase !== "succeeded" && connected.phase !== "succeeded") {
      checks.authentication = { status: "blocked", detail: { phase: auth.phase, credentialHome } };
      // Auth state may contain one-use links or terminal output. Keep it private and outside evidence logs.
      const actionPath = path.join(home.artifacts, `acp-auth-action-${agentId}.json`);
      await writeFile(actionPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
      report.authenticationActionFile = actionPath;
      await save();
      process.stdout.write(
        `Connection or authentication requires attention in ${home.root}. Private action: ${actionPath}\n`,
      );
      if (args.includes("--hold")) {
        const deadline = Date.now() + 15 * 60_000;
        while (Date.now() < deadline && auth.phase !== "succeeded") {
          await delay(1000);
          auth = await invoke(page, "acp:auth:read", { instanceId });
        }
        if (auth.phase === "succeeded") connected = await connect();
      }
    }
    checks.authentication = {
      status:
        auth.phase === "succeeded"
          ? "verified"
          : connected.phase === "succeeded"
            ? auth.methods?.length
              ? "not-run"
              : "unsupported"
            : "blocked",
      detail: { phase: auth.phase },
    };
    checks.connection = {
      status: connected.phase === "succeeded" ? "verified" : "failed",
      detail: connected.result ?? connected.error,
    };
    await save();
    if (connected.phase !== "succeeded") {
      process.exitCode = 2;
      return;
    }
    if (!args.includes("--exercise")) {
      process.exitCode = 2;
      return;
    }
    const model = args.includes("--model") ? value("--model") : undefined;
    if (!model)
      throw new Error("--exercise requires an explicit --model ID from the connection report.");
    report.selectedModel = model;
    const providerId = agentRuntimeProviderId({
      kind: "acp",
      agentDefinitionId: agentId,
      instanceConfigId: instanceId,
    })!;
    const catalog = await invoke(page, "agent-runtime:providers:read", {
      instanceIds: [providerId],
    });
    if (!catalog[0]?.models.some((entry) => entry.slug === model))
      throw new Error("Requested model is not in the current Agent catalog.");
    const projects = await invoke(page, "projects:list");
    let project = projects.items.find((entry) => entry.primaryWorkspaceRoot === home.workspace);
    if (!project) {
      const createdProject = await invoke(page, "projects:create", {
        operationId: createBoundedOperationId("live.acp.project.create"),
        payload: {
          projectId: createUuidV7(),
          input: { name: "ACP live workspace", sources: [home.workspace] },
        },
      });
      if (!createdProject.ok) throw new Error("Could not create the disposable workspace Project.");
      project = createdProject.value;
    }
    const token = randomUUID();
    const fixture = path.join(home.workspace, "acp-live-input.txt");
    await writeFile(fixture, `${token}\n`);
    const sessionId = createUuidV7();
    const created = await invoke(page, "project-sessions:create", {
      operationId: createBoundedOperationId("live.acp.session.create"),
      payload: {
        sessionId,
        input: {
          projectId: project.id,
          noThreadFallbackTitle: "ACP live verification",
          initialPageIds: [],
        },
      },
    });
    if (!created.ok) throw new Error("Could not create the disposable verification chat.");
    const launched = await invoke(page, "agent-runtime:session:launch", {
      launchId: createUuidV7(),
      acceptedAt: Date.now(),
      sessionId,
      projectId: project.id,
      title: "ACP live verification",
      modelSelection: { instanceId: providerId, model },
      interactionMode: "default",
      message: {
        messageId: createUuidV7(),
        text: "Read acp-live-input.txt with a file tool. Write its exact contents to acp-live-output.txt. Reply with the contents and nothing else. Do not access any other file or network resource.",
      },
    });
    const target = { sessionId: launched.sessionId, threadId: launched.threadId };
    conversationTarget = target;
    report.session = target;
    const settled = async (minimumRuns: number) => {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const result = await invoke(page, "agent-runtime:session:read", target);
        const runs = result.snapshot.projection.runs;
        report.latestRunStatuses = runs.map((run) => ({ id: run.id, status: run.status }));
        report.pendingRequestKinds = result.snapshot.projection.runtimeRequests
          .filter((request) => request.status === "pending")
          .map((request) => request.kind);
        if (
          runs.length >= minimumRuns &&
          runs.every((run) =>
            ["completed", "failed", "interrupted", "cancelled"].includes(run.status),
          )
        )
          return result;
        await delay(300);
      }
      throw new Error("Live Run exceeded two minutes.");
    };
    const first = await settled(1);
    report.firstRunStatuses = first.snapshot.projection.runs.map((run) => run.status);
    const output = await readFile(path.join(home.workspace, "acp-live-output.txt"), "utf8").catch(
      () => "",
    );
    checks.fileTool = { status: output.trim() === token ? "verified" : "failed" };
    checks.text = {
      status: first.snapshot.projection.messages.some(
        (message) => message.role === "assistant" && message.text.includes(token),
      )
        ? "verified"
        : "failed",
    };
    if (checks.fileTool.status !== "verified" || checks.text.status !== "verified")
      throw new Error("The live model did not complete the text and file fixture.");
    report.nativeSession = first.snapshot.projection.providerThreads.map(
      (thread) => thread.nativeThreadRef?.nativeId ?? null,
    );
    await invoke(page, "agent-runtime:session:message", {
      ...target,
      message: {
        messageId: createUuidV7(),
        text: "Wait for 30 seconds using a terminal command, then reply WAITED. Do not do anything else.",
      },
    });
    let running;
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await invoke(page, "agent-runtime:session:control", target);
      running = state.snapshot.projection.runs.find(
        (run) => !["completed", "failed", "interrupted", "cancelled"].includes(run.status),
      );
      if (running) break;
      await delay(100);
    }
    if (!running) throw new Error("Could not observe the live Run to interrupt.");
    const stopped = await invoke(page, "agent-runtime:session:stop", {
      ...target,
      runId: running.id,
    });
    await settled(2);
    checks.stop = { status: stopped.stopped ? "verified" : "failed" };
    await invoke(page, "agent-runtime:session:message", {
      ...target,
      message: { messageId: createUuidV7(), text: "Reply CONTINUED and nothing else." },
    });
    const continued = await settled(3);
    checks.continue = {
      status: continued.snapshot.projection.messages.some(
        (message) => message.role === "assistant" && message.text.trim() === "CONTINUED",
      )
        ? "verified"
        : "failed",
    };
    const probe =
      connected.result && "sessionManagement" in connected.result ? connected.result : null;
    await stopNodexElectronApplication(app!);
    app = undefined;
    page = await launch();
    const restored = await invoke(page, "agent-runtime:session:read", target);
    checks.restart = {
      status:
        JSON.stringify(restored.snapshot.projection.messages) ===
        JSON.stringify(continued.snapshot.projection.messages)
          ? "verified"
          : "failed",
    };
    checks.nativeRecovery = { status: "unsupported" };
    if (probe?.sessionManagement.canLoad || probe?.sessionManagement.canResume) {
      await invoke(page, "agent-runtime:session:message", {
        ...target,
        message: { messageId: createUuidV7(), text: "Reply RESTORED and nothing else." },
      });
      const recovered = await settled(4);
      checks.nativeRecovery = {
        status:
          recovered.snapshot.projection.messages.some(
            (message) => message.role === "assistant" && message.text.trim() === "RESTORED",
          ) &&
          JSON.stringify(
            recovered.snapshot.projection.providerThreads.map(
              (thread) => thread.nativeThreadRef?.nativeId ?? null,
            ),
          ) === JSON.stringify(report.nativeSession)
            ? "verified"
            : "failed",
      };
    }
    checks.nativeSessions = probe?.sessionManagement.canList
      ? {
          status: "verified",
          detail: await invoke(page, "acp:sessions:list", { instanceId, projectId: project.id }),
        }
      : { status: "unsupported" };
    if (
      Object.values(checks).some((check) => ["failed", "blocked", "not-run"].includes(check.status))
    )
      process.exitCode = 2;
  } catch (error) {
    report.failure = error instanceof Error ? error.message : "ACP live probe failed";
    throw error;
  } finally {
    await save();
    if (app && conversationTarget) {
      const target = conversationTarget;
      await invoke(page!, "agent-runtime:session:control", target)
        .then(async (state) => {
          for (const run of state.snapshot.projection.runs) {
            if (
              ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
                run.status,
              )
            )
              continue;
            await invoke(page!, "agent-runtime:session:stop", { ...target, runId: run.id });
          }
        })
        .catch(() => {
          process.exitCode = 1;
        });
    }
    if (app) await stopNodexElectronApplication(app);
    const cleanup = await cleanupIsolatedCore({ lease, nodexHome: home.nodexHome, runId });
    if (!cleanup.safeToDeleteRunRoot) {
      process.stderr.write(`Could not release owned development Core: ${cleanup.status}\n`);
      process.exitCode = 1;
    }
    process.stdout.write(`ACP live evidence: ${reportPath}\n`);
  }
}
void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "ACP live probe failed"}\n`);
  process.exitCode = 1;
});
