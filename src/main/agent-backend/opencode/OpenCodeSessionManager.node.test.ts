// @effect-diagnostics strictEffectProvide:off
import type { Event, Model, Session, SessionStatusResponse } from "@opencode-ai/sdk/v2";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { defaultOpenCodeInstance } from "../../../shared/opencode-agent-settings";
import type { FrozenNodexAgentTurnAuthority } from "../../../shared/nodex-agent-authority";
import { createNativeAppToolClaimIssuer } from "../../app-tools/AppToolCaller";
import { ApplicationSettings } from "../../settings/ApplicationSettings";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import {
  OpenCodeSdk,
  nodeLive as openCodeNodeLive,
  type OpenCodeConnection,
  type OpenCodeInventory,
  type OpenCodeLaunchInput,
  type OpenCodeNativeMessage,
  type OpenCodeHistoryPage,
  type OpenCodePromptInput,
} from "../../platform/node/OpenCodeSdk";
import { AgentRuntimeError } from "../AgentRuntimeError";
import { make, type OpenOpenCodeSessionInput } from "./OpenCodeSessionManager";
import { openCodeCatalog } from "./OpenCodeModels";

const model = (id: string, variants: Model["variants"] = {}): Model => ({
  id,
  providerID: "moonshot",
  api: { id, url: "https://api.moonshot.test", npm: "@ai-sdk/openai-compatible" },
  name: id,
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, image: false, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 1, output: 1, cache: { read: 0, write: 0 } },
  limit: { context: 100000, output: 10000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-10-01",
  variants,
});
const inventory: OpenCodeInventory = {
  providers: {
    all: [
      {
        id: "moonshot",
        name: "Moonshot",
        source: "env",
        env: ["MOONSHOT_API_KEY"],
        options: {},
        models: {
          "kimi-k3": model("kimi-k3"),
          "kimi-thinking": model("kimi-thinking", { high: { reasoningEffort: "high" } }),
        },
      },
      {
        id: "unconnected",
        name: "Unconnected",
        source: "api",
        env: [],
        options: {},
        models: { hidden: { ...model("hidden"), providerID: "unconnected" } },
      },
    ],
    connected: ["moonshot"],
    default: { moonshot: "kimi-k3" },
  },
  agents: [
    { name: "build", mode: "primary", permission: [], options: {} },
    { name: "plan", mode: "primary", permission: [], options: {} },
    { name: "explore", mode: "subagent", permission: [], options: {} },
  ],
  commands: [],
  config: { model: "moonshot/kimi-k3" },
  version: "1.15.13",
};
const session = (id: string, parentID?: string): Session => ({
  id,
  slug: "native",
  projectID: "project",
  directory: "/workspace",
  title: "Native",
  version: "1.15.13",
  time: { created: 1, updated: 1 },
  ...(parentID ? { parentID } : {}),
});
const input: OpenOpenCodeSessionInput = {
  threadId: "thread",
  instanceConfigId: "opencode-default",
  workspaceRoot: "/workspace",
  permissionPolicy: "ask",
};
it.live(
  "an actual local SDK runtime completes its first prompt and resumes native history after reopening",
  () =>
    Effect.gen(function* () {
      const temporaryRoot = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-opencode-native-"))),
        (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
      );
      const root = yield* Effect.promise(() => realpath(temporaryRoot));
      const workspaceRoot = join(root, "workspace");
      const profileDirectory = join(root, "profile");
      const binaryPath = join(root, "opencode");
      const fixtureUrl = pathToFileURL(
        resolve("scripts/scenarios/runtime/scripted-opencode-agent.mjs"),
      ).href;
      yield* Effect.promise(() => mkdir(workspaceRoot));
      yield* Effect.promise(() =>
        writeFile(binaryPath, `#!${process.execPath}\nimport(${JSON.stringify(fixtureUrl)});\n`, {
          mode: 0o700,
        }),
      );
      const settings = ApplicationSettings.of({
        openCodeLaunchConfiguration: () =>
          Effect.succeed({
            instance: { ...defaultOpenCodeInstance(), enabled: true, binaryPath },
            profileDirectory,
            environment: {},
          }),
        claudeLaunchConfiguration: () => Effect.die("Unused Claude config"),
        snapshot: () => Effect.die("Unused snapshot"),
        update: () => Effect.die("Unused update"),
      });
      yield* Effect.gen(function* () {
        const manager = yield* make;
        const opened = yield* manager.open({
          ...input,
          workspaceRoot,
          model: "moonshot/kimi-k3",
          modeId: "plan",
          configOptions: [{ id: "variant", value: "high" }],
        });
        expect(
          yield* opened.prompt("OPEN_CODE_OK", { clientUserMessageId: "stable-client-id" }),
        ).toEqual({ stopReason: "end_turn" });
        const completed = yield* SubscriptionRef.get(opened.snapshot);
        if (!opened.sessionId) return yield* Effect.die("Native session identity is unavailable");
        expect(completed.turns.at(-1)).toMatchObject({
          clientUserMessageId: "stable-client-id",
          status: "completed",
        });
        expect(completed.turns.at(-1)?.updates).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "message", role: "agent", text: "OPEN_CODE_OK" }),
          ]),
        );
        yield* manager.close(input.threadId);
        const restored = yield* manager.open({
          ...input,
          workspaceRoot,
          resumeSessionId: opened.sessionId,
        });
        const history = yield* SubscriptionRef.get(restored.snapshot);
        expect(history.turns.at(-1)?.nativeUserMessageId).toBe(
          completed.turns.at(-1)?.nativeUserMessageId,
        );
        expect(history.turns.at(-1)?.updates).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "message", role: "agent", text: "OPEN_CODE_OK" }),
          ]),
        );
        const observations = yield* Effect.promise(() =>
          readFile(join(profileDirectory, "data", "opencode", "observations.jsonl"), "utf8"),
        );
        const rows = yield* Effect.forEach(observations.trim().split("\n"), (row) =>
          Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ kind: Schema.String })))(row),
        );
        expect(rows.filter((row) => row.kind === "createSession")).toHaveLength(1);
        expect(rows.filter((row) => row.kind === "prompt")).toHaveLength(1);
      }).pipe(
        Effect.provideService(ApplicationSettings, settings),
        Effect.provide(
          Layer.mergeAll(
            mainConfigLayer({
              environment: { HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin" },
            }),
            openCodeNodeLive,
          ),
        ),
      );
    }),
);
const fixture = (
  options: {
    missingResume?: boolean;
    holdAdmission?: boolean;
    holdAbort?: boolean;
    history?: readonly OpenCodeNativeMessage[];
    pages?: readonly OpenCodeHistoryPage[];
    parentMessage?: OpenCodeNativeMessage;
    serverUrl?: string | null;
    statuses?: SessionStatusResponse;
    parentIds?: Readonly<Record<string, string>>;
  } = {},
) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<Event>();
    const sent = yield* Queue.unbounded<OpenCodePromptInput>();
    const admission = yield* Deferred.make<void>();
    const abortCompleted = yield* Deferred.make<void>();
    const abortReceipts = yield* Queue.unbounded<string>();
    const requestReceipts = yield* Queue.unbounded<string>();
    const opened: OpenCodeLaunchInput[] = [];
    const replies: { id: string; reply: string }[] = [];
    let created = 0;
    let released = 0;
    let nextId = 0;
    let historyReads = 0;
    const beforeValues: (string | undefined)[] = [];
    let statuses = options.statuses ?? {};
    const connection: OpenCodeConnection = {
      nextMessageId: Effect.sync(() => `msg_${++nextId}`),
      inventory: Effect.succeed(inventory),
      events: Stream.fromQueue(events),
      ready: Effect.void,
      termination: Effect.never,
      sessionStatuses: Effect.sync(() => statuses),
      createSession: () =>
        Effect.sync(() => {
          created += 1;
          return session("ses_native");
        }),
      session: (id) =>
        options.missingResume
          ? Effect.fail(
              new AgentRuntimeError({
                message: "Native session missing",
                operation: "opencode.get-session",
                reason: "resource-not-found",
                retryable: false,
              }),
            )
          : Effect.succeed(
              session(
                id,
                options.parentIds?.[id] ?? (id === "ses_child" ? "ses_native" : undefined),
              ),
            ),
      history: (_id, page) =>
        Effect.sync(() => {
          beforeValues.push(page?.before);
          return (
            options.pages?.[historyReads++] ?? {
              messages: options.history ?? [],
              cursor: null,
              hasMore: false,
            }
          );
        }),
      message: (_sessionId, messageId) =>
        options.parentMessage?.info.id === messageId
          ? Effect.succeed(options.parentMessage)
          : Effect.die("Unexpected message read"),
      prompt: (prompt) =>
        Queue.offer(sent, prompt).pipe(
          Effect.andThen(options.holdAdmission ? Deferred.await(admission) : Effect.void),
        ),
      abort: (id) =>
        Queue.offer(abortReceipts, id).pipe(
          Effect.andThen(options.holdAbort ? Deferred.await(abortCompleted) : Effect.void),
        ),
      children: () => Effect.succeed([]),
      setPermissions: () => Effect.void,
      pendingPermissions: Effect.succeed([]),
      pendingQuestions: Effect.succeed([]),
      replyPermission: (id, reply) =>
        Effect.sync(() => {
          replies.push({ id, reply });
        }).pipe(Effect.andThen(Queue.offer(requestReceipts, id)), Effect.asVoid),
      replyQuestion: () => Effect.void,
      rejectQuestion: () => Effect.void,
      fork: () => Effect.succeed(session("ses_fork")),
      compact: () => Effect.void,
    };
    const sdk = OpenCodeSdk.of({
      open: (launch) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            opened.push(launch);
            return connection;
          }),
          () =>
            Effect.sync(() => {
              released += 1;
            }),
        ),
    });
    const settings = ApplicationSettings.of({
      openCodeLaunchConfiguration: () =>
        Effect.succeed({
          instance: {
            ...defaultOpenCodeInstance(),
            enabled: true,
            serverUrl: options.serverUrl ?? null,
          },
          profileDirectory: "/profile",
          environment: { INSTANCE_VALUE: "instance" },
        }),
      claudeLaunchConfiguration: () => Effect.die("Unused Claude config"),
      snapshot: () => Effect.die("Unused snapshot"),
      update: () => Effect.die("Unused update"),
    });
    const manager = yield* make.pipe(
      Effect.provideService(OpenCodeSdk, sdk),
      Effect.provideService(ApplicationSettings, settings),
      Effect.provide(
        mainConfigLayer({
          environment: { EXCLUDED: "ambient", INSTANCE_VALUE: "ambient", AMBIENT: "kept" },
        }),
      ),
    );
    return {
      manager,
      events,
      sent,
      admission,
      abortCompleted,
      abortReceipts,
      requestReceipts,
      opened,
      replies,
      beforeValues,
      setStatuses: (next: SessionStatusResponse) => {
        statuses = next;
      },
      created: () => created,
      released: () => released,
    };
  });

