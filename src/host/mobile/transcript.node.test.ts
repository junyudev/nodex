import type { AgentTurnItem } from "@nodex/agent-runtime/contracts";
import { HostInvocation } from "../HostInvocation";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vitest";
import { CHAT_STOP_RESERVED_REASON } from "../../shared/space-connection";
import type { ProjectSessionsChangeEvent } from "../../shared/ipc-api";
import { agentRuntimeSnapshotFixture } from "../../shared/testing/agent-runtime-snapshot";
import type { ProjectSession } from "../../shared/types";
import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import { AgentRuntimeSessionActivity } from "../../main/agent-runtime/AgentRuntimeSessionActivity";
import { AgentRuntimeSupervisor } from "../../main/agent-runtime/AgentRuntimeSupervisor";
import { CodexNativeThreadLookup } from "../../main/codex-application/CodexNativeThreadLookup";
import { CodexGateway } from "../../main/codex-runtime/CodexGateway";
import { DatabaseNotifierRuntime } from "../../main/host-runtime/DatabaseNotifierRuntime";
import { ProjectWorkspace } from "../../main/project-application/ProjectWorkspace";
import type { ProjectSessionStart } from "../../shared/types";
import { parseAttachmentRef } from "./files";
import { UserPresence } from "../UserPresence";
import { PhoneMember } from "./rpc";
import { testLayer } from "../../main/app/MainConfig";
import { makeMobileTranscript as makeTranscriptOnHost } from "./transcript";
import { chatItemId } from "./transcript-projection";

/** This host writes paths the way a POSIX test machine does. */
const makeMobileTranscript = (chats: Parameters<typeof makeTranscriptOnHost>[0]) =>
  makeTranscriptOnHost(chats).pipe(Effect.provide(testLayer()));

/** Records which chats the phone holds in front of its Member. */
const recordingPresence = (views: string[]) =>
  ({
    showOnPhone: ({ memberId, sessionId, conversationId }) =>
      Effect.acquireRelease(
        Effect.sync(() => views.push(`show ${memberId} ${sessionId} ${conversationId}`)),
        () => Effect.sync(() => views.push(`hide ${sessionId}`)),
      ),
  }) as Pick<UserPresence["Service"], "showOnPhone"> as UserPresence["Service"];

