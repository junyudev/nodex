import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { release } from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { z } from "zod";
import { hostCapabilities } from "../../../shared/host-capabilities";
import {
  BrowserUseNativePipeFrameDecoder,
  encodeBrowserUseNativePipeFrame,
} from "../../browser-use/native-pipe-framing";
import type { BrowserRuntimeAvailability } from "../../codex/browser-runtime-bundle";
import type {
  WindowsDesktopToolsService,
  WindowsJobStdio,
  WindowsPipeConnection,
} from "../node/WindowsDesktopTools";
import { ComputerUseHostPlatformError } from "./ComputerUseHostPlatform";

const PACKAGE_MINIMUM_WINDOWS = "10.0.19041";
const MAX_HELPER_FRAME = 8 * 1024 * 1024;
const STOPPED =
  "Computer Use was stopped by the user with the physical Escape key. Stop your work, do not call further Computer Use tools in this turn, and send a final message noting that the user stopped Computer Use.";
const TURN_ENDED = "Computer Use is no longer available in this turn because the turn has ended.";
const APPROVED_APP = "x-oai-cua-approved-app";
const BUDGET = "x-oai-cua-request-budget-ms";
const VERSION = /^\d+\.\d+\.\d+(?:\.\d+)?$/u;

const record = z.record(z.string(), z.unknown());
const turnMetadata = z.looseObject({
  session_id: z.string().min(1).max(512),
  turn_id: z.string().min(1).max(512),
});
type TurnMetadata = z.infer<typeof turnMetadata>;
const turnKey = (metadata: TurnMetadata) => JSON.stringify([metadata.session_id, metadata.turn_id]);

const interruptMarkerPart = (value: string) => {
  const part = value.replace(/[^A-Za-z0-9._-]/gu, "_");
  return part === "." || part === ".." ? "_" : part;
};

const request = z.object({
  id: z.number().int(),
  jsonrpc: z.literal("2.0"),
  method: z.enum(["ping", "close", "request"]),
  params: z.unknown().optional(),
});
const toolRequest = z.object({
  method: z.string().min(1).max(128),
  params: z.unknown().optional(),
  codexTurnMetadata: turnMetadata,
});
const approvalResponse = z.object({
  id: z.string(),
  jsonrpc: z.literal("2.0"),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});
