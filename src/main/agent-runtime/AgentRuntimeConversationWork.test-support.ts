import { EventEmitter } from "node:events";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { IpcMainInvokeEvent } from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import {
  withCoreScenario,
  type CoreScenarioContext,
} from "../../../scripts/scenarios/harness/core-scenario-harness";
import { NODEX_COORDINATOR_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/nodex-coordinator";
import type { RuntimeCorpus } from "../../../scripts/scenarios/runtime/corpora/runtime-corpora";
import type { AgentRuntimeSessionEvent } from "../../shared/agent-runtime-api";
import {
  createRuntimeWorkLedger,
  type RuntimeWorkLedger,
  type RuntimeWorkReading,
} from "../../shared/diagnostics/runtime-work";
import { createUuidV7 } from "../../shared/uuid-v7";
import {
  AgentRuntimeConversationOwner,
  type AgentRuntimeReadTransport,
} from "../../renderer/features/local-conversation/agent-runtime-conversation-owner";
import {
  RUNTIME_NAVIGATION_MARK,
  runtimeConversationNavigation,
  type RuntimeNavigationRecord,
} from "../../renderer/features/local-conversation/runtime-conversation-navigation";
import { replaceRendererRuntimeWork } from "../../renderer/lib/runtime-work";
import { testLayer as mainConfigTestLayer } from "../app/MainConfig";
import { layer as callbacks, ScopedCallbackRuntime } from "../app/ScopedCallbackRuntime";
import { CoreModules } from "../core-runtime/CoreModules";
import { ProjectRuntimeLifecycleRuntime } from "../host-runtime/ProjectRuntimeLifecycleRuntime";
import { live as agentRuntimeIpc } from "../ipc/handlers/AgentRuntimeIpc";
import { ElectronIpc } from "../platform/electron/ElectronIpc";
import { makeTestElectronIpc } from "../platform/electron/ElectronIpc.test-support";
import { acquireAgentRuntimeProcess } from "../platform/node/AgentRuntimeProcess";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import { AgentRuntimeApplication, make as makeApplication } from "./AgentRuntimeApplication";
import * as SessionActivity from "./AgentRuntimeSessionActivity";
import { AgentRuntimeSessionActivity } from "./AgentRuntimeSessionActivity";
import { AgentRuntimeSupervisor } from "./AgentRuntimeSupervisor";
import { AgentRuntimeWorkLedger, windowRuntimeWorkId } from "./AgentRuntimeWork";

/**
 * One Runtime conversation materialized from a corpus, read the way windows read it: the real
 * renderer conversation owner, through Main's Runtime IPC handlers and Session Interface, over a
 * real Core and a real Agent Runtime process whose Codex is the scripted app-server fixture.
 * Main and the windows each count their work in their own ledger.
 */
export interface ConversationWorkHarness {
  readonly target: { readonly sessionId: string; readonly threadId: string };
  readonly mainWork: RuntimeWorkLedger;
  readonly rendererWork: RuntimeWorkLedger;
  /** The renderer transport of one window, bound to that window's IPC sender. */
  readonly transport: (window: 1 | 2) => AgentRuntimeReadTransport;
  /** One window's Session operation, by IPC channel. */
  readonly invoke: (window: 1 | 2, channel: string, input: unknown) => Promise<unknown>;
  /** Starts the corpus's controlled stream Turn; its chunks then arrive through `streamChunk`. */
  readonly startStream: Effect.Effect<void, unknown>;
  readonly streamChunk: (delta: string) => Effect.Effect<void>;
  readonly completeStream: Effect.Effect<void>;
}

/** Every Codex Turn completes at once except the corpus's stream, which the test drives. */
const STREAM_PROMPT_MARKER = "Stream into";

const fixturePath = (name: string) =>
  fileURLToPath(new URL(`../../../tests/e2e/fixtures/${name}`, import.meta.url));

const acquireScenario = Effect.acquireRelease(
  Effect.callback<
    { scenario: CoreScenarioContext; release: () => void; completed: Promise<void> },
    unknown
  >((resume) => {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const completed = withCoreScenario(
      { scenarioId: NODEX_COORDINATOR_SCENARIO_ID },
      async (scenario) => {
        resume(Effect.succeed({ scenario, release, completed }));
        await released;
      },
    );
    void completed.catch((cause) => resume(Effect.fail(cause)));
  }),
  ({ release, completed }) =>
    Effect.promise(() => {
      release();
      return completed;
    }),
);

type Handler = (event: IpcMainInvokeEvent, input: unknown) => Effect.Effect<unknown, unknown>;

export const conversationWorkHarness = Effect.fn("test.conversationWorkHarness")(function* (
  corpus: RuntimeCorpus,
) {
  const { scenario } = yield* acquireScenario;
  const home = join(scenario.profile.nodexHome, "execution");
  const fake = join(home, "fake-codex");
  const commands = join(fake, "commands.jsonl");
  const replyPath = join(fake, "reply.md");
  yield* Effect.promise(async () => {
    await mkdir(fake, { recursive: true });
    await writeFile(
      join(fake, "state.json"),
      JSON.stringify({
        thread: null,
        turns: [],
        turnSequence: 0,
        queueSequence: 0,
        queuedSubmissions: [],
      }),
    );
    await writeFile(commands, "");
    await writeFile(replyPath, "");
    const peer = pathToFileURL(fixturePath("codex-transcript-performance-app-server.mjs"));
    await writeFile(join(home, "app-server"), `void import(${JSON.stringify(peer.href)});\n`);
  });
  const mainWork = createRuntimeWorkLedger();
  const rendererWork = createRuntimeWorkLedger();
  yield* Effect.acquireRelease(
    Effect.sync(() => replaceRendererRuntimeWork(rendererWork)),
    (restore) => Effect.sync(restore),
  );
  const runtime = yield* acquireAgentRuntimeProcess({
    executable: process.execPath,
    entryPath: fileURLToPath(
      new URL("../../../packages/agent-runtime/src/nodex/entry.ts", import.meta.url),
    ),
    environment: {
      ...process.env,
      NODE_OPTIONS: `--import=${import.meta.resolve("tsx")}`,
      NODEX_FAKE_CODEX_STATE_PATH: join(fake, "state.json"),
      NODEX_FAKE_CODEX_COMMAND_PATH: commands,
      NODEX_FAKE_CODEX_LOG_PATH: join(fake, "requests.jsonl"),
      NODEX_FAKE_CODEX_BASE_FIXTURE: fixturePath("codex-queue-app-server.mjs"),
      NODEX_FAKE_CODEX_CONTROLLED_PROMPT: STREAM_PROMPT_MARKER,
      NODEX_FAKE_CODEX_FINAL_REPLY_PATH: replyPath,
      NODEX_FAKE_CODEX_AUTO_COMPLETE_FIRST_TURN: "1",
      NODEX_FAKE_CODEX_AUTOMATIC_COMPLETION_DELAY_MS: "0",
      NODEX_FAKE_CODEX_RESUMED_COMPLETION_DELAY_MS: "0",
    },
    configuration: {
      home,
      cwd: home,
      automaticWorkAtOnce: 2,
      host: { tools: [] },
      providers: {
        codex: {
          driver: "codex",
          config: {
            binaryPath: process.execPath,
            homePath: join(home, "codex"),
            setupMode: "existing",
          },
        },
      },
    },
    host: () => Effect.succeed({}),
  }).pipe(Effect.provideService(AgentRuntimeWorkLedger, mainWork));
  const core = {
    workspace: {
      apply: (input: Parameters<CoreModules["Service"]["workspace"]["apply"]>[0]) =>
        Effect.tryPromise(() => scenario.client.workspaceApply(input)),
      read: (input: Parameters<CoreModules["Service"]["workspace"]["read"]>[0]) =>
        Effect.tryPromise(() => scenario.client.workspaceRead(input)),
    },
  };
  const application = yield* makeApplication({
    connect: Effect.succeed(runtime),
    currentConnection: Effect.succeed(runtime),
    projectless: {
      engineProjectId: "profile:projectless",
      workspaceRoot: home,
      ensureWorkspaceRoot: Effect.void,
    },
  }).pipe(
    Effect.provideService(CoreModules, core as never),
    Effect.provideService(ProjectWorkspace, {} as never),
    Effect.provideService(ProjectRuntimeLifecycleRuntime, { runExclusive: (_id, use) => use }),
    Effect.provideService(AgentRuntimeWorkLedger, mainWork),
  );

  // Main's Runtime IPC, with each window's deliveries routed to its renderer listeners.
  const handlers = new Map<string, Handler>();
  const callbackContext = yield* Layer.build(callbacks);
  const callbackRuntime = Context.get(callbackContext, ScopedCallbackRuntime);
  const deliveries = new Map<number, Set<(event: AgentRuntimeSessionEvent) => void>>([
    [1, new Set()],
    [2, new Set()],
  ]);
  yield* Layer.build(
    agentRuntimeIpc.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(AgentRuntimeApplication, {
            ...application,
            catalogInvalidations: Stream.never,
          } as AgentRuntimeApplication["Service"]),
          Layer.succeed(AgentRuntimeSupervisor, { get: () => Effect.succeed(runtime) } as never),
          Layer.succeed(AgentRuntimeSessionActivity, SessionActivity.inactive),
          Layer.succeed(
            ElectronIpc,
            makeTestElectronIpc({
              handle: (channel: string, handler: Handler) =>
                Effect.sync(() => {
                  handlers.set(channel, handler);
                }),
              on: () => Effect.void,
            }),
          ),
          Layer.succeed(WindowRuntime, {
            has: (id: number) => id === 1 || id === 2,
            all: () => [],
          } as never),
          mainConfigTestLayer(),
          Layer.succeed(ScopedCallbackRuntime, callbackRuntime),
        ),
      ),
    ),
  ).pipe(Effect.provideService(AgentRuntimeWorkLedger, mainWork));
  const senders = new Map(
    ([1, 2] as const).map((id) => {
      const frame = { url: "app://-/index.html" };
      const sender = Object.assign(new EventEmitter(), {
        id,
        mainFrame: frame,
        getType: () => "window",
        isDestroyed: () => false,
        send: (_channel: string, event: AgentRuntimeSessionEvent) => {
          for (const listener of deliveries.get(id)!) listener(event);
        },
      });
      return [id, { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent] as const;
    }),
  );
  // A window's invocation crosses into Main the way Electron's callbacks do.
  const invoke = (window: 1 | 2, channel: string, input: unknown) =>
    callbackRuntime.runPromise(handlers.get(channel)!(senders.get(window)!, input));
  const transport = (window: 1 | 2): AgentRuntimeReadTransport => ({
    read: (input) => invoke(window, "agent-runtime:session:read", input) as never,
    control: (input) => invoke(window, "agent-runtime:session:control", input) as never,
    history: (input) => invoke(window, "agent-runtime:session:history", input) as never,
    promptIndex: (input) => invoke(window, "agent-runtime:session:prompt-index", input) as never,
    item: (input) => invoke(window, "agent-runtime:session:item", input) as never,
    readQueuePage: (input) => invoke(window, "agent-runtime:session:queue-read", input) as never,
    readRunMessage: (input) => invoke(window, "agent-runtime:session:run-message", input) as never,
    readQueuedPreview: (input) =>
      invoke(window, "agent-runtime:session:queued-preview", input) as never,
    attachment: (input) => invoke(window, "agent-runtime:session:attachment", input) as never,
    subscribe: async (input, listener) => {
      const subscriptionId = createUuidV7();
      const listeners = deliveries.get(window)!;
      const deliver = (event: AgentRuntimeSessionEvent) => {
        if (event.subscriptionId === subscriptionId) listener(event);
      };
      listeners.add(deliver);
      await invoke(window, "agent-runtime:session:observe", { ...input, subscriptionId });
      return () => {
        listeners.delete(deliver);
        void invoke(window, "agent-runtime:session:unobserve", { subscriptionId }).catch(() => {});
      };
    },
  });

  // The conversation: a Core Session bound to a Runtime root, then the corpus's settled Turns.
  const sessionId = createUuidV7();
  const threadId = `thread:${sessionId}`;
  const cwd = join(home, "chat");
  yield* Effect.promise(() => mkdir(cwd, { recursive: true }));
  yield* Effect.promise(() =>
    scenario.client.workspaceApply({
      operationId: createUuidV7(),
      intent: {
        kind: "create_agent_runtime_session",
        session_id: sessionId,
        project_id: scenario.manifest.projectId,
        runtime_id: runtime.identity.runtimeId,
        runtime_thread_id: threadId,
        launch_request_id: `launch:${sessionId}`,
        title: corpus.id,
        initial_page_ids: [],
      },
    }),
  );
  yield* runtime.request("command.dispatch", {
    command: {
      type: "thread.create",
      commandId: `create:${threadId}`,
      threadId,
      projectId: scenario.manifest.projectId,
      title: corpus.id,
      modelSelection: { instanceId: "codex", model: "gpt-5.5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "system",
      creationSource: "server",
    },
  });
  const send = (index: number, text: string) =>
    runtime.request("thread.send", {
      threadId,
      commandId: `send:${threadId}:${index}`,
      messageId: createUuidV7(),
      text,
      attachments: [],
      mode: "auto",
      createdBy: "user",
    });
  for (const [index, turn] of corpus.turns.entries()) {
    yield* Effect.promise(() => writeFile(replyPath, turn.reply));
    const { runId } = yield* send(index, turn.prompt);
    let execution = yield* runtime.request("thread.execution", { threadId, runId });
    while (execution.status !== "completed")
      execution = yield* runtime.request("thread.execution.wait", {
        threadId,
        runId,
        afterRevision: execution.revision,
        timeoutMs: 30_000,
      });
  }
  const command = (value: object) =>
    Effect.promise(() => appendFile(commands, `${JSON.stringify(value)}\n`));
  return {
    target: { sessionId, threadId },
    mainWork,
    rendererWork,
    transport,
    invoke,
    startStream: Effect.gen(function* () {
      if (!corpus.stream?.prompt.includes(STREAM_PROMPT_MARKER))
        return yield* Effect.die("This corpus has no controlled stream");
      yield* send(corpus.turns.length, corpus.stream.prompt);
      yield* command({ type: "start" });
    }),
    streamChunk: (delta: string) => command({ type: "delta", delta }),
    completeStream: command({ type: "complete" }),
  } satisfies ConversationWorkHarness;
});

