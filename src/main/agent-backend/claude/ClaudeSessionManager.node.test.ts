// @effect-diagnostics strictEffectProvide:off
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SDKMessage,
  SessionMessage,
  ModelInfo,
  PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { ApplicationSettings, make as makeSettings } from "../../settings/ApplicationSettings";
import {
  ClaudeSdk,
  claudeHistoryWindow,
  type ClaudeSdkOpenInput,
  type ClaudeSdkSession,
} from "../../platform/node/ClaudeSdk";
import { make as makeManager, type OpenClaudeSessionInput } from "./ClaudeSessionManager";
import { agentRuntimeError } from "../AgentRuntimeError";
import type { AgentSessionHandle } from "../AgentSessionHandle";
import { defaultClaudeInstance } from "../../../shared/claude-agent-settings";
import { createUuidV7 } from "../../../shared/uuid-v7";
import type { ClaudeEffortSelection, ClaudeModelSelection } from "../../../shared/claude-models";
import type { ClaudeResolvedIntelligence } from "../../../shared/claude-models";
import type { AgentSessionPermissionPolicy } from "../AgentSessionHandle";

const id = "01991e60-b800-7000-8000-000000000012";
const result = (sessionId: string) =>
  ({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    uuid: createUuidV7(),
    is_error: false,
    result: "done",
    modelUsage: {},
    total_cost_usd: 0,
  }) as unknown as SDKMessage;
const fixture = (ignoreInterrupt = false) =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-claude-test-"))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    );
    const settings = yield* makeSettings({
      environment: {},
      hostHomeDirectory: root,
      settingsPath: join(root, "settings.toml"),
    });
    const events = yield* Queue.unbounded<SDKMessage>();
    const sent = yield* Queue.unbounded<string>();
    let opened: ClaudeSdkOpenInput | null = null;
    let released = 0;
    let terminated = 0;
    let mutationFailure = false;
    let modeFailure = false;
    let reopenFailure = false;
    let historyFailure = false;
    let forkFailure = false;
    let forkMessageIds: Readonly<Record<string, string>> | undefined;
    let nativeSaved = true;
    const openedInputs: ClaudeSdkOpenInput[] = [];
    const sentInputs: {
      text: string;
      uuid?: string;
      sessionId?: string;
      priority?: string;
      images?: readonly import("../../../shared/agent-conversation").AgentPromptImage[];
    }[] = [];
    const stoppedTasks: string[] = [];
    const historyPages: { before?: string; limit?: number; all?: boolean }[] = [];
    let olderHistory: SessionMessage[] | null = null;
    let initialHistory: SessionMessage[] | null = null;
    let historySession: string | null = null;
    let historyEnvironment: Readonly<Record<string, string | undefined>> = {};
    const selectedModels: (string | undefined)[] = [];
    const selectedEfforts: ClaudeEffortSelection[] = [];
    const selectedModes: PermissionMode[] = [];
    const selectedIntelligence: ClaudeModelSelection[] = [];
    let models: readonly ModelInfo[] = [
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5",
        displayName: "Sonnet",
        description: "Runtime model",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high", "xhigh", "max"],
        supportsFastMode: true,
        supportsAdaptiveThinking: true,
      },
    ];
    const nativeHistory = (
      input:
        | ClaudeSdkOpenInput
        | { sessionId: string; environment: Readonly<Record<string, string | undefined>> },
    ) =>
      Effect.sync(() => {
        historySession = input.sessionId;
        historyEnvironment = input.environment;
        return (
          initialHistory ??
          ([
            {
              type: "user",
              uuid:
                input.sessionId === "01991e60-b800-7000-8000-000000000018"
                  ? (forkMessageIds?.[id] ?? id)
                  : id,
              session_id: input.sessionId,
              parent_tool_use_id: null,
              parent_agent_id: null,
              message: { content: "Remember 42" },
            },
            {
              type: "assistant",
              uuid: "01991e60-b800-7000-8000-000000000014",
              session_id: input.sessionId,
              parent_tool_use_id: null,
              parent_agent_id: null,
              message: {
                id: "old-message",
                model: "gateway-claude-pinned",
                content: [{ type: "text", text: "Remembered." }],
              },
            },
          ] satisfies SessionMessage[])
        );
      });
    const sdk = ClaudeSdk.of({
      hasSession: () => Effect.sync(() => nativeSaved),
      historyImage: () => Effect.succeed({ mediaType: "image/png" as const, data: "AA==" }),
      historyToolOutput: () =>
        Effect.succeed({ text: "full native tool output", truncated: false, originalBytes: 23 }),
      configuration: () => Effect.succeed({ skillOverrides: {} }),
      history: (input) =>
        historyFailure
          ? Effect.fail(
              agentRuntimeError({
                operation: "fixture.history",
                reason: "request",
                retryable: false,
                cause: new Error("History read failed"),
              }),
            )
          : nativeHistory(input),
      historyPage: (input, page) => {
        historyPages.push(page ?? {});
        if (initialHistory) return Effect.succeed(claudeHistoryWindow(initialHistory, page));
        if ((page?.before || page?.all) && olderHistory)
          return Effect.succeed({ messages: olderHistory, before: null, hasMore: false });
        return nativeHistory(input).pipe(
          Effect.map((messages) => ({
            messages,
            before: olderHistory ? id : null,
            hasMore: Boolean(olderHistory),
          })),
        );
      },
      fork: () =>
        forkFailure
          ? Effect.fail(
              agentRuntimeError({
                operation: "fixture.fork",
                reason: "request",
                retryable: false,
                cause: new Error("Fork failed"),
              }),
            )
          : Effect.succeed({
              sessionId: "01991e60-b800-7000-8000-000000000018",
              ...(forkMessageIds ? { messageIdMap: forkMessageIds } : {}),
            }),
      open: (input) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            opened = input;
            openedInputs.push(input);
            let intelligence: ClaudeResolvedIntelligence = {
              model: input.model ?? "claude-sonnet-5",
              effort: input.effort ?? "high",
              fast: input.fast ?? false,
              thinking: input.thinking ?? true,
            };
            return {
              messages: Stream.fromQueue(events),
              models,
              get intelligence() {
                return intelligence;
              },
              inspectIntelligence: Effect.sync(() => intelligence),
              diagnostics: {
                health: {
                  status: "unknown" as const,
                  executable: null,
                  version: null,
                  account: null,
                  error: null,
                },
                mcpServers: [],
                agents: [],
                capabilities: [],
              },
              inspectRuntime: Effect.succeed({
                health: {
                  status: "unknown" as const,
                  executable: null,
                  version: null,
                  account: null,
                  error: null,
                },
                mcpServers: [],
                agents: [],
                capabilities: [],
              }),
              stopTask: (taskId: string) =>
                Effect.sync(() => {
                  stoppedTasks.push(taskId);
                }),
              setIntelligence: (selection: ClaudeModelSelection) =>
                Effect.suspend(() => {
                  if (mutationFailure)
                    return Effect.fail(
                      agentRuntimeError({
                        operation: "mock-intelligence",
                        reason: "request",
                        retryable: false,
                        cause: new Error("Rejected"),
                      }),
                    );
                  return Effect.sync(() => {
                    selectedIntelligence.push(selection);
                    selectedModels.push(
                      selection.model === "default" ? undefined : selection.model,
                    );
                    selectedEfforts.push(selection.effort);
                    intelligence = {
                      model: selection.model === "default" ? "claude-sonnet-5" : selection.model,
                      effort: selection.effort === "default" ? "high" : selection.effort,
                      fast: selection.fast ?? false,
                      thinking: selection.thinking ?? true,
                    };
                  });
                }),
              commands: [{ name: "compact", description: "Compact context", argumentHint: "" }],
              send: (
                text: string,
                uuid?: string,
                sessionId?: string,
                priority?: string,
                images?: readonly import("../../../shared/agent-conversation").AgentPromptImage[],
              ) =>
                Effect.sync(() => {
                  sentInputs.push({ text, uuid, sessionId, priority, images });
                }).pipe(Effect.andThen(Queue.offer(sent, text)), Effect.asVoid),
              terminate: Effect.sync(() => {
                terminated += 1;
              }),
              interrupt: ignoreInterrupt
                ? Effect.succeed(undefined)
                : Queue.offer(events, result(input.sessionId)).pipe(Effect.as(undefined)),
              setMode: (mode: PermissionMode) =>
                modeFailure
                  ? Effect.fail(
                      agentRuntimeError({
                        operation: "fixture.mode",
                        reason: "request",
                        retryable: false,
                        cause: new Error("Mode rejected"),
                      }),
                    )
                  : Effect.sync(() => {
                      selectedModes.push(mode);
                    }),
            } satisfies ClaudeSdkSession;
          }),
          () =>
            Effect.sync(() => {
              released += 1;
            }),
        ).pipe(
          Effect.tap(() =>
            reopenFailure && openedInputs.length > 1
              ? Effect.fail(
                  agentRuntimeError({
                    operation: "fixture.initialize",
                    reason: "initialize",
                    retryable: false,
                    cause: new Error("Initialization failed"),
                  }),
                )
              : Effect.void,
          ),
        ),
    });
    const manager = yield* makeManager.pipe(
      Effect.provideService(ApplicationSettings, settings),
      Effect.provideService(ClaudeSdk, sdk),
      Effect.provide(mainConfigLayer({ environment: { HOME: root, PATH: "/usr/bin" } })),
    );
    const open = (sessionId?: string, selection?: Partial<OpenClaudeSessionInput>) =>
      manager.open({
        threadId: "thread-1",
        instanceConfigId: "claude-default",
        workspaceRoot: root,
        permissionPolicy: "ask",
        ...selection,
        ...(sessionId ? { sessionId } : {}),
      });
    const sdkInput = () => {
      if (!opened) throw new Error("SDK was not opened");
      return opened;
    };
    return {
      manager,
      openedInputs,
      sentInputs,
      stoppedTasks,
      historyPages,
      setNativeSaved: (value: boolean) => {
        nativeSaved = value;
      },
      rejectMutation: () => {
        mutationFailure = true;
      },
      rejectReopen: () => {
        reopenFailure = true;
      },
      rejectHistory: () => {
        historyFailure = true;
      },
      rejectFork: () => {
        forkFailure = true;
      },
      setForkMessageIds: (map: Readonly<Record<string, string>>) => {
        forkMessageIds = map;
      },
      setOlderHistory: (messages: SessionMessage[]) => {
        olderHistory = messages;
      },
      setInitialHistory: (messages: SessionMessage[]) => {
        initialHistory = messages;
      },
      selectedModels,
      selectedEfforts,
      selectedModes,
      selectedIntelligence,
      setModels: (value: readonly ModelInfo[]) => {
        models = value;
      },
      rejectMode: () => {
        modeFailure = true;
      },
      settings,
      historyEnvironment: () => historyEnvironment,
      open,
      sdkInput,
      events,
      sent,
      released: () => released,
      terminated: () => terminated,
      historySession: () => historySession,
    };
  });
