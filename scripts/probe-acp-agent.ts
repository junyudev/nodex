import { parseArgs } from "node:util";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { live as launchProbeLive } from "../src/main/platform/node/AcpAgentLaunchProbe";
import { AcpAgentLaunchProbe } from "../src/main/platform/node/AcpAgentLaunchProbe";
import { live as transportLive } from "../src/main/platform/node/AcpSessionTransport";
import {
  denied as deniedCapabilities,
  live as capabilityOwnerLive,
  permissionOnly,
  workspaceAcpClientCapabilities,
} from "../src/main/agent-backend/acp/AcpClientCapabilityOwner";
import { AcpInteractionAuthority } from "../src/main/agent-backend/acp/AcpInteractionAuthority";
import { live as terminalOwnerLive } from "../src/main/agent-backend/acp/AcpTerminalOwner";
import { live as workspaceFileOwnerLive } from "../src/main/agent-backend/acp/AcpWorkspaceFileOwner";
import { live as terminalPtyLive } from "../src/main/platform/node/TerminalPty";
import { live as terminalRuntimeMapLive } from "../src/main/terminal-runtime/TerminalRuntimeMap";
import { acpRuntimeError } from "../src/main/agent-backend/acp/AcpRuntimeError";
import {
  AcpSessionRuntime,
  layer as sessionRuntimeLayer,
} from "../src/main/agent-backend/acp/AcpSessionRuntime";
import { resolveClaudeAcpLaunch } from "../src/main/agent-backend/acp/ClaudeAcpAgentDefinition";

interface AcpAgentProbeReport {
  readonly agentVersion: string;
  readonly nodeVersion: string;
  readonly protocolVersion: number;
  readonly sessionId: string | null;
  readonly authMethodIds: readonly string[];
  readonly sessionCapabilities: AcpSessionRuntime["Service"]["capabilities"]["session"];
  readonly prompt?: {
    readonly stopReason: string;
    readonly eventCount: number;
    readonly updateKinds: readonly string[];
    readonly expectedTextObserved?: boolean;
    readonly expectedStopReasonObserved?: boolean;
  };
}

const options = parseArgs({
  allowPositionals: false,
  strict: true,
  options: {
    "package-root": { type: "string" },
    cwd: { type: "string", default: process.cwd() },
    "node-executable": { type: "string", default: process.execPath },
    prompt: { type: "string" },
    "expect-text": { type: "string" },
    "expect-stop-reason": { type: "string" },
    "approve-permissions": { type: "boolean", default: false },
    "workspace-tools": { type: "boolean", default: false },
    "cancel-after-ms": { type: "string" },
  },
}).values;

if (!options["package-root"]?.trim()) {
  throw new Error(
    "Usage: vp run agent:smoke:acp --package-root /absolute/package/root [--cwd /workspace] [--prompt 'Reply OK']",
  );
}
if (options["expect-text"] !== undefined && options.prompt === undefined) {
  throw new Error("--expect-text requires --prompt");
}
if (options["expect-stop-reason"] !== undefined && options.prompt === undefined) {
  throw new Error("--expect-stop-reason requires --prompt");
}
const cancelAfterMs = (() => {
  if (options["cancel-after-ms"] === undefined) return null;
  const value = Number(options["cancel-after-ms"]);
  if (Number.isSafeInteger(value) && value > 0) return value;
  throw new Error("--cancel-after-ms must be a positive safe integer");
})();

const requestPermission = (
  request: Parameters<AcpInteractionAuthority["Service"]["requestPermission"]>[0],
) => {
  if (!options["approve-permissions"]) {
    return Effect.succeed({ outcome: { outcome: "cancelled" as const } });
  }
  const option = request.options.find(({ kind }) => kind === "allow_once");
  return Effect.succeed(
    option === undefined
      ? { outcome: { outcome: "cancelled" as const } }
      : {
          outcome: {
            outcome: "selected" as const,
            optionId: option.optionId,
          },
        },
  );
};

