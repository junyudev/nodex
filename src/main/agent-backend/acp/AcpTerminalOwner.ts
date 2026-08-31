import { randomUUID } from "node:crypto";
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
} from "@agentclientprotocol/sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { TerminalRuntime, TerminalRuntimeMap } from "../../terminal-runtime/TerminalRuntimeMap";
import { acpRuntimeError, type AcpRuntimeError } from "./AcpRuntimeError";
import { AcpWorkspaceFileOwner } from "./AcpWorkspaceFileOwner";

export const ACP_DEFAULT_TERMINAL_OUTPUT_BYTE_LIMIT = 64 * 1024;
export const ACP_MAXIMUM_TERMINAL_OUTPUT_BYTE_LIMIT = 4 * 1024 * 1024;

interface TerminalRecord {
  readonly runtime: TerminalRuntime["Service"];
  readonly outputByteLimit: number;
}

export class AcpTerminalOwner extends Context.Service<
  AcpTerminalOwner,
  {
    readonly create: (
      request: CreateTerminalRequest,
    ) => Effect.Effect<CreateTerminalResponse, AcpRuntimeError>;
    readonly output: (
      request: TerminalOutputRequest,
    ) => Effect.Effect<TerminalOutputResponse, AcpRuntimeError>;
    readonly waitForExit: (
      request: WaitForTerminalExitRequest,
    ) => Effect.Effect<WaitForTerminalExitResponse, AcpRuntimeError>;
    readonly kill: (
      request: KillTerminalRequest,
    ) => Effect.Effect<KillTerminalResponse, AcpRuntimeError>;
    readonly release: (
      request: ReleaseTerminalRequest,
    ) => Effect.Effect<ReleaseTerminalResponse, AcpRuntimeError>;
  }
>()("nodex/main/agent-backend/acp/AcpTerminalOwner") {}

export interface AcpTerminalOwnerOptions {
  readonly environment: Readonly<Record<string, string>>;
  readonly maximumOutputByteLimit?: number;
}

const mapFailure = (operation: string, cause: unknown): AcpRuntimeError =>
  acpRuntimeError({ operation, reason: "request", retryable: false, cause });

const normalizeOutputLimit = (requested: number | null | undefined, maximum: number): number => {
  const value = requested ?? ACP_DEFAULT_TERMINAL_OUTPUT_BYTE_LIMIT;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`ACP terminal outputByteLimit must be between 1 and ${maximum}`);
  }
  return value;
};

/** Retains the newest valid UTF-8 suffix without exceeding the byte contract. */
export const truncateUtf8Tail = (
  output: string,
  maximumBytes: number,
): { readonly output: string; readonly truncated: boolean } => {
  const encoded = Buffer.from(output, "utf8");
  if (encoded.byteLength <= maximumBytes) return { output, truncated: false };
  let start = encoded.byteLength - maximumBytes;
  while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start += 1;
  return { output: encoded.subarray(start).toString("utf8"), truncated: true };
};

const exitStatus = (exit: {
  readonly exitCode: number | null;
  readonly signal: number | null;
}) => ({
  exitCode: exit.exitCode,
  signal: exit.signal === null ? null : String(exit.signal),
});

