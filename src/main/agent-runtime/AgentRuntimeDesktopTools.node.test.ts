import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { PresentationAnchor } from "../../shared/nodex-app-tools/workbench";
import type { BrowserUseRouteCapture } from "../browser-use/browser-use-session-runtime";
import { BrowserUseRuntimeError } from "../host-runtime/BrowserUseRuntime";
import type { WindowRuntime } from "../window-runtime/WindowRuntime";
import { make } from "./AgentRuntimeDesktopTools";

const primary = (webContentsId: number, windowSessionId: string) =>
  ({
    kind: "primary",
    webContentsId,
    windowId: webContentsId,
    windowSessionId,
    activeSessionId: null,
    focusSequence: null,
    focused: false,
    layoutRevision: 0,
    rendererGeneration: "renderer",
  }) as const;

const fixture = (options: {
  readonly anchors?: Record<string, string>;
  readonly busy?: boolean;
}) => {
  const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
  const record = (method: string) => (input: unknown) =>
    Effect.sync(() => {
      calls.push({ method, input });
    });
  const tools = make({
    tools: {
      threadConfig: (cwd) =>
        Effect.succeed({
          "mcp_servers.node_repl": { command: "/desktop/node", cwd },
          "features.image_generation": false,
        }),
    },
    browserUse: {
      captureRoute: (input: BrowserUseRouteCapture) =>
        options.busy
          ? Effect.fail(
              new BrowserUseRuntimeError({ operation: "capture-route", cause: new Error("busy") }),
            )
          : record("captureRoute")(input),
      turnStarted: record("turnStarted"),
      turnEnded: record("turnEnded"),
      endSessionActivity: record("endSessionActivity"),
      releaseSession: record("releaseSession"),
    },
    windows: {
      snapshot: (): ReturnType<WindowRuntime["Service"]["snapshot"]> => ({
        revision: 1,
        windows: [primary(11, "window-a"), primary(12, "window-b")],
      }),
    },
    presentation: {
      read: (threadId, runId) => {
        const windowSessionId = options.anchors?.[`${threadId}/${runId}`];
        return windowSessionId ? ({ windowSessionId } as PresentationAnchor) : null;
      },
    },
  });
  return { tools, calls };
};

const started = (runId: string, nativeTurnId: string) =>
  ({
    phase: "started",
    threadId: "thread:root",
    runId,
    sessionId: "session",
    projectId: "project",
    nativeThreadId: "codex-thread",
    nativeTurnId,
  }) as const;

it.effect("an Agent Turn drives the in-app Browser of the window that submitted it", () =>
  Effect.gen(function* () {
    const { tools, calls } = fixture({ anchors: { "thread:root/run:one": "window-b" } });
    yield* tools.observeNativeTurn(started("run:one", "turn-one"));
    yield* tools.observeNativeTurn({
      phase: "ended",
      nativeThreadId: "codex-thread",
      nativeTurnId: "turn-one",
    });
    assert.deepEqual(calls, [
      {
        method: "captureRoute",
        input: {
          browserConversationId: "session",
          browserViewScopeId: "window-b",
          codexSessionId: "codex-thread",
          ownerWebContentsId: 12,
          projectId: "project",
        },
      },
      { method: "turnStarted", input: { sessionId: "codex-thread", turnId: "turn-one" } },
      { method: "turnEnded", input: { sessionId: "codex-thread", turnId: "turn-one" } },
      { method: "endSessionActivity", input: "codex-thread" },
    ]);
  }),
);

it.effect("a Turn without a submitting window keeps the conversation's current Browser", () =>
  Effect.gen(function* () {
    const { tools, calls } = fixture({ anchors: { "thread:root/run:gone": "closed-window" } });
    yield* tools.observeNativeTurn(started("run:queued", "turn-queued"));
    yield* tools.observeNativeTurn(started("run:gone", "turn-gone"));
    assert.deepEqual(
      calls.map((call) => call.method),
      ["turnStarted", "turnStarted"],
    );
  }),
);

it.effect("a Browser that cannot take the route still lets the Turn run", () =>
  Effect.gen(function* () {
    const { tools, calls } = fixture({
      anchors: { "thread:root/run:one": "window-a" },
      busy: true,
    });
    yield* tools.observeNativeTurn(started("run:one", "turn-one"));
    assert.deepEqual(calls, []);
  }),
);

it.effect("archiving a Session releases the Browser conversations its Agents routed", () =>
  Effect.gen(function* () {
    const { tools, calls } = fixture({ anchors: { "thread:root/run:one": "window-a" } });
    yield* tools.observeNativeTurn(started("run:one", "turn-one"));
    calls.length = 0;
    yield* tools.releaseSession("other-session");
    yield* tools.releaseSession("session");
    yield* tools.releaseSession("session");
    assert.deepEqual(calls, [{ method: "releaseSession", input: "codex-thread" }]);
  }),
);

it.effect("Codex threads get the Desktop features beneath the host's own tool config", () =>
  Effect.gen(function* () {
    const { tools } = fixture({});
    const config = yield* tools.threadConfig("/workspace");
    assert.deepEqual(config["mcp_servers.node_repl"], {
      command: "/desktop/node",
      cwd: "/workspace",
    });
    assert.equal(config["features.image_generation"], false);
    assert.equal(config["features.collaboration_modes"], true);
  }),
);
