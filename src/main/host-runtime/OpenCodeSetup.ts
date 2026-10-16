import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { MINIMUM_OPENCODE_VERSION } from "../../../packages/agent-runtime/vendor/provider-opencode/src/settings";
import {
  compareSemverVersions,
  parseSemver,
} from "../../../packages/agent-runtime/vendor/shared/src/semver";
import { projectOpenCodeInstallerLog } from "../../shared/opencode-install-log";
import type { OpenCodeExecutable, OpenCodeSetupState } from "../../shared/opencode-setup";
import { AgentRuntimeProviderConfiguration } from "../agent-runtime/AgentRuntimeProviderConfiguration";
import { MainConfig } from "../app/MainConfig";
import {
  OPENCODE_INSTALL_COMMAND,
  OpenCodeInstallPlatform,
  type OpenCodeInstalledExecutable,
  type OpenCodeInstallOutput,
} from "../platform/node/OpenCodeInstallPlatform";

const MAXIMUM_RAW_LOG_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class OpenCodeSetup extends Context.Service<
  OpenCodeSetup,
  {
    readonly read: Effect.Effect<OpenCodeSetupState>;
    readonly install: Effect.Effect<OpenCodeSetupState>;
    readonly cancel: Effect.Effect<OpenCodeSetupState>;
    readonly changes: Stream.Stream<OpenCodeSetupState>;
  }
>()("nodex/main/host-runtime/OpenCodeSetup") {}

class OpenCodeSetupConfigurationError extends Schema.TaggedError<OpenCodeSetupConfigurationError>()(
  "OpenCodeSetupConfigurationError",
  { reason: Schema.Literal("configuration"), message: Schema.String, cause: Schema.Defect() },
) {}

const executableState = (installed: OpenCodeInstalledExecutable | null): OpenCodeExecutable => {
  if (!installed) return { status: "missing" };
  const comparable = installed.version.split("+", 1)[0]!;
  const version = parseSemver(comparable);
  if (!version) return { status: "unusable", message: "OpenCode returned an invalid version." };
  if (
    version.major >= 2 ||
    (version.major === 1 && compareSemverVersions(comparable, MINIMUM_OPENCODE_VERSION) >= 0)
  )
    return { status: "ready", ...installed };
  return { status: "incompatible", ...installed, minimumVersion: MINIMUM_OPENCODE_VERSION };
};

const sameExecutable = (left: OpenCodeExecutable, right: OpenCodeExecutable): boolean => {
  if (left.status !== right.status) return false;
  if (left.status === "missing" && right.status === "missing") return true;
  if (left.status === "unusable" && right.status === "unusable")
    return left.message === right.message;
  if (
    (left.status === "ready" || left.status === "incompatible") &&
    (right.status === "ready" || right.status === "incompatible")
  )
    return left.binaryPath === right.binaryPath && left.version === right.version;
  return false;
};

/** Keep complete UTF-8 characters when the retained raw terminal tail crosses its byte budget. */
const appendRawOutput = (current: string, data: string): string => {
  const bytes = encoder.encode(current + data);
  let start = Math.max(0, bytes.length - MAXIMUM_RAW_LOG_BYTES);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return decoder.decode(bytes.subarray(start));
};

