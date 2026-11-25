import { describe, afterAll } from "vite-plus/test";
import { createAppToolAdmissionFixture } from "./app-tool-operation.test-fixtures";
import { CoreModules } from "../core-runtime/CoreModules";
import { assert, it } from "@effect/vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as Effect from "effect/Effect";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import type {
  WorkbenchAgentRequestBody,
  WorkbenchWindowReference,
} from "../../shared/nodex-app-tools/workbench";
import { CodexTurnPresentation } from "../../host/TurnPresentation";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import { GitWorkerRuntime } from "../host-runtime/GitWorkerRuntime";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { BrowserApplication } from "../browser-application/BrowserApplication";
import { WorkbenchAgentBridge, WorkbenchAgentBridgeError } from "./WorkbenchAgentBridge";
import { WorkbenchContentRouting } from "./WorkbenchContentRouting";
import { make } from "./SessionPresentationAppTools";
import type { WorkbenchAppToolContext } from "./WorkbenchControl";
import { createHostedAppToolCaller } from "./AppToolCaller";
import * as Clock from "effect/Clock";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CodexThreadDirectory } from "../codex-application/CodexThreadDirectory";
import { CodexThreadReadState } from "../codex-application/CodexThreadReadState";
import { CodexMainConversationManagers } from "../codex-application/CodexMainConversationManagers";
import { CodexMainConversationResume } from "../codex-application/CodexMainConversationResume";
import { CodexMainConversationInterrupt } from "../codex-application/CodexMainConversationInterrupt";
import { CodexQueuedFollowUps } from "../codex-application/CodexQueuedFollowUps";
import { CodexTurnCommands } from "../codex-application/CodexTurnCommands";
import { makeControlsWithCapture as makeWithCapture } from "./NativeSessionTools";
import { denied } from "./SessionControlAuthority";