const approvalResult = z.looseObject({
  action: z.enum(["accept", "decline", "cancel"]),
  content: record.nullish(),
  _meta: record.nullish(),
});
const helperReply = z.object({
  id: z.number().int(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  approvalRequest: z
    .object({
      app: z.string().trim().min(1).max(1024),
      displayName: z.string().trim().optional(),
      allowPersistentApproval: z.boolean().optional(),
      riskLevel: z.enum(["low", "high"]).optional(),
    })
    .optional(),
});
type HelperReply = z.infer<typeof helperReply>;
type AppApproval = NonNullable<HelperReply["approvalRequest"]>;

export type WindowsComputerUseTurn = {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
} & ({ readonly phase: "started"; readonly sessionId: string } | { readonly phase: "ended" });

export interface WindowsComputerUseHost {
  readonly platform: "win32";
  readonly architecture: string;
  readonly osRelease: string;
  readonly start: (
    executable: string,
    nodeRepl: string,
    activeTurns: { has(key: string): boolean },
  ) => Effect.Effect<WindowsComputerUseServer, ComputerUseHostPlatformError, Scope.Scope>;
}

interface WindowsComputerUseServer {
  readonly pipePath: string;
  readonly isListening: () => boolean;
  readonly endTurn: (turn: WindowsComputerUseTurn) => Effect.Effect<void>;
}

export function windowsComputerUseTurnKey(turn: WindowsComputerUseTurn): string {
  return turnKey({ session_id: turn.nativeThreadId, turn_id: turn.nativeTurnId });
}

function meetsWindowsMinimum(osRelease: string, minimum: string): boolean {
  if (!VERSION.test(osRelease) || !VERSION.test(minimum)) return false;
  const actual = osRelease.split(".").map(Number);
  const required = minimum.split(".").map(Number);
  const difference = required
    .map((part, index) => (actual[index] ?? 0) - part)
    .find((part) => part !== 0);
  return difference === undefined || difference > 0;
}

export function resolveWindowsComputerUse(
  runtime: BrowserRuntimeAvailability,
  host: Pick<WindowsComputerUseHost, "architecture" | "osRelease">,
) {
  if (runtime.status === "unavailable") {
    return {
      status: "unavailable",
      reason: "runtime-unavailable",
      message: runtime.message,
    } as const;
  }
  const { manifest, paths } = runtime.bundle;
  if (
    manifest.targetPlatform !== "win32" ||
    manifest.targetArch !== host.architecture ||
    !hostCapabilities("win32", host.architecture, {
      computerUseReady: manifest.capabilities.computerUse.status === "available",
    }).computerControl
  ) {
    return {
      status: "unavailable",
      reason: "architecture-unsupported",
      message: "Computer Use requires a verified Windows runtime for this architecture.",
    } as const;
  }
  // The v8 closure binds the matching package, whose Windows.Desktop minimum is 19041.
  const declaredMinimum = manifest.capabilities.computerUse.minimumWindowsVersion;
  const minimum =
    declaredMinimum && meetsWindowsMinimum(declaredMinimum, PACKAGE_MINIMUM_WINDOWS)
      ? declaredMinimum
      : PACKAGE_MINIMUM_WINDOWS;
  if (!meetsWindowsMinimum(host.osRelease, minimum)) {
    return {
      status: "unavailable",
      reason: "windows-version-unsupported",
      message: `Computer Use requires Windows build ${minimum} or later.`,
    } as const;
  }
  if (!paths.computerUseService) {
    return {
      status: "unavailable",
      reason: "helper-invalid",
      message: "The verified Windows Computer Use service is missing.",
    } as const;
  }
  // The resolver attests the complete closure, including the capture helper and its DLLs.
  return {
    status: "available",
    serviceExecutablePath: paths.computerUseService,
    nodeRepl: paths.nodeRepl,
  } as const;
}

const platformError = (operation: string, cause: unknown) =>
  new ComputerUseHostPlatformError({ operation, cause });

const asError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)));

interface Helper {
  readonly scope: Scope.Closeable;
  readonly exited: () => boolean;
  readonly waitForStop: Effect.Effect<never, Error>;
  readonly call: (
    method: string,
    params: unknown,
    metadata: Readonly<Record<string, unknown>>,
    budget?: number,
  ) => Effect.Effect<HelperReply, Error>;
}