it.effect(
  "catalog discovery is scoped to the selected instance and exact cwd without native sessions",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      const catalog = yield* test.manager.discover({
        instanceConfigId: input.instanceConfigId,
        workspaceRoot: "/another-project",
      });
      expect(test.created()).toBe(0);
      expect(test.opened[0]).toMatchObject({
        cwd: "/another-project",
        profileDirectory: "/profile",
      });
      expect(catalog.models.map((model) => model.model)).toEqual([
        "moonshot/kimi-k3",
        "moonshot/kimi-thinking",
      ]);
      expect(catalog.modelConfigOptions?.["moonshot/kimi-k3"]).toEqual([]);
      expect(catalog.modelConfigOptions?.["moonshot/kimi-thinking"]?.[0]).toMatchObject({
        id: "variant",
        options: [{ value: "" }, { value: "high" }],
      });
      expect(catalog.modes?.availableModes.map((mode) => mode.id)).toEqual(["build", "plan"]);
    }),
);
it.effect(
  "catalog helper capacity limits rapid distinct workspace queries without creating sessions",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      for (let index = 0; index < 32; index += 1) {
        const catalog = yield* test.manager.discover({
          instanceConfigId: input.instanceConfigId,
          workspaceRoot: `/workspace/${index}`,
        });
        expect(catalog.health.status).toBe("ready");
      }
      const exhausted = yield* test.manager.discover({
        instanceConfigId: input.instanceConfigId,
        workspaceRoot: "/workspace/overflow",
      });
      expect(exhausted.health.status).toBe("unavailable");
      expect(test.opened).toHaveLength(32);
      expect(test.created()).toBe(0);
    }),
);
it.effect(
  "missing native resume never creates a replacement conversation and releases its runtime",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture({ missingResume: true });
      const result = yield* test.manager
        .open({ ...input, resumeSessionId: "ses_missing" })
        .pipe(Effect.result);
      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "resource-not-found" } });
      expect(test.created()).toBe(0);
      expect(test.released()).toBe(1);
    }),
);
it.effect("changed native owners fail before acquiring a server", () =>
  Effect.gen(function* () {
    const test = yield* fixture({ serverUrl: "https://new-server.test" });
    const result = yield* test.manager
      .open({ ...input, expectedHome: "https://old-server.test", resumeSessionId: "ses_native" })
      .pipe(Effect.result);
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "authorization" } });
    expect(test.opened).toHaveLength(0);
  }),
);
it.effect("workspace environment excludes are applied before explicit instance settings", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    yield* test.manager.open({
      ...input,
      workspaceEnvironment: {
        version: 1,
        set: { INSTANCE_VALUE: "workspace", WORKSPACE: "yes" },
        exclude: ["EXCLUDED"],
      },
    });
    expect(test.opened[0]?.environment).toEqual({
      AMBIENT: "kept",
      INSTANCE_VALUE: "instance",
      WORKSPACE: "yes",
    });
  }),
);
it.effect(
  "catalog discovery shares execution environment authority and caches each resolved environment",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      const discovery = {
        instanceConfigId: input.instanceConfigId,
        workspaceRoot: input.workspaceRoot,
        workspaceEnvironment: {
          version: 1 as const,
          set: { INSTANCE_VALUE: "workspace", WORKSPACE: "first" },
          exclude: ["EXCLUDED"],
        },
      };
      yield* test.manager.discover(discovery);
      yield* test.manager.discover(discovery);
      expect(test.opened).toHaveLength(1);
      expect(test.opened[0]?.environment).toEqual({
        AMBIENT: "kept",
        INSTANCE_VALUE: "instance",
        WORKSPACE: "first",
      });
      yield* test.manager.discover({
        ...discovery,
        workspaceEnvironment: { ...discovery.workspaceEnvironment, set: { WORKSPACE: "second" } },
      });
      expect(test.opened).toHaveLength(2);
      expect(test.opened[1]?.environment.WORKSPACE).toBe("second");
      expect(test.created()).toBe(0);
    }),
);
it.effect(
  "native provider/model/agent/variant routing settles only after an admitted turn finishes",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture({ holdAdmission: true });
      const handle = yield* test.manager.open({
        ...input,
        model: "moonshot/kimi-thinking",
        modeId: "plan",
        configOptions: [{ id: "variant", value: "high" }],
      });
      const running = yield* handle
        .prompt("hello", { clientUserMessageId: "client-id" })
        .pipe(Effect.forkScoped);
      const prompt = yield* Queue.take(test.sent);
      expect(prompt).toMatchObject({
        model: { providerID: "moonshot", modelID: "kimi-thinking" },
        variant: "high",
        agent: "plan",
      });
      yield* Queue.offer(test.events, {
        id: "evt_early_idle",
        type: "session.idle",
        properties: { sessionID: "ses_native" },
      });
      yield* Queue.offer(test.events, {
        id: "evt_busy",
        type: "session.status",
        properties: { sessionID: "ses_native", status: { type: "busy" } },
      });
      yield* Deferred.succeed(test.admission, undefined);
      yield* Effect.yieldNow;
      expect(running.pollUnsafe()).toBeUndefined();
      yield* Queue.offer(test.events, {
        id: "evt_idle",
        type: "session.idle",
        properties: { sessionID: "ses_native" },
      });
      expect(yield* Fiber.join(running)).toEqual({ stopReason: "end_turn" });
      expect((yield* SubscriptionRef.get(handle.snapshot)).turns[0]).toMatchObject({
        clientUserMessageId: "client-id",
        nativeUserMessageId: prompt.messageId,
        status: "completed",
      });
    }),
);
it.effect("unadvertised model variants are rejected before a native prompt", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    const handle = yield* test.manager.open(input);
    const result = yield* handle.setConfigOption("variant", "high").pipe(Effect.result);
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "capability" } });
    expect(handle.configOptions.some((option) => option.id === "variant")).toBe(false);
    expect(
      openCodeCatalog(input.instanceConfigId, inventory).models[0]?.supportedReasoningEfforts,
    ).toEqual([]);
  }),
);
it.effect("cancelling a native turn prevents its in-flight abort from touching the next turn", () =>
  Effect.gen(function* () {
    const test = yield* fixture({ holdAbort: true });
    const handle = yield* test.manager.open(input);
    const first = yield* handle.prompt("first").pipe(Effect.forkScoped);
    yield* Queue.take(test.sent);
    const changing = yield* handle
      .setConfigOption("model", "moonshot/kimi-thinking")
      .pipe(Effect.result);
    expect(changing).toMatchObject({ _tag: "Failure", failure: { reason: "authorization" } });
    const cancelling = yield* handle.cancel.pipe(Effect.forkScoped);
    expect(yield* Queue.take(test.abortReceipts)).toBe("ses_native");
    yield* Queue.offer(test.events, {
      id: "evt_cancel_busy",
      type: "session.status",
      properties: { sessionID: "ses_native", status: { type: "busy" } },
    });
    yield* Queue.offer(test.events, {
      id: "evt_cancel_idle",
      type: "session.idle",
      properties: { sessionID: "ses_native" },
    });
    expect(yield* Fiber.join(first)).toEqual({ stopReason: "cancelled" });
    const admissionDuringAbort = yield* handle.prompt("second").pipe(Effect.result);
    expect(admissionDuringAbort).toMatchObject({
      _tag: "Failure",
      failure: { reason: "authorization" },
    });
    expect(yield* Queue.size(test.sent)).toBe(0);
    yield* Deferred.succeed(test.abortCompleted, undefined);
    yield* Fiber.join(cancelling);
    const second = yield* handle.prompt("second").pipe(Effect.forkScoped);
    expect((yield* Queue.take(test.sent)).text).toBe("second");
    yield* Queue.offer(test.events, {
      id: "evt_second_busy",
      type: "session.status",
      properties: { sessionID: "ses_native", status: { type: "busy" } },
    });
    yield* Queue.offer(test.events, {
      id: "evt_second_idle",
      type: "session.idle",
      properties: { sessionID: "ses_native" },
    });
    expect(yield* Fiber.join(second)).toEqual({ stopReason: "end_turn" });
  }),
);
it.effect("cancellation reaches the native server while a prompt request awaits its response", () =>
  Effect.gen(function* () {
    const test = yield* fixture({ holdAdmission: true });
    const handle = yield* test.manager.open(input);
    const running = yield* handle.prompt("native command").pipe(Effect.forkScoped);
    yield* Queue.take(test.sent);
    yield* handle.cancel;
    expect(yield* Queue.take(test.abortReceipts)).toBe("ses_native");
    expect((yield* SubscriptionRef.get(handle.snapshot)).turns[0]?.status).toBe("cancelled");
    yield* Deferred.succeed(test.admission, undefined);
    expect(yield* Fiber.join(running)).toEqual({ stopReason: "cancelled" });
  }),
);
it.effect(
  "permissions are thread scoped and native always approval cannot broaden a session grant",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      const handle = yield* test.manager.open(input);
      const permission = (id: string, sessionID: string): Event => ({
        id: `evt_${id}`,
        type: "permission.asked",
        properties: {
          id,
          sessionID,
          permission: "bash",
          patterns: ["ls"],
          always: ["*"],
          metadata: {},
        },
      });
      yield* Queue.offer(test.events, permission("foreign", "ses_foreign"));
      yield* Queue.offer(test.events, permission("child", "ses_child"));
      yield* SubscriptionRef.changes(handle.snapshot).pipe(
        Stream.filter(
          (present) => present.requests?.some((request) => request.id === "child") ?? false,
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const present = yield* SubscriptionRef.get(handle.snapshot);
      expect(present.requests?.map((request) => request.id)).toEqual(["child"]);
      expect(present.requests?.[0]?.constraints?.allowForSession).toBe(false);
      const always = yield* handle.respond!("child", { decision: "allow-for-session" }).pipe(
        Effect.result,
      );
      expect(always).toMatchObject({ _tag: "Failure", failure: { reason: "capability" } });
      yield* handle.respond!("child", { decision: "allow" });
      expect(test.replies).toEqual([{ id: "child", reply: "once" }]);
    }),
);
it.effect("closing one thread releases its server and settles an outstanding prompt", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    const handle = yield* test.manager.open(input);
    const prompt = yield* handle.prompt("running").pipe(Effect.result, Effect.forkScoped);
    yield* Queue.take(test.sent);
    yield* test.manager.close(input.threadId);
    expect(test.released()).toBe(1);
    expect(yield* Fiber.join(prompt)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "closing" },
    });
    expect((yield* SubscriptionRef.get(handle.snapshot)).status).toBe("closed");
  }),
);