describe("SessionPresentationAppTools", () => {
  const windowA = { windowSessionId: "window-a", rendererGeneration: "generation-a" };
  const windowB = { windowSessionId: "window-b", rendererGeneration: "generation-b" };
  const workspaceDirectory = realpathSync.native(
    mkdtempSync(join(tmpdir(), "nodex-open-in-nodex-")),
  );
  afterAll(() => rmSync(workspaceDirectory, { recursive: true, force: true }));
  const writeWorkspaceFile = (name: string) => {
    const path = join(workspaceDirectory, name);
    writeFileSync(path, "<!doctype html><h1>Report</h1>");
    return { path, url: pathToFileURL(path).href };
  };
  const report = writeWorkspaceFile("report.html");
  const browserTab = (browserTabId: string) => ({
    tabId: `browser:${browserTabId}`,
    surface: { kind: "browser", config: { browserTabId } },
  });
  const authority: NodexAgentTurnContext = {
    threadId: "caller-thread",
    turnId: "turn",
    rootThreadId: "caller-thread",
    actorProjectId: "project-a",
    libraryId: "library",
    storeEpoch: "epoch",
    admittedAtMs: 1,
  };
  const context = (
    name: string,
    args: Record<string, unknown>,
    override: Partial<WorkbenchAppToolContext> = {},
  ): WorkbenchAppToolContext => ({
    invocation: {
      name,
      arguments: args,
      caller: {
        threadId: "caller-thread",
        turnId: "turn",
        callId: "call",
        hostId: "local",
        generation: 1,
        isActive: () => true,
      },
    },
    principal: {
      profileId: "profile",
      authorityFingerprint: "fingerprint",
      hostId: "local",
      backendGeneration: 1,
    },
    authority,
    isCurrent: Effect.succeed(true),
    ...override,
  });

  const fixture = (
    options: {
      noAnchor?: boolean;
      stale?: boolean;
      targetProject?: string | null;
      cwd?: string;
      runtimeBound?: boolean;
      presentation?: CodexTurnPresentation["Service"];
      executionHostId?: string;
      observedTabs?: readonly ReturnType<typeof browserTab>[];
      browserTabUrls?: Readonly<Record<string, string>>;
      navigateOk?: boolean;
      registered?: readonly WorkbenchWindowReference[];
      lastFocused?: WorkbenchWindowReference | null;
      discovered?: Readonly<
        Record<string, { selected?: "target" | "dock"; sceneOwners?: readonly unknown[] } | "fails">
      >;
    } = {},
  ) => {
    const requests: Array<{ window: WorkbenchWindowReference; body: WorkbenchAgentRequestBody }> =
      [];
    const navigations: unknown[] = [];
    const build = make.pipe(
      Effect.provideService(BrowserApplication, {
        projection: {
          getTab: (identity: { browserTabId: string }) => {
            const url = options.browserTabUrls?.[identity.browserTabId];
            return url ? { url } : null;
          },
        },
        applyCommand: (command: unknown) =>
          Effect.sync(() => {
            navigations.push(command);
            return { ok: options.navigateOk ?? true };
          }),
      } as never),
      Effect.provideService(CoreModules, createAppToolAdmissionFixture().core),
      Effect.provideService(ProjectWorkspace, {
        getThread: (id: string) =>
          Effect.succeed({
            threadId: id,
            sessionId: "caller-session",
            projectId: "project-a",
            executionHostId: options.executionHostId ?? "local",
            cwd: options.cwd ?? "/workspace",
          }),
        getProjectSession: (id: string) =>
          Effect.succeed({
            id,
            projectId: options.targetProject === undefined ? "project-a" : options.targetProject,
            thread: options.runtimeBound ? null : { threadId: "target-thread" },
            executionRef: options.runtimeBound
              ? { runtimeId: "engine", threadId: "engine-thread" }
              : null,
          }),
        getProject: () => Effect.succeed({ primaryWorkspaceRoot: "/workspace", sources: [] }),
      } as never),
      Effect.provideService(
        CodexTurnPresentation,
        options.presentation ??
          ({
            read: () =>
              options.noAnchor
                ? null
                : { ...windowA, ...(options.stale ? { rendererGeneration: "old" } : {}) },
          } as never),
      ),
      Effect.provideService(TerminalSessions, {
        listSnapshotsForOwners: () => Effect.succeed([]),
      } as never),
      Effect.provideService(GitWorkerRuntime, {
        request: () =>
          Effect.succeed({ isGitRepository: true, root: "/workspace", errorMessage: null }),
      } as never),
      Effect.provideService(WorkbenchContentRouting, {
        describe: () => Effect.succeed({ status: "available", title: "Authorized Page" }),
      } as never),
      Effect.provideService(WorkbenchAgentBridge, {
        registered: () => options.registered ?? [windowB, windowA],
        lastFocused: () => options.lastFocused ?? null,
        request: (window: WorkbenchWindowReference, body: WorkbenchAgentRequestBody) =>
          Effect.suspend(() => {
            requests.push({ window, body });
            const discovered = options.discovered?.[window.windowSessionId];
            if (body.kind === "discover" && discovered === "fails")
              return Effect.fail(new WorkbenchAgentBridgeError({ reason: "timeout" }));
            return Effect.succeed(
              (() => {
                if (body.kind === "observe")
                  return {
                    kind: "observe",
                    observation: options.observedTabs
                      ? {
                          presentationRevision: 17,
                          selectedSceneOwner: { kind: "session", sessionId: "caller-session" },
                          tabs: options.observedTabs,
                        }
                      : null,
                  };
                if (body.kind === "discover") {
                  const relation = discovered === "fails" ? undefined : discovered;
                  return {
                    kind: "discover",
                    presentationRevision: 17,
                    selectedSceneOwner:
                      relation?.selected === "target"
                        ? { kind: "session", sessionId: body.sessionId }
                        : relation?.selected === "dock"
                          ? { kind: "project", projectId: "project-a" }
                          : { kind: "library" },
                    sceneOwners:
                      relation?.sceneOwners ??
                      (relation?.selected === "dock"
                        ? [{ kind: "project", projectId: "project-a" }]
                        : []),
                  };
                }
                if (body.kind !== "command") throw new Error("Unexpected presentation request");
                return {
                  kind: "command",
                  receipt: {
                    operationId: body.envelope.operationId,
                    sceneOwner: body.envelope.sceneOwner,
                    applied: true,
                    persisted: true,
                    presentationRevision: 18,
                    layoutRevision: 3,
                    tabId: body.envelope.command.kind === "navigate_session" ? null : "opened",
                    groupId: null,
                    error: null,
                  },
                };
              })(),
            );
          }),
      } as never),
    );
    return { build, requests, navigations };
  };

  it.effect("opens in the Runtime submission window using its exact engine Run coordinates", () =>
    Effect.gen(function* () {
      const subject = fixture({
        presentation: {
          read: (threadId: string, runId: string) =>
            threadId === "engine-thread" && runId === "engine-run" ? windowA : null,
        } as never,
      });
      const execute = yield* subject.build;
      const leased = {
        ...authority,
        threadId: "engine-thread",
        turnId: "engine-run",
        runtime: { sessionId: "caller-session", runtimeId: "runtime", turnKind: "run" as const },
      };
      const caller = createHostedAppToolCaller({
        backend: "codex",
        authority: leased,
        callId: "call",
        generation: 1,
        isActive: () => true,
        capture: Effect.succeed(leased),
        sessionContext: {
          sessionId: "caller-session",
          projectId: "project-a",
          runtimeId: "runtime",
          rootThreadId: "engine-thread",
          threadId: "engine-thread",
          runId: "engine-run",
          cwd: "/workspace",
        },
      });
      const request = context("open_in_nodex", { target: { kind: "page", pageId: "page" } });
      const result = yield* execute({ ...request, invocation: { ...request.invocation, caller } });
      assert.equal(result.structuredContent?.status, "queued");
      assert.isTrue(subject.requests.every((request) => request.window === windowA));
    }),
  );

  it.effect(
    "opens review for a Runtime-bound Session from verified metadata without a legacy Thread",
    () =>
      Effect.gen(function* () {
        const subject = fixture({ runtimeBound: true });
        const reads: unknown[] = [];
        const execute = yield* subject.build.pipe(
          Effect.provideService(AgentRuntimeApplication, {
            inspect: (target: unknown) =>
              Effect.sync(() => {
                reads.push(target);
                return {
                  sessionId: "target",
                  projectId: "project-a",
                  runtimeId: "engine",
                  rootThreadId: "engine-thread",
                  threadId: "engine-thread",
                  thread: { worktreePath: "/workspace" },
                };
              }),
          } as never),
        );
        const result = yield* execute(
          context("open_in_nodex", {
            sessionId: "target",
            window: windowB,
            target: { kind: "review", view: "branch" },
          }),
        );
        assert.strictEqual(result.structuredContent?.status, "queued");
        assert.deepEqual(reads, [{ sessionId: "target" }]);
        const body = subject.requests.at(-1)!.body;
        assert.strictEqual(body.kind, "command");
        if (body.kind !== "command" || body.envelope.command.kind !== "open_surface") return;
        assert.deepEqual(body.envelope.command.reveal, {
          kind: "review",
          threadId: "engine-thread",
          view: "branch",
        });
      }),
  );

  it.effect(
    "opens in the calling Session and submission window even when another window is listed first",
    () =>
      Effect.gen(function* () {
        const subject = fixture();
        const execute = yield* subject.build;
        const result = yield* execute(
          context("open_in_nodex", { target: { kind: "page", pageId: "page" } }),
        );
        assert.strictEqual(result.structuredContent?.status, "queued");
        assert.strictEqual(result.structuredContent?.sessionId, "caller-session");
        assert.strictEqual(result.structuredContent?.url, "nodex://pages/page");
        assert.isTrue(subject.requests.every((request) => request.window === windowA));
        const body = subject.requests.at(-1)!.body;
        assert.strictEqual(body.kind, "command");
        if (body.kind !== "command") return;
        assert.deepEqual(body.envelope.sceneOwner, {
          kind: "session",
          sessionId: "caller-session",
        });
        assert.strictEqual(body.envelope.expectedPresentationRevision, 17);
        assert.strictEqual(body.envelope.command.kind, "open_surface");
      }),
  );

  it.effect(
    "navigates an explicitly authorized projectless Session in an explicit window without substituting its Project",
    () =>
      Effect.gen(function* () {
        const subject = fixture({ targetProject: null });
        const execute = yield* subject.build;
        const result = yield* execute(
          context(
            "navigate_to_session",
            { sessionId: "target", window: windowB, idempotencyKey: "navigation" },
            {
              authority: {
                ...authority,

                actorProjectId: null,
              },
            },
          ),
        );
        assert.strictEqual(result.structuredContent?.status, "navigated");
        assert.strictEqual(result.structuredContent?.url, "nodex://sessions/target");
        assert.deepEqual(subject.requests.at(-1), {
          window: windowB,
          body: {
            kind: "command",
            envelope: {
              operationId: String(result.structuredContent?.operationId),
              sceneOwner: { kind: "session", sessionId: "target" },
              expectedPresentationRevision: 17,
              command: { kind: "navigate_session", projectId: null },
            },
          },
        });
      }),
  );

  it.effect(
    "requires an explicit current window when there is no submission anchor and never falls back after reload",
    () =>
      Effect.gen(function* () {
        const unanchored = fixture({ noAnchor: true });
        const execute = yield* unanchored.build;
        const result = yield* execute(context("navigate_to_session", { sessionId: "target" }));
        assert.deepEqual(result.structuredContent, {
          status: "window_required",
          windows: [windowB, windowA],
        });
        assert.deepEqual(unanchored.requests, []);
        const stale = fixture({ stale: true });
        const staleExecute = yield* stale.build;
        assert.deepEqual(
          (yield* staleExecute(context("navigate_to_session", { sessionId: "target" })))
            .structuredContent,
          { error: { code: "stale_renderer" } },
        );
        assert.deepEqual(stale.requests, []);
      }),
  );

  it.effect("cross-Project presentation is available and withdrawn execution cannot dispatch", () =>
    Effect.gen(function* () {
      const foreign = fixture({ targetProject: "other-project" });
      const open = yield* foreign.build;
      assert.equal(
        (yield* open(context("navigate_to_session", { sessionId: "target" }))).structuredContent
          ?.status,
        "navigated",
      );
      const subject = fixture();
      const execute = yield* subject.build;
      assert.deepEqual(
        (yield* execute(
          context(
            "navigate_to_session",
            { sessionId: "target" },
            { isCurrent: Effect.succeed(false) },
          ),
        )).structuredContent,
        { error: { code: "authority_unavailable" } },
      );
      assert.isFalse(subject.requests.some((request) => request.body.kind === "command"));
    }),
  );

  it.effect(
    "resolves an absolute Review file against the repository root from a nested working directory",
    () =>
      Effect.gen(function* () {
        const subject = fixture({ cwd: "/workspace/packages/app" });
        const execute = yield* subject.build;
        const result = yield* execute(
          context("open_in_nodex", {
            target: { kind: "review", view: "staged", path: "/workspace/src/app.ts" },
          }),
        );
        assert.strictEqual(result.structuredContent?.status, "queued");
        const request = subject.requests.at(-1)!.body;
        assert.strictEqual(request.kind, "command");
        if (request.kind !== "command") return;
        assert.deepInclude(request.envelope.command, {
          kind: "open_surface",
          reveal: { kind: "review", threadId: "target-thread", view: "staged", path: "src/app.ts" },
        });
      }),
  );

  const lastCommand = (subject: ReturnType<typeof fixture>) => {
    const body = subject.requests.at(-1)!.body;
    if (body.kind !== "command") throw new Error("Expected a Workbench command");
    return body.envelope.command;
  };

  const openFile = (target: Record<string, unknown>, args: Record<string, unknown> = {}) =>
    context("open_in_nodex", { target: { kind: "file", ...target }, ...args });

  it.effect("shows a local HTML file rendered in a Browser tab and reports that surface", () =>
    Effect.gen(function* () {
      for (const name of ["report.html", "REPORT.HTM"]) {
        const file = writeWorkspaceFile(name);
        const subject = fixture();
        const execute = yield* subject.build;
        const result = yield* execute(openFile({ path: file.path }));
        assert.deepInclude(result.structuredContent, { surface: "browser", url: file.url });
        const command = lastCommand(subject);
        assert.strictEqual(command.kind, "open_surface");
        if (command.kind !== "open_surface") return;
        assert.strictEqual(command.surface.kind, "browser");
        assert.strictEqual(command.surface.titleSnapshot, name);
        if (command.surface.kind !== "browser") return;
        assert.strictEqual(command.surface.config.url, file.url);
      }
    }),
  );

  it.effect("resolves a relative HTML path against the Session's working directory", () =>
    Effect.gen(function* () {
      const subject = fixture({ cwd: workspaceDirectory });
      const execute = yield* subject.build;
      const result = yield* execute(openFile({ path: "report.html" }));
      assert.deepInclude(result.structuredContent, { surface: "browser", url: report.url });
    }),
  );

  it.effect("a line opens an HTML file's source, and other files stay in Files", () =>
    Effect.gen(function* () {
      const source = fixture();
      const showSource = yield* source.build;
      const sourceResult = yield* showSource(openFile({ path: report.path, line: 3 }));
      assert.strictEqual(sourceResult.structuredContent?.surface, "files");
      assert.isUndefined(sourceResult.structuredContent?.url);
      assert.deepInclude(lastCommand(source), {
        kind: "open_surface",
        reveal: { kind: "file", line: 3 },
      });

      const notes = writeWorkspaceFile("notes.md");
      const plain = fixture();
      const showPlain = yield* plain.build;
      const plainResult = yield* showPlain(openFile({ path: notes.path }));
      assert.strictEqual(plainResult.structuredContent?.surface, "files");
    }),
  );

  it.effect("a directory or missing file named like HTML is unavailable, never a Browser tab", () =>
    Effect.gen(function* () {
      const directory = join(workspaceDirectory, "site.html");
      mkdirSync(directory);
      for (const path of [directory, join(workspaceDirectory, "missing.html")]) {
        const subject = fixture();
        const execute = yield* subject.build;
        const result = yield* execute(openFile({ path }));
        assert.deepEqual(result.structuredContent, { error: { code: "target_unavailable" } });
        assert.isFalse(subject.requests.some((request) => request.body.kind === "command"));
      }
    }),
  );

  it.effect("a remote Session cannot open a local file in the Browser", () =>
    Effect.gen(function* () {
      for (const target of [
        { kind: "file", path: report.path },
        { kind: "browser", url: report.url },
      ]) {
        const subject = fixture({ executionHostId: "remote-host" });
        const execute = yield* subject.build;
        const result = yield* execute(
          context("open_in_nodex", { sessionId: "remote", window: windowA, target }),
        );
        assert.deepEqual(result.structuredContent, { error: { code: "target_unavailable" } });
      }
    }),
  );

  it.effect("reloads the tab already showing the file instead of opening another", () =>
    Effect.gen(function* () {
      const subject = fixture({
        observedTabs: [browserTab("other"), browserTab("showing")],
        browserTabUrls: {
          other: "https://example.com/report.html",
          // Scrolling to a heading keeps the same document.
          showing: `${report.url}#section`,
        },
      });
      const execute = yield* subject.build;
      const result = yield* execute(openFile({ path: report.path }));
      assert.deepEqual(lastCommand(subject), {
        kind: "activate_surface",
        tabId: "browser:showing",
      });
      assert.deepEqual(subject.navigations, [
        {
          type: "navigate",
          browserConversationId: "caller-session",
          browserViewScopeId: windowA.windowSessionId,
          browserTabId: "showing",
          url: report.url,
        },
      ]);
      assert.deepInclude(result.structuredContent, {
        surface: "browser",
        url: report.url,
        reloaded: true,
      });
    }),
  );

  it.effect("reports a reload that failed while keeping the activated tab", () =>
    Effect.gen(function* () {
      const subject = fixture({
        observedTabs: [browserTab("showing")],
        browserTabUrls: { showing: report.url },
        navigateOk: false,
      });
      const execute = yield* subject.build;
      const result = yield* execute(openFile({ path: report.path }));
      assert.strictEqual(lastCommand(subject).kind, "activate_surface");
      assert.strictEqual(result.structuredContent?.reloaded, false);
    }),
  );

  it.effect("an exact retry repeats the command that opened the tab", () =>
    Effect.gen(function* () {
      const options: Parameters<typeof fixture>[0] = {};
      const subject = fixture(options);
      const execute = yield* subject.build;
      const call = openFile({ path: report.path }, { idempotencyKey: "open-report" });
      yield* execute(call);
      const first = lastCommand(subject);
      assert.strictEqual(first.kind, "open_surface");
      if (first.kind !== "open_surface" || first.surface.kind !== "browser") return;
      const { browserTabId } = first.surface.config;
      options.observedTabs = [browserTab(browserTabId)];
      options.browserTabUrls = { [browserTabId]: report.url };
      yield* execute(call);
      assert.deepEqual(lastCommand(subject), first);
      assert.deepEqual(subject.navigations, []);
    }),
  );

  it.effect("opens a new tab when the existing Browser tab left the file", () =>
    Effect.gen(function* () {
      const subject = fixture({
        observedTabs: [browserTab("moved")],
        browserTabUrls: { moved: "https://example.com/" },
      });
      const execute = yield* subject.build;
      yield* execute(openFile({ path: report.path }));
      assert.strictEqual(lastCommand(subject).kind, "open_surface");
      assert.deepEqual(subject.navigations, []);
    }),
  );

  it.effect("a Browser target accepts a local file URL and keeps its query and fragment", () =>
    Effect.gen(function* () {
      const subject = fixture();
      const execute = yield* subject.build;
      const url = `${report.url}?view=compact#section`;
      const result = yield* execute(context("open_in_nodex", { target: { kind: "browser", url } }));
      assert.deepInclude(result.structuredContent, { surface: "browser", url });
    }),
  );

  it.effect("a Browser target refuses a file that is not on this device or does not exist", () =>
    Effect.gen(function* () {
      const subject = fixture();
      const execute = yield* subject.build;
      const invalid = yield* execute(
        context("open_in_nodex", {
          target: { kind: "browser", url: "file://server/share/a.html" },
        }),
      );
      assert.isTrue(invalid.isError);
      assert.isFalse(subject.requests.some((request) => request.body.kind === "command"));
      for (const url of [`${report.url}.missing`, "file:///tmp/encoded%2Fseparator.html"]) {
        const result = yield* execute(
          context("open_in_nodex", { target: { kind: "browser", url } }),
        );
        assert.deepEqual(result.structuredContent, { error: { code: "target_unavailable" } });
      }
    }),
  );

  it.effect("keeps the web in Browser tabs of their own", () =>
    Effect.gen(function* () {
      const subject = fixture({
        observedTabs: [browserTab("showing")],
        browserTabUrls: { showing: "https://example.com/" },
      });
      const execute = yield* subject.build;
      const result = yield* execute(
        context("open_in_nodex", { target: { kind: "browser", url: "https://example.com/" } }),
      );
      assert.strictEqual(lastCommand(subject).kind, "open_surface");
      assert.deepInclude(result.structuredContent, {
        surface: "browser",
        url: "https://example.com/",
      });
    }),
  );

  const selectedWindow = (result: { readonly structuredContent?: Record<string, unknown> }) =>
    result.structuredContent?.window;

  it.effect("without a submission window, opens in the window showing the Session", () =>
    Effect.gen(function* () {
      const subject = fixture({
        noAnchor: true,
        lastFocused: windowB,
        discovered: { "window-a": { selected: "target" } },
      });
      const execute = yield* subject.build;
      const result = yield* execute(openFile({ path: report.path }));
      assert.deepEqual(selectedWindow(result), windowA);
      assert.deepEqual(subject.requests.at(-1)!.window, windowA);
    }),
  );

  it.effect("counts a Session shown in a Project's Agent Dock as showing it", () =>
    Effect.gen(function* () {
      const subject = fixture({
        noAnchor: true,
        lastFocused: windowB,
        discovered: { "window-a": { selected: "dock" } },
      });
      const execute = yield* subject.build;
      assert.deepEqual(selectedWindow(yield* execute(openFile({ path: report.path }))), windowA);
    }),
  );

  it.effect("otherwise prefers a window that has shown the Session, then the focused window", () =>
    Effect.gen(function* () {
      const shownBefore = fixture({
        noAnchor: true,
        lastFocused: windowB,
        discovered: {
          "window-a": { sceneOwners: [{ kind: "session", sessionId: "caller-session" }] },
        },
      });
      const executeShownBefore = yield* shownBefore.build;
      assert.deepEqual(
        selectedWindow(yield* executeShownBefore(openFile({ path: report.path }))),
        windowA,
      );

      const focused = fixture({ noAnchor: true, lastFocused: windowA });
      const executeFocused = yield* focused.build;
      const result = yield* executeFocused(openFile({ path: report.path }));
      assert.deepEqual(selectedWindow(result), windowA);
      assert.strictEqual(result.structuredContent?.status, "queued");
    }),
  );

  it.effect("skips a window that cannot answer and uses the only window open", () =>
    Effect.gen(function* () {
      const unresponsive = fixture({
        noAnchor: true,
        lastFocused: windowB,
        discovered: { "window-b": "fails" },
      });
      const executeUnresponsive = yield* unresponsive.build;
      assert.deepEqual(
        selectedWindow(yield* executeUnresponsive(openFile({ path: report.path }))),
        windowA,
      );

      const single = fixture({ noAnchor: true, registered: [windowB] });
      const executeSingle = yield* single.build;
      assert.deepEqual(
        selectedWindow(yield* executeSingle(openFile({ path: report.path }))),
        windowB,
      );
    }),
  );

  it.effect("a submission window that has gone away chooses again; a named one does not", () =>
    Effect.gen(function* () {
      const implicit = fixture({ stale: true, discovered: { "window-b": { selected: "target" } } });
      const executeImplicit = yield* implicit.build;
      assert.deepEqual(
        selectedWindow(yield* executeImplicit(openFile({ path: report.path }))),
        windowB,
      );

      const named = fixture();
      const executeNamed = yield* named.build;
      assert.deepEqual(
        (yield* executeNamed(
          openFile(
            { path: report.path },
            { window: { windowSessionId: "gone", rendererGeneration: "gone" } },
          ),
        )).structuredContent,
        { error: { code: "stale_renderer" } },
      );
      assert.deepEqual(named.requests, []);
    }),
  );

  it.effect("fails plainly when no window is open", () =>
    Effect.gen(function* () {
      const subject = fixture({ noAnchor: true, registered: [] });
      const execute = yield* subject.build;
      assert.deepEqual((yield* execute(openFile({ path: report.path }))).structuredContent, {
        error: { code: "window_unavailable" },
      });
    }),
  );
});