it.effect(
  "watermarks a reopened snapshot ahead of queued patches and preserves revisions during recovery",
  () =>
    Effect.gen(function* () {
      const invalidations = yield* Queue.unbounded<ProjectSessionsChangeEvent>();
      const queued = yield* Queue.unbounded<{ event: string; data: unknown }>();
      const proofs: (string | null)[] = [];
      let title = "Start";
      let historyRevision = 0;
      const sessionId = "session";
      const views: string[] = [];
      const refresh = (next: string) =>
        Effect.gen(function* () {
          title = next;
          yield* Queue.offer(invalidations, {
            changeType: "update",
            summaryScopes: [],
            detailInvalidation: { kind: "sessions", sessionIds: [sessionId] },
          });
          yield* TestClock.adjust("80 millis");
        });
      const makeTranscript = yield* makeMobileTranscript({
        session: () =>
          Effect.sync(
            () =>
              ({
                id: sessionId,
                projectId: null,
                displayTitle: title,
                executionRef: { runtimeId: "runtime", threadId: "thread" },
              }) as ProjectSession,
          ),
      }).pipe(
        Effect.provideService(DatabaseNotifierRuntime, {
          projectSessionInvalidations: Stream.fromQueue(invalidations),
        } as DatabaseNotifierRuntime["Service"]),
        Effect.provideService(AgentRuntimeApplication, {
          resolveTarget: () => Effect.never,
          read: () =>
            Effect.flatMap(HostInvocation, (proof) =>
              Effect.sync(() => {
                proofs.push(proof);
                return { snapshot: agentRuntimeSnapshotFixture({ thread: { historyRevision } }) };
              }),
            ),
        } as unknown as AgentRuntimeApplication["Service"]),
        Effect.provideService(AgentRuntimeSessionActivity, {
          read: Effect.succeed({ items: [] }),
          activityChanges: Stream.never,
        } as unknown as AgentRuntimeSessionActivity["Service"]),
        Effect.provideService(AgentRuntimeSupervisor, {} as AgentRuntimeSupervisor["Service"]),
        Effect.provideService(CodexNativeThreadLookup, {} as CodexNativeThreadLookup["Service"]),
        Effect.provideService(CodexGateway, {} as CodexGateway["Service"]),
        Effect.provideService(UserPresence, recordingPresence(views)),
        Effect.provideService(ProjectWorkspace, {} as ProjectWorkspace["Service"]),
      );

      const transcript = yield* makeTranscript((event, data) =>
        Queue.offer(queued, { event, data }).pipe(Effect.asVoid),
      ).pipe(
        Effect.provideService(HostInvocation, "observation-proof"),
        Effect.provideService(PhoneMember, "alice"),
      );
      const open = Effect.flatten(transcript.handlers["chat.open"]({ sessionId })).pipe(
        Effect.provideService(HostInvocation, "request-proof"),
      );
      expect(yield* open).toMatchObject({ title: "Start", revision: 0 });
      yield* refresh("First update");
      yield* refresh("First update"); // This invalidation has no changes to send.
      yield* refresh("Second update");
      expect(yield* open).toMatchObject({ title: "Second update", revision: 2 });
      // Reopening a watched chat keeps its one view in front of the phone's Member.
      expect(views).toEqual(["show alice session thread"]);
      expect(proofs).toEqual([
        "request-proof",
        "observation-proof",
        "observation-proof",
        "observation-proof",
      ]);
      expect(yield* Queue.take(queued)).toEqual({
        event: "chat.patch",
        data: { sessionId, revision: 1, ops: [{ op: "title", title: "First update" }] },
      });

      const recovered: unknown[] = [];
      yield* transcript.recover(
        (event, data) =>
          Effect.sync(() => {
            recovered.push({ event, data });
          }),
        Queue.clear(queued).pipe(Effect.asVoid),
      );
      expect(recovered).toEqual([
        {
          event: "chat.snapshot",
          data: expect.objectContaining({ title: "Second update", revision: 2 }),
        },
      ]);
      expect(yield* Queue.size(queued)).toBe(0);
      yield* refresh("Third update");
      expect(yield* Queue.take(queued)).toMatchObject({
        event: "chat.patch",
        data: { revision: 3 },
      });

      historyRevision++;
      yield* refresh("History replaced");
      expect(yield* Queue.take(queued)).toMatchObject({
        event: "chat.snapshot",
        data: { title: "History replaced", revision: 3 },
      });
      yield* transcript.handlers["chat.close"]({ sessionId });
      expect(views).toEqual(["show alice session thread", "hide session"]);
    }),
);

