import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { randomUUID } from "node:crypto";
import { buildSessionDeepLink } from "../../shared/nodex-deeplink";
import { getWorkbenchSceneReturnLocation } from "../../shared/workbench-layout";
import { AgentRuntimeSessionActivity } from "../agent-runtime/AgentRuntimeSessionActivity";
import { MainConfig } from "../app/MainConfig";
import { AutomationApplication } from "../automation-application/AutomationApplication";
import { ChatSearch } from "../chat-search/ChatSearch";
import { getLogger } from "../logging/logger";
import { ElectronApp } from "../platform/electron/ElectronApp";
import { ElectronDesktop } from "../platform/electron/ElectronDesktop";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { ApplicationWindowRuntime } from "../window-runtime/ApplicationWindowRuntime";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import { windowsTrayChatGroups, windowsQuitWarning } from "../windows-desktop-policy";
import { DeepLinkRuntime } from "./DeepLinkRuntime";
import { WindowsTrayRuntime } from "./WindowsTrayRuntime";

export class WindowsTrayIntegration extends Context.Service<
  WindowsTrayIntegration,
  {
    readonly confirmQuit: Effect.Effect<boolean>;
  }
>()("nodex/main/host-runtime/WindowsTrayIntegration") {}

/** Native tray actions borrow the same Workspace, chat catalog and navigation owners as Desktop. */
export const live = Layer.effect(
  WindowsTrayIntegration,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const tray = yield* WindowsTrayRuntime;
    const windows = yield* WindowRuntime;
    const applicationWindows = yield* ApplicationWindowRuntime;
    const links = yield* DeepLinkRuntime;
    const workspace = yield* ProjectWorkspace;
    const chats = yield* ChatSearch;
    const activity = yield* AgentRuntimeSessionActivity;
    const automations = yield* AutomationApplication;
    const desktop = yield* ElectronDesktop;
    const electron = yield* ElectronApp;
    const logger = getLogger({ component: "windows-tray" });

    const confirmQuit =
      config.platform !== "win32"
        ? Effect.succeed(true)
        : Effect.gen(function* () {
            const live = yield* activity.read;
            const scheduled = yield* automations.automations.list();
            const warning = windowsQuitWarning({
              activeChats:
                live.items.some(
                  (item) =>
                    item.activeRunId !== null ||
                    item.pendingRequestCount > 0 ||
                    item.backgroundTasks.length > 0,
                ) || !live.complete,
              scheduledTasks: scheduled.some((definition) => definition.status === "ACTIVE"),
            });
            if (!warning) return true;
            const { response } = yield* desktop.showMessage({
              type: "warning",
              title: "Quit Nodex?",
              message: "Quit Nodex?",
              detail: warning,
              buttons: ["Quit", "Cancel"],
              defaultId: 0,
              cancelId: 1,
              noLink: true,
            });
            return response === 0;
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                logger.error("Could not confirm application quit", { cause });
                // A failed observation or native dialog must not make Quit unavailable.
                return true;
              }),
            ),
          );

    yield* tray.actions.pipe(
      Stream.runForEach((action) =>
        Effect.gen(function* () {
          if (action.kind === "open") return yield* Effect.sync(applicationWindows.focusLast);
          if (action.kind === "quit") return yield* electron.quit;
          if (action.kind === "chat") {
            yield* links.handle(buildSessionDeepLink({ sessionId: action.sessionId }));
            return;
          }
          if (action.kind === "new-chat") {
            const window = windows.getLastFocused();
            const location = window
              ? getWorkbenchSceneReturnLocation(
                  windows.bootstrap(window.webContents.id).layout.location,
                )
              : null;
            const projectId =
              location?.kind === "project"
                ? location.projectId
                : location?.kind === "session"
                  ? location.projectContextId
                  : null;
            const { value } = yield* workspace.ensureDefaultDraftProjectSession({
              operationId: randomUUID(),
              payload: { candidateSessionId: randomUUID(), projectId },
            });
            yield* links.handle(buildSessionDeepLink({ sessionId: value.id }));
            return;
          }
          const catalog = yield* chats.search({ query: "", limit: 60 });
          yield* tray.showMenu(windowsTrayChatGroups(catalog.matches.map(({ chat }) => chat)));
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              logger.warn("Notification-area action failed", { action: action.kind, cause });
              if (action.kind === "menu") yield* tray.showMenu([]);
            }),
          ),
        ),
      ),
      Effect.forkScoped,
    );
    return WindowsTrayIntegration.of({ confirmQuit });
  }),
);
