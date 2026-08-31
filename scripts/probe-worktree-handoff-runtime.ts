import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { ServerNotification } from "@nodex/codex-app-server-protocol";
import type {
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  TurnStartResponse,
} from "@nodex/codex-app-server-protocol/v2";
import { ScopedCallbackRuntime } from "../src/main/app/ScopedCallbackRuntime";
import { resolveCodexRuntime } from "../src/main/codex/codex-runtime";
import {
  type CodexProbeClient,
  type CodexProbeSessionLease,
  openCodexProbeSession,
  runCodexProbeMain,
} from "./codex-probe-session";
import { responses, ScriptedModelServer } from "./scenarios/runtime/scripted-model-server";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const waitTimeoutMs = 15_000;

type ProbeResult = "pass";

export interface WorktreeHandoffRuntimeProbeReport {
  readonly capabilities: {
    readonly activeTurnInterruptBeforeRelocation: ProbeResult;
    readonly loadedResumeReplacesRuntimeRoots: ProbeResult;
    readonly loadedSettingsUpdateChangesCwd: ProbeResult;
    readonly matchingRolloutPathRejoinsLoadedThread: ProbeResult;
    readonly mismatchedRolloutPathFailsClosed: ProbeResult;
    readonly restartCanonicalProjectionRestoresLocation: ProbeResult;
    readonly unloadedResumeReplacesRuntimeRoots: ProbeResult;
  };
  readonly generatedAt: string;
  readonly notificationOrder: readonly string[];
  readonly rollout: {
    readonly coldReadRetainedRelocatedCwd: boolean;
    readonly exists: true;
    readonly remainsInsideIsolatedHome: true;
  };
  readonly runtimeVersion: string;
  readonly schemaContract: {
    readonly loadedSettingsUpdateCarriesRuntimeRoots: false;
    readonly resumeCarriesRuntimeRoots: true;
    readonly turnStartCarriesRuntimeRoots: true;
  };
}

function waitForFile(filePath: string, expectedContent: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = (): void => {
      if (existsSync(filePath) && readFileSync(filePath, "utf8").trim() === expectedContent) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= waitTimeoutMs) {
        reject(new Error(`Timed out waiting for shell-command evidence at ${filePath}`));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

function waitForPath(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = (): void => {
      if (existsSync(filePath)) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= waitTimeoutMs) {
        reject(new Error(`Timed out waiting for ${filePath}`));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

function quoteShellPath(filePath: string): string {
  return `'${filePath.replaceAll("'", `'\\''`)}'`;
}

function waitForNotification(
  client: CodexProbeClient,
  predicate: (notification: ServerNotification) => boolean,
  label: string,
): Promise<ServerNotification> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${label}`));
    }, waitTimeoutMs);
    const listener = (notification: ServerNotification): void => {
      if (!predicate(notification)) return;
      cleanup();
      resolve(notification);
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      client.off("notification", listener);
    };
    client.on("notification", listener);
  });
}

function readNotificationThreadId(notification: ServerNotification): string | null {
  if (!("threadId" in notification.params)) return null;
  return notification.params.threadId;
}

function readNotificationThreadSettingsCwd(notification: ServerNotification): string | null {
  if (notification.method !== "thread/settings/updated") return null;
  return notification.params.threadSettings.cwd;
}

function notificationHasThreadSettingsCwd(
  notification: ServerNotification,
  expectedCwd: string,
): boolean {
  const actualCwd = readNotificationThreadSettingsCwd(notification);
  if (!actualCwd) return false;
  return pathsMatch(actualCwd, expectedCwd);
}

function readNotificationTurnId(notification: ServerNotification): string | null {
  if (notification.method !== "turn/started" && notification.method !== "turn/completed") {
    return null;
  }
  return notification.params.turn.id;
}

function pathsMatch(actual: string, expected: string): boolean {
  return realpathSync(actual) === realpathSync(expected);
}