it.effect("keeps slow chat reads independent and recovery snapshots uninterrupted", () =>
  Effect.gen(function* () {
    const invalidations = yield* PubSub.unbounded<ProjectSessionsChangeEvent>();
    const activityChanges = yield* PubSub.unbounded<{ type: "reset"; sequence: number }>();
    const releaseRead = yield* Deferred.make<void>();
    const reading = yield* Deferred.make<void>();
    const recoveryStarted = yield* Deferred.make<void>();
    const releaseRecovery = yield* Deferred.make<void>();
    const events: { event: string; data: unknown }[] = [];
    const reads: string[] = [];
    let refreshing = false;
    const makeTranscript = yield* makeMobileTranscript({
      session: (id) =>
        Effect.succeed({
          id,
          projectId: null,
          displayTitle: refreshing ? "Updated" : "Start",
          executionRef: { runtimeId: "runtime", threadId: id },
        } as ProjectSession),
    }).pipe(
      Effect.provideService(DatabaseNotifierRuntime, {
        projectSessionInvalidations: Stream.fromPubSub(invalidations),
      } as DatabaseNotifierRuntime["Service"]),
      Effect.provideService(AgentRuntimeApplication, {
        resolveTarget: () => Effect.never,
        read: ({ sessionId }: { sessionId: string }) =>
          Effect.gen(function* () {
            if (refreshing) reads.push(sessionId);
            if (refreshing && sessionId === "slow") {
              yield* Deferred.succeed(reading, undefined);
              yield* Deferred.await(releaseRead);
            }
            return { snapshot: agentRuntimeSnapshotFixture({}) };
          }),
      } as unknown as AgentRuntimeApplication["Service"]),
      Effect.provideService(AgentRuntimeSessionActivity, {
        read: Effect.succeed({ items: [] }),
        activityChanges: Stream.fromPubSub(activityChanges),
      } as unknown as AgentRuntimeSessionActivity["Service"]),
      Effect.provideService(AgentRuntimeSupervisor, {} as AgentRuntimeSupervisor["Service"]),
      Effect.provideService(CodexNativeThreadLookup, {} as CodexNativeThreadLookup["Service"]),
      Effect.provideService(CodexGateway, {} as CodexGateway["Service"]),
      Effect.provideService(UserPresence, recordingPresence([])),
      Effect.provideService(ProjectWorkspace, {} as ProjectWorkspace["Service"]),
    );
    const transcript = yield* makeTranscript((event, data) =>
      Effect.sync(() => {
        events.push({ event, data });
      }),
    );
    for (const sessionId of ["slow", "fast"])
      yield* Effect.flatten(transcript.handlers["chat.open"]({ sessionId }));
    yield* TestClock.adjust("1 millis");
    refreshing = true;
    yield* PubSub.publish(invalidations, {
      changeType: "update",
      summaryScopes: [],
      detailInvalidation: { kind: "sessions", sessionIds: ["slow"] },
    });
    yield* TestClock.adjust("80 millis");
    expect(yield* Deferred.isDone(reading)).toBe(true);
    yield* PubSub.publish(invalidations, {
      changeType: "update",
      summaryScopes: [],
      detailInvalidation: { kind: "sessions", sessionIds: ["fast"] },
    });
    yield* TestClock.adjust("80 millis");
    expect(events).toEqual([
      {
        event: "chat.patch",
        data: { sessionId: "fast", revision: 2, ops: [{ op: "title", title: "Updated" }] },
      },
    ]);

    // A second source must not start another read of the blocked chat.
    yield* PubSub.publish(activityChanges, { type: "reset" as const, sequence: 1 });
    yield* TestClock.adjust("80 millis");
    expect(reads.filter((id) => id === "slow")).toHaveLength(1);
    const recovering = yield* transcript
      .recover(
        (event, data) =>
          Effect.sync(() => {
            events.push({ event, data });
          }),
        Deferred.succeed(recoveryStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseRecovery)),
        ),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(recoveryStarted);
    yield* Deferred.succeed(releaseRead, undefined);
    yield* Effect.yieldNow;
    expect(events).toHaveLength(1);
    yield* Deferred.succeed(releaseRecovery, undefined);
    yield* Fiber.join(recovering);
    yield* TestClock.adjust("1 millis");
    expect(events.slice(1, 3)).toMatchObject([
      { event: "chat.snapshot", data: { sessionId: "slow", revision: 0, title: "Start" } },
      { event: "chat.snapshot", data: { sessionId: "fast", revision: 2, title: "Updated" } },
    ]);
    expect(events.slice(3)).toEqual([
      {
        event: "chat.patch",
        data: { sessionId: "slow", revision: 1, ops: [{ op: "title", title: "Updated" }] },
      },
    ]);
    expect(reads.filter((id) => id === "slow")).toHaveLength(2);
  }),
);

