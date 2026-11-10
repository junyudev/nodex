import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import type { components } from "@nodex/core-protocol";
import type { IpcApi } from "../../shared/ipc-api";
import { CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { ElectronIpc } from "../platform/electron/ElectronIpc";
import { rendererLocalCommitApply } from "../core-client/types";
import { setExecutionHoldInputSchema } from "../../shared/work-application";
import { effectiveHolds } from "../../host/work-application/execution-holds";
import {
  AgentRuntimeAttachmentSchema,
  AgentRuntimeLaunchSchema,
  type HostedChatAttachmentChunk,
} from "../../shared/schemas/agent-runtime-api";
import { makeHostedChatInput } from "./hosted-chat-input";
import { readHostedChatImage } from "./hosted-chat-attachment";
import { makeRemoteHostCall, RemoteHostError } from "./remote-host-call";

/** A team Desktop requests its execution owner through this Space's authenticated Core, never a local Runtime. */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const ipc = yield* ElectronIpc;
    const access = yield* CoreSessionAccess;
    const core = yield* CoreModules;
    const hostedInput = yield* makeHostedChatInput;
    const callHost = yield* makeRemoteHostCall;
    const call = <K extends keyof IpcApi>(
      operation: components["schemas"]["HostOperation"],
      input: unknown,
    ) => callHost<IpcApi[K]["result"]>(operation, input);
    yield* ipc.handleQuery("work:host-status", () =>
      access.use("host.availability", (client, signal) => {
        if (!client.hostAvailability) throw new Error("Host availability is unsupported");
        return client.hostAvailability({ signal });
      }),
    );
    yield* ipc.handleLocalCommitCommand("work:start", (_, input) =>
      call<"work:start">("work_start", input),
    );
    yield* ipc.handlePlainCommand("work:refresh-workspace", (_, pageId) =>
      call<"work:refresh-workspace">("workspace_refresh", { pageId }),
    );
    yield* ipc.handleQuery("work:workspace", (_, pageId) =>
      core.workspace.read({ kind: "page_workspace", page_id: pageId }, undefined, null).pipe(
        Effect.map((read) => {
          if (read.value.kind !== "page_workspace") throw new Error("Invalid Page Workspace");
          return read.value;
        }),
      ),
    );
    yield* ipc.handleQuery("work:effective-hold", (_, target) => effectiveHolds(core, target));
    yield* ipc.handleQuery("work:holds", () =>
      Effect.gen(function* () {
        const holds: IpcApi["work:holds"]["result"][number][] = [];
        let after: string | null = null;
        do {
          const read: import("../core-client/types").ProjectWorkspaceReadSnapshot =
            yield* core.workspace.read(
              { kind: "execution_holds", after_key: after, limit: 100 },
              undefined,
              null,
            );
          if (read.value.kind !== "execution_holds") throw new Error("Invalid execution holds");
          holds.push(...read.value.holds);
          after = read.value.next_key ?? null;
        } while (after);
        return holds;
      }),
    );
    yield* ipc.handleLocalCommitCommand("work:set-hold", (_, input) =>
      Effect.gen(function* () {
        const parsed = setExecutionHoldInputSchema.parse(input);
        const apply = yield* core.workspace.apply(
          {
            operationId: parsed.operationId,
            intent: { kind: parsed.paused ? "pause_work" : "resume_work", scope: parsed.scope },
          },
          undefined,
          null,
        );
        return {
          ok: true as const,
          value: undefined,
          localCommit: rendererLocalCommitApply(apply),
        };
      }),
    );
    yield* ipc.handleQuery("agent-runtime:providers:read", (_, input) =>
      call<"agent-runtime:providers:read">("providers", input ?? {}),
    );
    yield* ipc.handleQuery("agent-runtime:activity:read", () =>
      call<"agent-runtime:activity:read">("activity", {}),
    );
    yield* ipc.handleQuery("agent-runtime:connection:read", () =>
      call<"agent-runtime:connection:read">("connection", {}),
    );
    yield* ipc.handleQuery("agent-runtime:session:overview", (_, input) =>
      call<"agent-runtime:session:overview">("session_overview", input),
    );
    yield* ipc.handleQuery("agent-runtime:session:queued-preview", (_, input) =>
      call<"agent-runtime:session:queued-preview">("session_queued_preview", input),
    );
    yield* ipc.handleQuery("agent-runtime:session:run-message", (_, input) =>
      call<"agent-runtime:session:run-message">("session_run_message", input),
    );
    yield* ipc.handleQuery("agent-runtime:providers:known", () =>
      call<"agent-runtime:providers:known">("providers", {}),
    );
    yield* ipc.handleQuery("agent-runtime:session:read", (_, input) =>
      call<"agent-runtime:session:read">("session_read", input),
    );
    yield* ipc.handleQuery("agent-runtime:session:control", (_, input) =>
      call<"agent-runtime:session:control">("session_control", input),
    );
    yield* ipc.handleQuery("agent-runtime:session:inspect", (_, input) =>
      call<"agent-runtime:session:inspect">("session_inspect", input),
    );
    // A transcript names its senders, forks and answering chats by their host's current title.
    yield* ipc.handleQuery("agent-runtime:thread:identity", (_, input) =>
      call<"agent-runtime:thread:identity">("thread_identity", input),
    );
    yield* ipc.handleQuery("agent-runtime:session:history", (_, input) =>
      call<"agent-runtime:session:history">("session_history", input),
    );
    yield* ipc.handleQuery("agent-runtime:session:prompt-turns", (_, input) =>
      call<"agent-runtime:session:prompt-turns">("session_prompt_turns", input),
    );
    yield* ipc.handleQuery("agent-runtime:session:prompt-index", (_, input) =>
      call<"agent-runtime:session:prompt-index">("session_prompt_index", input),
    );
    yield* ipc.handleQuery("agent-runtime:session:queue-read", (_, input) =>
      call<"agent-runtime:session:queue-read">("session_queue_read", input),
    );
    yield* ipc.handleQuery("agent-runtime:session:item", (_, input) =>
      call<"agent-runtime:session:item">("session_item", input),
    );
    const hosted = <A>(map: () => A) =>
      Effect.try({
        try: map,
        catch: (cause) =>
          new RemoteHostError({ message: cause instanceof Error ? cause.message : String(cause) }),
      });
    // Two pictures at a time leave the Member's host calls for the transcript around them.
    const pictures = yield* Semaphore.make(2);
    yield* ipc.handleQuery("agent-runtime:session:attachment", (_, input) =>
      hosted(() => AgentRuntimeAttachmentSchema.parse(input)).pipe(
        Effect.flatMap((reference) =>
          readHostedChatImage(reference, (range) =>
            callHost<HostedChatAttachmentChunk>("session_attachment", range),
          ),
        ),
        pictures.withPermit,
      ),
    );
    // A Member starts a new chat on the host, which makes them its owner; their own unstarted
    // draft keeps its identity.
    yield* ipc.handlePlainCommand("agent-runtime:session:launch", (_, input) =>
      hosted(() => AgentRuntimeLaunchSchema.parse(input)).pipe(
        Effect.flatMap(hostedInput.start),
        Effect.flatMap((start) => call<"agent-runtime:session:launch">("session_start", start)),
      ),
    );
    // A hosted Run presents on its host; no window here can receive what it opens.
    yield* ipc.handleControl("codex:turn-presentation:capture", () => Effect.succeed(undefined));
    yield* ipc.handlePlainCommand("agent-runtime:session:message", (_, input) =>
      hostedInput
        .message(input, false)
        .pipe(
          Effect.flatMap((message) =>
            call<"agent-runtime:session:message">("session_message", message),
          ),
        ),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:queue-message", (_, input) =>
      hostedInput
        .message(input, true)
        .pipe(
          Effect.flatMap((message) =>
            call<"agent-runtime:session:queue-message">("session_message", message),
          ),
        ),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:queue", (_, input) =>
      hostedInput
        .queue(input)
        .pipe(
          Effect.flatMap((queue) => call<"agent-runtime:session:queue">("session_queue", queue)),
        ),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:create-side-chat", (_, input) =>
      call<"agent-runtime:session:create-side-chat">("session_side_chat_create", input),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:delete-side-chat", (_, input) =>
      call<"agent-runtime:session:delete-side-chat">("session_side_chat_delete", input),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:merge-back", (_, input) =>
      call<"agent-runtime:session:merge-back">("session_merge_back", input),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:compact", (_, input) =>
      call<"agent-runtime:session:compact">("session_compact", input),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:clear-context", (_, input) =>
      call<"agent-runtime:session:clear-context">("session_clear_context", input),
    );
    // A worktree environment chosen on this computer means nothing on the Space host.
    yield* ipc.handlePlainCommand(
      "agent-runtime:session:fork",
      (_, { runInEnvironmentPath: _local, ...fork }) =>
        call<"agent-runtime:session:fork">("session_fork", fork),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:rewrite-message", (_, input) =>
      hostedInput
        .rewrite(input)
        .pipe(
          Effect.flatMap((rewrite) =>
            call<"agent-runtime:session:rewrite-message">("session_rewrite_message", rewrite),
          ),
        ),
    );
    // The chat's owner or a Space Owner changes what every Member sees; Core decides who.
    yield* ipc.handleLocalCommitCommand("project-sessions:rename", (_, command) =>
      call<"project-sessions:rename">("session_rename", command),
    );
    yield* ipc.handleLocalCommitCommand("project-sessions:archive", (_, command) =>
      call<"project-sessions:archive">("session_archive", command),
    );
    yield* ipc.handleLocalCommitCommand("project-sessions:unarchive", (_, command) =>
      call<"project-sessions:unarchive">("session_unarchive", command),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:move", (_, input) =>
      call<"agent-runtime:session:move">("session_move", input),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:respond", (_, input) =>
      call<"agent-runtime:session:respond">("session_respond", input),
    );
    // Only the Run's requester, the chat's owner or a Space Owner stops its work; Core checks
    // each call.
    yield* ipc.handlePlainCommand("agent-runtime:session:stop", (_, input) =>
      call<"agent-runtime:session:stop">("session_stop", input),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:stop-task", (_, input) =>
      call<"agent-runtime:session:stop-task">("session_stop_task", input),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:cancel-task", (_, input) =>
      call<"agent-runtime:session:cancel-task">("session_cancel_task", input),
    );
    yield* ipc.handlePlainCommand("agent-runtime:session:stop-background", (_, input) =>
      call<"agent-runtime:session:stop-background">("session_stop_background", input),
    );
    yield* ipc.handleQuery("agent-runtime:session:background-output", (_, input) =>
      call<"agent-runtime:session:background-output">("session_background_output", input),
    );
    // The host searches the chats this Member may read, with their authority, as a desktop
    // searches its own.
    yield* ipc.handleQuery("chats:search", (_, input) =>
      call<"chats:search">("chat_search", input),
    );
    yield* ipc.handleQuery("chats:search-messages", (_, input) =>
      call<"chats:search-messages">("chat_search_messages", input),
    );
    yield* ipc.handlePlainCommand("inbox:open-nodex", () =>
      call<"inbox:open-nodex">("coordinator_open", {}),
    );
    yield* ipc.handleQuery("inbox:reply-destination", (_, pageId, body) =>
      call<"inbox:reply-destination">("inbox_reply_destination", { pageId, body }),
    );
    yield* ipc.handleLocalCommitCommand("inbox:send", (_, input) =>
      call<"inbox:send">("inbox_send", input),
    );
    yield* ipc.handleQuery("inbox:skill-availability", (_, input) =>
      call<"inbox:skill-availability">("inbox_skill_availability", input),
    );
    yield* ipc.handleQuery("inbox:prepare-confirmation", (_, input) =>
      call<"inbox:prepare-confirmation">("inbox_prepare_confirmation", input),
    );
    yield* ipc.handleLocalCommitCommand("inbox:confirm", (_, input) =>
      call<"inbox:confirm">("inbox_confirm", input),
    );
    yield* ipc.handleLocalCommitCommand("inbox:dispatch", (_, input) =>
      call<"inbox:dispatch">("inbox_dispatch", input),
    );
    yield* ipc.handleQuery("inbox:chat-targets", (_, input) =>
      call<"inbox:chat-targets">("inbox_chat_targets", input),
    );
    yield* ipc.handleLocalCommitCommand("inbox:request-suggestion", (_, input) =>
      call<"inbox:request-suggestion">("inbox_request_suggestion", input),
    );
    yield* ipc.handleLocalCommitCommand("inbox:stop-suggestion", (_, input) =>
      call<"inbox:stop-suggestion">("inbox_stop_suggestion", input),
    );
    yield* ipc.handleLocalCommitCommand("inbox:retry-dispatch", (_, input) =>
      call<"inbox:retry-dispatch">("inbox_retry_dispatch", input),
    );
  }),
);
