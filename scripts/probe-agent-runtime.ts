import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { ThreadStartResponse } from "@nodex/codex-app-server-protocol/v2";
import { ScopedCallbackRuntime } from "../src/main/app/ScopedCallbackRuntime";
import { CodexRpcError } from "../src/main/codex-runtime/CodexRpcError";
import { resolveCodexRuntime } from "../src/main/codex/codex-runtime";
import {
  readCodexAppServerReleaseLock,
  resolveCodexAppServerReleaseLockPath,
} from "./agent-runtime-release-lock";
import {
  type CodexProbeClient,
  runCodexProbeMain,
  withCodexProbeSession,
} from "./codex-probe-session";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

type JsonObject = Record<string, unknown>;

export type AgentRuntimeConformanceReport = {
  appServerRuntimeVersion: string;
  binaryPath: string;
  capabilities: {
    coldRestart: "pass";
    gracefulShutdown: "pass";
    initialize: "pass";
    invalidMethod: "pass";
    modelList: "pass";
    paginatedThreadStart: "pass";
  };
  generatedAt: string;
  initialize: {
    codexHome: string;
    platformFamily: string;
    platformOs: string;
    userAgent: string;
  };
  modelCount: number;
  protocolSchemaFingerprint: string;
  sourceCommit: string;
  sourceTag: string;
  threadCount: { first: number; restarted: number };
};

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readData(value: unknown, label: string): unknown[] {
  if (isObject(value) && Array.isArray(value.data)) return value.data;
  throw new Error(`Agent runtime conformance expected ${label}.data`);
}

function withProbeClient<A>(
  callbacks: ScopedCallbackRuntime["Service"],
  binaryPath: string,
  stateHome: string,
  use: (client: CodexProbeClient) => Promise<A>,
): Promise<A> {
  return callbacks.runPromise(
    withCodexProbeSession(
      callbacks,
      {
        binaryPath,
        env: { ...process.env, CODEX_HOME: stateHome },
        expectedCodexHome: stateHome,
        clientInfo: {
          name: "nodex-agent-runtime-conformance",
          title: "Nodex Agent Runtime Conformance",
          version: "1.0.0",
        },
      },
      use,
    ),
  );
}

async function probeAgentRuntimePromise(
  input: { binaryPath: string; stateHome: string },
  callbacks: ScopedCallbackRuntime["Service"],
): Promise<AgentRuntimeConformanceReport> {
  const lock = readCodexAppServerReleaseLock(resolveCodexAppServerReleaseLockPath(projectRoot));
  mkdirSync(input.stateHome, { mode: 0o700, recursive: true });
  const stateHome = realpathSync(input.stateHome);
  const versionOutput = execFileSync(input.binaryPath, ["--version"], {
    encoding: "utf8",
  }).trim();
  if (!versionOutput.includes(lock.appServerRuntimeVersion)) {
    throw new Error(
      `Agent runtime version ${versionOutput} does not match ${lock.appServerRuntimeVersion}`,
    );
  }

  const first = await withProbeClient(callbacks, input.binaryPath, stateHome, async (client) => {
    const initialize = client.getInitializeResponse();
    const models = readData(
      await client.request("model/list", { cursor: null, limit: 100 }),
      "model/list",
    );
    if (models.length === 0) throw new Error("Codex app-server returned an empty model catalog");
    const started = await client.request<ThreadStartResponse>("thread/start", {
      cwd: projectRoot,
      historyMode: "paginated",
    });
    if (started.thread.historyMode !== "paginated" || started.thread.turns.length !== 0) {
      throw new Error("Codex app-server did not honor the paginated Thread metadata contract");
    }
    const threads = readData(
      await client.request("thread/list", {
        archived: false,
        cursor: null,
        limit: 1,
        sortKey: "updated_at",
      }),
      "thread/list",
    );
    try {
      await client.request("nodex/conformance/invalid-method", {});
      throw new Error("Codex app-server accepted an invalid method");
    } catch (error) {
      if (!(error instanceof CodexRpcError)) throw error;
    }
    return { initialize, modelCount: models.length, threadCount: threads.length };
  });
  const restartedThreadCount = await withProbeClient(
    callbacks,
    input.binaryPath,
    stateHome,
    async (client) =>
      readData(
        await client.request("thread/list", {
          archived: false,
          cursor: null,
          limit: 1,
          sortKey: "updated_at",
        }),
        "thread/list",
      ).length,
  );

  return {
    appServerRuntimeVersion: lock.appServerRuntimeVersion,
    binaryPath: path.resolve(input.binaryPath),
    capabilities: {
      coldRestart: "pass",
      gracefulShutdown: "pass",
      initialize: "pass",
      invalidMethod: "pass",
      modelList: "pass",
      paginatedThreadStart: "pass",
    },
    generatedAt: new Date().toISOString(),
    initialize: {
      codexHome: first.initialize.codexHome,
      platformFamily: first.initialize.platformFamily,
      platformOs: first.initialize.platformOs,
      userAgent: first.initialize.userAgent,
    },
    modelCount: first.modelCount,
    protocolSchemaFingerprint: lock.protocolSchema.sha256,
    sourceCommit: lock.upstream.commit,
    sourceTag: lock.upstream.tag,
    threadCount: { first: first.threadCount, restarted: restartedThreadCount },
  };
}

export const probeAgentRuntime = (input: {
  binaryPath: string;
  stateHome: string;
}): Effect.Effect<AgentRuntimeConformanceReport, Cause.UnknownError, ScopedCallbackRuntime> =>
  Effect.gen(function* () {
    const callbacks = yield* ScopedCallbackRuntime;
    return yield* Effect.tryPromise(() => probeAgentRuntimePromise(input, callbacks));
  });

function readOption(argv: string[], option: string): string | null {
  const index = argv.indexOf(option);
  if (index < 0) return null;
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
  return value;
}

const main = Effect.gen(function* () {
  const argv = process.argv.slice(2);
  const binaryPath = path.resolve(
    readOption(argv, "--binary") ??
      resolveCodexRuntime({ isPackaged: false, projectRootPath: projectRoot }).binaryPath,
  );
  const explicitStateHome = readOption(argv, "--state-home");
  const temporaryRoot = explicitStateHome
    ? null
    : mkdtempSync(path.join(os.tmpdir(), "nodex-agent-runtime-conformance-"));
  const stateHome = path.resolve(explicitStateHome ?? path.join(temporaryRoot!, "home"));
  const outputPath = path.resolve(
    readOption(argv, "--out") ??
      path.join(projectRoot, ".generated", "agent-runtime-conformance", "latest.json"),
  );
  try {
    const report = yield* probeAgentRuntime({ binaryPath, stateHome });
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    if ((statSync(outputPath).mode & 0o077) !== 0) {
      throw new Error(`Conformance report permissions are too broad: ${outputPath}`);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (temporaryRoot) rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCodexProbeMain(main);
}
