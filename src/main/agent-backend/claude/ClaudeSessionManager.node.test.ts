// @effect-diagnostics strictEffectProvide:off
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { ApplicationSettings, make as makeSettings } from "../../settings/ApplicationSettings";
import { ClaudeSdk, type ClaudeSdkOpenInput } from "../../platform/node/ClaudeSdk";
import { make as makeManager } from "./ClaudeSessionManager";
import type { AgentSessionHandle } from "../AgentSessionHandle";
import { defaultClaudeInstance } from "../../../shared/claude-agent-settings";
import type { ClaudeEffortSelection } from "../../../shared/claude-models";

const id = "01991e60-b800-7000-8000-000000000012";
const result = (sessionId: string) =>
  ({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    uuid: id,
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
      settingsPath: join(root, "settings.toml"),
    });
    const events = yield* Queue.unbounded<SDKMessage>();
    const sent = yield* Queue.unbounded<string>();
    let opened: ClaudeSdkOpenInput | null = null;
    let released = 0;
    let terminated = 0;
    let historySession: string | null = null;
    let historyEnvironment: Readonly<Record<string, string | undefined>> = {};
    const selectedModels: (string | undefined)[] = [];
    const selectedEfforts: ClaudeEffortSelection[] = [];
    const sdk = ClaudeSdk.of({
      open: (input) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            opened = input;
            return {
              messages: Stream.fromQueue(events),
              models: [
                {
                  value: "sonnet",
                  resolvedModel: "claude-sonnet-5",
                  displayName: "Sonnet",
                  description: "Runtime model",
                  supportsEffort: true,
                  supportedEffortLevels: ["low", "high", "xhigh", "max"],
                },
              ],
              commands: [{ name: "compact", description: "Compact context", argumentHint: "" }],
              send: (text: string) => Queue.offer(sent, text).pipe(Effect.asVoid),
              terminate: Effect.sync(() => {
                terminated += 1;
              }),
              interrupt: ignoreInterrupt
                ? Effect.void
                : Queue.offer(events, result(input.sessionId)).pipe(Effect.asVoid),
              setModel: (model: string | undefined, effort?: ClaudeEffortSelection) =>
                Effect.sync(() => {
                  selectedModels.push(model);
                  if (effort !== undefined) selectedEfforts.push(effort);
                }),
              setEffort: (effort: ClaudeEffortSelection) =>
                Effect.sync(() => {
                  selectedEfforts.push(effort);
                }),
              setMode: () => Effect.void,
            };
          }),
          () =>
            Effect.sync(() => {
              released += 1;
            }),
        ),
      history: (input) =>
        Effect.sync(() => {
          historySession = input.sessionId;
          historyEnvironment = input.environment;
          return [
            {
              type: "user",
              uuid: id,
              session_id: input.sessionId,
              parent_tool_use_id: null,
              parent_agent_id: null,
              message: { content: "Remember 42" },
            },
            {
              type: "assistant",
              uuid: id,
              session_id: input.sessionId,
              parent_tool_use_id: null,
              parent_agent_id: null,
              message: {
                id: "old-message",
                model: "gateway-claude-pinned",
                content: [{ type: "text", text: "Remembered." }],
              },
            },
          ] satisfies SessionMessage[];
        }),
    });
    const manager = yield* makeManager.pipe(
      Effect.provideService(ApplicationSettings, settings),
      Effect.provideService(ClaudeSdk, sdk),
      Effect.provide(mainConfigLayer({ environment: { HOME: root, PATH: "/usr/bin" } })),
    );
    const open = (sessionId?: string, selection?: { model: string; effort: string }) =>
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
      selectedModels,
      selectedEfforts,
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
      model: "gateway-claude-pinned",
    });
    expect(handle.configOptions[0]).toMatchObject({ currentValue: "gateway-claude-pinned" });
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
      expect((yield* SubscriptionRef.get(handle.snapshot)).requests).toEqual([]);
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
    expect(options.map(({ value }) => value)).toEqual(["default", "claude-sonnet-5"]);
    expect(options[1]?.reasoningEfforts).toEqual(["low", "high", "xhigh", "max"]);
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
    expect(f.selectedModels).toEqual(["claude-sonnet-5", undefined]);
  }),
);

it.effect(
  "applies only advertised effort levels and resets unsupported effort with the model",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const handle = yield* f.open();
      yield* handle.setConfigOption("model", "claude-sonnet-5");
      yield* handle.setConfigOption("effort", "xhigh");
      yield* handle.setConfigOption("effort", "max");
      expect(f.selectedEfforts).toEqual(["xhigh", "max"]);
      yield* handle.setConfigOption("effort", "medium").pipe(Effect.flip);
      expect(f.selectedEfforts).toEqual(["xhigh", "max"]);
      expect(handle.configOptions.find(({ id }) => id === "effort")).toMatchObject({
        currentValue: "max",
      });
      yield* handle.setConfigOption("model", "default");
      expect(f.selectedModels).toEqual(["claude-sonnet-5", undefined]);
      expect(f.selectedEfforts).toEqual(["xhigh", "max", "default"]);
      expect(handle.configOptions.find(({ id }) => id === "effort")).toMatchObject({
        currentValue: "default",
        options: [{ value: "default" }],
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
    expect(f.selectedEfforts).toEqual(["default"]);
    yield* f.manager.close("thread-1");
    const reopened = yield* f.open(id, { model: "claude-sonnet-5", effort: "medium" });
    expect(f.selectedEfforts).toEqual(["default", "default"]);
    expect(reopened.configOptions.find(({ id }) => id === "effort")).toMatchObject({
      currentValue: "default",
    });
  }),
);