export const live = (
  options: AcpTerminalOwnerOptions,
): Layer.Layer<AcpTerminalOwner, never, TerminalRuntimeMap | AcpWorkspaceFileOwner> =>
  Layer.effect(
    AcpTerminalOwner,
    Effect.gen(function* () {
      const runtimes = yield* TerminalRuntimeMap;
      const workspace = yield* AcpWorkspaceFileOwner;
      const records = yield* Ref.make<ReadonlyMap<string, TerminalRecord>>(new Map());
      const maximum = Math.min(
        options.maximumOutputByteLimit ?? ACP_MAXIMUM_TERMINAL_OUTPUT_BYTE_LIMIT,
        ACP_MAXIMUM_TERMINAL_OUTPUT_BYTE_LIMIT,
      );

      const lookup = Effect.fn("AcpTerminalOwner.lookup")(function* (terminalId: string) {
        const record = (yield* Ref.get(records)).get(terminalId);
        if (record !== undefined) return record;
        return yield* mapFailure(
          "capability.terminal.lookup",
          new Error(`ACP terminal is not owned by this session: ${terminalId}`),
        );
      });
      const releaseById = Effect.fn("AcpTerminalOwner.releaseById")(function* (terminalId: string) {
        const existed = yield* Ref.modify(records, (current) => {
          if (!current.has(terminalId)) return [false, current] as const;
          const next = new Map(current);
          next.delete(terminalId);
          return [true, next] as const;
        });
        if (!existed) return;
        yield* runtimes.close(terminalId);
      });

      yield* Effect.addFinalizer(() =>
        Ref.get(records).pipe(
          Effect.flatMap((current) =>
            Effect.forEach(current.keys(), (terminalId) => runtimes.close(terminalId), {
              discard: true,
              concurrency: "unbounded",
            }),
          ),
          Effect.andThen(Ref.set(records, new Map())),
        ),
      );

      return AcpTerminalOwner.of({
        create: (request) =>
          Effect.gen(function* () {
            if (!request.command.trim()) {
              return yield* mapFailure(
                "capability.terminal.create",
                new Error("Command is required"),
              );
            }
            const cwd = yield* workspace.resolveDirectory(request.cwd);
            const outputByteLimit = yield* Effect.try({
              try: () => normalizeOutputLimit(request.outputByteLimit, maximum),
              catch: (cause) => mapFailure("capability.terminal.create", cause),
            });
            const terminalId = `acp:${randomUUID()}`;
            const env = { ...options.environment };
            for (const variable of request.env ?? []) env[variable.name] = variable.value;
            const runtime = yield* runtimes
              .open({
                sessionId: terminalId,
                conversationId: null,
                projectSessionId: null,
                title: request.command,
                command: request.command,
                args: request.args ?? [],
                cwd,
                env,
                cols: 120,
                rows: 40,
              })
              .pipe(Effect.mapError((cause) => mapFailure("capability.terminal.create", cause)));
            yield* Ref.update(records, (current) =>
              new Map(current).set(terminalId, { runtime, outputByteLimit }),
            );
            return { terminalId };
          }),
        output: (request) =>
          Effect.gen(function* () {
            const record = yield* lookup(request.terminalId);
            const snapshot = yield* SubscriptionRef.get(record.runtime.snapshot);
            const bounded = truncateUtf8Tail(snapshot.buffer, record.outputByteLimit);
            if (!snapshot.exited) {
              return {
                output: bounded.output,
                truncated: snapshot.truncated || bounded.truncated,
              };
            }
            const exit = yield* record.runtime.exit;
            return {
              output: bounded.output,
              truncated: snapshot.truncated || bounded.truncated,
              exitStatus: exitStatus(exit),
            };
          }).pipe(Effect.mapError((cause) => mapFailure("capability.terminal.output", cause))),
        waitForExit: (request) =>
          lookup(request.terminalId).pipe(
            Effect.flatMap(({ runtime }) => runtime.exit),
            Effect.map(exitStatus),
            Effect.mapError((cause) => mapFailure("capability.terminal.wait", cause)),
          ),
        kill: (request) =>
          lookup(request.terminalId).pipe(
            Effect.flatMap(({ runtime }) => runtime.kill),
            Effect.as({}),
            Effect.mapError((cause) => mapFailure("capability.terminal.kill", cause)),
          ),
        release: (request) =>
          lookup(request.terminalId).pipe(
            Effect.andThen(releaseById(request.terminalId)),
            Effect.as({}),
            Effect.mapError((cause) => mapFailure("capability.terminal.release", cause)),
          ),
      });
    }),
  );