it.effect("a running command's step shows what it has written so far, until it ends", () =>
  Effect.gen(function* () {
    const sessionId = "session";
    const at = "2026-11-08T04:32:02.000Z";
    const command = (status: "running" | "completed", output?: string) =>
      ({
        id: "item",
        threadId: "thread",
        runId: "run",
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: { driver: "codex", nativeId: "call-1", strength: "strong" },
        parentItemId: null,
        ordinal: 0,
        status,
        title: null,
        startedAt: at,
        completedAt: status === "running" ? null : at,
        updatedAt: at,
        type: "command_execution",
        input: "for i in $(seq 1 40); do echo tick $i; sleep 1; done",
        ...(output === undefined ? {} : { output }),
      }) as AgentTurnItem;
    let current = command("running");
    let written: string | null = "tick 1\n";
    const reads: unknown[] = [];
    const makeTranscript = yield* makeMobileTranscript({
      session: () =>
        Effect.succeed({
          id: sessionId,
          projectId: null,
          displayTitle: "Ticks",
          executionRef: { runtimeId: "runtime", threadId: "thread" },
        } as ProjectSession),
    }).pipe(
      Effect.provideService(DatabaseNotifierRuntime, {
        projectSessionInvalidations: Stream.never,
      } as unknown as DatabaseNotifierRuntime["Service"]),
      Effect.provideService(AgentRuntimeApplication, {
        resolveTarget: () => Effect.never,
        item: () => Effect.sync(() => current),
        backgroundOutput: (input: unknown) =>
          Effect.suspend(() => {
            reads.push(input);
            return written === null
              ? Effect.fail(new Error("The Agent is not reachable"))
              : Effect.succeed({
                  text: written,
                  truncated: false,
                  totalBytes: Buffer.byteLength(written),
                });
          }),
      } as unknown as AgentRuntimeApplication["Service"]),
      Effect.provideService(AgentRuntimeSessionActivity, {
        read: Effect.succeed({ items: [] }),
        activityChanges: Stream.never,
      } as unknown as AgentRuntimeSessionActivity["Service"]),
      Effect.provideService(AgentRuntimeSupervisor, {} as AgentRuntimeSupervisor["Service"]),
      Effect.provideService(CodexNativeThreadLookup, {} as CodexNativeThreadLookup["Service"]),
      Effect.provideService(CodexGateway, {} as CodexGateway["Service"]),
      Effect.provideService(UserPresence, recordingPresence([])),
      Effect.provideService(ProjectWorkspace, {} as ProjectWorkspace["Service"]),
    );
    const transcript = yield* makeTranscript(() => Effect.void);
    const open = transcript.handlers["chat.item"]({
      sessionId,
      itemId: chatItemId("thread", "item"),
    });

    expect(yield* open).toMatchObject({
      kind: "activity",
      status: "running",
      output: "tick 1\n",
      outputTruncated: false,
    });
    written = "tick 1\ntick 2\n";
    expect(yield* open).toMatchObject({ status: "running", output: "tick 1\ntick 2\n" });
    expect(reads).toEqual([
      { sessionId, threadId: "thread", taskId: "call-1" },
      { sessionId, threadId: "thread", taskId: "call-1" },
    ]);

    // Only the end of a long output reaches the phone, marked as cut.
    written = `${"x".repeat(128 * 1024)}tick 40\n`;
    const long = yield* open;
    if (long.kind !== "activity" || long.output === null) throw new Error("Expected output");
    expect(long.outputTruncated).toBe(true);
    expect(long.output.endsWith("tick 40\n")).toBe(true);
    expect(Buffer.byteLength(long.output)).toBeLessThanOrEqual(64 * 1024);

    // A read that fails still opens the step, with what its record holds.
    written = null;
    expect(yield* open).toMatchObject({ status: "running", output: null });

    // Once it ends, its record holds the whole output and nothing live is read.
    current = command("completed", "tick 1\ntick 2\ndone\n");
    const settled = reads.length;
    expect(yield* open).toMatchObject({ status: "done", output: "tick 1\ntick 2\ndone\n" });
    expect(reads).toHaveLength(settled);
  }),
);

it.effect("a step that returned a full-size screenshot opens on the phone, its picture apart", () =>
  Effect.gen(function* () {
    const sessionId = "session";
    const at = "2026-11-08T04:32:02.000Z";
    // The full record keeps the bytes the host's attachment owner serves.
    const screenshot = Buffer.alloc(3 * 1024 * 1024, 7).toString("base64");
    const reads: unknown[] = [];
    const makeTranscript = yield* makeMobileTranscript({
      session: () =>
        Effect.succeed({
          id: sessionId,
          projectId: null,
          displayTitle: "Screenshot",
          executionRef: { runtimeId: "runtime", threadId: "thread" },
        } as ProjectSession),
    }).pipe(
      Effect.provideService(DatabaseNotifierRuntime, {
        projectSessionInvalidations: Stream.never,
      } as unknown as DatabaseNotifierRuntime["Service"]),
      Effect.provideService(AgentRuntimeApplication, {
        resolveTarget: () => Effect.never,
        item: (input: unknown) =>
          Effect.sync(() => {
            reads.push(input);
            return {
              id: "item",
              threadId: "thread",
              runId: "run",
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "completed",
              title: "Take a screenshot",
              startedAt: at,
              completedAt: at,
              updatedAt: at,
              type: "dynamic_tool",
              toolName: "browser.screenshot",
              input: {},
              mcpToolCall: {
                type: "mcpToolCall",
                id: "call",
                server: "browser",
                tool: "screenshot",
                status: "completed",
                arguments: {},
                result: {
                  content: [
                    { type: "text", text: "Captured the page." },
                    { type: "image", data: screenshot, mimeType: "image/png" },
                  ],
                  structuredContent: null,
                },
              },
              resultImages: [{ attachmentId: "tool-result:1", mimeType: "image/png" }],
            } as AgentTurnItem;
          }),
      } as unknown as AgentRuntimeApplication["Service"]),
      Effect.provideService(AgentRuntimeSessionActivity, {
        read: Effect.succeed({ items: [] }),
        activityChanges: Stream.never,
      } as unknown as AgentRuntimeSessionActivity["Service"]),
      Effect.provideService(AgentRuntimeSupervisor, {} as AgentRuntimeSupervisor["Service"]),
      Effect.provideService(CodexNativeThreadLookup, {} as CodexNativeThreadLookup["Service"]),
      Effect.provideService(CodexGateway, {} as CodexGateway["Service"]),
      Effect.provideService(UserPresence, recordingPresence([])),
      Effect.provideService(ProjectWorkspace, {} as ProjectWorkspace["Service"]),
    );
    const transcript = yield* makeTranscript(() => Effect.void);
    const step = yield* transcript.handlers["chat.item"]({
      sessionId,
      itemId: chatItemId("source-thread", "source-item"),
    });

    expect(reads).toEqual([
      { sessionId, sourceThreadId: "source-thread", itemId: "source-item", full: true },
    ]);
    expect(step).toMatchObject({
      kind: "activity",
      title: "Take a screenshot",
      output: "Captured the page.",
    });
    if (step.kind !== "activity") throw new Error("Expected a step");
    // The picture is fetched in ranges with the Member's authority, not carried in the reply.
    expect(step.images.map(({ ref }) => parseAttachmentRef(ref))).toEqual([
      [sessionId, "source-thread", "source-item", "tool-result:1"],
    ]);
    expect(Buffer.byteLength(JSON.stringify(step))).toBeLessThan(4 * 1024);
  }),
);