const waitForRequest = (handle: AgentSessionHandle) =>
  SubscriptionRef.changes(handle.snapshot).pipe(
    Stream.filter((snapshot) => (snapshot.requests?.length ?? 0) > 0),
    Stream.runHead,
  );

it.effect("loads the exact native session and resumes without submitting an old prompt", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const handle = yield* f.open(id);
    expect(f.historySession()).toBe(id);
    expect(f.sdkInput()).toMatchObject({
      resume: true,
      sessionId: id,
      permissionMode: "default",
    });
    expect(f.sdkInput().model).toBeUndefined();
    expect(handle.configOptions[0]).toMatchObject({ currentValue: "claude-sonnet-5" });
    expect((yield* SubscriptionRef.get(handle.snapshot)).metadata?.effectiveSelection?.model).toBe(
      "claude-sonnet-5",
    );
    expect(yield* Queue.size(f.sent)).toBe(0);
    expect((yield* SubscriptionRef.get(handle.snapshot)).turns[0]).toMatchObject({
      promptText: "Remember 42",
      updates: [{ text: "Remembered." }],
    });
    yield* f.manager.close("thread-1");
    expect(f.released()).toBe(1);
  }),
);

it.effect("keeps one assistant message across streaming deltas and final content", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const handle = yield* f.open();
    const prompt = yield* Effect.forkChild(handle.prompt("hello", { clientUserMessageId: id }));
    yield* Queue.take(f.sent);
    const sessionId = f.sdkInput().sessionId;
    for (const message of [
      {
        type: "stream_event",
        event: { type: "message_start", message: { id: "msg-1" } },
        parent_tool_use_id: null,
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
        parent_tool_use_id: null,
      },
      {
        type: "assistant",
        message: { id: "msg-1", content: [{ type: "text", text: "Hello world" }] },
        parent_tool_use_id: null,
      },
    ])
      yield* Queue.offer(f.events, {
        ...message,
        session_id: sessionId,
        uuid: id,
      } as unknown as SDKMessage);
    yield* Queue.offer(f.events, result(sessionId));
    expect(yield* Fiber.join(prompt)).toEqual({ stopReason: "end_turn" });
    const snapshot = yield* SubscriptionRef.get(handle.snapshot);
    const turn = snapshot.turns.find((entry) => entry.promptText === "hello");
    expect(turn?.clientUserMessageId).toBe(id);
    expect(turn?.updates.filter((update) => update.kind === "message")).toMatchObject([
      { text: "Hello world" },
    ]);
  }),
);

it.effect(
  "correlates approvals and answers to live requests and rejects stale or incomplete responses",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const handle = yield* f.open();
      const prompt = yield* Effect.forkChild(handle.prompt("edit"));
      yield* Queue.take(f.sent);
      const approval = yield* Effect.forkChild(
        f
          .sdkInput()
          .canUseTool({ name: "Bash", toolUseId: "tool-1", input: { command: "echo hello" } }),
      );
      yield* waitForRequest(handle);
      let request = (yield* SubscriptionRef.get(handle.snapshot)).requests![0]!;
      expect(
        yield* handle.respond!("stale", { decision: "allow" }).pipe(Effect.flip),
      ).toMatchObject({ reason: "request" });
      yield* handle.respond!(request.id, { decision: "allow" });
      expect(yield* Fiber.join(approval)).toEqual({
        behavior: "allow",
        updatedInput: { command: "echo hello" },
      });
      const question = yield* Effect.forkChild(
        f.sdkInput().canUseTool({
          name: "AskUserQuestion",
          toolUseId: "tool-2",
          input: {
            questions: [
              { question: "Which branch?", options: [{ label: "main", description: "Default" }] },
            ],
          },
        }),
      );
      yield* waitForRequest(handle);
      request = (yield* SubscriptionRef.get(handle.snapshot)).requests![0]!;
      yield* handle.respond!(request.id, { decision: "answer", answers: {} }).pipe(Effect.flip);
      yield* handle.respond!(request.id, {
        decision: "answer",
        answers: { "Which branch?": "feature" },
      });
      expect(yield* Fiber.join(question)).toMatchObject({
        behavior: "allow",
        updatedInput: { answers: { "Which branch?": "feature" } },
      });
      yield* Queue.offer(f.events, result(f.sdkInput().sessionId));
      yield* Fiber.join(prompt);
      expect((yield* SubscriptionRef.get(handle.snapshot)).requests ?? []).toEqual([]);
    }),
);

it.effect(
  "stop denies pending requests and settles the turn before the session can run again",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const handle = yield* f.open();
      const prompt = yield* Effect.forkChild(handle.prompt("run"));
      yield* Queue.take(f.sent);
      const approval = yield* Effect.forkChild(
        f
          .sdkInput()
          .canUseTool({ name: "Bash", input: { command: "sleep 10" }, toolUseId: "tool" }),
      );
      yield* waitForRequest(handle);
      yield* handle.cancel;
      expect(yield* Fiber.join(approval)).toMatchObject({ behavior: "deny" });
      expect(yield* Fiber.join(prompt)).toEqual({ stopReason: "cancelled" });
      yield* f.manager.close("thread-1");
      yield* handle.prompt("stale").pipe(Effect.flip);
      expect(f.released()).toBe(1);
    }),
);

it.effect("retains an observed session and releases it after the final observer leaves", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.manager.observe("thread-1");
    yield* f.open();
    yield* TestClock.adjust("3 minutes");
    expect(f.released()).toBe(0);
    yield* f.manager.unobserve("thread-1");
    yield* TestClock.adjust("3 minutes");
    expect(f.released()).toBe(1);
  }),
);

it.effect("terminates a runtime that never acknowledges interruption", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true);
    const handle = yield* f.open();
    const prompt = yield* Effect.forkChild(handle.prompt("wait"));
    yield* Queue.take(f.sent);
    const cancel = yield* Effect.forkChild(handle.cancel);
    yield* TestClock.adjust("6 seconds");
    yield* Fiber.join(cancel);
    yield* Fiber.await(prompt);
    expect(f.terminated()).toBe(1);
    expect((yield* SubscriptionRef.get(handle.snapshot)).status).toBe("failed");
  }),
);