/** The assistant text an owner's transcript shows now. */
export function transcriptReplies(owner: AgentRuntimeConversationOwner): readonly string[] {
  const structure = owner.readOwner.readStructure();
  if (!structure) return [];
  return structure.turns.flatMap((turn) =>
    turn.itemIds.flatMap((itemId) => {
      const item = itemId === undefined ? null : owner.readOwner.readItem(turn.entityKey, itemId);
      return item?.type === "agentMessage" ? [item.text] : [];
    }),
  );
}

/**
 * Reads the transcript as its view does: the structure, and one leaf per item, following the
 * structure as items arrive. Returns the release.
 */
function mountTranscript(owner: AgentRuntimeConversationOwner): () => void {
  const leaves = new Map<string, () => void>();
  const follow = () => {
    for (const turn of owner.readOwner.readStructure()?.turns ?? [])
      for (const itemId of turn.itemIds) {
        const key = itemId === undefined ? null : JSON.stringify([turn.entityKey, itemId]);
        if (key === null || leaves.has(key)) continue;
        leaves.set(
          key,
          owner.readOwner.subscribeItem(turn.entityKey, itemId!, () => {}),
        );
      }
  };
  const releaseStructure = owner.readOwner.subscribeStructure(follow);
  follow();
  return () => {
    for (const release of leaves.values()) release();
    releaseStructure();
  };
}