it.effect("a chat opened before its host starts it says so and why, then follows its Run", () =>
  Effect.gen(function* () {
    const invalidations = yield* PubSub.unbounded<ProjectSessionsChangeEvent>();
    const activityChanges = yield* PubSub.unbounded<{ type: "reset"; sequence: number }>();
    const events: { event: string; data: unknown }[] = [];
    const sessionId = "session";
    let started = false;
    let start: ProjectSessionStart | null = null;
    let title = "Investigate";
    const changed = Effect.gen(function* () {
      yield* PubSub.publish(invalidations, {
        changeType: "update",
        summaryScopes: [],
        detailInvalidation: { kind: "sessions", sessionIds: [sessionId] },
      });
      yield* TestClock.adjust("80 millis");
    });
    const makeTranscript = yield* makeMobileTranscript({
      session: () =>
        Effect.sync(
          () =>
            ({
              id: sessionId,
              projectId: null,
              displayTitle: title,
              archived: false,
              thread: null,
              executionRef: started ? { runtimeId: "runtime", threadId: "thread" } : null,
            }) as ProjectSession,
        ),
    }).pipe(
      Effect.provideService(DatabaseNotifierRuntime, {
        projectSessionInvalidations: Stream.fromPubSub(invalidations),
      } as DatabaseNotifierRuntime["Service"]),
      Effect.provideService(AgentRuntimeApplication, {
        resolveTarget: () => Effect.never,
        read: () => Effect.succeed({ snapshot: agentRuntimeSnapshotFixture({}) }),
      } as unknown as AgentRuntimeApplication["Service"]),
      Effect.provideService(AgentRuntimeSessionActivity, {
        read: Effect.succeed({ items: [] }),
        activityChanges: Stream.fromPubSub(activityChanges),
      } as unknown as AgentRuntimeSessionActivity["Service"]),
      Effect.provideService(AgentRuntimeSupervisor, {} as AgentRuntimeSupervisor["Service"]),
      Effect.provideService(CodexNativeThreadLookup, {} as CodexNativeThreadLookup["Service"]),
      Effect.provideService(CodexGateway, {} as CodexGateway["Service"]),
      Effect.provideService(UserPresence, recordingPresence([])),
      Effect.provideService(ProjectWorkspace, {
        readSessionStart: () => Effect.sync(() => start),
      } as unknown as ProjectWorkspace["Service"]),
    );
    const transcript = yield* makeTranscript((event, data) =>
      Effect.sync(() => {
        events.push({ event, data });
      }),
    );
    const opened = yield* Effect.flatten(transcript.handlers["chat.open"]({ sessionId }));
    // Not a conversation for another desktop: it simply has not started.
    expect(opened).toMatchObject({
      items: [],
      state: { status: "idle", sendBlockedReason: "This chat hasn't started yet." },
    });
    yield* TestClock.adjust("1 millis");

    // Its Inbox decision could not start it: the phone says why and offers the decision again.
    start = {
      proposalId: "proposal",
      pageId: "message",
      state: "failed",
      failureMessage: "The host has no Agent for this chat",
      retryable: true,
    };
    yield* changed;
    expect(events).toMatchObject([
      {
        event: "chat.snapshot",
        data: {
          state: {
            sendBlockedReason: "This chat couldn’t start: The host has no Agent for this chat",
            start: { state: "failed", retry: { entryId: "message", proposalId: "proposal" } },
          },
        },
      },
    ]);

    started = true;
    yield* changed;
    expect(events.slice(1)).toMatchObject([
      { event: "chat.snapshot", data: { state: { sendBlockedReason: null } } },
    ]);

    // From here the chat follows its Run, as one opened while it runs does.
    title = "Investigating";
    yield* PubSub.publish(activityChanges, { type: "reset" as const, sequence: 1 });
    yield* TestClock.adjust("80 millis");
    expect(events.slice(2)).toMatchObject([
      { event: "chat.patch", data: { ops: [{ op: "title", title: "Investigating" }] } },
    ]);
  }),
);