it.effect(
  "streams consecutive live deltas to an observer that opened before the first prompt",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const handle = yield* f.open();
      const changes = yield* Queue.unbounded<unknown>();
      yield* f.manager.changes.pipe(
        Stream.runForEach((event) => Queue.offer(changes, event)),
        Effect.forkChild({ startImmediately: true }),
      );
      const prompt = yield* Effect.forkChild(handle.prompt("live"));
      yield* Queue.take(f.sent);
      const event = yield* Queue.take(changes);
      expect(event).toMatchObject({
        threadId: "thread-1",
        delta: { backend: "claude", status: "running", turns: [{ promptText: "live" }] },
      });
      yield* Queue.offer(f.events, result(f.sdkInput().sessionId));
      yield* Fiber.join(prompt);
    }),
);

it.effect(
  "applies instance overrides on connection while preserving an existing session environment",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const update = (value: string) =>
        f.settings.update({
          type: "update-claude-agents",
          input: {
            instances: [
              {
                ...defaultClaudeInstance(),
                environment: [
                  { name: "ANTHROPIC_BASE_URL", value, sensitive: false },
                  { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
                ],
              },
            ],
          },
        });
      yield* update("https://first.example");
      const first = yield* f.open();
      const original = f.sdkInput();
      expect(original.environment).toMatchObject({
        PATH: "/usr/bin",
        ANTHROPIC_BASE_URL: "https://first.example",
        ANTHROPIC_API_KEY: "",
      });
      yield* update("https://second.example");
      expect(yield* f.open()).toBe(first);
      expect(f.sdkInput()).toBe(original);
      expect(original.environment.ANTHROPIC_BASE_URL).toBe("https://first.example");
      yield* f.manager.close("thread-1");
      yield* f.open(id);
      expect(f.sdkInput().environment.ANTHROPIC_BASE_URL).toBe("https://second.example");
      expect(f.historyEnvironment()).toEqual(f.sdkInput().environment);
    }).pipe(Effect.scoped),
);

it.effect("discovers the configured catalog without sending a prompt or retaining a session", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const options = yield* f.manager.models("claude-default", "/workspace");
    expect(options.map(({ value }) => value)).toEqual(["claude-sonnet-5"]);
    expect(options[0]?.reasoningEfforts).toEqual(["low", "high", "xhigh", "max"]);
    expect(f.sdkInput()).toMatchObject({ cwd: "/workspace", persistSession: false, resume: false });
    expect(yield* Queue.size(f.sent)).toBe(0);
    expect(f.released()).toBe(1);
    expect(yield* f.manager.get("thread-1")).toBeNull();
  }),
);

it.effect("sends concrete model IDs and only commits accepted model changes", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const handle = yield* f.open();
    yield* handle.setConfigOption("model", "claude-sonnet-5");
    expect(f.selectedModels).toEqual(["claude-sonnet-5"]);
    expect(handle.configOptions[0]).toMatchObject({ currentValue: "claude-sonnet-5" });
    yield* handle.setConfigOption("model", "unknown-model").pipe(Effect.flip);
    expect(f.selectedModels).toEqual(["claude-sonnet-5"]);
    yield* handle.setConfigOption("model", "default");
    expect(f.sdkInput().model).toBeUndefined();
    expect(f.sdkInput().resume).toBe(false);
  }),
);

it.effect("Off caps effort and any effort level reenables thinking in one native mutation", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.setModels([
      {
        value: "opus",
        resolvedModel: "claude-opus-5",
        displayName: "Opus",
        description: "",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        supportsAdaptiveThinking: true,
        supportsFastMode: true,
      },
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5-5",
        displayName: "Sonnet",
        description: "",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"],
        supportsAdaptiveThinking: true,
        supportsFastMode: false,
      },
    ]);
    const handle = yield* f.open(undefined, { model: "claude-opus-5", effort: "max" });
    yield* handle.setConfigOption("effort", "off");
    expect(f.selectedIntelligence).toEqual([
      { model: "claude-opus-5", effort: "high", thinking: false },
    ]);
    expect(
      (yield* SubscriptionRef.get(handle.snapshot)).metadata?.effectiveSelection,
    ).toMatchObject({ model: "claude-opus-5", effort: "high", thinking: false, fast: false });
    expect(handle.configOptions.find(({ id }) => id === "effort")).toMatchObject({
      currentValue: "off",
    });
    yield* handle.setConfigOption("effort", "high");
    expect(f.selectedIntelligence.at(-1)).toEqual({
      model: "claude-opus-5",
      effort: "high",
      thinking: true,
    });
    expect(handle.configOptions.find(({ id }) => id === "effort")).toMatchObject({
      currentValue: "high",
    });
    yield* handle.setIntelligence!({
      model: "claude-opus-5",
      effort: "high",
      thinking: false,
      fast: true,
    });
    yield* handle.setIntelligence!({
      model: "claude-sonnet-5-5",
      effort: "high",
      thinking: false,
      fast: true,
    });
    expect(f.selectedIntelligence.at(-1)).toEqual({
      model: "claude-sonnet-5-5",
      effort: "high",
      thinking: undefined,
      fast: false,
    });
    expect(f.openedInputs).toHaveLength(1);
    expect(
      (yield* SubscriptionRef.get(handle.snapshot)).metadata?.requestedSelection?.thinking,
    ).toBeUndefined();
    expect(
      (yield* SubscriptionRef.get(handle.snapshot)).metadata?.effectiveSelection,
    ).toMatchObject({ model: "claude-sonnet-5-5", thinking: true, fast: false });
  }).pipe(Effect.scoped),
);

it.effect("startup bounds saved Off effort before the first prompt is admitted", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.setModels([
      {
        value: "opus",
        resolvedModel: "claude-opus-5",
        displayName: "Opus",
        description: "",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        supportsAdaptiveThinking: true,
      },
    ]);
    const handle = yield* f.open(undefined, {
      model: "claude-opus-5",
      effort: "max",
      thinking: false,
    });
    expect(f.selectedIntelligence).toEqual([
      { model: "claude-opus-5", effort: "high", thinking: false },
    ]);
    expect(
      (yield* SubscriptionRef.get(handle.snapshot)).metadata?.effectiveSelection,
    ).toMatchObject({ model: "claude-opus-5", effort: "high", thinking: false });
    expect(f.sentInputs).toEqual([]);
    expect(f.openedInputs).toHaveLength(1);
    const running = yield* Effect.forkChild(handle.prompt("first"));
    yield* Queue.take(f.sent);
    expect(f.selectedIntelligence.at(-1)?.effort).toBe("high");
    yield* Queue.offer(f.events, result(handle.sessionId!));
    yield* Fiber.join(running);
  }).pipe(Effect.scoped),
);

it.effect("startup rejects unsupported Fast without admitting or sending a prompt", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.setModels([
      {
        value: "claude-sonnet-5-5",
        displayName: "Sonnet",
        description: "",
        supportsAdaptiveThinking: true,
        supportsFastMode: false,
      },
    ]);
    let admissions = 0;
    expect(
      (yield* Effect.result(
        f.open(undefined, {
          model: "claude-sonnet-5-5",
          fast: true,
          onTurnAdmitted: () =>
            Effect.sync(() => {
              admissions++;
            }),
        }),
      ))._tag,
    ).toBe("Failure");
    expect(f.sentInputs).toEqual([]);
    expect(admissions).toBe(0);
    expect(f.released()).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect(
  "full access is a real native mode and fresh policy restores approvals before admission",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let policy: AgentSessionPermissionPolicy = "full-access";
      const handle = yield* f.open(undefined, {
        permissionPolicy: policy,
        readPermissionPolicy: Effect.sync(() => policy),
      });
      expect(f.sdkInput().permissionMode).toBe("bypassPermissions");
      expect((yield* SubscriptionRef.get(handle.snapshot)).metadata?.permissionMode).toBe(
        "full-access",
      );
      yield* handle.setMode("plan");
      yield* handle.setPermissionPolicy!("ask");
      expect(f.selectedModes).toEqual(["plan", "plan"]);
      policy = "ask";
      yield* handle.setMode("default");
      policy = "full-access";
      const running = yield* Effect.forkChild(handle.prompt("first"));
      yield* Queue.take(f.sent);
      expect(f.selectedModes.at(-1)).toBe("bypassPermissions");
      yield* Queue.offer(f.events, result(handle.sessionId!));
      yield* Fiber.join(running);
      policy = "ask";
      const next = yield* Effect.forkChild(handle.prompt("second"));
      yield* Queue.take(f.sent);
      expect(f.selectedModes.at(-1)).toBe("default");
      expect((yield* SubscriptionRef.get(handle.snapshot)).metadata?.permissionMode).toBe("auto");
      yield* Queue.offer(f.events, result(handle.sessionId!));
      yield* Fiber.join(next);
    }).pipe(Effect.scoped),
);

