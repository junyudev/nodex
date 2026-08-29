import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { CodexProjectSessionFork } from "../../codex-application/CodexProjectSessionFork";
import { CodexSidebarSectionSync } from "../../codex-application/CodexSidebarSectionSync";
import { CodexThreadTitlePersistence } from "../../codex-application/CodexThreadTitlePersistence";
import { ConversationCommands } from "../../codex-application/ConversationCommands";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { BrowserApplication } from "../../browser-application/BrowserApplication";
import { ProjectLifecycleCommands } from "../../project-application/ProjectLifecycleCommands";
import {
  ProjectWorkspace,
  type ProjectWorkspaceService,
} from "../../project-application/ProjectWorkspace";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./ProjectWorkspaceIpc";

type Handler = (event: IpcMainInvokeEvent, ...args: readonly unknown[]) => Effect.Effect<unknown>;

it.effect("owns Project and Project Session ingress with the Main Scope", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const ipc = ElectronIpc.of({
      handle: (channel: string, handler: Handler) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            handlers.set(channel, handler);
          }),
          () => Effect.sync(() => handlers.delete(channel)),
        ),
      on: () => Effect.die("unused"),
    } as unknown as ElectronIpc["Service"]);
    const workspace = ProjectWorkspace.of({} as ProjectWorkspaceService);
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ProjectWorkspace, workspace),
            Layer.succeed(
              CodexThreadTitlePersistence,
              CodexThreadTitlePersistence.of({
                set: () => Effect.die("unused"),
                setRequired: () => Effect.die("unused"),
              }),
            ),
            Layer.succeed(
              ConversationCommands,
              ConversationCommands.of({
                archive: () => Effect.die("unused"),
                unarchive: () => Effect.die("unused"),
                setMemoryMode: () => Effect.die("unused"),
                startReview: () => Effect.die("unused"),
                uploadFeedback: () => Effect.die("unused"),
                listBackgroundTerminalsPage: () => Effect.die("unused"),
                listBackgroundTerminals: () => Effect.die("unused"),
                terminateBackgroundTerminal: () => Effect.die("unused"),
                interrupt: () => Effect.die("unused"),
                cleanBackgroundTerminals: () => Effect.die("unused"),
                cleanBackgroundTerminalsSilently: () => Effect.die("unused"),
              }),
            ),
            Layer.succeed(ElectronIpc, ipc),
            Layer.succeed(
              CodexProjectSessionFork,
              CodexProjectSessionFork.of({ fork: () => Effect.die("unused") }),
            ),
            Layer.succeed(
              CodexSidebarSectionSync,
              CodexSidebarSectionSync.of({
                request: () => Effect.void,
                syncHost: () => Effect.die("unused"),
                syncAll: () => Effect.succeed([]),
              }),
            ),
            Layer.succeed(BrowserApplication, {
              closeConversation: () => Effect.void,
              localServers: { closeProject: () => Effect.void },
            } as unknown as BrowserApplication["Service"]),
            mainConfigLayer(),
            Layer.succeed(
              ProjectLifecycleCommands,
              ProjectLifecycleCommands.of({ setLifecycle: () => Effect.die("unused") }),
            ),
            Layer.succeed(ElectronDesktop, { dialog: {} } as unknown as ElectronDesktop["Service"]),
            Layer.succeed(WindowRuntime, {
              has: () => true,
            } as unknown as WindowRuntime["Service"]),
          ),
        ),
      ),
      scope,
    );

    assert.strictEqual(handlers.size, 43);
    assert.isTrue(handlers.has("projects:create"));
    assert.isTrue(handlers.has("project-sessions:fork"));
    assert.isTrue(handlers.has("project-session-threads:detach"));
    assert.isTrue(handlers.has("page-chats:activity-summaries"));
    assert.isTrue(handlers.has("page-chats:list"));
    assert.isTrue(handlers.has("page-chats:link"));
    assert.isTrue(handlers.has("page-chats:unlink"));

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(handlers.size, 0);
  }),
);