it.effect("a phone offers stopping and archiving a hosted chat only as Core lets its Member", () =>
  Effect.gen(function* () {
    const invalidations = yield* Queue.unbounded<ProjectSessionsChangeEvent>();
    const queued = yield* Queue.unbounded<{ event: string; data: unknown }>();
    const sessionId = "session";
    // Bob reads Alice's chat: he neither manages it nor, until he asks for its Run, stops it.
    let read = { canManage: false, canStop: false, archived: false };
    const makeTranscript = yield* makeMobileTranscript({
      session: () =>
        Effect.sync(
          () =>
            ({
              id: sessionId,
              projectId: null,
              displayTitle: "Alice's chat",
              executionRef: { runtimeId: "runtime", threadId: "thread" },
              ...read,
            }) as ProjectSession,
        ),
    }).pipe(
      Effect.provideService(DatabaseNotifierRuntime, {
        projectSessionInvalidations: Stream.fromQueue(invalidations),
      } as DatabaseNotifierRuntime["Service"]),
      Effect.provideService(AgentRuntimeApplication, {
        resolveTarget: () => Effect.never,
        read: () => Effect.succeed({ snapshot: agentRuntimeSnapshotFixture() }),
      } as unknown as AgentRuntimeApplication["Service"]),
      Effect.provideService(AgentRuntimeSessionActivity, {
        read: Effect.succeed({ items: [] }),
        activityChanges: Stream.never,
      } as unknown as AgentRuntimeSessionActivity["Service"]),
      Effect.provideService(AgentRuntimeSupervisor, {} as AgentRuntimeSupervisor["Service"]),
      Effect.provideService(CodexNativeThreadLookup, {} as CodexNativeThreadLookup["Service"]),
      Effect.provideService(CodexGateway, {} as CodexGateway["Service"]),
      Effect.provideService(UserPresence, recordingPresence([])),
      Effect.provideService(ProjectWorkspace, {} as ProjectWorkspace["Service"]),
    );
    const transcript = yield* makeTranscript((event, data) =>
      Queue.offer(queued, { event, data }).pipe(Effect.asVoid),
    ).pipe(Effect.provideService(HostInvocation, "observation-proof"));
    const open = Effect.flatten(transcript.handlers["chat.open"]({ sessionId })).pipe(
      Effect.provideService(HostInvocation, "request-proof"),
    );
    expect((yield* open).state).toMatchObject({
      stopBlockedReason: CHAT_STOP_RESERVED_REASON,
      archived: false,
      canManage: false,
    });

    // Once Bob's own Run is the chat's work, Core lets him stop it, and the phone hears so.
    read = { ...read, canStop: true };
    yield* Queue.offer(invalidations, {
      changeType: "update",
      summaryScopes: [],
      detailInvalidation: { kind: "sessions", sessionIds: [sessionId] },
    });
    yield* TestClock.adjust("80 millis");
    expect(yield* Queue.take(queued)).toMatchObject({
      event: "chat.patch",
      data: { ops: [{ op: "state", state: { stopBlockedReason: null, canManage: false } }] },
    });
  }),
);