export const make = Effect.gen(function* () {
  const platform = yield* OpenCodeInstallPlatform;
  const providers = yield* AgentRuntimeProviderConfiguration;
  const config = yield* MainConfig;
  const supported = config.platform === "darwin" || config.platform === "linux";
  const initial: OpenCodeSetupState = {
    revision: 0,
    supported,
    command: OPENCODE_INSTALL_COMMAND,
    executable: { status: "missing" },
    installation: { phase: "idle" },
  };
  const state = yield* Ref.make({ snapshot: initial, raw: "" });
  const updates = yield* Effect.acquireRelease(
    PubSub.sliding<OpenCodeSetupState>(16),
    PubSub.shutdown,
  );
  const logSignals = yield* Effect.acquireRelease(PubSub.sliding<void>(1), PubSub.shutdown);
  const task = yield* FiberHandle.make<void, never>();
  const admission = yield* Semaphore.make(1);
  const delivery = yield* Semaphore.make(1);
  const lastDelivered = yield* Ref.make(-1);
  const current = Ref.get(state).pipe(Effect.map((value) => value.snapshot));
  const update = (
    change: (value: { snapshot: OpenCodeSetupState; raw: string }) => {
      snapshot: OpenCodeSetupState;
      raw: string;
    },
  ) =>
    Ref.modify(state, (value) => {
      const next = change(value);
      if (next === value) return [value.snapshot, value] as const;
      const snapshot = { ...next.snapshot, revision: value.snapshot.revision + 1 };
      return [snapshot, { ...next, snapshot }] as const;
    });
  const deliver = delivery.withPermits(1)(
    Effect.gen(function* () {
      const snapshot = yield* current;
      if (snapshot.revision <= (yield* Ref.get(lastDelivered))) return;
      yield* Ref.set(lastDelivered, snapshot.revision);
      yield* PubSub.publish(updates, snapshot);
    }),
  );
  const publish = (change: (snapshot: OpenCodeSetupState) => OpenCodeSetupState) =>
    update((value) => ({ ...value, snapshot: change(value.snapshot) })).pipe(
      Effect.tap(() => deliver),
    );
  const readExecutable = Effect.suspend(() => platform.probe()).pipe(
    Effect.map(executableState),
    Effect.catch((error) =>
      Effect.succeed<OpenCodeExecutable>({ status: "unusable", message: error.message }),
    ),
  );
  const onOutput = ({ data }: OpenCodeInstallOutput) =>
    update((value) => {
      if (value.snapshot.installation.phase !== "running") return value;
      const raw = appendRawOutput(value.raw, data);
      return {
        raw,
        snapshot: {
          ...value.snapshot,
          installation: { phase: "running", log: projectOpenCodeInstallerLog(raw) },
        },
      };
    }).pipe(Effect.andThen(PubSub.publish(logSignals, undefined)), Effect.asVoid);
  const subscription = yield* PubSub.subscribe(logSignals);
  yield* Stream.fromSubscription(subscription).pipe(
    Stream.runForEach(() => Effect.sleep("100 millis").pipe(Effect.andThen(deliver))),
    Effect.forkScoped,
  );
  const clearInstallation = publish((snapshot) => ({
    ...snapshot,
    installation: { phase: "idle" },
  })).pipe(Effect.asVoid);
  const complete = Effect.fn("OpenCodeSetup.complete")(function* (executable: OpenCodeExecutable) {
    yield* update((value) => ({ ...value, snapshot: { ...value.snapshot, executable } }));
    yield* providers.refresh.pipe(
      Effect.mapError(
        (cause) =>
          new OpenCodeSetupConfigurationError({
            reason: "configuration",
            message: "OpenCode is available, but its provider configuration could not refresh.",
            cause,
          }),
      ),
    );
    yield* publish((snapshot) => ({
      ...snapshot,
      installation: {
        phase: "succeeded",
        log:
          snapshot.installation.phase === "running"
            ? snapshot.installation.log
            : projectOpenCodeInstallerLog(""),
      },
    }));
  });
  const run = Effect.gen(function* () {
    const executable = yield* readExecutable;
    if (executable.status === "ready") return yield* complete(executable);
    if (executable.status !== "missing")
      return yield* publish((snapshot) => ({
        ...snapshot,
        executable,
        installation: { phase: "idle" },
      }));
    const installed = executableState(yield* platform.install(onOutput));
    if (installed.status !== "ready")
      return yield* publish((snapshot) => ({
        ...snapshot,
        executable: installed,
        installation: { phase: "idle" },
      }));
    yield* complete(installed);
  }).pipe(
    Effect.catch((error) =>
      publish((snapshot) => ({
        ...snapshot,
        installation: {
          phase: "failed",
          log:
            snapshot.installation.phase === "running"
              ? snapshot.installation.log
              : projectOpenCodeInstallerLog(""),
          reason: error.reason,
          message: error.message,
        },
      })),
    ),
    Effect.onInterrupt(() => clearInstallation),
    Effect.asVoid,
  );
  return OpenCodeSetup.of({
    read: admission.withPermits(1)(
      Effect.gen(function* () {
        const snapshot = yield* current;
        if (snapshot.installation.phase === "running" || !supported) return snapshot;
        const executable = yield* readExecutable;
        if (sameExecutable(snapshot.executable, executable)) return snapshot;
        return yield* publish((value) => ({ ...value, executable }));
      }),
    ),
    install: admission.withPermits(1)(
      Effect.gen(function* () {
        const snapshot = yield* current;
        if (snapshot.installation.phase === "running") return snapshot;
        if (!supported)
          return yield* publish((value) => ({
            ...value,
            installation: {
              phase: "failed",
              log: projectOpenCodeInstallerLog(""),
              reason: "unsupported-platform",
              message: "OpenCode installation requires macOS or Linux.",
            },
          }));
        yield* update((value) => ({
          raw: "",
          snapshot: {
            ...value.snapshot,
            installation: { phase: "running", log: projectOpenCodeInstallerLog("") },
          },
        }));
        yield* deliver;
        yield* FiberHandle.run(task, run.pipe(Effect.interruptible));
        return yield* current;
      }).pipe(Effect.uninterruptible),
    ),
    cancel: admission.withPermits(1)(FiberHandle.clear(task).pipe(Effect.andThen(current))),
    changes: Stream.fromPubSub(updates),
  });
});

export const live = Layer.effect(OpenCodeSetup, make);