const capabilityOwner = options["workspace-tools"]
  ? (() => {
      const workspace = workspaceFileOwnerLive({ workspaceRoot: options.cwd! });
      const runtimeMap = terminalRuntimeMapLive.pipe(Layer.provide(terminalPtyLive));
      const terminal = terminalOwnerLive({
        environment: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          TERM: process.env.TERM ?? "xterm-256color",
        },
      }).pipe(Layer.provide(Layer.merge(workspace, runtimeMap)));
      const interaction = Layer.succeed(
        AcpInteractionAuthority,
        AcpInteractionAuthority.of({
          requestPermission,
          createElicitation: () => Effect.succeed({ action: "cancel" }),
          completeElicitation: () => Effect.void,
        }),
      );
      return capabilityOwnerLive(workspaceAcpClientCapabilities).pipe(
        Layer.provide(Layer.mergeAll(interaction, workspace, terminal)),
      );
    })()
  : options["approve-permissions"]
    ? permissionOnly(requestPermission)
    : deniedCapabilities;

const program = Effect.scoped(
  Effect.gen(function* () {
    const probeContext = yield* Layer.build(launchProbeLive);
    const launch = yield* resolveClaudeAcpLaunch({
      installation: { packageRoot: options["package-root"]! },
      nodeExecutable: options["node-executable"]!,
      workspaceRoot: options.cwd!,
      hostEnvironment: process.env,
      policy: {
        credentials: { kind: "inherit-host-profile" },
        proxy: "inherit-host",
        sandbox: { kind: "agent-native-permissions", acknowledged: true },
      },
    }).pipe(
      Effect.provideService(AcpAgentLaunchProbe, Context.get(probeContext, AcpAgentLaunchProbe)),
    );
    const runtimeContext = yield* Layer.build(
      sessionRuntimeLayer({
        spawn: launch.spawn,
        cwd: launch.cwd,
        clientInfo: { name: "nodex-acp-agent-probe", title: "Nodex ACP Agent Probe", version: "1" },
      }).pipe(Layer.provide(Layer.merge(transportLive, capabilityOwner))),
    );
    const runtime = Context.get(runtimeContext, AcpSessionRuntime);
    let eventCount = 0;
    let agentText = "";
    const updateKinds = new Set<string>();
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          eventCount += 1;
          if (event.kind === "turn_stopped") {
            updateKinds.add("turn_stopped");
            return;
          }
          updateKinds.add(event.update.sessionUpdate);
          if (
            event.update.sessionUpdate === "agent_message_chunk" &&
            event.update.content.type === "text"
          ) {
            agentText = `${agentText}${event.update.content.text}`.slice(-8_192);
          }
        }),
      ),
      Effect.forkScoped,
    );

    const report: AcpAgentProbeReport = {
      agentVersion: launch.agentVersion,
      nodeVersion: launch.nodeVersion,
      protocolVersion: runtime.initializeResponse.protocolVersion,
      sessionId: runtime.sessionId,
      authMethodIds: runtime.capabilities.authMethods.map(({ id }) => id),
      sessionCapabilities: runtime.capabilities.session,
    };
    if (options.prompt === undefined) return report;
    if (runtime.sessionId === null) {
      return yield* Effect.fail(
        acpRuntimeError({
          operation: "probe.prompt",
          reason: "authentication-required",
          retryable: false,
          pid: runtime.pid,
          cause: new Error("Authenticate the ACP Agent before running a paid prompt smoke"),
        }),
      );
    }
    if (cancelAfterMs !== null) {
      yield* Effect.sleep(cancelAfterMs).pipe(Effect.andThen(runtime.cancel), Effect.forkScoped);
    }
    const response = yield* runtime.prompt([{ type: "text", text: options.prompt }]);
    yield* Effect.yieldNow;
    return {
      ...report,
      prompt: {
        stopReason: response.stopReason,
        eventCount,
        updateKinds: [...updateKinds].sort(),
        ...(options["expect-text"] === undefined
          ? {}
          : { expectedTextObserved: agentText.includes(options["expect-text"]) }),
        ...(options["expect-stop-reason"] === undefined
          ? {}
          : {
              expectedStopReasonObserved: response.stopReason === options["expect-stop-reason"],
            }),
      },
    };
  }),
);

void Effect.runPromise(Effect.exit(program)).then((exit) => {
  if (Exit.isSuccess(exit)) {
    process.stdout.write(`${JSON.stringify(exit.value, null, 2)}\n`);
    if (
      exit.value.prompt?.expectedTextObserved === false ||
      exit.value.prompt?.expectedStopReasonObserved === false
    ) {
      process.stderr.write("Expected ACP prompt outcome was not observed.\n");
      process.exitCode = 1;
    }
    return;
  }
  process.stderr.write(`${Cause.pretty(exit.cause)}\n`);
  process.exitCode = 1;
});