it.effect("applies advertised effort and resolves inherited effort after replacing the query", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const handle = yield* f.open();
    yield* handle.setConfigOption("model", "claude-sonnet-5");
    yield* handle.setConfigOption("effort", "xhigh");
    yield* handle.setConfigOption("effort", "max");
    expect(f.selectedEfforts.filter((effort) => effort !== "default")).toEqual(["xhigh", "max"]);
    yield* handle.setConfigOption("effort", "medium").pipe(Effect.flip);
    expect(f.selectedEfforts.filter((effort) => effort !== "default")).toEqual(["xhigh", "max"]);
    expect(handle.configOptions.find(({ id }) => id === "effort")).toMatchObject({
      currentValue: "max",
    });
    yield* handle.setIntelligence!({ model: "default", effort: "default" });
    expect(f.sdkInput().model).toBeUndefined();
    expect(f.sdkInput().resume).toBe(false);
    expect(f.sdkInput().effort).toBeUndefined();
    expect(handle.configOptions.find(({ id }) => id === "effort")).toMatchObject({
      currentValue: "high",
    });
  }),
);

it.effect("restores the saved model and effort before the next prompt", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const handle = yield* f.open(id, { model: "claude-sonnet-5", effort: "max" });
    expect(f.sdkInput()).toMatchObject({ resume: true, model: "claude-sonnet-5", effort: "max" });
    expect(handle.configOptions.find(({ id }) => id === "effort")).toMatchObject({
      currentValue: "max",
    });
    expect(yield* Queue.size(f.sent)).toBe(0);
    yield* handle.setConfigOption("effort", "default");
    expect(f.sdkInput().effort).toBeUndefined();
    yield* f.manager.close("thread-1");
    const reopened = yield* f.open(id, { model: "claude-sonnet-5", effort: "medium" });
    expect(f.sdkInput().effort).toBeUndefined();
    expect(reopened.configOptions.find(({ id }) => id === "effort")).toMatchObject({
      currentValue: "high",
    });
  }),
);

const nextId = "01991e60-b800-7000-8000-000000000020";
const waitForSnapshot = (
  handle: AgentSessionHandle,
  predicate: (
    snapshot: import("../../../shared/agent-conversation").AgentConversationSnapshot,
  ) => boolean,
) => SubscriptionRef.changes(handle.snapshot).pipe(Stream.filter(predicate), Stream.runHead);
const nativeMessage = (sessionId: string, message: Readonly<Record<string, unknown>>): SDKMessage =>
  ({ ...message, uuid: createUuidV7(), session_id: sessionId }) as unknown as SDKMessage;

it.effect("structured failure settles durable outcome and remains reusable", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const outcomes: string[] = [];
    const handle = yield* f.open(undefined, {
      onTurnSettled: (outcome) =>
        Effect.sync(() => {
          outcomes.push(`${outcome.status}:${outcome.everSaved}`);
        }),
    });
    const running = yield* Effect.forkChild(handle.prompt("first", { clientUserMessageId: id }));
    yield* Queue.take(f.sent);
    yield* Queue.offer(
      f.events,
      nativeMessage(handle.sessionId!, {
        ...result(handle.sessionId!),
        terminal_reason: "api_error",
        result: "Gateway rejected the request",
        user_message_uuid: id,
      }),
    );
    expect((yield* Effect.result(Fiber.join(running)))._tag).toBe("Failure");
    const snapshot = yield* SubscriptionRef.get(handle.snapshot);
    expect(snapshot.status).toBe("idle");
    expect(snapshot.turns.at(-1)).toMatchObject({
      status: "failed",
      stopReason: "error",
      error: "Gateway rejected the request",
    });
    expect(outcomes).toEqual(["failed:true"]);
    const next = yield* Effect.forkChild(handle.prompt("retry", { clientUserMessageId: nextId }));
    yield* Queue.take(f.sent);
    yield* Queue.offer(
      f.events,
      nativeMessage(handle.sessionId!, { ...result(handle.sessionId!), user_message_uuid: nextId }),
    );
    expect(yield* Fiber.join(next)).toEqual({ stopReason: "end_turn" });
  }).pipe(Effect.scoped),
);

it.effect("a late result cannot settle a newer prompt UUID", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const handle = yield* f.open();
    const first = yield* Effect.forkChild(handle.prompt("first", { clientUserMessageId: id }));
    yield* Queue.take(f.sent);
    yield* Queue.offer(
      f.events,
      nativeMessage(handle.sessionId!, { ...result(handle.sessionId!), user_message_uuid: id }),
    );
    yield* Fiber.join(first);
    const second = yield* Effect.forkChild(
      handle.prompt("second", { clientUserMessageId: nextId }),
    );
    yield* Queue.take(f.sent);
    yield* Queue.offer(
      f.events,
      nativeMessage(handle.sessionId!, { ...result(handle.sessionId!), user_message_uuid: id }),
    );
    yield* Queue.offer(
      f.events,
      nativeMessage(handle.sessionId!, {
        type: "assistant",
        parent_tool_use_id: null,
        message: { id: "new-reply", content: [{ type: "text", text: "Fresh second reply" }] },
      }),
    );
    yield* waitForSnapshot(
      handle,
      (snapshot) =>
        snapshot.turns
          .at(-1)
          ?.updates.some((update) => "text" in update && update.text === "Fresh second reply") ??
        false,
    );
    expect((yield* SubscriptionRef.get(handle.snapshot)).status).toBe("running");
    yield* Queue.offer(
      f.events,
      nativeMessage(handle.sessionId!, { ...result(handle.sessionId!), user_message_uuid: nextId }),
    );
    expect(yield* Fiber.join(second)).toEqual({ stopReason: "end_turn" });
  }).pipe(Effect.scoped),
);

it.effect("settled message IDs cannot be readmitted after a Query rebuild", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const admitted: string[] = [];
    const handle = yield* f.open(undefined, {
      model: "claude-sonnet-5",
      effort: "max",
      onTurnAdmitted: (value) =>
        Effect.sync(() => {
          admitted.push(value.clientUserMessageId);
        }),
    });
    const first = yield* Effect.forkChild(handle.prompt("first", { clientUserMessageId: id }));
    yield* Queue.take(f.sent);
    yield* Queue.offer(f.events, result(handle.sessionId!));
    yield* Fiber.join(first);
    expect((yield* Effect.result(handle.prompt("repeat", { clientUserMessageId: id })))._tag).toBe(
      "Failure",
    );
    yield* handle.setIntelligence!({ model: "default", effort: "default" });
    expect(f.openedInputs).toHaveLength(2);
    expect(
      (yield* Effect.result(handle.prompt("repeat again", { clientUserMessageId: id })))._tag,
    ).toBe("Failure");
    expect(admitted).toEqual([id]);
    expect(f.sentInputs).toHaveLength(1);
    expect((yield* SubscriptionRef.get(handle.snapshot)).status).toBe("idle");
    const fresh = yield* Effect.forkChild(handle.prompt("fresh", { clientUserMessageId: nextId }));
    yield* Queue.take(f.sent);
    yield* Queue.offer(f.events, result(handle.sessionId!));
    yield* Fiber.join(fresh);
    expect(admitted).toEqual([id, nextId]);
  }).pipe(Effect.scoped),
);

it.effect("steering rejects current, settled, and queued message IDs without sending", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const admitted: string[] = [];
    const handle = yield* f.open(undefined, {
      onTurnAdmitted: (value) =>
        Effect.sync(() => {
          admitted.push(value.clientUserMessageId);
        }),
    });
    const first = yield* Effect.forkChild(handle.prompt("first", { clientUserMessageId: id }));
    yield* Queue.take(f.sent);
    expect(
      (yield* Effect.result(handle.steer!("same prompt", { clientUserMessageId: id })))._tag,
    ).toBe("Failure");
    yield* Queue.offer(f.events, result(handle.sessionId!));
    yield* Fiber.join(first);
    const activeId = createUuidV7();
    const second = yield* Effect.forkChild(
      handle.prompt("second", { clientUserMessageId: activeId }),
    );
    yield* Queue.take(f.sent);
    expect(
      (yield* Effect.result(handle.steer!("old prompt", { clientUserMessageId: id })))._tag,
    ).toBe("Failure");
    yield* handle.steer!("valid follow up", { clientUserMessageId: nextId });
    yield* Queue.take(f.sent);
    expect(
      (yield* Effect.result(handle.steer!("replace queued", { clientUserMessageId: nextId })))._tag,
    ).toBe("Failure");
    expect(f.sentInputs.map((value) => [value.text, value.uuid])).toEqual([
      ["first", id],
      ["second", activeId],
      ["valid follow up", nextId],
    ]);
    expect(admitted).toEqual([id, activeId]);
    yield* Queue.offer(
      f.events,
      nativeMessage(handle.sessionId!, {
        ...result(handle.sessionId!),
        user_message_uuids: [activeId, nextId],
      }),
    );
    yield* Fiber.join(second);
    expect((yield* SubscriptionRef.get(handle.snapshot)).status).toBe("idle");
  }).pipe(Effect.scoped),
);

