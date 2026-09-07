import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initializeStandaloneDataAuthority } from "../../src/main/core-client";
import { readCoreRuntimeConnection } from "../../src/main/core-client/runtime-descriptor";
import { resolveCodexRuntime } from "../../src/main/codex/codex-runtime";
import { runCodexProbeMain, withCancelableProbeOperation } from "../codex-probe-session";
import { CoreClientSeedAdapter } from "../scenarios/adapters/core-client-seed-adapter";
import { ElectronScenarioHarness } from "../scenarios/harness/electron-e2e-harness";
import { materializeScenario } from "../scenarios/seed/scenario-seed";
import { CASES } from "./cases";
import { archiveConversation } from "./conversation";
import { runDesktopAgent } from "./desktop-driver";
import { prepareDesktopEnvironment } from "./desktop-environment";
import { directoryFingerprint } from "./fingerprint";

const digestFile = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

async function run(signal: AbortSignal): Promise<void> {
  if (process.env.CI) throw new Error("Supervised paid CLI evaluation is local-only");
  const options = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index],
      value = argv[index + 1];
    if (!name || !["--case", "--variant", "--out"].includes(name) || !value || options.has(name))
      throw new Error(
        "Usage: vp run agent:eval:paid --case read-detail --variant 0 --out runs.local/agent-eval/NAME",
      );
    options.set(name, value);
  }
  const definition = CASES.find((entry) => entry.id === (options.get("--case") ?? "read-detail"));
  const variant = Number(options.get("--variant") ?? "0");
  if (!definition || ![0, 1, 2].includes(variant))
    throw new Error("Unknown case or invalid variant count");
  if (definition.id === "concurrent-edit")
    throw new Error(
      "Concurrent-edit requires a shell observation trigger; it is not enabled in the supervised runner yet",
    );
  const repository = process.cwd();
  const output = path.resolve(
    options.get("--out") ??
      path.join("runs.local/agent-eval", new Date().toISOString().replaceAll(":", "-")),
  );
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output, { mode: 0o700 });
  const harness = await ElectronScenarioHarness.create({
    label: `cli-eval-${definition.id}`,
    codex: "copy-auth",
    retention: "keep",
    sourceCodexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    cwd: repository,
    prepareAgentRuntime: false,
    environment: { NODEX_LOG_FILE: "1", NODEX_LOG_CONSOLE: "0" },
  });
  const profile = harness.profile;
  let evaluatedThreadId: string | undefined;
  let conversationArchived = false;
  try {
    const runtime = await initializeStandaloneDataAuthority({
      buildId: "supervised-cli-evaluation",
      isPackaged: false,
      nodexHome: profile.nodexHome,
    });
    const seed = new CoreClientSeedAdapter(runtime);
    const scenarioManifest = await materializeScenario(
      "agent/cli-workflow",
      seed,
      profile.initialProjectsDirectory,
    );
    const fixture = await definition.prepare(
      { runtime, seed, manifest: scenarioManifest, profile },
      variant,
    );
    const prepared = await prepareDesktopEnvironment({
      repository,
      workspace: profile.initialProjectsDirectory,
      nodexHome: profile.nodexHome,
      codexHome: profile.codexHome,
      projectId: scenarioManifest.projectId,
    });
    const descriptor = readCoreRuntimeConnection(profile.nodexHome).descriptor;
    if (descriptor.start_nonce !== runtime.rootClient.handshake.generation.start_nonce)
      throw new Error("Seeded Core generation changed before launch");
    const contextText = execFileSync(
      prepared.binary,
      ["--project", scenarioManifest.projectId, "context"],
      {
        cwd: profile.initialProjectsDirectory,
        env: { ...process.env, ...prepared.environment },
        encoding: "utf8",
      },
    );
    const context = JSON.parse(contextText) as {
      ok: boolean;
      result?: { project?: { id?: string } };
    };
    if (!context.ok || context.result?.project?.id !== scenarioManifest.projectId)
      throw new Error("Development CLI did not resolve the seeded Project");
    const agentBinary = resolveCodexRuntime({
      isPackaged: false,
      projectRootPath: repository,
    }).binaryPath;
    const manifest = {
      schemaVersion: 2,
      executionMode: "supervised-desktop-shell",
      startedAt: new Date().toISOString(),
      commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      caseId: definition.id,
      variant,
      model: "gpt-5.6-luna",
      effort: "max",
      timeoutMs: 300_000,
      cliHash: await digestFile(prepared.binary),
      coreHash: descriptor.artifact.sha256,
      agentHash: await digestFile(agentBinary),
      skillHash: await directoryFingerprint(path.join(repository, "agent-skills/nodex")),
      runnerHash: await directoryFingerprint(path.join(repository, "scripts/agent-eval")),
      projectId: scenarioManifest.projectId,
      profileId: descriptor.profile_id,
      profileRoot: profile.runRoot,
      workspace: profile.initialProjectsDirectory,
      coreStartNonce: descriptor.start_nonce,
    };
    await writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });
    signal.throwIfAborted();
    const page = await harness.launch();
    await harness.application.evaluate(({ BrowserWindow }, label) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.setTitle(label);
      window?.show();
      window?.focus();
    }, `Nodex — Development CLI evaluation: ${definition.id}`);
    process.stdout.write(
      `Visible development Profile: ${profile.runRoot}\nProject: ${scenarioManifest.projectId}\nStarting ONE ${definition.id} task with full shell. Use Stop in this development window to interrupt.\n`,
    );
    const agent = await runDesktopAgent({
      page,
      projectId: scenarioManifest.projectId,
      codexHome: profile.codexHome,
      prompt: fixture.prompt,
      timeoutMs: 300_000,
      signal,
      onStarted: ({ threadId }) => {
        evaluatedThreadId = threadId;
        process.stdout.write(`Luna Max task: ${threadId}\n`);
      },
    });
    const conversation = await archiveConversation(profile.codexHome, agent.threadId, output);
    conversationArchived = true;
    const verification = await fixture.verify(agent.finalText);
    const passed = agent.status === "completed" && verification.passed;
    await writeFile(
      path.join(output, "result.json"),
      JSON.stringify(
        { manifest, prompt: fixture.prompt, agent, conversation, verification, passed },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    const report = [
      "# Supervised CLI Agent evaluation",
      "",
      `Result: **${passed ? "PASS" : agent.status === "completed" ? "FAIL" : agent.status}**`,
      "",
      `Case: ${definition.id}; variant ${variant}; Luna Max; ${(agent.durationMs / 1000).toFixed(1)} seconds.`,
      "",
      "The Agent used an ordinary visible Nodex task with full shell access. This run does not establish strong production isolation or a full-matrix improvement.",
      "",
      "## Task answer",
      "",
      agent.finalText,
      "",
      "## Independent verification",
      "",
      ...verification.assertions.map((item) => `- ${item.passed ? "PASS" : "FAIL"}: ${item.name}`),
      "",
      `Task: ${agent.threadId}`,
      "Conversation: [native JSONL](conversation.jsonl); identity and checksum: [metadata](conversation.metadata.json).",
      `Development Profile: ${profile.runRoot}`,
      "",
      "The window stays open for inspection. No next case or feedback turn starts automatically.",
      "",
    ].join("\n");
    await writeFile(path.join(output, "report.md"), report, { mode: 0o600 });
    await page.screenshot({ path: path.join(output, "desktop.png") });
    process.stdout.write(
      `${passed ? "PASS" : agent.status}: ${output}/report.md\nWindow retained for inspection. Close it or interrupt this runner to finish cleanup; no further task will start.\n`,
    );
    if (!signal.aborted && !page.isClosed())
      await new Promise<void>((resolve) => {
        const finish = () => {
          signal.removeEventListener("abort", finish);
          page.off("close", finish);
          resolve();
        };
        signal.addEventListener("abort", finish, { once: true });
        page.once("close", finish);
      });
  } catch (error) {
    if (evaluatedThreadId && !conversationArchived) {
      await archiveConversation(profile.codexHome, evaluatedThreadId, output).catch(
        async (archiveError: unknown) => {
          await writeFile(path.join(output, "conversation-error.txt"), String(archiveError), {
            mode: 0o600,
          });
        },
      );
    }
    await writeFile(
      path.join(output, "error.txt"),
      error instanceof Error ? (error.stack ?? error.message) : String(error),
      { mode: 0o600 },
    );
    try {
      await harness.page.screenshot({ path: path.join(output, "error.png") });
    } catch {
      /* Startup may not have opened a renderer. */
    }
    throw error;
  } finally {
    try {
      await harness.close();
    } finally {
      await rm(path.join(profile.codexHome, "auth.json"), { force: true });
    }
  }
}

runCodexProbeMain(withCancelableProbeOperation(run));
