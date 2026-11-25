import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderThread,
  TurnItemId,
} from "@nodex/runtime-contracts";
import * as Clock from "effect/Clock";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import type { AcpToolCallState } from "./runtimeModel.ts";

interface CommandRef {
  readonly toolCallId: string;
  readonly taskId?: string;
}

type TerminalStatus = "completed" | "failed";
interface TaskObservation {
  readonly toolCallId: string;
  readonly taskId: string;
  readonly status: "running" | TerminalStatus;
  readonly startedAt?: DateTime.Utc;
}

export interface AcpBackgroundCommandSource {
  readonly describe: (
    tool: AcpToolCallState,
  ) => { readonly description?: string; readonly handoffWaitMs: number } | undefined;
  readonly read: (
    sessionId: string,
    commands: ReadonlyArray<CommandRef>,
  ) => Effect.Effect<ReadonlyArray<TaskObservation>>;
  readonly readOutput: (
    sessionId: string,
    taskId: string,
  ) => Effect.Effect<{
    readonly text: string;
    readonly truncated: boolean;
    readonly totalBytes: number;
  } | null>;
}

interface Command {
  readonly turnItemId: TurnItemId;
  readonly command: string;
  readonly description?: string;
  readonly startedAt: DateTime.Utc;
  readonly handoffWaitMs: number;
  readonly onTerminal: (status: TerminalStatus) => Effect.Effect<void>;
}

interface TrackedCommand extends Command {
  readonly discoverUntil: number;
  readonly retainUntil: number;
  observed?: TaskObservation;
}

interface TrackedSession {
  readonly thread: OrchestrationV2ProviderThread;
  readonly commands: Map<string, TrackedCommand>;
  published: string;
}

// Allow native storage to catch up after the requested handoff. A command the Agent
// never acknowledges must not keep a retired runtime polling or block policy changes.
const DISCOVERY_GRACE_MS = 30_000;
const RETAIN_GRACE_MS = 2_000;
const RECENT_TERMINAL_LIMIT = 256;