it.effect("known native, durable, restored, and newly loaded history IDs cannot be admitted", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const durableId = createUuidV7();
    const restoredId = createUuidV7();
    const olderId = createUuidV7();
    f.setOlderHistory([
      {
        type: "user",
        uuid: olderId,
        session_id: id,
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { content: "Older known prompt" },
      },
    ]);
    let admissions = 0;
    const handle = yield* f.open(id, {
      historyFacts: [{ clientUserMessageId: durableId, stopReason: "completed" }],
      restoredTurns: [
        {
          sequence: 1,
          clientUserMessageId: restoredId,
          promptText: "Restored known prompt",
          stopReason: "completed",
          updates: [],
        },
      ],
      onTurnAdmitted: () =>
        Effect.sync(() => {
          admissions++;
        }),
    });
    yield* handle.loadHistory!();
    for (const knownId of [id, durableId, restoredId, olderId])
      expect(
        (yield* Effect.result(handle.prompt("repeat", { clientUserMessageId: knownId })))._tag,
      ).toBe("Failure");
    expect(admissions).toBe(0);
    expect(f.sentInputs).toEqual([]);
    expect((yield* SubscriptionRef.get(handle.snapshot)).status).toBe("idle");
  }).pipe(Effect.scoped),
);

it.effect(
  "native reset changes identity only after owner acknowledgement and clears its transcript",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const hooks: string[] = [];
      const handle = yield* f.open(undefined, {
        onTurnSettled: (value) =>
          Effect.sync(() => {
            hooks.push(`settle:${value.nativeSessionId}`);
          }),
        onSessionIdentityChanged: (value) =>
          Effect.sync(() => {
            hooks.push(`reset:${value.previousSessionId}:${value.sessionId}`);
          }),
      });
      const previous = handle.sessionId!;
      const first = yield* Effect.forkChild(handle.prompt("clear", { clientUserMessageId: id }));
      yield* Queue.take(f.sent);
      yield* Queue.offer(
        f.events,
        nativeMessage(previous, { type: "conversation_reset", new_conversation_id: nextId }),
      );
      expect(yield* Fiber.join(first)).toEqual({ stopReason: "cancelled" });
      yield* waitForSnapshot(handle, (snapshot) => snapshot.sessionId === nextId);
      expect(handle.sessionId).toBe(nextId);
      expect((yield* SubscriptionRef.get(handle.snapshot)).turns).toEqual([]);
      expect(hooks).toEqual([`settle:${previous}`, `reset:${previous}:${nextId}`]);
      expect(
        (yield* Effect.result(handle.prompt("repeat", { clientUserMessageId: id })))._tag,
      ).toBe("Failure");
      expect(f.sentInputs).toHaveLength(1);
      const second = yield* Effect.forkChild(
        handle.prompt("fresh", { clientUserMessageId: createUuidV7() }),
      );
      yield* Queue.take(f.sent);
      expect(f.sentInputs.at(-1)?.sessionId).toBe(nextId);
      yield* Queue.offer(f.events, result(nextId));
      yield* Fiber.join(second);
    }).pipe(Effect.scoped),
);

it.effect("unexpected native identity terminates its query and rejects the admitted turn", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const handle = yield* f.open();
    const running = yield* Effect.forkChild(handle.prompt("work", { clientUserMessageId: id }));
    yield* Queue.take(f.sent);
    yield* Queue.offer(
      f.events,
      nativeMessage(nextId, {
        type: "assistant",
        message: { content: [] },
        parent_tool_use_id: null,
      }),
    );
    expect((yield* Effect.result(Fiber.join(running)))._tag).toBe("Failure");
    expect(f.terminated()).toBe(1);
    expect((yield* SubscriptionRef.get(handle.snapshot)).status).toBe("failed");
  }).pipe(Effect.scoped),
);

it.effect("idle background roster keeps an unobserved runtime alive until the level clears", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const handle = yield* f.open();
    yield* Queue.offer(
      f.events,
      nativeMessage(handle.sessionId!, {
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          { task_id: "background-1", task_type: "local_agent", description: "Continue checking" },
        ],
      }),
    );
    yield* waitForSnapshot(
      handle,
      (snapshot) => snapshot.liveBackgroundTaskIds?.includes("background-1") ?? false,
    );
    yield* TestClock.adjust("2 minutes");
    expect(f.released()).toBe(0);
    yield* Queue.offer(
      f.events,
      nativeMessage(handle.sessionId!, {
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [],
      }),
    );
    yield* waitForSnapshot(handle, (snapshot) => snapshot.liveBackgroundTaskIds?.length === 0);
    yield* TestClock.adjust("2 minutes");
    expect(f.released()).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect(
  "Default restores inherited configuration by replacing an idle query and rejects live background work",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const handle = yield* f.open(undefined, { model: "claude-sonnet-5", effort: "max" });
      yield* Queue.offer(
        f.events,
        nativeMessage(handle.sessionId!, {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "background-1", task_type: "local_agent", description: "Work" }],
        }),
      );
      yield* waitForSnapshot(handle, (snapshot) => snapshot.liveBackgroundTaskIds?.length === 1);
      expect(
        (yield* Effect.result(handle.setIntelligence!({ model: "default", effort: "default" })))
          ._tag,
      ).toBe("Failure");
      expect(f.openedInputs).toHaveLength(1);
      yield* Queue.offer(
        f.events,
        nativeMessage(handle.sessionId!, {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [],
        }),
      );
      yield* waitForSnapshot(handle, (snapshot) => snapshot.liveBackgroundTaskIds?.length === 0);
      yield* handle.setIntelligence!({ model: "default", effort: "default" });
      expect(f.openedInputs).toHaveLength(2);
      expect(f.released()).toBe(1);
      expect(f.sdkInput().model).toBeUndefined();
      expect(f.sdkInput().effort).toBeUndefined();
      expect(f.sdkInput().resume).toBe(false);
      expect((yield* SubscriptionRef.get(handle.snapshot)).metadata?.requestedSelection).toEqual({
        model: "default",
        effort: "default",
      });
    }).pipe(Effect.scoped),
);

it.effect(
  "full selection commits once and native rejection leaves requested intent unchanged",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const handle = yield* f.open();
      yield* handle.setIntelligence!({ model: "claude-sonnet-5", effort: "xhigh" });
      expect(f.selectedModels).toEqual(["claude-sonnet-5"]);
      expect(f.selectedEfforts).toEqual(["xhigh"]);
      f.rejectMutation();
      expect(
        (yield* Effect.result(handle.setIntelligence!({ model: "claude-sonnet-5", effort: "max" })))
          ._tag,
      ).toBe("Failure");
      expect((yield* SubscriptionRef.get(handle.snapshot)).metadata?.requestedSelection).toEqual({
        model: "claude-sonnet-5",
        effort: "xhigh",
      });
    }).pipe(Effect.scoped),
);

it.effect(
  "reusing a handle applies lowered policy and session approvals never persist to user settings",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const handle = yield* f.open(undefined, { permissionPolicy: "approve-for-me" });
      expect(
        yield* f
          .sdkInput()
          .canUseTool({ name: "Read", input: { file_path: "a" }, toolUseId: "read-1" }),
      ).toMatchObject({ behavior: "allow" });
      expect(yield* f.open()).toBe(handle);
      const approval = yield* Effect.forkChild(
        f.sdkInput().canUseTool({
          name: "Read",
          input: { file_path: "a" },
          toolUseId: "read-1",
          defaultToNo: true,
          suggestions: [
            {
              type: "addRules",
              rules: [{ toolName: "Read", ruleContent: "**" }],
              behavior: "allow",
              destination: "userSettings",
            },
          ],
        }),
      );
      yield* waitForRequest(handle);
      const request = (yield* SubscriptionRef.get(handle.snapshot)).requests![0]!;
      expect(request.constraints).toMatchObject({ defaultToNo: true, allowForSession: true });
      yield* handle.respond!(request.id, { decision: "allow-for-session" });
      expect(yield* Fiber.join(approval)).toMatchObject({
        behavior: "allow",
        updatedPermissions: [{ destination: "session" }],
      });
    }).pipe(Effect.scoped),
);