it.effect(
  "native task execution revokes host-issued claims across foreground turns and unsolicited parent prompts",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      const changes = yield* Queue.unbounded<readonly string[]>();
      const issuer = createNativeAppToolClaimIssuer({
        backend: "opencode",
        threadId: input.threadId,
        hostId: "local",
        generation: 1,
        capture: () => Effect.succeed(true),
      });
      const authority = (turnId: string): FrozenNodexAgentTurnAuthority => ({
        threadId: input.threadId,
        turnId,
        rootThreadId: input.threadId,
        actorProjectId: "project",
        libraryId: "library",
        storeEpoch: "epoch",
        frozenAtMs: 1,
        readOnly: false,
        scope: "project",
        source: "project_turn",
      });
      const handle = yield* test.manager.open({
        ...input,
        onTurnAdmitted: ({ clientUserMessageId }) =>
          Effect.sync(() => {
            expect(issuer.beginTurn(authority(clientUserMessageId))).toBe(true);
          }),
        onTurnCompleted: ({ clientUserMessageId }) =>
          Effect.sync(() => issuer.endTurn(clientUserMessageId)),
        onBackgroundTasksChanged: (ids) =>
          Effect.sync(() => issuer.setBackgroundTasks(ids)).pipe(
            Effect.andThen(Queue.offer(changes, ids)),
            Effect.asVoid,
          ),
      });
      const first = yield* handle.prompt("first").pipe(Effect.forkScoped);
      const nativeFirst = yield* Queue.take(test.sent);
      const admittedClaim = issuer.claim();
      expect(admittedClaim?.isActive()).toBe(true);
      yield* Queue.offer(test.events, {
        id: "evt_task_started",
        type: "message.part.updated",
        properties: {
          sessionID: "ses_native",
          time: 1,
          part: {
            type: "tool",
            id: "part_task",
            sessionID: "ses_native",
            messageID: "msg_assistant",
            callID: "call_task",
            tool: "task",
            state: { status: "pending", input: { background: true }, raw: "" },
          },
        },
      });
      expect(yield* Queue.take(changes)).toEqual(["task:ses_native:call_task"]);
      expect(admittedClaim?.isActive()).toBe(false);
      expect(issuer.claim()).toBeNull();
      yield* Queue.offer(test.events, {
        id: "evt_child_created",
        type: "session.created",
        properties: { sessionID: "ses_child", info: session("ses_child", "ses_native") },
      });
      expect(yield* Queue.take(changes)).toEqual(["ses_child", "task:ses_native:call_task"]);
      test.setStatuses({ ses_child: { type: "busy" } });
      yield* Queue.offer(test.events, {
        id: "evt_child_busy",
        type: "session.status",
        properties: { sessionID: "ses_child", status: { type: "busy" } },
      });
      yield* Queue.offer(test.events, {
        id: "evt_task_returned",
        type: "message.part.updated",
        properties: {
          sessionID: "ses_native",
          time: 2,
          part: {
            type: "tool",
            id: "part_task",
            sessionID: "ses_native",
            messageID: "msg_assistant",
            callID: "call_task",
            tool: "task",
            state: {
              status: "completed",
              input: { background: true },
              output: "Running in background",
              title: "Task",
              metadata: { background: true, sessionId: "ses_child" },
              time: { start: 1, end: 2 },
            },
          },
        },
      });
      expect(yield* Queue.take(changes)).toEqual(["ses_child"]);
      yield* Queue.offer(test.events, {
        id: "evt_first_busy",
        type: "session.status",
        properties: { sessionID: "ses_native", status: { type: "busy" } },
      });
      yield* Queue.offer(test.events, {
        id: "evt_first_idle",
        type: "session.idle",
        properties: { sessionID: "ses_native" },
      });
      expect(yield* Fiber.join(first)).toEqual({ stopReason: "end_turn" });
      const second = yield* handle.prompt("second").pipe(Effect.forkScoped);
      const nativeSecond = yield* Queue.take(test.sent);
      expect(nativeSecond.messageId).not.toBe(nativeFirst.messageId);
      expect(issuer.claim()).toBeNull();
      yield* Queue.offer(test.events, {
        id: "evt_foreign_busy",
        type: "session.status",
        properties: { sessionID: "ses_foreign", status: { type: "busy" } },
      });
      test.setStatuses({});
      yield* Queue.offer(test.events, {
        id: "evt_child_idle",
        type: "session.idle",
        properties: { sessionID: "ses_child" },
      });
      expect(yield* Queue.take(changes)).toEqual([]);
      const renewedClaim = issuer.claim();
      expect(renewedClaim?.isActive()).toBe(true);
      expect(admittedClaim?.isActive()).toBe(false);
      yield* Queue.offer(test.events, {
        id: "evt_injected_user",
        type: "message.updated",
        properties: {
          sessionID: "ses_native",
          info: {
            id: "msg_unsponsored",
            role: "user",
            sessionID: "ses_native",
            time: { created: 3 },
            model: nativeSecond.model,
            agent: "build",
          },
        },
      });
      expect(yield* Queue.take(changes)).toEqual(["native-turn:ses_native"]);
      expect(renewedClaim?.isActive()).toBe(false);
      expect(issuer.claim()).toBeNull();
      yield* Queue.offer(test.events, {
        id: "evt_second_busy",
        type: "session.status",
        properties: { sessionID: "ses_native", status: { type: "busy" } },
      });
      yield* Queue.offer(test.events, {
        id: "evt_second_idle",
        type: "session.idle",
        properties: { sessionID: "ses_native" },
      });
      expect(yield* Queue.take(changes)).toEqual([]);
      expect(yield* Fiber.join(second)).toEqual({ stopReason: "end_turn" });
      expect(issuer.claim()).toBeNull();
    }),
);