async function waitForThreadCwd(input: {
  readonly client: CodexProbeClient;
  readonly expectedCwd: string;
  readonly label: string;
  readonly threadId: string;
}): Promise<ThreadReadResponse> {
  const startedAt = Date.now();
  let observedCwd = "<missing>";
  while (true) {
    const response = await input.client.request<"thread/read", ThreadReadResponse>("thread/read", {
      threadId: input.threadId,
      includeTurns: false,
    });
    observedCwd = response.thread.cwd;
    if (pathsMatch(observedCwd, input.expectedCwd)) return response;
    if (Date.now() - startedAt >= waitTimeoutMs) {
      throw new Error(`${input.label} remained at ${observedCwd}; expected ${input.expectedCwd}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function startBlockingResponsesServer(): Promise<ScriptedModelServer> {
  return await ScriptedModelServer.start({
    modelsResponse: {
      object: "list",
      data: [
        {
          id: "mock-handoff-model",
          object: "model",
          created: 0,
          owned_by: "nodex-test",
        },
      ],
    },
    exchanges: [
      {
        name: "active handoff turn remains in flight",
        match: (request) => request.path.endsWith("/responses"),
        respond: responses.stream([responses.created("resp_handoff_probe")], {
          keepOpen: true,
        }),
      },
    ],
  });
}

function createClient(
  callbacks: ScopedCallbackRuntime["Service"],
  binaryPath: string,
  stateHome: string,
  loopbackEnvironment: Readonly<Record<string, string>>,
): Promise<CodexProbeSessionLease> {
  return callbacks.runPromise(
    openCodexProbeSession(callbacks, {
      binaryPath,
      expectedCodexHome: stateHome,
      requestTimeout: waitTimeoutMs,
      env: {
        ...process.env,
        ...loopbackEnvironment,
        CODEX_HOME: stateHome,
        NODEX_HANDOFF_PROBE_API_KEY: "isolated-probe-secret",
      },
      clientInfo: {
        name: "nodex-worktree-handoff-probe",
        title: "Nodex Worktree Handoff Probe",
        version: "1.0.0",
      },
    }),
  );
}

function assertSamePath(actual: string, expected: string, label: string): void {
  if (pathsMatch(actual, expected)) return;
  throw new Error(`${label} resolved to ${actual}; expected ${expected}`);
}

function assertRoots(actual: readonly string[], expected: readonly string[], label: string): void {
  const normalizedActual = actual.map((root) => realpathSync(root));
  const normalizedExpected = expected.map((root) => realpathSync(root));
  if (JSON.stringify(normalizedActual) === JSON.stringify(normalizedExpected)) return;
  throw new Error(
    `${label} roots ${JSON.stringify(actual)} did not match ${JSON.stringify(expected)}`,
  );
}

async function assertShellCwd(input: {
  readonly client: CodexProbeClient;
  readonly cwd: string;
  readonly evidencePath: string;
  readonly threadId: string;
}): Promise<void> {
  const completed = waitForNotification(
    input.client,
    (notification) =>
      notification.method === "turn/completed" &&
      readNotificationThreadId(notification) === input.threadId,
    `shell-command completion on ${input.threadId}`,
  );
  await input.client.request("thread/shellCommand", {
    threadId: input.threadId,
    command: `/bin/pwd > ${quoteShellPath(input.evidencePath)}`,
  });
  await Promise.all([waitForFile(input.evidencePath, realpathSync(input.cwd)), completed]);
}

async function probeWorktreeHandoffRuntimePromise(
  input: {
    readonly binaryPath: string;
    readonly outputPath?: string;
  },
  callbacks: ScopedCallbackRuntime["Service"],
): Promise<WorktreeHandoffRuntimeProbeReport> {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "nodex-handoff-runtime-"));
  const stateHome = path.join(fixtureRoot, "agent-home");
  const sourceRoot = path.join(fixtureRoot, "source");
  const destinationOne = path.join(fixtureRoot, "destination-one");
  const destinationTwo = path.join(fixtureRoot, "destination-two");
  const destinationThree = path.join(fixtureRoot, "destination-three");
  const additionalRoot = path.join(fixtureRoot, "additional");
  for (const directory of [
    stateHome,
    sourceRoot,
    destinationOne,
    destinationTwo,
    destinationThree,
    additionalRoot,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  const notifications: string[] = [];
  const notificationTrace: string[] = [];
  let firstClient: CodexProbeSessionLease | null = null;
  let secondClient: CodexProbeSessionLease | null = null;
  let thirdClient: CodexProbeSessionLease | null = null;
  const responsesServer = await startBlockingResponsesServer();
  const probeConfig = {
    "model_providers.nodex-handoff-probe": {
      name: "Nodex handoff probe",
      base_url: `${responsesServer.baseUrl}/v1`,
      env_key: "NODEX_HANDOFF_PROBE_API_KEY",
      wire_api: "responses",
      request_max_retries: 0,
      stream_max_retries: 0,
    },
    harness: "native",
    "features.plugins": false,
  } as const;
  try {
    firstClient = await createClient(
      callbacks,
      input.binaryPath,
      stateHome,
      responsesServer.loopbackEnvironment(),
    );
    firstClient.on("notification", (notification: ServerNotification) => {
      notifications.push(notification.method);
      notificationTrace.push(JSON.stringify(notification));
    });
    const started = await firstClient.request<"thread/start", ThreadStartResponse>("thread/start", {
      cwd: sourceRoot,
      model: "mock-handoff-model",
      modelProvider: "nodex-handoff-probe",
      runtimeWorkspaceRoots: [sourceRoot, additionalRoot],
      approvalPolicy: "never",
      sandbox: "workspace-write",
      threadSource: "system",
      config: probeConfig,
    });
    const threadId = started.thread.id;
    const rolloutPath = started.thread.path;
    if (!rolloutPath) throw new Error("thread/start did not return a rollout path");
    assertSamePath(started.cwd, sourceRoot, "thread/start cwd");
    assertRoots(started.runtimeWorkspaceRoots, [sourceRoot, additionalRoot], "thread/start");
    await assertShellCwd({
      client: firstClient,
      cwd: sourceRoot,
      evidencePath: path.join(fixtureRoot, "source-cwd.txt"),
      threadId,
    });
    await waitForPath(rolloutPath);
    statSync(rolloutPath);

    const settingsNotification = waitForNotification(
      firstClient,
      (notification) =>
        notification.method === "thread/settings/updated" &&
        readNotificationThreadId(notification) === threadId &&
        notificationHasThreadSettingsCwd(notification, destinationOne),
      "thread/settings/updated",
    );
    await firstClient.request("thread/settings/update", {
      threadId,
      cwd: destinationOne,
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [destinationOne, additionalRoot],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
    await settingsNotification;
    const loadedRead = await waitForThreadCwd({
      client: firstClient,
      expectedCwd: destinationOne,
      label: "loaded settings cwd",
      threadId,
    });
    assertSamePath(loadedRead.thread.cwd, destinationOne, "loaded settings cwd");

    const loadedResume = await firstClient.request<"thread/resume", ThreadResumeResponse>(
      "thread/resume",
      {
        threadId,
        path: rolloutPath,
        cwd: destinationOne,
        runtimeWorkspaceRoots: [destinationOne, additionalRoot],
        approvalPolicy: "never",
        sandbox: "workspace-write",
        config: probeConfig,
        excludeTurns: true,
      },
    );
    assertSamePath(loadedResume.cwd, destinationOne, "loaded resume cwd");
    assertRoots(
      loadedResume.runtimeWorkspaceRoots,
      [destinationOne, additionalRoot],
      "loaded resume",
    );
    await assertShellCwd({
      client: firstClient,
      cwd: destinationOne,
      evidencePath: path.join(fixtureRoot, "loaded-cwd.txt"),
      threadId,
    });

    let mismatchFailed = false;
    try {
      await firstClient.request("thread/resume", {
        threadId,
        path: path.join(fixtureRoot, "wrong-rollout.jsonl"),
        cwd: destinationTwo,
        runtimeWorkspaceRoots: [destinationTwo],
        approvalPolicy: "never",
        sandbox: "workspace-write",
        config: probeConfig,
        excludeTurns: true,
      });
    } catch {
      mismatchFailed = true;
    }
    if (!mismatchFailed) throw new Error("Loaded resume accepted a mismatched rollout path");
    await assertShellCwd({
      client: firstClient,
      cwd: destinationOne,
      evidencePath: path.join(fixtureRoot, "after-mismatch-cwd.txt"),
      threadId,
    });

    await firstClient.stop();
    firstClient = null;
    secondClient = await createClient(
      callbacks,
      input.binaryPath,
      stateHome,
      responsesServer.loopbackEnvironment(),
    );
    secondClient.on("notification", (notification: ServerNotification) => {
      notifications.push(notification.method);
      notificationTrace.push(JSON.stringify(notification));
    });
    const unloaded = await waitForThreadCwd({
      client: secondClient,
      expectedCwd: destinationOne,
      label: "persisted settings cwd",
      threadId,
    });
    if (unloaded.thread.status.type !== "notLoaded") {
      throw new Error(`Restarted thread status was ${unloaded.thread.status.type}`);
    }
    assertSamePath(unloaded.thread.cwd, destinationOne, "persisted settings cwd");
    const resumed = await secondClient.request<"thread/resume", ThreadResumeResponse>(
      "thread/resume",
      {
        threadId,
        path: rolloutPath,
        cwd: destinationTwo,
        runtimeWorkspaceRoots: [destinationTwo, additionalRoot],
        approvalPolicy: "never",
        sandbox: "workspace-write",
        config: probeConfig,
        excludeTurns: true,
      },
    );
    assertSamePath(resumed.cwd, destinationTwo, "unloaded resume cwd");
    assertRoots(resumed.runtimeWorkspaceRoots, [destinationTwo, additionalRoot], "unloaded resume");
    await assertShellCwd({
      client: secondClient,
      cwd: destinationTwo,
      evidencePath: path.join(fixtureRoot, "unloaded-cwd.txt"),
      threadId,
    });

    const turnStarted = waitForNotification(
      secondClient,
      (notification) =>
        notification.method === "turn/started" &&
        readNotificationThreadId(notification) === threadId,
      "turn/started for interrupt probe",
    );
    const activeTurnStart = await secondClient.request<"turn/start", TurnStartResponse>(
      "turn/start",
      {
        threadId,
        input: [
          {
            type: "text",
            text: "Keep this probe turn active until interrupted.",
            text_elements: [],
          },
        ],
        cwd: destinationTwo,
        runtimeWorkspaceRoots: [destinationTwo, additionalRoot],
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [destinationTwo, additionalRoot],
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      },
    );
    const activeTurn = await turnStarted;
    const activeTurnId = readNotificationTurnId(activeTurn) ?? activeTurnStart.turn.id;
    if (!activeTurnId) throw new Error("turn/started did not include a turn id");
    await responsesServer.waitForRequest(
      (request) => request.path.endsWith("/responses"),
      waitTimeoutMs,
    );
    const turnCompleted = waitForNotification(
      secondClient,
      (notification) =>
        notification.method === "turn/completed" &&
        readNotificationThreadId(notification) === threadId &&
        readNotificationTurnId(notification) === activeTurnId,
      "turn/completed after interrupt",
    );
    await secondClient.request("turn/interrupt", { threadId, turnId: activeTurnId });
    await turnCompleted;
    const postInterruptSettings = waitForNotification(
      secondClient,
      (notification) =>
        notification.method === "thread/settings/updated" &&
        readNotificationThreadId(notification) === threadId &&
        notificationHasThreadSettingsCwd(notification, destinationThree),
      "thread/settings/updated after interrupt",
    );
    await secondClient.request("thread/settings/update", {
      threadId,
      cwd: destinationThree,
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [destinationThree, additionalRoot],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
    await postInterruptSettings;
    const postInterruptResume = await secondClient.request<"thread/resume", ThreadResumeResponse>(
      "thread/resume",
      {
        threadId,
        path: rolloutPath,
        cwd: destinationThree,
        runtimeWorkspaceRoots: [destinationThree, additionalRoot],
        approvalPolicy: "never",
        sandbox: "workspace-write",
        config: probeConfig,
        excludeTurns: true,
      },
    );
    assertSamePath(postInterruptResume.cwd, destinationThree, "post-interrupt resume cwd");
    assertRoots(
      postInterruptResume.runtimeWorkspaceRoots,
      [destinationThree, additionalRoot],
      "post-interrupt resume",
    );
    await assertShellCwd({
      client: secondClient,
      cwd: destinationThree,
      evidencePath: path.join(fixtureRoot, "post-interrupt-cwd.txt"),
      threadId,
    });

    await secondClient.stop();
    secondClient = null;
    thirdClient = await createClient(
      callbacks,
      input.binaryPath,
      stateHome,
      responsesServer.loopbackEnvironment(),
    );
    const coldRead = await thirdClient.request<"thread/read", ThreadReadResponse>("thread/read", {
      threadId,
      includeTurns: false,
    });
    const coldReadRetainedRelocatedCwd =
      realpathSync(coldRead.thread.cwd) === realpathSync(destinationThree);
    const coldResume = await thirdClient.request<"thread/resume", ThreadResumeResponse>(
      "thread/resume",
      {
        threadId,
        cwd: destinationThree,
        runtimeWorkspaceRoots: [destinationThree, additionalRoot],
        approvalPolicy: "never",
        sandbox: "workspace-write",
        config: probeConfig,
        excludeTurns: true,
      },
    );
    assertSamePath(coldResume.cwd, destinationThree, "restart-preserved cwd");
    assertRoots(
      coldResume.runtimeWorkspaceRoots,
      [destinationThree, additionalRoot],
      "restart-preserved roots",
    );

    const canonicalStateHome = realpathSync(stateHome);
    const canonicalRollout = realpathSync(rolloutPath);
    if (!canonicalRollout.startsWith(`${canonicalStateHome}${path.sep}`)) {
      throw new Error("Rollout escaped the isolated Agent home");
    }
    const report: WorktreeHandoffRuntimeProbeReport = {
      capabilities: {
        activeTurnInterruptBeforeRelocation: "pass",
        loadedResumeReplacesRuntimeRoots: "pass",
        loadedSettingsUpdateChangesCwd: "pass",
        matchingRolloutPathRejoinsLoadedThread: "pass",
        mismatchedRolloutPathFailsClosed: "pass",
        restartCanonicalProjectionRestoresLocation: "pass",
        unloadedResumeReplacesRuntimeRoots: "pass",
      },
      generatedAt: new Date().toISOString(),
      notificationOrder: notifications,
      rollout: {
        coldReadRetainedRelocatedCwd,
        exists: true,
        remainsInsideIsolatedHome: true,
      },
      runtimeVersion: execFileSync(input.binaryPath, ["--version"], { encoding: "utf8" }).trim(),
      schemaContract: {
        loadedSettingsUpdateCarriesRuntimeRoots: false,
        resumeCarriesRuntimeRoots: true,
        turnStartCarriesRuntimeRoots: true,
      },
    };
    if (input.outputPath) {
      mkdirSync(path.dirname(input.outputPath), { recursive: true, mode: 0o700 });
      writeFileSync(input.outputPath, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    responsesServer.verify();
    return report;
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n\nNotifications:\n${notificationTrace.slice(-20).join("\n") || "<empty>"}\n\nModel transcript:\n${responsesServer.transcript() || "<empty>"}`,
      { cause: error },
    );
  } finally {
    await thirdClient?.stop().catch(() => undefined);
    await secondClient?.stop().catch(() => undefined);
    await firstClient?.stop().catch(() => undefined);
    await responsesServer.close().catch(() => undefined);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

export const probeWorktreeHandoffRuntime = (input: {
  readonly binaryPath: string;
  readonly outputPath?: string;
}): Effect.Effect<WorktreeHandoffRuntimeProbeReport, Cause.UnknownError, ScopedCallbackRuntime> =>
  Effect.gen(function* () {
    const callbacks = yield* ScopedCallbackRuntime;
    return yield* Effect.tryPromise(() => probeWorktreeHandoffRuntimePromise(input, callbacks));
  });

function readOption(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value;
}

const main = Effect.gen(function* () {
  const argv = process.argv.slice(2);
  const explicitBinaryPath = readOption(argv, "--binary");
  const binaryPath = path.resolve(
    explicitBinaryPath ??
      resolveCodexRuntime({ isPackaged: false, projectRootPath: projectRoot }).binaryPath,
  );
  const outputPath = path.resolve(
    readOption(argv, "--out") ??
      path.join(projectRoot, ".generated", "agent-runtime-conformance", "handoff.json"),
  );
  const report = yield* probeWorktreeHandoffRuntime({ binaryPath, outputPath });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCodexProbeMain(main);
}