it.effect(
  "unattended execution denies every interactive callback without publishing requests",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const handle = yield* f.open(undefined, {
        permissionPolicy: "approve-for-me",
        isUnattended: Effect.succeed(true),
      });
      expect(
        yield* f
          .sdkInput()
          .canUseTool({ name: "AskUserQuestion", input: {}, toolUseId: "question" }),
      ).toMatchObject({ behavior: "deny" });
      expect(
        yield* f.sdkInput().onUserDialog!({ dialogKind: "resume_return", payload: {} }),
      ).toEqual({ behavior: "cancelled" });
      expect(
        yield* f.sdkInput().onElicitation!({ serverName: "server", message: "Credentials?" }),
      ).toEqual({ action: "cancel" });
      expect((yield* SubscriptionRef.get(handle.snapshot)).requests ?? []).toEqual([]);
    }).pipe(Effect.scoped),
);

it.effect("typed dialogs return native action while unsupported dialogs fail closed", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const handle = yield* f.open();
    expect(yield* f.sdkInput().onUserDialog!({ dialogKind: "new-kind", payload: {} })).toEqual({
      behavior: "cancelled",
    });
    const dialog = yield* Effect.forkChild(
      f.sdkInput().onUserDialog!({ dialogKind: "resume_return", payload: {} }),
    );
    yield* waitForRequest(handle);
    const request = (yield* SubscriptionRef.get(handle.snapshot)).requests![0]!;
    yield* handle.respond!(request.id, { decision: "dialog", result: "continue" });
    expect(yield* Fiber.join(dialog)).toEqual({ behavior: "completed", result: "continue" });
  }).pipe(Effect.scoped),
);

it.effect(
  "steered input settles only when consumed and queued continuation acquires a new turn",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const admitted: string[] = [];
      const settled: string[][] = [];
      const continuationSettled = yield* Deferred.make<void>();
      const handle = yield* f.open(undefined, {
        onTurnAdmitted: (value) =>
          Effect.sync(() => {
            admitted.push(value.clientUserMessageId);
          }),
        onTurnSettled: (value) =>
          Effect.sync(() => {
            settled.push([...value.clientUserMessageIds]);
          }).pipe(
            Effect.andThen(
              value.clientUserMessageIds.includes(nextId)
                ? Deferred.succeed(continuationSettled, undefined)
                : Effect.void,
            ),
          ),
      });
      const running = yield* Effect.forkChild(handle.prompt("first", { clientUserMessageId: id }));
      yield* Queue.take(f.sent);
      yield* handle.steer!("follow up", { clientUserMessageId: nextId });
      yield* Queue.take(f.sent);
      expect(f.sentInputs.at(-1)?.priority).toBe("now");
      yield* Queue.offer(
        f.events,
        nativeMessage(handle.sessionId!, {
          ...result(handle.sessionId!),
          user_message_uuids: [id],
          queued_turn_count: 1,
        }),
      );
      yield* Fiber.join(running);
      yield* waitForSnapshot(
        handle,
        (snapshot) => snapshot.turns.at(-1)?.clientUserMessageId === nextId,
      );
      expect(admitted).toEqual([id, nextId]);
      expect(settled).toEqual([[id]]);
      expect((yield* SubscriptionRef.get(handle.snapshot)).status).toBe("running");
      yield* Queue.offer(
        f.events,
        nativeMessage(handle.sessionId!, {
          ...result(handle.sessionId!),
          user_message_uuids: [nextId],
        }),
      );
      yield* Deferred.await(continuationSettled);
      expect(settled).toEqual([[id], [nextId]]);
    }).pipe(Effect.scoped),
);

it.effect("loads an older page into canonical history without changing current turn identity", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.setOlderHistory([
      {
        type: "user",
        uuid: nextId,
        session_id: id,
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { content: "Earlier question" },
      },
    ]);
    const handle = yield* f.open(id);
    const original = (yield* SubscriptionRef.get(handle.snapshot)).turns[0]!.sequence;
    yield* handle.loadHistory!({ limit: 12 });
    const snapshot = yield* SubscriptionRef.get(handle.snapshot);
    expect(snapshot.turns.map((turn) => turn.promptText)).toEqual([
      "Earlier question",
      "Remember 42",
    ]);
    expect(snapshot.turns.at(-1)?.sequence).toBe(original);
    expect(snapshot.history?.hasOlder).toBe(false);
    expect(f.historyPages.at(-1)).toEqual({ before: id, limit: 12 });
    expect(yield* Queue.size(f.sent)).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect(
  "rollback of every turn starts a clean native identity and never resumes a nonexistent transcript",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const transitions: boolean[] = [];
      f.setOlderHistory([
        {
          type: "system",
          uuid: nextId,
          session_id: id,
          parent_tool_use_id: null,
          parent_agent_id: null,
          message: { content: "Native setup" },
        },
        {
          type: "user",
          uuid: id,
          session_id: id,
          parent_tool_use_id: null,
          parent_agent_id: null,
          message: { content: "First question" },
        },
      ]);
      const handle = yield* f.open(id, {
        onSessionIdentityChanged: (value) =>
          Effect.sync(() => {
            transitions.push(value.everSaved ?? true);
          }),
      });
      yield* handle.rollback!(1);
      expect(handle.sessionId).not.toBe(id);
      expect((yield* SubscriptionRef.get(handle.snapshot)).turns).toEqual([]);
      expect(f.sdkInput().resume).toBe(false);
      expect(transitions).toEqual([false]);
      expect(
        (yield* Effect.result(handle.prompt("repeat", { clientUserMessageId: id })))._tag,
      ).toBe("Failure");
      expect(f.sentInputs).toEqual([]);
    }).pipe(Effect.scoped),
);

it.effect("cached discovery is isolated and settings changes invalidate its account catalog", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.manager.discover("claude-default", "/workspace");
    yield* f.manager.discover("claude-default", "/workspace");
    expect(f.openedInputs).toHaveLength(1);
    expect(f.sdkInput().purpose).toBe("discovery");
    expect(f.released()).toBe(1);
    yield* f.settings.update({
      type: "update-claude-agents",
      input: {
        instances: [
          {
            ...defaultClaudeInstance(),
            environment: [
              { name: "ANTHROPIC_BASE_URL", value: "https://other.example", sensitive: false },
            ],
          },
        ],
      },
    });
    yield* f.manager.discover("claude-default", "/workspace");
    expect(f.openedInputs).toHaveLength(2);
    expect(f.sdkInput().environment.ANTHROPIC_BASE_URL).toBe("https://other.example");
  }).pipe(Effect.scoped),
);

it.effect("prepared images reach native prompts and steering without converting to text", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const handle = yield* f.open();
    const images = [{ mediaType: "image/png" as const, data: "AA==" }];
    const running = yield* Effect.forkChild(
      handle.prompt("", {
        clientUserMessageId: id,
        images,
      }),
    );
    yield* Queue.take(f.sent);
    expect(f.sentInputs.at(-1)?.images).toEqual(images);
    yield* handle.steer!("", { clientUserMessageId: nextId, images });
    yield* Queue.take(f.sent);
    expect(f.sentInputs.at(-1)).toMatchObject({ priority: "now", images });
    yield* Queue.offer(
      f.events,
      nativeMessage(handle.sessionId!, {
        ...result(handle.sessionId!),
        user_message_uuids: [id, nextId],
      }),
    );
    yield* Fiber.join(running);
  }).pipe(Effect.scoped),
);

it.effect(
  "background ownership changes revoke authority before their snapshot becomes visible",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const ownership: string[][] = [];
      const handle = yield* f.open(undefined, {
        onBackgroundTasksChanged: (ids) =>
          Effect.sync(() => {
            ownership.push([...ids]);
          }),
      });
      expect(ownership).toEqual([[]]);
      yield* Queue.offer(
        f.events,
        nativeMessage(handle.sessionId!, {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [
            { task_id: "watch", task_type: "local_agent", description: "Watch", ambient: true },
          ],
        }),
      );
      yield* waitForSnapshot(
        handle,
        (snapshot) => snapshot.liveBackgroundTaskIds?.includes("watch") ?? false,
      );
      expect(ownership).toEqual([[], ["watch"]]);
      yield* Queue.offer(
        f.events,
        nativeMessage(handle.sessionId!, {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [],
        }),
      );
      yield* waitForSnapshot(handle, (snapshot) => snapshot.liveBackgroundTaskIds?.length === 0);
      expect(ownership).toEqual([[], ["watch"], []]);
    }).pipe(Effect.scoped),
);