it.effect("resume and new admission reconcile only verified busy native descendants", () =>
  Effect.gen(function* () {
    const test = yield* fixture({
      statuses: {
        ses_native: { type: "idle" },
        ses_child: { type: "retry", attempt: 1, message: "Retry", next: 3 },
      },
    });
    const changes = yield* Queue.unbounded<readonly string[]>();
    const handle = yield* test.manager.open({
      ...input,
      resumeSessionId: "ses_native",
      onBackgroundTasksChanged: (ids) => Queue.offer(changes, ids).pipe(Effect.asVoid),
    });
    expect(yield* Queue.take(changes)).toEqual(["ses_child"]);
    test.setStatuses({ ses_foreign: { type: "busy" } });
    const prompt = yield* handle.prompt("next").pipe(Effect.result, Effect.forkScoped);
    yield* Queue.take(test.sent);
    expect(yield* Queue.take(changes)).toEqual([]);
    yield* Queue.offer(test.events, {
      id: "evt_created",
      type: "session.created",
      properties: { sessionID: "ses_child", info: session("ses_child", "ses_native") },
    });
    expect(yield* Queue.take(changes)).toEqual(["ses_child"]);
    yield* test.manager.close(input.threadId);
    expect(yield* Queue.take(changes)).toEqual([]);
    expect(yield* Fiber.join(prompt)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "closing" },
    });
  }),
);

