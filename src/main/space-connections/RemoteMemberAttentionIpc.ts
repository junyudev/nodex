import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DEFAULT_INBOX_SETTINGS, type InboxSettings } from "../../shared/inbox";
import { isBoundedOperationId } from "../../shared/operation-identity";
import { UpdateInboxSettingsInputSchema } from "../../shared/schemas/inbox";
import { rendererLocalCommitApply } from "../core-client/types";
import { CoreModules } from "../core-runtime/CoreModules";
import {
  readRoutingConsent,
  writeRoutingConsent,
} from "../../host/inbox-application/InboxRoutingConsent";
import { ElectronIpc } from "../platform/electron/ElectronIpc";
import { makeRemoteHostCall } from "./remote-host-call";
import {
  ProjectWorkspace,
  type ProjectWorkspaceCommandResult,
} from "../project-application/ProjectWorkspace";

/** Acquired inside the authenticated Space graph, after sender/envelope validation.
 * Core derives the Member for every read and write; no device preference substitutes for it. */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const ipc = yield* ElectronIpc;
    const core = yield* CoreModules;
    const projects = yield* ProjectWorkspace;
    const host = yield* makeRemoteHostCall;
    // The host chooses what its Inbox runs on; whether a Member's own requests start on their own
    // is that Member's consent, kept in Core. A window never shows its desktop's values for either.
    const read = Effect.gen(function* () {
      const [settings, start] = yield* Effect.all(
        [
          host<InboxSettings>("inbox_settings", {}),
          readRoutingConsent(core, DEFAULT_INBOX_SETTINGS),
        ],
        { concurrency: 2 },
      );
      return {
        ...settings,
        dispatchMode: start ? ("act_on_requests" as const) : ("suggest" as const),
      };
    });
    yield* ipc.handleQuery("settings:inbox:get", () => read);
    yield* ipc.handlePlainCommand("settings:inbox:update", (_, input) =>
      Effect.gen(function* () {
        const parsed = yield* Effect.try(() => UpdateInboxSettingsInputSchema.parse(input));
        if (Object.keys(parsed).some((key) => key !== "dispatchMode"))
          return yield* Effect.fail(new Error("Inbox execution settings run on the Space host"));
        if (parsed.dispatchMode !== undefined)
          yield* writeRoutingConsent(core, parsed.dispatchMode === "act_on_requests");
        return yield* read;
      }),
    );
    // A chat's unread state, pins and reminders are each Member's own, on every chat they read.
    const own = <Value>(
      command: { readonly operationId: string },
      task: Effect.Effect<ProjectWorkspaceCommandResult<Value>, unknown>,
    ) =>
      Effect.gen(function* () {
        if (!isBoundedOperationId(command.operationId))
          return yield* Effect.fail(new Error("Workspace catalog operation identity is invalid"));
        const { value, apply } = yield* task;
        return { ok: true as const, value, localCommit: rendererLocalCommitApply(apply) };
      });
    yield* ipc.handleLocalCommitCommand("project-sessions:mark-unread", (_, command) =>
      own(command, projects.markProjectSessionUnread(command)),
    );
    yield* ipc.handleLocalCommitCommand("project-sessions:set-pinned", (_, command) =>
      own(command, projects.setProjectSessionPinned(command)),
    );
    yield* ipc.handleLocalCommitCommand("project-sessions:set-pinned-order", (_, command) =>
      own(command, projects.setPinnedProjectSessionOrder(command)),
    );
    yield* ipc.handleLocalCommitCommand("project-sessions:set-reminder", (_, command) =>
      own(command, projects.setProjectSessionReminder(command)),
    );
    // A New chat opens the Member's own default draft, which no one else lists or starts; its
    // first message starts it on the Space host.
    yield* ipc.handleLocalCommitCommand("project-sessions:ensure-default-draft", (_, command) =>
      own(command, projects.ensureDefaultDraftProjectSession(command)),
    );
  }),
);