it.effect("foreground stop preserves a background approval and fatal close clears liveness", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const handle = yield* f.open();
    const running = yield* Effect.forkChild(handle.prompt("work"));
    yield* Queue.take(f.sent);
    yield* Queue.offer(
      f.events,
      nativeMessage(handle.sessionId!, {
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [{ task_id: "background", task_type: "local_agent", description: "Continue" }],
      }),
    );
    yield* waitForSnapshot(
      handle,
      (snapshot) => snapshot.liveBackgroundTaskIds?.includes("background") ?? false,
    );
    const approval = yield* Effect.forkChild(
      f.sdkInput().canUseTool({
        name: "Bash",
        toolUseId: "background-tool",
        agentId: "background",
        input: { command: "echo later" },
      }),
    );
    yield* waitForRequest(handle);
    const request = (yield* SubscriptionRef.get(handle.snapshot)).requests![0]!;
    yield* handle.cancel;
    yield* Fiber.join(running);
    expect((yield* SubscriptionRef.get(handle.snapshot)).requests?.map(({ id }) => id)).toEqual([
      request.id,
    ]);
    yield* handle.respond!(request.id, { decision: "allow" });
    expect(yield* Fiber.join(approval)).toMatchObject({ behavior: "allow" });
    yield* Queue.offer(
      f.events,
      nativeMessage(nextId, {
        type: "assistant",
        message: { content: [] },
        parent_tool_use_id: null,
      }),
    );
    yield* waitForSnapshot(handle, (snapshot) => snapshot.status === "failed");
    const failed = yield* SubscriptionRef.get(handle.snapshot);
    expect(failed.liveBackgroundTaskIds).toEqual([]);
    expect(failed.tasks?.find(({ id }) => id === "background")?.status).toBe("failed");
    yield* TestClock.adjust("2 minutes");
    expect(f.released()).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect(
  "native persistence confirmation distinguishes an unsaved auth failure from a saved turn",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setNativeSaved(false);
      const confirmations: boolean[] = [];
      const handle = yield* f.open(undefined, {
        model: "claude-sonnet-5",
        onTurnSettled: (value) =>
          Effect.sync(() => {
            confirmations.push(value.everSaved);
          }),
      });
      const failed = yield* Effect.forkChild(handle.prompt("first", { clientUserMessageId: id }));
      yield* Queue.take(f.sent);
      yield* Queue.offer(
        f.events,
        nativeMessage(handle.sessionId!, {
          type: "assistant",
          error: "authentication_failed",
          message: { content: [] },
          parent_tool_use_id: null,
        }),
      );
      yield* Queue.offer(
        f.events,
        nativeMessage(handle.sessionId!, {
          ...result(handle.sessionId!),
          terminal_reason: "api_error",
          user_message_uuid: id,
        }),
      );
      yield* Fiber.join(failed).pipe(Effect.flip);
      expect(confirmations).toEqual([false]);
      expect((yield* SubscriptionRef.get(handle.snapshot)).status).toBe("authentication-required");
      yield* handle.setIntelligence!({ model: "default", effort: "default" });
      expect(f.sdkInput().resume).toBe(false);
      expect(yield* Queue.size(f.sent)).toBe(0);
      f.setNativeSaved(true);
      const retried = yield* Effect.forkChild(
        handle.prompt("try again", { clientUserMessageId: nextId }),
      );
      yield* Queue.take(f.sent);
      yield* Queue.offer(
        f.events,
        nativeMessage(handle.sessionId!, {
          ...result(handle.sessionId!),
          user_message_uuid: nextId,
        }),
      );
      yield* Fiber.join(retried);
      expect(confirmations).toEqual([false, true]);
    }).pipe(Effect.scoped),
);

it.effect("native result ordinal gaps are diagnostics and never replace prompt identity", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const handle = yield* f.open();
    const first = yield* Effect.forkChild(handle.prompt("first", { clientUserMessageId: id }));
    yield* Queue.take(f.sent);
    yield* Queue.offer(
      f.events,
      nativeMessage(handle.sessionId!, {
        ...result(handle.sessionId!),
        user_message_uuid: id,
        result_index: 1,
      }),
    );
    yield* Fiber.join(first);
    const second = yield* Effect.forkChild(handle.prompt("next", { clientUserMessageId: nextId }));
    yield* Queue.take(f.sent);
    yield* Queue.offer(
      f.events,
      nativeMessage(handle.sessionId!, {
        ...result(handle.sessionId!),
        user_message_uuid: id,
        result_index: 3,
      }),
    );
    yield* waitForSnapshot(
      handle,
      (snapshot) =>
        snapshot.metadata?.diagnostics?.some(({ code }) => code === "native-result-gap") ?? false,
    );
    expect((yield* SubscriptionRef.get(handle.snapshot)).status).toBe("running");
    yield* Queue.offer(
      f.events,
      nativeMessage(handle.sessionId!, {
        ...result(handle.sessionId!),
        user_message_uuid: nextId,
        result_index: 4,
      }),
    );
    yield* Fiber.join(second);
    yield* handle.setMode("plan");
    expect(
      (yield* SubscriptionRef.get(handle.snapshot)).metadata?.diagnostics?.some(
        ({ code }) => code === "native-result-gap",
      ),
    ).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect(
  "native reset denies old approvals while query-lifetime background tasks remain stoppable",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const handle = yield* f.open();
      const previous = handle.sessionId!;
      const running = yield* Effect.forkChild(handle.prompt("reset", { clientUserMessageId: id }));
      yield* Queue.take(f.sent);
      yield* Queue.offer(
        f.events,
        nativeMessage(previous, {
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [
            {
              task_id: "background",
              task_type: "local_agent",
              description: "Continue",
              agent_id: "background",
            },
            { task_id: "watch", task_type: "local_agent", description: "Watch", ambient: true },
          ],
        }),
      );
      yield* waitForSnapshot(handle, (value) => value.liveBackgroundTaskIds?.length === 2);
      const approval = yield* Effect.forkChild(
        f.sdkInput().canUseTool({
          name: "Bash",
          toolUseId: "old-tool",
          agentId: "background",
          input: { command: "echo old" },
        }),
      );
      yield* waitForRequest(handle);
      yield* Queue.offer(
        f.events,
        nativeMessage(previous, { type: "conversation_reset", new_conversation_id: nextId }),
      );
      expect(yield* Fiber.join(approval)).toMatchObject({ behavior: "deny" });
      yield* Fiber.join(running);
      yield* waitForSnapshot(handle, (value) => value.sessionId === nextId);
      const reset = yield* SubscriptionRef.get(handle.snapshot);
      expect(reset.requests).toEqual([]);
      expect(reset.turns).toEqual([]);
      expect(reset.liveBackgroundTaskIds).toEqual(["background", "watch"]);
      expect(reset.tasks?.map((task) => [task.id, task.bornTurnSequence])).toEqual([
        ["background", null],
        ["watch", null],
      ]);
      yield* handle.stopTask!("watch");
      expect(f.stoppedTasks).toEqual(["watch"]);
      const freshId = createUuidV7();
      const fresh = yield* Effect.forkChild(
        handle.prompt("fresh", { clientUserMessageId: freshId }),
      );
      yield* Queue.take(f.sent);
      yield* Queue.offer(
        f.events,
        nativeMessage(nextId, {
          type: "system",
          subtype: "task_notification",
          task_id: "background",
          status: "completed",
          output_file: "/tmp/fixture-output",
          summary: "Old task completed",
        }),
      );
      yield* waitForSnapshot(
        handle,
        (value) => value.tasks?.find((task) => task.id === "background")?.status === "completed",
      );
      const after = yield* SubscriptionRef.get(handle.snapshot);
      expect(after.turns).toHaveLength(1);
      expect(after.turns[0]?.clientUserMessageId).toBe(freshId);
      expect(
        after.turns[0]?.updates.filter(
          (update) => update.kind === "message" && update.role === "agent" && !update.actor,
        ),
      ).toEqual([]);
      yield* Queue.offer(
        f.events,
        nativeMessage(nextId, { ...result(nextId), user_message_uuid: freshId }),
      );
      yield* Fiber.join(fresh);
    }).pipe(Effect.scoped),
);

it.effect(
  "rollback failures after identity commit close the query and reject subsequent prompts",
  () =>
    Effect.gen(function* () {
      for (const failingStage of ["initialize", "history"] as const) {
        const f = yield* fixture();
        f.setOlderHistory([
          {
            type: "user",
            uuid: id,
            session_id: id,
            parent_tool_use_id: null,
            parent_agent_id: null,
            message: { content: "First" },
          },
          ...(failingStage === "history"
            ? [
                {
                  type: "user" as const,
                  uuid: nextId,
                  session_id: id,
                  parent_tool_use_id: null,
                  parent_agent_id: null,
                  message: { content: "Second" },
                },
              ]
            : []),
        ]);
        const transitions: string[] = [];
        const handle = yield* f.open(id, {
          onSessionIdentityChanged: (value) =>
            Effect.sync(() => {
              transitions.push(value.sessionId);
            }),
        });
        if (failingStage === "initialize") f.rejectReopen();
        else f.rejectHistory();
        expect((yield* Effect.result(handle.rollback!(1)))._tag).toBe("Failure");
        const failed = yield* SubscriptionRef.get(handle.snapshot);
        expect(failed.status).toBe("failed");
        expect(failed.sessionId).toBe(handle.sessionId);
        expect(transitions).toEqual([handle.sessionId]);
        expect(f.released()).toBe(failingStage === "initialize" ? 2 : 1);
        expect((yield* Effect.result(handle.prompt("never send")))._tag).toBe("Failure");
        expect(f.sentInputs).toEqual([]);
      }
    }).pipe(Effect.scoped),
);