describe("SessionControlAppTools", () => {
  const errorCode = (result: CallToolResult) =>
    (result.structuredContent?.error as { code?: string } | undefined)?.code;

  const fixture = Effect.gen(function* () {
    const authority: NodexAgentTurnContext = {
      threadId: "caller-child",
      turnId: "run",
      rootThreadId: "caller-root",
      actorProjectId: "caller-project",
      libraryId: "library",
      storeEpoch: "epoch",
      admittedAtMs: yield* Clock.currentTimeMillis,
      runtime: { sessionId: "caller", runtimeId: "engine", turnKind: "run" },
    };
    let active = true;
    let authorized = true;
    let callerBackend: "runtime" | "native" = "runtime";
    let backend: "runtime" | "native" | "draft" = "runtime";
    let hostId = "remote";
    let archived = false;
    let sourceMode = "full-access";
    let sourcePlan = false;
    let targetPlan = false;
    let running = true;
    const calls: Array<{ name: string; input: unknown }> = [];
    const receipts = new Map<string, { fingerprint: string; resultJson: string | null }>();
    const record = (name: string, input: unknown) => calls.push({ name, input });
    const makeCaller = (turnId = "run") =>
      createHostedAppToolCaller({
        backend: "claude",
        authority: { ...authority, turnId },
        callId: turnId,
        generation: 1,
        isActive: () => active,
        capture: Effect.succeed({ ...authority, turnId }),
        sessionContext: {
          sessionId: "caller",
          projectId: "caller-project",
          runtimeId: "engine",
          rootThreadId: "caller-root",
          threadId: "caller-child",
          runId: turnId,
          cwd: "/repo",
        },
      });
    let caller = makeCaller();
    const nativeCaller = {
      threadId: "caller-native",
      turnId: "turn",
      callId: "native-call",
      hostId: "local",
      generation: 1,
      isActive: () => active,
    };
    const execute = yield* makeWithCapture((calling) =>
      Effect.sync(() => (authorized ? { ...authority, turnId: calling.turnId } : null)),
    ).pipe(
      Effect.provideService(CoreAuthority, { identity: { profileId: "profile" } } as never),
      Effect.provideService(CoreModules, {
        workspace: {
          admitToolOperation: createAppToolAdmissionFixture(authority.admittedAtMs)
            .admitToolOperation,
          read: (input: { session_id: string; provenance: unknown }) =>
            Effect.gen(function* () {
              assert.isNotNull(yield* CoreApplicationAgent);
              const isCaller = input.session_id === "caller";
              record("authorize", input);
              return {
                value: {
                  kind: "agent_session",
                  session: {
                    id: input.session_id,
                    project_id: isCaller ? "caller-project" : "other-project",
                    archived: !isCaller && archived,
                    execution_ref: (isCaller ? callerBackend === "runtime" : backend === "runtime")
                      ? {
                          runtime_id: "engine",
                          thread_id: isCaller ? "caller-root" : "target-root",
                        }
                      : null,
                  },
                  thread: (isCaller ? callerBackend === "native" : backend === "native")
                    ? {
                        thread_id: isCaller ? "caller-native" : "target-native",
                        execution_host_id: isCaller ? "local" : hostId,
                        backend_binding: { driver: "codex", instanceId: "codex" },
                      }
                    : null,
                },
              };
            }),
        },
      } as never),
      Effect.provideService(ProjectWorkspace, {
        getThread: () =>
          Effect.succeed({
            sessionId: "caller",
            executionHostId: "local",
            projectId: "caller-project",
            cwd: "/repo",
          }),
        getProjectSession: (id: string) =>
          Effect.sync(() => ({
            id,
            archived: id !== "caller" && archived,
            thread: {
              threadId: id === "caller" ? "caller-native" : "target-native",
              executionHostId: id === "caller" ? "local" : hostId,
              backendBinding: { driver: "codex", instanceId: "codex" },
            },
          })),
        setProjectSessionSnooze: (input: {
          payload: { sessionId: string; snoozedUntil: string | null };
        }) =>
          Effect.sync(() => {
            record("core-snooze", input);
            return {
              value: { snoozedUntil: input.payload.snoozedUntil },
              apply: { receipt: "core-receipt" },
            };
          }),
        setProjectSessionSettled: (input: unknown) =>
          Effect.gen(function* () {
            assert.isNotNull(yield* CoreApplicationAgent);
            record("core-settlement", input);
            return { value: { changedSessionIds: ["target"] }, apply: { receipt: "core-receipt" } };
          }),
        markProjectSessionUnread: (input: { payload: { sessionId: string; unread: boolean } }) =>
          Effect.sync(() => {
            record("core-unread", input);
            return { value: { unread: input.payload.unread }, apply: { receipt: "core-receipt" } };
          }),
      } as never),
      Effect.provideService(CodexThreadDirectory, {
        resolve: ({ threadId }: { threadId: string }) =>
          Effect.sync(() => ({
            canonical: {
              hostId: threadId === "caller-native" ? "local" : hostId,
              currentPermissions: {
                sandboxPolicy: { type: "dangerFullAccess" },
                approvalPolicy: "never",
                approvalsReviewer: "user",
              },
              latestThreadSettings: {
                model: "model",
                collaborationMode: {
                  mode:
                    threadId === "caller-native"
                      ? sourcePlan
                        ? "plan"
                        : "default"
                      : targetPlan
                        ? "plan"
                        : "default",
                },
                approvalPolicy: "never",
                sandboxPolicy: { type: "dangerFullAccess" },
              },
            },
          })),
      } as never),
      Effect.provideService(CodexThreadReadState, {
        set: (input: unknown) =>
          Effect.sync(() => {
            record("native-unread", input);
            return true;
          }),
      } as never),
      Effect.provideService(CodexMainConversationManagers, {
        get: () =>
          Effect.succeed({
            generation: 1,
            assertCurrent: () => {},
            stream: { getRole: () => ({ role: "owner" }) },
          }),
      } as never),
      Effect.provideService(CodexMainConversationResume, {} as never),
      Effect.provideService(CodexMainConversationInterrupt, {
        interrupt: (host: string, threadId: string, mode: string) =>
          Effect.sync(() => {
            record("native-stop", { host, threadId, mode });
            const result = { interruptedTurnId: running ? "turn" : null };
            running = false;
            return result;
          }),
      } as never),
      Effect.provideService(CodexQueuedFollowUps, {
        controlAsOwner: (_host: string, _threadId: string, input: unknown) =>
          Effect.sync(() => {
            record("native-queue", input);
            return { sequence: 1 };
          }),
      } as never),
      Effect.provideService(CodexTurnCommands, {} as never),
      Effect.provideService(AgentRuntimeApplication, {
        inspect: (input: { sessionId: string; threadId?: string }) =>
          Effect.gen(function* () {
            if (input.threadId === "unrelated") return yield* denied("forbidden");
            return {
              sessionId: input.sessionId,
              threadId:
                input.threadId ?? (input.sessionId === "caller" ? "caller-root" : "target-root"),
              thread: {
                runtimeMode: input.sessionId === "caller" ? sourceMode : "full-access",
                interactionMode: (input.sessionId === "caller" ? sourcePlan : targetPlan)
                  ? "plan"
                  : "default",
                modelSelection: { instanceId: "claude", model: "model" },
              },
            };
          }),
        sessionControlReceipt: (input: {
          operationId: string;
          fingerprint: string;
          resultJson?: string;
        }) =>
          Effect.gen(function* () {
            const previous = receipts.get(input.operationId);
            if (previous && previous.fingerprint !== input.fingerprint)
              return yield* denied("operation_conflict");
            if (input.resultJson !== undefined) {
              receipts.set(input.operationId, {
                fingerprint: input.fingerprint,
                resultJson: input.resultJson,
              });
              return { admitted: false, resultJson: input.resultJson };
            }
            if (previous) return { admitted: false, resultJson: previous.resultJson };
            receipts.set(input.operationId, { fingerprint: input.fingerprint, resultJson: null });
            return { admitted: true, resultJson: null };
          }),
        stopSession: (input: unknown) =>
          Effect.sync(() => {
            record("runtime-stop", input);
            const stopped = running;
            running = false;
            return { threadId: "target-root", stopped };
          }),
        controlSessionQueue: (input: unknown) =>
          Effect.sync(() => {
            record("runtime-queue", input);
            return { sequence: 1 };
          }),
      } as never),
    );
    return {
      calls,
      receipts,
      nextTurn: () => {
        caller = makeCaller("later-turn");
      },
      execute: (name: string, args: Record<string, unknown>) =>
        execute({
          caller: callerBackend === "runtime" ? caller : nativeCaller,
          name,
          arguments: args,
        }),
      setBackend: (next: typeof backend) => {
        backend = next;
      },
      setHost: (next: string) => {
        hostId = next;
      },
      setArchived: () => {
        archived = true;
      },
      setCallerBackend: () => {
        callerBackend = "native";
      },
      setSourceMode: (next: string) => {
        sourceMode = next;
      },
      setPlan: (source: boolean, target = false) => {
        sourcePlan = source;
        targetPlan = target;
      },
      withdraw: () => {
        active = false;
      },
      deny: () => {
        authorized = false;
      },
      idle: () => {
        running = false;
      },
    };
  });

  it.effect.each(["runtime", "native"] as const)(
    "stops %s work once across retries, preserving the stopped result",
    (backend) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setBackend(backend);
        const args = {
          sessionId: "other-project-session",
          reason: "User cancelled the task",
          idempotencyKey: "stop",
        };
        const result = yield* f.execute("stop_session", args);
        assert.deepEqual(result.structuredContent, {
          operationId: result.structuredContent?.operationId,
          sessionId: args.sessionId,
          threadId: backend === "runtime" ? "target-root" : "target-native",
          status: "stop_requested",
        });
        f.nextTurn();
        assert.deepEqual(yield* f.execute("stop_session", args), result);
        const calls = f.calls.filter((call) => call.name === `${backend}-stop`);
        assert.lengthOf(calls, 1);
        if (backend === "runtime")
          assert.equal(
            (calls[0]!.input as { reason: string }).reason,
            "Stopped by another agent: User cancelled the task",
          );
      }),
  );

  it.effect(
    "native callers can stop Runtime Sessions and local native Stop stays with its owner",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setCallerBackend();
        assert.isNotTrue((yield* f.execute("stop_session", { sessionId: "target" })).isError);
        f.setBackend("native");
        f.setHost("local");
        assert.isNotTrue(
          (yield* f.execute("stop_session", {
            sessionId: "target",
            idempotencyKey: "local",
          })).isError,
        );
        assert.lengthOf(
          f.calls.filter((call) => call.name === "native-stop"),
          1,
        );
      }),
  );

  it.effect.each(["runtime", "native", "draft"] as const)(
    "reports idle %s Sessions without creating execution",
    (backend) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setBackend(backend);
        f.idle();
        const result = yield* f.execute("stop_session", { sessionId: "target" });
        assert.equal(result.structuredContent?.status, "idle");
      }),
  );

  it.effect("rejects the calling Session, including its selected Runtime child", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      for (const execution of [undefined, { threadId: "caller-child" }]) {
        const result = yield* f.execute("stop_session", {
          sessionId: "caller",
          ...(execution ? { execution } : {}),
        });
        assert.equal(errorCode(result), "cannot_stop_calling_session");
      }
      assert.isEmpty(f.calls);
    }),
  );

  it.effect.each(["stop_session", "session_queue"])(
    "enforces live authority, archive state and permission ceilings for %s",
    (name) =>
      Effect.gen(function* () {
        const args =
          name === "stop_session"
            ? { sessionId: "target" }
            : { sessionId: "target", action: "list" };
        const mode = yield* fixture;
        mode.setSourceMode("approval-required");
        assert.equal(errorCode(yield* mode.execute(name, args)), "runtime_mode_escalation_denied");
        const plan = yield* fixture;
        plan.setPlan(true);
        assert.equal(
          errorCode(yield* plan.execute(name, args)),
          "interaction_mode_escalation_denied",
        );
        const archived = yield* fixture;
        archived.setArchived();
        assert.equal(errorCode(yield* archived.execute(name, args)), "session_unavailable");
        const unauthorized = yield* fixture;
        unauthorized.deny();
        assert.equal(errorCode(yield* unauthorized.execute(name, args)), "authority_unavailable");
        const withdrawn = yield* fixture;
        withdrawn.withdraw();
        assert.equal(errorCode(yield* withdrawn.execute(name, args)), "call_withdrawn");
      }),
  );

  it.effect(
    "uses the sidebar's Core and identity read-state paths, with exact retry receipts",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const args = { unread: true, idempotencyKey: "unread" };
        const result = yield* f.execute("set_session_unread", args);
        assert.equal(result.structuredContent?.sessionId, "caller");
        assert.deepEqual(yield* f.execute("set_session_unread", args), result);
        assert.lengthOf(
          f.calls.filter((call) => call.name === "core-unread"),
          1,
        );
        f.setBackend("native");
        yield* f.execute("set_session_unread", {
          sessionId: "target",
          unread: false,
          idempotencyKey: "read-native",
        });
        assert.deepEqual(f.calls.find((call) => call.name === "native-unread")?.input, {
          threadId: "target-native",
          hasUnreadTurn: false,
        });
        f.setBackend("draft");
        yield* f.execute("set_session_unread", {
          sessionId: "target",
          unread: true,
          idempotencyKey: "draft-unread",
        });
        assert.lengthOf(
          f.calls.filter((call) => call.name === "core-unread"),
          2,
        );
      }),
  );

  it.effect.each(["runtime", "native"] as const)(
    "routes %s queue actions and fences retries and unrelated children",
    (backend) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.setBackend(backend);
        for (const action of ["list", "read", "edit", "remove", "reorder", "steer"]) {
          const args = {
            sessionId: "target",
            action,
            ...(action === "list" ? {} : { queuedId: "queued" }),
            ...(action === "edit" ? { text: "replacement" } : {}),
            ...(action === "reorder" ? { beforeId: null } : {}),
            ...(["list", "read"].includes(action) ? {} : { idempotencyKey: action }),
          };
          const result = yield* f.execute("session_queue", args);
          assert.isNotTrue(result.isError);
          if (!["list", "read"].includes(action))
            assert.deepEqual(yield* f.execute("session_queue", args), result);
        }
        assert.lengthOf(
          f.calls.filter((call) => call.name === `${backend}-queue`),
          6,
        );
        if (backend === "runtime")
          assert.equal(
            errorCode(
              yield* f.execute("session_queue", {
                action: "list",
                sessionId: "target",
                execution: { threadId: "unrelated" },
              }),
            ),
            "forbidden",
          );
      }),
  );

  it.effect("returns unsupported for unavailable queues and refuses changed retry arguments", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setBackend("native");
      f.setHost("local");
      assert.equal(
        errorCode(yield* f.execute("session_queue", { sessionId: "target", action: "list" })),
        "unsupported",
      );
      const args = { sessionId: "target", idempotencyKey: "same" };
      yield* f.execute("stop_session", args);
      assert.equal(
        errorCode(yield* f.execute("stop_session", { ...args, reason: "changed" })),
        "idempotency_key_reused",
      );
    }),
  );

  it.effect("carries the admission ceiling to Runtime queue and Stop controls", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.execute("session_queue", {
        sessionId: "target",
        action: "edit",
        queuedId: "queued",
        text: "replacement",
      });
      yield* f.execute("stop_session", { sessionId: "target" });
      for (const name of ["runtime-queue", "runtime-stop"]) {
        const input = f.calls.find((call) => call.name === name)?.input as { modeLimit?: unknown };
        assert.deepEqual(input.modeLimit, {
          runtimeMode: "full-access",
          interactionMode: "default",
        });
      }
    }),
  );

  it.effect(
    "snoozes, wakes and exactly replays those commands for Runtime, native and draft Sessions",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        for (const backend of ["runtime", "native", "draft"] as const) {
          f.setBackend(backend);
          for (const snoozedUntil of ["2026-11-02T09:00:00.000Z", null]) {
            const args = {
              sessionId: "target",
              until: snoozedUntil,
              idempotencyKey: `${backend}-${snoozedUntil}`,
            };
            const first = yield* f.execute("set_session_snooze", args);
            assert.equal(first.structuredContent?.snoozedUntil, snoozedUntil);
            f.nextTurn();
            assert.deepEqual(yield* f.execute("set_session_snooze", args), first);
          }
        }
        assert.lengthOf(
          f.calls.filter((call) => call.name === "core-snooze"),
          6,
        );
        assert.lengthOf(
          f.calls.filter((call) => call.name === "native-unread" || call.name === "core-unread"),
          0,
        );
      }),
  );

  it.effect("settles a batch through Core and returns the exact changed ids on retry", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const args = {
        sessionIds: ["target", "already-settled"],
        settled: true,
        idempotencyKey: "batch",
      };
      const first = yield* f.execute("set_session_settled", args);
      assert.deepEqual(first.structuredContent?.changedSessionIds, ["target"]);
      f.nextTurn();
      assert.deepEqual(yield* f.execute("set_session_settled", args), first);
      assert.deepEqual(
        f.calls.filter((call) => call.name === "core-settlement"),
        [
          {
            name: "core-settlement",
            input: {
              operationId: first.structuredContent?.operationId,
              payload: { sessionIds: args.sessionIds, settled: true },
            },
          },
        ],
      );
      const invalid = yield* f.execute("set_session_settled", {
        sessionIds: ["target", "target"],
        settled: false,
      });
      assert.isTrue(invalid.isError);
    }),
  );
});
