import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import type {
  WorkbenchAgentRequestBody,
  WorkbenchWindowReference,
} from "../../shared/nodex-app-tools/workbench";
import { CodexTurnPresentation } from "../codex-application/CodexTurnPresentation";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import { GitWorkerRuntime } from "../host-runtime/GitWorkerRuntime";
import { WorkbenchAgentBridge } from "./WorkbenchAgentBridge";
import { WorkbenchContentAccess } from "./WorkbenchContentAccess";
import { make } from "./SessionPresentationAppTools";
import type { WorkbenchAppToolContext } from "./WorkbenchControl";

const windowA = { windowSessionId: "window-a", rendererGeneration: "generation-a" };
const windowB = { windowSessionId: "window-b", rendererGeneration: "generation-b" };
const authority: FrozenNodexAgentTurnAuthority = {
  threadId: "caller-thread",
  turnId: "turn",
  rootThreadId: "caller-thread",
  actorProjectId: "project-a",
  libraryId: "library",
  storeEpoch: "epoch",
  frozenAtMs: 1,
  scope: "project",
  source: "project_turn",
  readOnly: false,
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
  } = {},
) => {
  const requests: Array<{ window: WorkbenchWindowReference; body: WorkbenchAgentRequestBody }> = [];
  const build = make.pipe(
    Effect.provideService(ProjectWorkspace, {
      getThread: (id: string) =>
        Effect.succeed({
          threadId: id,
          sessionId: "caller-session",
          projectId: "project-a",
          executionHostId: "local",
          cwd: options.cwd ?? "/workspace",
        }),
      getProjectSession: (id: string) =>
        Effect.succeed({
          id,
          projectId: options.targetProject === undefined ? "project-a" : options.targetProject,
          thread: { threadId: "target-thread" },
        }),
      getProject: () => Effect.succeed({ primaryWorkspaceRoot: "/workspace", sources: [] }),
    } as never),
    Effect.provideService(CodexTurnPresentation, {
      read: () =>
        options.noAnchor
          ? null
          : { ...windowA, ...(options.stale ? { rendererGeneration: "old" } : {}) },
    } as never),
    Effect.provideService(TerminalSessions, {
      listSnapshotsForOwners: () => Effect.succeed([]),
    } as never),
    Effect.provideService(GitWorkerRuntime, {
      request: () =>
        Effect.succeed({ isGitRepository: true, root: "/workspace", errorMessage: null }),
    } as never),
    Effect.provideService(WorkbenchContentAccess, {
      describe: () => Effect.succeed({ status: "authorized", title: "Authorized Page" }),
    } as never),
    Effect.provideService(WorkbenchAgentBridge, {
      registered: () => [windowB, windowA],
      request: (window: WorkbenchWindowReference, body: WorkbenchAgentRequestBody) =>
        Effect.sync(() => {
          requests.push({ window, body });
          if (body.kind === "observe") return { kind: "observe", observation: null };
          if (body.kind === "discover")
            return {
              kind: "discover",
              presentationRevision: 17,
              selectedSceneOwner: { kind: "pages" },
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
  return { build, requests };
};

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
          { sessionId: "target", window: windowB, operationId: "navigation" },
          {
            authority: {
              ...authority,
              scope: "library",
              source: "builtin_full_access",
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
            operationId: "navigation",
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

it.effect(
  "checks Project access, Plan Mode and current Turn before issuing presentation changes",
  () =>
    Effect.gen(function* () {
      const foreign = fixture({ targetProject: "other-project" });
      const executeForeign = yield* foreign.build;
      assert.deepEqual(
        (yield* executeForeign(context("navigate_to_session", { sessionId: "target" })))
          .structuredContent,
        { error: { code: "session_unavailable" } },
      );
      assert.deepEqual(foreign.requests, []);
      const subject = fixture();
      const execute = yield* subject.build;
      assert.deepEqual(
        (yield* execute(
          context(
            "navigate_to_session",
            { sessionId: "target" },
            { authority: { ...authority, readOnly: true } },
          ),
        )).structuredContent,
        { error: { code: "read_only_turn" } },
      );
      assert.deepEqual(subject.requests, []);
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