export const makeAcpBackgroundCommands = Effect.fnUntraced(function* (
  source: AcpBackgroundCommandSource,
  publish: (thread: OrchestrationV2ProviderThread) => Effect.Effect<boolean>,
  scope: Scope.Scope,
) {
  const permit = yield* Semaphore.make(1);
  const sessions = new Map<string, TrackedSession>();
  const recentTerminals = new Set<string>();
  const publishRoster = (thread: OrchestrationV2ProviderThread) =>
    publish(thread).pipe(
      Effect.catchDefect(() =>
        Effect.logWarning("Could not publish ACP background commands.").pipe(Effect.as(false)),
      ),
    );
  const terminalKey = (sessionId: string, toolCallId: string) =>
    JSON.stringify([sessionId, toolCallId]);

  const rememberTerminal = (key: string) => {
    recentTerminals.add(key);
    if (recentTerminals.size > RECENT_TERMINAL_LIMIT) {
      const oldest = recentTerminals.values().next().value;
      if (oldest !== undefined) recentTerminals.delete(oldest);
    }
  };

  const refresh = Effect.fnUntraced(function* (sessionId: string, session: TrackedSession) {
    const candidates = yield* permit.withPermit(
      Effect.sync(() => (sessions.get(sessionId) === session ? new Map(session.commands) : null)),
    );
    if (candidates === null) return false;
    const observed =
      candidates.size === 0
        ? []
        : yield* source.read(
            sessionId,
            Array.from(candidates, ([toolCallId, command]) => ({
              toolCallId,
              ...(command.observed === undefined ? {} : { taskId: command.observed.taskId }),
            })),
          );
    const onTerminal: Effect.Effect<void>[] = [];
    const active = yield* permit.withPermit(
      Effect.gen(function* () {
        if (sessions.get(sessionId) !== session) return false;
        for (const observation of observed) {
          const command = session.commands.get(observation.toolCallId);
          if (
            command === undefined ||
            candidates.get(observation.toolCallId) !== command ||
            (command.observed !== undefined && command.observed.taskId !== observation.taskId)
          )
            continue;
          if (observation.status === "running") {
            command.observed = observation;
            continue;
          }
          session.commands.delete(observation.toolCallId);
          rememberTerminal(terminalKey(sessionId, observation.toolCallId));
          onTerminal.push(command.onTerminal(observation.status));
        }

        const now = yield* Clock.currentTimeMillis;
        const pendingBackgroundTasks: OrchestrationV2PendingBackgroundTask[] = [];
        for (const [toolCallId, command] of session.commands) {
          if (command.observed === undefined) {
            if (now >= command.discoverUntil) session.commands.delete(toolCallId);
            continue;
          }
          pendingBackgroundTasks.push({
            taskId: command.observed.taskId,
            kind: "command",
            stoppable: false,
            turnItemId: command.turnItemId,
            startedAt: command.observed.startedAt ?? command.startedAt,
            ...(command.command.length === 0 ? {} : { command: command.command }),
            ...(command.description === undefined ? {} : { description: command.description }),
          });
        }
        const revision = JSON.stringify(pendingBackgroundTasks);
        if (revision !== session.published) {
          const accepted = yield* publishRoster({ ...session.thread, pendingBackgroundTasks });
          if (!accepted) return true;
          session.published = revision;
        }
        if (session.commands.size > 0) return true;
        sessions.delete(sessionId);
        return false;
      }),
    );
    // A terminal may project back into ACP. Yield the roster permit before entering that lane.
    yield* Effect.forEach(onTerminal, (end) => end, { discard: true });
    return active;
  });

  const track = (
    sessionId: string,
    thread: OrchestrationV2ProviderThread,
    toolCallId: string,
    command: Command,
  ) =>
    permit.withPermit(
      Effect.gen(function* () {
        if (recentTerminals.has(terminalKey(sessionId, toolCallId))) return;
        const existing = sessions.get(sessionId);
        if (existing?.commands.has(toolCallId)) return;
        const now = yield* Clock.currentTimeMillis;
        const pending = {
          ...command,
          discoverUntil: now + command.handoffWaitMs + DISCOVERY_GRACE_MS,
          retainUntil: now + command.handoffWaitMs + RETAIN_GRACE_MS,
        };
        if (existing !== undefined) {
          existing.commands.set(toolCallId, pending);
          return;
        }
        const session: TrackedSession = {
          thread,
          commands: new Map([[toolCallId, pending]]),
          published: "[]",
        };
        sessions.set(sessionId, session);
        yield* refresh(sessionId, session).pipe(
          Effect.delay("1 second"),
          Effect.repeat({ while: (active) => active }),
          Effect.forkIn(scope),
        );
      }),
    );

  const update = (sessionId: string, toolCallId: string, state: "pending" | TerminalStatus) =>
    permit.withPermit(
      Effect.sync(() => {
        const session = sessions.get(sessionId);
        const command = session?.commands.get(toolCallId);
        if (session === undefined || command === undefined) return;
        if (state === "pending" && command.observed !== undefined) return;
        session.commands.delete(toolCallId);
        if (state !== "pending") rememberTerminal(terminalKey(sessionId, toolCallId));
      }),
    );

  const clear = permit.withPermit(
    Effect.gen(function* () {
      const retired = [...sessions.values()];
      for (const [sessionId, session] of sessions) {
        for (const toolCallId of session.commands.keys()) {
          rememberTerminal(terminalKey(sessionId, toolCallId));
        }
      }
      sessions.clear();
      for (const session of retired) {
        if (session.published !== "[]") {
          yield* publishRoster({ ...session.thread, pendingBackgroundTasks: [] });
        }
      }
    }),
  );

  const readOutput = (
    sessionId: string,
    taskId: string,
  ): ReturnType<AcpBackgroundCommandSource["readOutput"]> =>
    Effect.suspend(() => {
      const owned = [...(sessions.get(sessionId)?.commands.values() ?? [])].some(
        (command) => command.observed?.taskId === taskId,
      );
      return owned ? source.readOutput(sessionId, taskId) : Effect.succeed(null);
    });

  const hasWork = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    return [...sessions.values()].some(({ commands }) =>
      [...commands.values()].some(
        (command) => command.observed !== undefined || now < command.retainUntil,
      ),
    );
  });

  return { track, update, clear, readOutput, hasWork };
});