/** Waits for a condition on state that the conversation's own deliveries change. */
export const eventually = (condition: () => boolean) =>
  Effect.sync(condition).pipe(
    Effect.repeat({ until: (met) => met, schedule: Schedule.spaced("10 millis") }),
    Effect.timeout("30 seconds"),
  );

export const counts = (reading: RuntimeWorkReading) =>
  Object.fromEntries(
    Object.entries(reading)
      .map(([metric, tally]) => [metric, tally.count] as const)
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );

/**
 * Opens the conversation in one window as the Workbench does: the route dispatches the
 * navigation, the transcript subscribes during commit, and the conversation stage retains its
 * owner. Returns once the projection is current and its observation and queue are admitted.
 */
export const openConversation = Effect.fn("test.openConversation")(function* (
  harness: ConversationWorkHarness,
  window: 1 | 2,
  replies: number,
) {
  const { target } = harness;
  const owner = new AgentRuntimeConversationOwner(target, harness.transport(window));
  runtimeConversationNavigation.dispatch(target, { resident: false });
  const workId = runtimeConversationNavigation.workId(target)!;
  const leave = runtimeConversationNavigation.enter(target, { resident: false, provider: "codex" });
  const releaseTranscript = mountTranscript(owner);
  const releaseOwner = owner.retain();
  yield* eventually(
    () => owner.contentSource() !== null && transcriptReplies(owner).length >= replies,
  );
  runtimeConversationNavigation.committed(target, false);
  runtimeConversationNavigation.visible(target);
  const mainWorkId = windowRuntimeWorkId(window, workId);
  yield* eventually(() => {
    const reading = harness.mainWork.read(mainWorkId);
    return (
      reading["runtime.reply:events.observe"] !== undefined &&
      reading["runtime.reply:thread.queue"] !== undefined
    );
  });
  return {
    owner,
    workId,
    mainWorkId,
    close: () => {
      releaseTranscript();
      releaseOwner();
      leave();
      owner.dispose();
    },
  };
});

