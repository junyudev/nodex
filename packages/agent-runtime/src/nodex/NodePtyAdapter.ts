import * as NodeModule from "node:module";
import * as NodeNet from "node:net";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

export class NodePtyModuleLoadError extends Schema.TaggedError<NodePtyModuleLoadError>()(
  "NodePtyModuleLoadError",
  {
    platform: Schema.String,
    architecture: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to load node-pty for ${this.platform}-${this.architecture}.`;
  }
}

type NodePtyModuleLoader = () => Promise<typeof import("node-pty")>;

// node-pty stays external to the CLI bundle because it dlopens a native
// addon. Inside a Node single-executable, `import()` cannot load files from
// disk (only built-ins resolve), while `require` always reads the real
// filesystem, so both the module and its spawn-helper resolve through it.
const requireForNodePty = NodeModule.createRequire(import.meta.url);

export const PosixPtySignalRef = Context.Reference<(pid: number, signal: string) => void>(
  "nodex/PosixPtySignal",
  {
    defaultValue: () => (pid, signal) => {
      process.kill(pid, signal as NodeJS.Signals);
    },
  },
);

const loadNodePty: NodePtyModuleLoader = () =>
  Promise.resolve().then(() => requireForNodePty("node-pty") as typeof import("node-pty"));

export const NodePtyModuleLoaderRef = Context.Reference<NodePtyModuleLoader>(
  "nodex/NodePtyModuleLoader",
  { defaultValue: () => loadNodePty },
);

/**
 * node-pty defers creation to avoid blocking on named pipes:
 * https://github.com/microsoft/node-pty/pull/885 Its public API has no
 * readiness event. The private ready_datapipe handler sets pid before our
 * listener runs.
 */
const waitForWindowsPid = (
  process: import("node-pty").IPty,
  trackedProcess: NodePtyProcess,
  shell: string,
) =>
  Effect.callback<void, PtyAdapter.PtySpawnError>((resume) => {
    const hasPid = () => Number.isInteger(process.pid) && process.pid > 0;
    const failure = (cause: unknown) =>
      Effect.fail(new PtyAdapter.PtySpawnError({ adapter: "node-pty", shell, cause }));

    if (hasPid()) {
      resume(Effect.void);
      return;
    }

    if (!("_socket" in process) || !(process._socket instanceof NodeNet.Socket)) {
      resume(failure(new Error("Windows PTY readiness socket is unavailable.")));
      return;
    }

    const socket = process._socket;
    const onReady = () => {
      cleanup();
      resume(
        hasPid()
          ? Effect.void
          : failure(new Error("Windows PTY became ready without a valid PID.")),
      );
    };
    const onError = (cause: Error) => {
      cleanup();
      resume(failure(cause));
    };
    const onClose = () => onError(new Error("Windows PTY closed before its PID was available."));
    let stopExit = () => {};
    const cleanup = () => {
      socket.off("ready_datapipe", onReady);
      socket.off("error", onError);
      socket.off("close", onClose);
      stopExit();
    };
    socket.once("ready_datapipe", onReady);
    socket.once("error", onError);
    socket.once("close", onClose);
    stopExit = trackedProcess.onExit(({ exitCode }) =>
      onError(
        new Error(`Windows PTY exited before its PID was available (exit code ${exitCode}).`),
      ),
    );
    return Effect.sync(cleanup);
  });

/**
 * Cancels Windows startup without waiting for the first output, unlike public kill().
 * The private agent can cancel the pending connection before a child exists.
 */
const killStartingWindowsPty = (process: import("node-pty").IPty) =>
  Effect.try(() => {
    if (
      "_agent" in process &&
      typeof process._agent === "object" &&
      process._agent !== null &&
      "kill" in process._agent &&
      typeof process._agent.kill === "function"
    ) {
      process._agent.kill();
    } else {
      process.kill();
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to cancel Windows terminal startup", {
        terminalPid: process.pid,
        cause: error,
      }),
    ),
  );

class NodePtyProcess implements PtyAdapter.PtyProcess {
  private readonly process: import("node-pty").IPty;
  private readonly platform: NodeJS.Platform;
  private readonly signalGroup: (pid: number, signal: string) => void;
  private exitEvent: PtyAdapter.PtyExitEvent | undefined;
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  private readonly exitSubscription: import("node-pty").IDisposable;

  constructor(
    process: import("node-pty").IPty,
    platform: NodeJS.Platform,
    signalGroup: (pid: number, signal: string) => void,
  ) {
    this.process = process;
    this.platform = platform;
    this.signalGroup = signalGroup;
    this.exitSubscription = process.onExit((event) => {
      if (this.exitEvent) return;
      this.exitEvent = { exitCode: event.exitCode, signal: event.signal ?? null };
      this.exitSubscription.dispose();
      for (const listener of this.exitListeners) listener(this.exitEvent);
      this.exitListeners.clear();
    });
  }

  get pid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  kill(signal?: string): void {
    // node-pty terminates the Windows process tree without a POSIX signal.
    if (this.exitEvent) return;
    if (this.platform === "win32") {
      this.process.kill();
      return;
    }
    // forkpty creates a dedicated session/process group. Cancel all its members,
    // including CLI subprocesses, without touching the host's process group.
    try {
      this.signalGroup(-this.pid, signal ?? "SIGHUP");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  onData(callback: (data: string) => void): () => void {
    const disposable = this.process.onData(callback);
    return () => {
      disposable.dispose();
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    if (this.exitEvent) {
      callback(this.exitEvent);
      return () => {};
    }
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  disposeExitSubscription(): void {
    this.exitSubscription.dispose();
    this.exitListeners.clear();
  }
}

const make = Effect.fn("NodePtyAdapter.make")(function* () {
  const loadNodePtyModule = yield* NodePtyModuleLoaderRef;
  const signalGroup = yield* PosixPtySignalRef;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;

  // Defer native loading until a terminal is requested. Every failure stays scoped to
  // that operation instead of preventing unrelated Agent Runtime work from starting.
  const load = yield* Effect.cached(
    Effect.tryPromise({
      try: loadNodePtyModule,
      catch: (cause) => new NodePtyModuleLoadError({ platform, architecture, cause }),
    }),
  );

  return PtyAdapter.PtyAdapter.of({
    spawn: Effect.fn("NodePtyAdapter.spawn")(function* (input) {
      const nodePty = yield* load.pipe(
        Effect.mapError(
          (cause) =>
            new PtyAdapter.PtySpawnError({ adapter: "node-pty", shell: input.shell, cause }),
        ),
      );
      // node-pty only writes `name` into the child's TERM on the Unix path;
      // the ConPTY path leaves the environment untouched, so Windows children
      // inherit a missing or 16-color TERM unless it is set here.
      const env =
        platform === "win32" && input.env["TERM"] === undefined
          ? { ...input.env, TERM: "xterm-256color" }
          : input.env;
      const ptyProcess = yield* Effect.try({
        try: () => {
          const nativeProcess = nodePty.spawn(input.shell, input.args ?? [], {
            cwd: input.cwd,
            cols: input.cols,
            rows: input.rows,
            env,
            name: "xterm-256color",
          });
          return {
            nativeProcess,
            process: new NodePtyProcess(nativeProcess, platform, signalGroup),
          };
        },
        catch: (cause) =>
          new PtyAdapter.PtySpawnError({
            adapter: "node-pty",
            shell: input.shell,
            cause,
          }),
      });
      if (platform === "win32") {
        yield* waitForWindowsPid(ptyProcess.nativeProcess, ptyProcess.process, input.shell).pipe(
          Effect.onError(() =>
            Effect.sync(() => ptyProcess.process.disposeExitSubscription()).pipe(
              Effect.andThen(killStartingWindowsPty(ptyProcess.nativeProcess)),
            ),
          ),
        );
      }
      return ptyProcess.process;
    }),
  });
});

export const NodePtyAdapterLive = Layer.effect(PtyAdapter.PtyAdapter, make());
