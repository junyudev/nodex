import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { isBoundedOperationId } from "../../shared/operation-identity";
import { UpdateInboxSettingsInputSchema } from "../../shared/schemas/inbox";
import { rendererLocalCommitApply } from "../core-client/types";
import { CoreModules } from "../core-runtime/CoreModules";
import { ElectronIpc } from "../platform/electron/ElectronIpc";
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
    const read = Effect.gen(function* () {
      return {
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
  }),
);