it.effect("native task pressure fails closed instead of dropping live descendants", () =>
  Effect.gen(function* () {
    const ids = Array.from({ length: 129 }, (_, index) => `ses_child_${index}`);
    const test = yield* fixture({
      parentIds: Object.fromEntries(ids.map((id) => [id, "ses_native"])),
    });
    const handle = yield* test.manager.open(input);
    const prompt = yield* handle.prompt("running").pipe(Effect.result, Effect.forkScoped);
    yield* Queue.take(test.sent);
    for (const id of ids)
      yield* Queue.offer(test.events, {
        id: `evt_${id}`,
        type: "session.status",
        properties: { sessionID: id, status: { type: "busy" } },
      });
    expect(yield* Fiber.join(prompt)).toMatchObject({
      _tag: "Failure",
      failure: { operation: "opencode.background-tasks" },
    });
    expect(yield* handle.prompt("retry").pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "closing" },
    });
    yield* SubscriptionRef.changes(handle.snapshot).pipe(
      Stream.filter((snapshot) => snapshot.status === "failed"),
      Stream.take(1),
      Stream.runDrain,
    );
  }),
);

it.effect(
  "history pages that split one native turn preserve its user identity and both response fragments",
  () =>
    Effect.gen(function* () {
      const user: OpenCodeNativeMessage = {
        info: {
          id: "msg_user",
          sessionID: "ses_native",
          role: "user",
          time: { created: 1 },
          model: { providerID: "moonshot", modelID: "kimi-k3" },
          agent: "build",
        },
        parts: [
          {
            type: "text",
            id: "prt_user",
            sessionID: "ses_native",
            messageID: "msg_user",
            text: "Original native prompt",
          },
        ],
      };
      const assistant = (id: string, text: string, created: number): OpenCodeNativeMessage => ({
        info: {
          id,
          sessionID: "ses_native",
          role: "assistant",
          parentID: "msg_user",
          time: { created, completed: created + 1 },
          providerID: "moonshot",
          modelID: "kimi-k3",
          mode: "build",
          agent: "build",
          path: { cwd: "/workspace", root: "/workspace" },
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        },
        parts: [{ type: "text", id: `prt_${id}`, sessionID: "ses_native", messageID: id, text }],
      });
      const test = yield* fixture({
        parentMessage: user,
        pages: [
          {
            messages: [assistant("msg_new", "Newest response", 5)],
            cursor: "opaque-next-token",
            hasMore: true,
          },
          {
            messages: [user, assistant("msg_old", "Earlier response", 2)],
            cursor: null,
            hasMore: false,
          },
        ],
      });
      const handle = yield* test.manager.open({ ...input, resumeSessionId: "ses_native" });
      const initial = yield* SubscriptionRef.get(handle.snapshot);
      expect(initial.turns[0]).toMatchObject({
        nativeUserMessageId: "msg_user",
        promptText: "Original native prompt",
      });
      expect(initial.history).toMatchObject({ cursor: "opaque-next-token", hasOlder: true });
      yield* handle.loadHistory!();
      const expanded = yield* SubscriptionRef.get(handle.snapshot);
      expect(expanded.turns).toHaveLength(1);
      expect(
        expanded.turns[0]?.updates
          .filter((update) => update.kind === "message")
          .map((update) => (update.kind === "message" ? update.text : "")),
      ).toEqual(["Earlier response", "Newest response"]);
      expect(expanded.history?.hasOlder).toBe(false);
      expect(test.beforeValues).toEqual([undefined, "opaque-next-token"]);
    }),
);