export const navigationRecords = () =>
  performance
    .getEntriesByName(RUNTIME_NAVIGATION_MARK)
    .map((entry) => (entry as PerformanceMeasure).detail as RuntimeNavigationRecord);

/** Today's reads behind one ordinary open of a settled Runtime conversation, by boundary. */
export const OPEN_RENDERER_REQUESTS = {
  "renderer.request:observe": 1,
  "renderer.request:queue-read": 1,
  "renderer.request:read": 1,
};
export const OPEN_MAIN_WORK = {
  "core.read:agent_runtime_session_binding": 3,
  "core.read:project": 3,
  "renderer.delivery:event": 0,
  "runtime.reply:events.observe": 1,
  "runtime.reply:thread.queue": 1,
  "runtime.reply:thread.read": 3,
  "runtime.reply:thread.snapshot": 1,
  "runtime.request:events.observe": 1,
  "runtime.request:thread.queue": 1,
  "runtime.request:thread.read": 3,
  "runtime.request:thread.snapshot": 1,
};
/** The serial reads before the first content can paint: the snapshot read and what it waits on. */
export const FIRST_CONTENT_ROUND_TRIPS = 5;

export const recorded = (reading: RuntimeWorkReading, expected: Record<string, number>) =>
  Object.fromEntries(Object.keys(expected).map((metric) => [metric, reading[metric]?.count ?? 0]));