it.effect("invalid rollback and a precommit fork failure preserve a usable current query", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.setOlderHistory([
      {
        type: "user",
        uuid: id,
        session_id: id,
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { content: "First" },
      },
      {
        type: "user",
        uuid: nextId,
        session_id: id,
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { content: "Second" },
      },
    ]);
    let transitioned = false;
    const handle = yield* f.open(id, {
      onSessionIdentityChanged: () =>
        Effect.sync(() => {
          transitioned = true;
        }),
    });
    expect((yield* Effect.result(handle.rollback!(-1)))._tag).toBe("Failure");
    f.rejectFork();
    expect((yield* Effect.result(handle.rollback!(1)))._tag).toBe("Failure");
    expect(transitioned).toBe(false);
    expect(handle.sessionId).toBe(id);
    expect((yield* SubscriptionRef.get(handle.snapshot)).status).toBe("idle");
    expect(f.released()).toBe(0);
    const prompt = yield* Effect.forkChild(handle.prompt("still usable"));
    yield* Queue.take(f.sent);
    yield* Queue.offer(f.events, result(id));
    yield* Fiber.join(prompt);
  }).pipe(Effect.scoped),
);

it.effect(
  "failed turn admission closes its Query lease and publishes failure without sending or settling a turn",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let openLeases = 0;
      let admissions = 0;
      let settlements = 0;
      const handle = yield* f.open(undefined, {
        acquireLaunchContext: Effect.acquireRelease(
          Effect.sync(() => {
            openLeases++;
            return {};
          }),
          () =>
            Effect.sync(() => {
              openLeases--;
            }),
        ),
        onTurnAdmitted: () =>
          Effect.sync(() => {
            admissions++;
          }).pipe(
            Effect.andThen(
              Effect.fail(
                agentRuntimeError({
                  operation: "admit",
                  reason: "authorization",
                  retryable: false,
                  cause: new Error("Core rejected admission"),
                }),
              ),
            ),
          ),
        onTurnSettled: () =>
          Effect.sync(() => {
            settlements++;
          }),
      });
      expect(openLeases).toBe(1);
      expect((yield* Effect.result(handle.prompt("do not send")))._tag).toBe("Failure");
      const failed = yield* SubscriptionRef.get(handle.snapshot);
      expect(failed.status).toBe("failed");
      expect(failed.error).toContain("Core rejected admission");
      expect(failed.turns).toEqual([]);
      expect(openLeases).toBe(0);
      expect(f.released()).toBe(1);
      expect(f.sentInputs).toEqual([]);
      expect(settlements).toBe(0);
      expect((yield* Effect.result(handle.prompt("requires reconnect")))._tag).toBe("Failure");
      expect(admissions).toBe(1);
    }).pipe(Effect.scoped),
);

it.effect(
  "restored observations survive older history loading and verified rollback UUID remapping",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const earlierId = "01991e60-b800-7000-8000-000000000024";
      const remappedId = "01991e60-b800-7000-8000-000000000026";
      const factTurn = (
        uuid: string,
        used: number,
      ): import("../../../shared/agent-conversation").AgentConversationTurn => ({
        sequence: 1,
        clientUserMessageId: uuid,
        nativeUserMessageId: uuid,
        promptText: "Known history",
        stopReason: "completed",
        updates: [
          {
            kind: "usage",
            key: "usage",
            used,
            size: 1_000,
            cost: { amount: 0.2, currency: "USD" },
            tokens: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0 },
            contextEstimated: true,
          },
          {
            kind: "compaction",
            key: `compaction:${uuid}`,
            compactionId: uuid,
            status: "completed",
            summary: "Preserved summary",
            error: null,
            trigger: "manual",
            preTokens: 100,
            postTokens: 40,
          },
          {
            kind: "diagnostic",
            key: "files:saved",
            code: "files:saved",
            severity: "info",
            message: "Saved",
            details: { files: [{ filename: "report.md", file_id: "asset" }] },
          },
        ],
      });
      const nativeUser = (uuid: string, text: string): SessionMessage => ({
        type: "user",
        uuid,
        session_id: id,
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { content: text },
      });
      f.setOlderHistory([nativeUser(earlierId, "Earlier")]);
      const handle = yield* f.open(id, {
        restoredTurns: [factTurn(id, 42), factTurn(earlierId, 84)],
      });
      const assertObservations = (
        turn: import("../../../shared/agent-conversation").AgentConversationTurn | undefined,
        used: number,
      ) => {
        expect(turn?.updates.find((update) => update.kind === "usage")).toMatchObject({
          used,
          cost: { amount: 0.2, currency: "USD" },
          tokens: { input: 8, output: 2 },
        });
        expect(turn?.updates.find((update) => update.kind === "compaction")).toMatchObject({
          summary: "Preserved summary",
          trigger: "manual",
          postTokens: 40,
        });
        expect(
          turn?.updates.find(
            (update) => update.kind === "diagnostic" && update.code === "restored-files",
          ),
        ).toMatchObject({ details: { artifacts: [{ filename: "report.md", fileId: "asset" }] } });
      };
      assertObservations((yield* SubscriptionRef.get(handle.snapshot)).turns[0], 42);
      yield* handle.loadHistory!();
      const loaded = yield* SubscriptionRef.get(handle.snapshot);
      assertObservations(
        loaded.turns.find((turn) => turn.nativeUserMessageId === earlierId),
        84,
      );
      f.setOlderHistory([nativeUser(id, "First"), nativeUser(nextId, "Second")]);
      f.setForkMessageIds({ [id]: remappedId });
      yield* handle.rollback!(1);
      const rolledBack = yield* SubscriptionRef.get(handle.snapshot);
      expect(rolledBack.turns).toHaveLength(1);
      expect(rolledBack.turns[0]?.nativeUserMessageId).toBe(remappedId);
      expect(rolledBack.turns[0]?.clientUserMessageId).toBe(id);
      assertObservations(rolledBack.turns[0], 42);
    }).pipe(Effect.scoped),
);

it.effect(
  "a full resident history window avoids repeated native reads that cannot make progress",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setOlderHistory(
        Array.from({ length: 512 }, (_, index): SessionMessage => ({
          type: "user",
          uuid: createUuidV7(),
          session_id: id,
          parent_tool_use_id: null,
          parent_agent_id: null,
          message: { content: `Earlier ${index}` },
        })),
      );
      const handle = yield* f.open(id);
      yield* handle.loadHistory!();
      const snapshot = yield* SubscriptionRef.get(handle.snapshot);
      expect(snapshot.turns).toHaveLength(512);
      expect(snapshot.history?.windowFull).toBe(true);
      const reads = f.historyPages.length;
      yield* handle.loadHistory!();
      expect(f.historyPages).toHaveLength(reads);
      expect((yield* SubscriptionRef.get(handle.snapshot)).revision).toBe(snapshot.revision);
    }).pipe(Effect.scoped),
);

it.effect(
  "native page projection keeps the actual retained cursor so older turns are never skipped",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const messages = Array.from({ length: 120 }, (_, index): SessionMessage => ({
        type: "user",
        uuid: createUuidV7(),
        session_id: id,
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { content: `History ${index}` },
      }));
      f.setInitialHistory(messages);
      const handle = yield* f.open(id);
      const initial = yield* SubscriptionRef.get(handle.snapshot);
      expect(initial.turns).toHaveLength(64);
      expect(initial.history?.hasOlder).toBe(true);
      expect(initial.history?.cursor).toBe(messages[56]!.uuid);
      yield* handle.loadHistory!();
      const loaded = yield* SubscriptionRef.get(handle.snapshot);
      expect(f.historyPages.at(-1)?.before).toBe(messages[56]!.uuid);
      expect(loaded.turns).toHaveLength(120);
      expect(loaded.turns.map((turn) => turn.nativeUserMessageId)).toEqual(
        messages.map((message) => message.uuid),
      );
      expect(loaded.history?.hasOlder).toBe(false);
    }).pipe(Effect.scoped),
);