const makeHelper = (job: WindowsJobStdio, scope: Scope.Closeable, onEscape: () => void) =>
  Effect.gen(function* () {
    const pending = new Map<number, Deferred.Deferred<HelperReply, Error>>();
    const stop = yield* Deferred.make<never, Error>();
    let nextId = 0;
    let stopped: Error | undefined;
    const fail = (error: Error) =>
      Effect.gen(function* () {
        stopped ??= error;
        yield* Deferred.fail(stop, stopped);
        for (const reply of pending.values()) yield* Deferred.fail(reply, stopped);
        pending.clear();
      });
    // Read every flushed reply before handling the native command's exit code.
    yield* Effect.forkIn(
      Effect.gen(function* () {
        let buffer: Buffer = Buffer.alloc(0);
        yield* Stream.fromAsyncIterable(job.output, asError).pipe(
          Stream.runForEach((chunk: Buffer) =>
            Effect.gen(function* () {
              buffer = Buffer.concat([buffer, chunk]);
              while (buffer.length > 0) {
                const newline = buffer.indexOf(10);
                if ((newline < 0 ? buffer.length : newline) > MAX_HELPER_FRAME) {
                  return yield* Effect.fail(new Error("Computer Use helper frame is too large"));
                }
                if (newline < 0) return;
                const line = buffer.subarray(0, newline).toString("utf8").trim();
                buffer = buffer.subarray(newline + 1);
                if (!line) continue;
                const parsed = yield* Effect.try({
                  try: () => JSON.parse(line) as unknown,
                  catch: asError,
                });
                const message = helperReply.safeParse(parsed);
                if (!message.success) {
                  // The reference Main subscribes to request replies, leaving unsolicited
                  // helper events with the native indicator and input lifecycle.
                  if (record.safeParse(parsed).success && !Object.hasOwn(parsed as object, "id"))
                    continue;
                  return yield* Effect.fail(new Error("Invalid Computer Use helper response"));
                }
                const waiter = pending.get(message.data.id);
                if (waiter) yield* Deferred.succeed(waiter, message.data);
              }
            }),
          ),
        );
      }).pipe(
        Effect.andThen(Effect.promise(() => job.exited)),
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            if (code === 130) onEscape();
            yield* fail(new Error(code === 130 ? STOPPED : `Computer Use helper exited (${code})`));
          }),
        ),
        Effect.catch(fail),
      ),
      scope,
    );

    const call: Helper["call"] = (
      method,
      params,
      metadata,
      budget = method === "launch_app" ? 15_000 : 10_000,
    ) =>
      Effect.gen(function* () {
        if (stopped) return yield* Effect.fail(stopped);
        const id = ++nextId;
        const reply = yield* Deferred.make<HelperReply, Error>();
        const frame = `${JSON.stringify({ id, method, params: params ?? {}, meta: { ...metadata, [BUDGET]: budget } })}\n`;
        if (Buffer.byteLength(frame) > MAX_HELPER_FRAME) {
          return yield* Effect.fail(new Error("Computer Use helper request is too large"));
        }
        pending.set(id, reply);
        return yield* Effect.callback<void, Error>((resume) => {
          job.input.write(frame, (error) => resume(error ? Effect.fail(error) : Effect.void));
        }).pipe(
          Effect.andThen(Deferred.await(reply)),
          Effect.timeoutOrElse({
            duration: budget,
            orElse: () => {
              const error = new Error(`Computer Use helper timed out: ${method}`);
              return fail(error).pipe(Effect.andThen(Effect.fail(error)));
            },
          }),
          Effect.ensuring(
            Effect.sync(() => {
              pending.delete(id);
            }),
          ),
        );
      });
    return {
      scope,
      exited: () => stopped !== undefined,
      waitForStop: Deferred.await(stop),
      call,
    } satisfies Helper;
  });

interface Work {
  readonly stream: Duplex;
  readonly key: string;
  readonly stop: Deferred.Deferred<never, Error>;
  approval?: { readonly id: string; readonly reply: Deferred.Deferred<unknown, Error> };
}

function send(stream: Duplex, id: number | string, body: object): void {
  if (stream.destroyed) return;
  const json = JSON.stringify({ jsonrpc: "2.0", id, ...body });
  if (Buffer.byteLength(json) > MAX_HELPER_FRAME) {
    send(stream, id, { error: { code: -32000, message: "Computer Use response is too large" } });
    return;
  }
  stream.write(encodeBrowserUseNativePipeFrame(json, MAX_HELPER_FRAME));
}

