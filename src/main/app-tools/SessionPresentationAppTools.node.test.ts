import { createAppToolAdmissionFixture } from "./app-tool-operation.test-fixtures";
import { CoreModules } from "../core-runtime/CoreModules";
import { assert, it } from "@effect/vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as Effect from "effect/Effect";
import { afterAll } from "vite-plus/test";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import type {
  WorkbenchAgentRequestBody,
  WorkbenchWindowReference,
} from "../../shared/nodex-app-tools/workbench";
import { CodexTurnPresentation } from "../codex-application/CodexTurnPresentation";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import { GitWorkerRuntime } from "../host-runtime/GitWorkerRuntime";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { BrowserApplication } from "../browser-application/BrowserApplication";
import { WorkbenchAgentBridge } from "./WorkbenchAgentBridge";
import { WorkbenchContentRouting } from "./WorkbenchContentRouting";
import { make } from "./SessionPresentationAppTools";
import type { WorkbenchAppToolContext } from "./WorkbenchControl";
import { createHostedAppToolCaller } from "./AppToolCaller";

const windowA = { windowSessionId: "window-a", rendererGeneration: "generation-a" };
const windowB = { windowSessionId: "window-b", rendererGeneration: "generation-b" };
const workspaceDirectory = realpathSync(mkdtempSync(join(tmpdir(), "nodex-open-in-nodex-")));
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
  } = {},
) => {
  const requests: Array<{ window: WorkbenchWindowReference; body: WorkbenchAgentRequestBody }> = [];
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
      registered: () => [windowB, windowA],
      request: (window: WorkbenchWindowReference, body: WorkbenchAgentRequestBody) =>
        Effect.sync(() => {
          requests.push({ window, body });
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
          if (body.kind === "discover")
            return {
              kind: "discover",
              presentationRevision: 17,
              selectedSceneOwner: { kind: "library" },
              sceneOwners: [],
            };
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
      assert.isTrue(subject.requests.every((request) => request.window === windowA));
      const body = subject.requests.at(-1)!.body;
      assert.strictEqual(body.kind, "command");
      if (body.kind !== "command") return;
      assert.deepEqual(body.envelope.sceneOwner, { kind: "session", sessionId: "caller-session" });
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
      context("open_in_nodex", { target: { kind: "browser", url: "file://server/share/a.html" } }),
    );
    assert.isTrue(invalid.isError);
    assert.isFalse(subject.requests.some((request) => request.body.kind === "command"));
    for (const url of [`${report.url}.missing`, "file:///tmp/encoded%2Fseparator.html"]) {
      const result = yield* execute(context("open_in_nodex", { target: { kind: "browser", url } }));
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