export function makeWindowsComputerUseHostPlatform(options: {
  readonly tools: WindowsDesktopToolsService;
  readonly architecture?: string;
  readonly osRelease?: string;
  readonly parentPid: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly runtimeStateHome: string;
  readonly codexCliPath: string | null;
  readonly canonicalPath?: (file: string) => string;
}): WindowsComputerUseHost {
  const { tools } = options;
  const canonical = options.canonicalPath ?? realpathSync.native;
  return {
    platform: "win32",
    architecture: options.architecture ?? process.arch,
    osRelease: options.osRelease ?? release(),
    start: (executable, nodeRepl, activeTurns) =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const listener = yield* tools.listenPipe("nodex-computer-use");
        const executableIdentity = yield* Effect.try(() => canonical(executable));
        const replIdentity = yield* Effect.try(() => canonical(nodeRepl));
        const gate = yield* Semaphore.make(1);
        const stoppedTurns = new Set<string>();
        let listening = true;
        let helper: Helper | null = null;
        let current: { readonly stream: Duplex; readonly metadata: TurnMetadata } | null = null;
        let work: Work | null = null;

        const disposeHelper = (graceful: boolean) =>
          Effect.suspend(() => {
            const previous = helper;
            helper = null;
            current = null;
            if (!previous) return Effect.void;
            const closeJob = Scope.close(previous.scope, Exit.void);
            if (!graceful || previous.exited()) return closeJob;
            // Give the helper a chance to clear its overlay and restore the system cursor.
            return previous
              .call("close", {}, {}, 1_000)
              .pipe(Effect.ignore, Effect.ensuring(closeJob));
          });
        const closeHelper = disposeHelper(true);
        const terminateHelper = disposeHelper(false);
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            listening = false;
          }).pipe(Effect.andThen(gate.withPermits(1)(closeHelper))),
        );

        const startHelper = Effect.gen(function* () {
          if (helper && !helper.exited()) return helper;
          yield* closeHelper;
          const childScope = yield* Scope.make();
          const environment = Object.fromEntries(
            Object.entries(options.environment)
              .filter(([key]) =>
                /^(?:SystemRoot|WINDIR|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA)$/iu.test(key),
              )
              .map(([key, value]) => [key.toUpperCase(), value]),
          );
          const child = yield* tools
            .spawnInJob({
              executable: executableIdentity,
              args: ["--parent-pid", String(options.parentPid)],
              cwd: path.dirname(executableIdentity),
              env: {
                ...environment,
                CODEX_HOME: options.runtimeStateHome,
                ...(options.codexCliPath ? { CODEX_CLI_PATH: options.codexCliPath } : {}),
              },
            })
            .pipe(
              Scope.provide(childScope),
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? Scope.close(childScope, Exit.void) : Effect.void,
              ),
              Effect.mapError(asError),
            );
          const launchedImage = yield* Effect.try(() => canonical(child.identity.imagePath)).pipe(
            Effect.onError(() => Scope.close(childScope, Exit.void)),
          );
          if (launchedImage !== executableIdentity) {
            yield* Scope.close(childScope, Exit.void);
            return yield* Effect.fail(
              new Error("Computer Use helper image did not match the verified executable"),
            );
          }
          helper = yield* makeHelper(child, childScope, () => {
            if (!current) return;
            const key = turnKey(current.metadata);
            if (activeTurns.has(key)) stoppedTurns.add(key);
          });
          return helper;
        }).pipe(Effect.uninterruptible);

        const endCurrentTurn = Effect.suspend(() => {
          const ending = current;
          current = null;
          if (!ending || !helper) return Effect.void;
          if (helper.exited()) return terminateHelper;
          // End the helper's native activity even if the REPL abandoned its outstanding reply.
          return helper.call("end_turn", {}, ending.metadata, 1_000).pipe(
            Effect.flatMap((reply) => (reply.ok ? Effect.void : terminateHelper)),
            Effect.catch(() => terminateHelper),
          );
        });

        const finishTurn: WindowsComputerUseServer["endTurn"] = (turn) =>
          Effect.gen(function* () {
            const key = windowsComputerUseTurnKey(turn);
            stoppedTurns.delete(key);
            if (work?.key === key) yield* Deferred.fail(work.stop, new Error(TURN_ENDED));
            yield* gate.withPermits(1)(
              Effect.suspend(() =>
                current && turnKey(current.metadata) === key ? endCurrentTurn : Effect.void,
              ),
            );
          });

        const elicit = (owner: Work, approval: AppApproval, metadata: TurnMetadata) =>
          Effect.gen(function* () {
            const reply = yield* Deferred.make<unknown, Error>();
            const id = `computer-use-approval:${randomUUID()}`;
            const name = approval.displayName || approval.app;
            const audio = approval.app === "computer-audio";
            const canPersist = approval.allowPersistentApproval !== false && !audio;
            owner.approval = { id, reply };
            yield* Effect.sync(() =>
              send(owner.stream, id, {
                method: "requestComputerUseApproval",
                params: {
                  message: audio
                    ? "Allow Computer Use to record computer audio?"
                    : `Allow Nodex to use ${name}?`,
                  meta: {
                    codex_approval_kind: "mcp_tool_call",
                    ...(audio
                      ? {
                          codex_request_type: "approval_request",
                          tool_name: "start_audio_recording",
                        }
                      : {}),
                    ...(audio && typeof (metadata.call_id ?? metadata.item_id) === "string"
                      ? { tool_call_id: metadata.call_id ?? metadata.item_id }
                      : {}),
                    connector_id: "computer-use",
                    connector_name: "Computer Use",
                    persist: canPersist ? ["session", "always"] : ["session"],
                    riskLevel: approval.riskLevel ?? "low",
                    tool_params: { app: approval.app },
                    tool_params_display: [{ name: "app", display_name: "App", value: name }],
                  },
                },
              }),
            );
            const result = approvalResult.safeParse(
              yield* Deferred.await(reply).pipe(
                Effect.timeoutOrElse({
                  duration: "5 minutes",
                  orElse: () => Effect.fail(new Error("Computer Use app approval timed out")),
                }),
                Effect.ensuring(
                  Effect.sync(() => {
                    delete owner.approval;
                  }),
                ),
              ),
            );
            if (
              !result.success ||
              result.data.action !== "accept" ||
              (!canPersist &&
                (result.data._meta?.persist === "always" ||
                  result.data.content?.persist === "always" ||
                  (result.data.content?.source === "computer-use-persisted-state" &&
                    result.data.content.scope === "global")))
            ) {
              return yield* Effect.fail(new Error(`Computer Use was not approved to use ${name}`));
            }
          });

        const invoke = (owner: Work, input: z.infer<typeof toolRequest>) =>
          Effect.gen(function* () {
            const { method, params } = input;
            const metadata = { ...input.codexTurnMetadata };
            delete metadata[APPROVED_APP];
            if (
              stoppedTurns.has(owner.key) ||
              existsSync(
                path.join(
                  options.runtimeStateHome,
                  "cache",
                  "computer-use",
                  "interrupts",
                  interruptMarkerPart(metadata.session_id),
                  interruptMarkerPart(metadata.turn_id),
                ),
              )
            )
              return yield* Effect.fail(new Error(STOPPED));
            const child = yield* gate.withPermits(1)(
              Effect.gen(function* () {
                if (current && turnKey(current.metadata) !== owner.key) yield* endCurrentTurn;
                if (!activeTurns.has(owner.key)) return yield* Effect.fail(new Error(TURN_ENDED));
                if (stoppedTurns.has(owner.key)) return yield* Effect.fail(new Error(STOPPED));
                const child = yield* startHelper;
                current = { stream: owner.stream, metadata };
                return child;
              }),
            );
            const run = Effect.gen(function* () {
              for (;;) {
                if (!activeTurns.has(owner.key)) return yield* Effect.fail(new Error(TURN_ENDED));
                const response = yield* child.call(method, params, metadata);
                if (response.ok) return response.result ?? null;
                if (!response.approvalRequest) {
                  return yield* Effect.fail(
                    new Error(response.error ?? "Computer Use helper request failed"),
                  );
                }
                yield* Effect.raceFirst(
                  elicit(owner, response.approvalRequest, metadata),
                  child.waitForStop,
                );
                metadata[APPROVED_APP] = response.approvalRequest.app;
              }
            });
            return yield* run.pipe(
              Effect.tapError((error) =>
                Effect.gen(function* () {
                  if (error.message === STOPPED && activeTurns.has(owner.key))
                    stoppedTurns.add(owner.key);
                  if (child.exited() || error.message === STOPPED) {
                    yield* gate.withPermits(1)(
                      Effect.suspend(() => (helper === child ? closeHelper : Effect.void)),
                    );
                  }
                }),
              ),
            );
          });

        const disconnect = (stream: Duplex) =>
          Effect.gen(function* () {
            if (work?.stream === stream) {
              yield* Deferred.fail(work.stop, new Error("Computer Use client disconnected"));
            }
            yield* gate.withPermits(1)(
              Effect.suspend(() => (current?.stream === stream ? closeHelper : Effect.void)),
            );
          });

        const handle = (stream: Duplex, message: unknown) =>
          Effect.gen(function* () {
            const answer = approvalResponse.safeParse(message);
            const approval = work?.stream === stream ? work.approval : undefined;
            if (answer.success && approval && answer.data.id === approval.id) {
              if (answer.data.error)
                yield* Deferred.fail(approval.reply, new Error(answer.data.error.message));
              else yield* Deferred.succeed(approval.reply, answer.data.result);
              return;
            }
            const parsed = request.safeParse(message);
            if (!parsed.success) return;
            const { id, method, params } = parsed.data;
            if (method === "ping") return send(stream, id, { result: "pong" });
            if (method === "close") {
              yield* disconnect(stream);
              return send(stream, id, { result: null });
            }
            const input = toolRequest.safeParse(params);
            if (!input.success)
              return send(stream, id, {
                error: { code: -32602, message: "Invalid Computer Use request" },
              });
            const key = turnKey(input.data.codexTurnMetadata);
            // The trusted REPL also sends end_turn on normal completion. Main owns finalization.
            if (input.data.method === "end_turn") return send(stream, id, { result: null });
            if (input.data.method === "close" || !activeTurns.has(key) || work) {
              return send(stream, id, {
                error: {
                  code: -32000,
                  message: work ? "Computer Use helper already has an active request" : TURN_ENDED,
                },
              });
            }
            const owner: Work = { stream, key, stop: Deferred.makeUnsafe<never, Error>() };
            work = owner;
            yield* Effect.forkIn(
              Effect.raceFirst(invoke(owner, input.data), Deferred.await(owner.stop)).pipe(
                Effect.matchEffect({
                  onSuccess: (result) => Effect.sync(() => send(stream, id, { result })),
                  onFailure: (error) =>
                    Effect.sync(() =>
                      send(stream, id, { error: { code: -32000, message: error.message } }),
                    ),
                }),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (work === owner) work = null;
                  }),
                ),
              ),
              scope,
            );
          });

        const admit = ({ peer, stream }: WindowsPipeConnection) =>
          Effect.gen(function* () {
            const actual = yield* Effect.try(() => canonical(peer.imagePath));
            if (actual !== replIdentity) return;
            const live = yield* tools.processIdentity(peer.pid);
            if (
              live.pid !== peer.pid ||
              live.creationTime !== peer.creationTime ||
              live.imagePath !== peer.imagePath
            )
              return;
            const decoder = new BrowserUseNativePipeFrameDecoder(MAX_HELPER_FRAME);
            yield* Stream.fromAsyncIterable(stream, asError).pipe(
              Stream.runForEach((chunk: Buffer) =>
                Effect.try({
                  try: () => decoder.push(chunk).map((line) => JSON.parse(line) as unknown),
                  catch: asError,
                }).pipe(
                  Effect.flatMap((frames) =>
                    Effect.forEach(frames, (frame) => handle(stream, frame), { discard: true }),
                  ),
                ),
              ),
            );
          }).pipe(
            Effect.catch(() => Effect.void),
            Effect.ensuring(
              Effect.sync(() => {
                stream.destroy();
              }).pipe(Effect.andThen(disconnect(stream))),
            ),
          );

        yield* Effect.forkScoped(
          listener.accept.pipe(
            // A client can disconnect while the native listener queries its identity.
            Effect.retry({ times: 3, schedule: Schedule.spaced("100 millis") }),
            Effect.flatMap((connection) => Effect.forkIn(admit(connection), scope)),
            Effect.forever,
            Effect.catch(() =>
              Effect.sync(() => {
                listening = false;
              }).pipe(Effect.andThen(gate.withPermits(1)(closeHelper))),
            ),
          ),
        );
        return { pipePath: listener.endpoint, isListening: () => listening, endTurn: finishTurn };
      }).pipe(Effect.mapError((cause) => platformError("windows-computer-use", cause))),
  };
}
