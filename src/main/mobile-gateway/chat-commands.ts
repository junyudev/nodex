import * as Effect from "effect/Effect";
import type { AgentTurnItem } from "@nodex/agent-runtime/contracts";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CodexGitProbe } from "../codex-application/CodexGitProbe";
import { createOperationId } from "../core-runtime/operation-identity";
import { resolveInboxModel } from "../inbox-application/InboxRuntimeSelection";
import { makeSetSessionUnread } from "../project-application/SessionUnread";
import { ProjectSessionCommands } from "../project-application/ProjectSessionCommands";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { MobileProfileFiles } from "../platform/node/MobileProfileFiles";
import { isUuidV7 } from "../../shared/uuid-v7";
import { approvalOptions, snapshotTurnItems } from "./transcript-projection";
import type { makeMobileFiles } from "./files";
import type { makeMobileCatalog } from "./catalog";
import { invalid, missing, rpcError, unavailable, type MobileHandlers } from "./rpc";

const desktopOnly = "Continue this chat on your desktop.";
const notFound = () => missing("This chat is unavailable.");
/** A phone sees a product sentence; the Runtime's own reason stays in the Host's log. */
const runtimeError = (error: { readonly admissionRejected?: boolean; readonly message: string }) =>
  error.admissionRejected
    ? Effect.succeed(rpcError("rejected", error.message))
    : Effect.logWarning(`Mobile chat command failed: ${error.message}`).pipe(
        Effect.as(unavailable("The Agent Runtime could not complete this request.")),
      );

export const makeMobileChatCommands = Effect.fn("MobileChatCommands.make")(function* (
  files: Effect.Success<typeof makeMobileFiles>,
  catalog: Effect.Success<typeof makeMobileCatalog>,
) {
  const runtime = yield* AgentRuntimeApplication;
  const projects = yield* ProjectWorkspace;
  const commands = yield* ProjectSessionCommands;
  const setUnread = yield* makeSetSessionUnread;
  const platform = yield* MobileProfileFiles;
  const git = yield* CodexGitProbe;
  const worktreeStart = (projectId: string) =>
    Effect.gen(function* () {
      const project = yield* projects.getProject(projectId).pipe(Effect.mapError(notFound));
      if (!project?.primaryWorkspaceRoot)
        return yield* Effect.fail(invalid("Choose a Project with a Git workspace."));
      const root = project.primaryWorkspaceRoot;
      const current = yield* git.readPath(root, ["symbolic-ref", "--short", "HEAD"]);
      const branchName =
        current ??
        (yield* git.readPath(root, [
          "symbolic-ref",
          "--short",
          "refs/remotes/origin/HEAD",
        ]))?.replace(/^origin\//u, "") ??
        (yield* git.readPath(root, [
          "for-each-ref",
          "--count=1",
          "--format=%(refname:short)",
          "refs/heads",
        ])) ??
        "HEAD";
      return { type: "branch" as const, branchName };
    });
  const session = Effect.fn("MobileChatCommands.session")(function* (sessionId: string) {
    const session = yield* projects.getProjectSession(sessionId).pipe(Effect.mapError(notFound));
    if (!session) return yield* Effect.fail(notFound());
    return session;
  });
  const writable = Effect.fn("MobileChatCommands.writable")(function* (sessionId: string) {
    const row = yield* session(sessionId);
    if (!row.executionRef || row.archived)
      return yield* Effect.fail(
        rpcError("rejected", row.archived ? "Restore this chat to continue it." : desktopOnly),
      );
    return { sessionId, threadId: row.executionRef.threadId };
  });

  const start: MobileHandlers["chats.start"] = (input) =>
    Effect.gen(function* () {
      const { sessionId, launchId, messageId, text, projectId, location } = input;
      if (
        !isUuidV7(launchId) ||
        !sessionId ||
        !messageId ||
        (!text.trim() && !input.fileRefs.length)
      )
        return yield* Effect.fail(invalid("The chat launch is invalid."));
      if (location === "worktree" && !projectId)
        return yield* Effect.fail(invalid("Choose a Project for this worktree."));
      const acceptedAt = Number.parseInt(launchId.slice(0, 8) + launchId.slice(9, 13), 16);
      const fingerprint = platform.contentFingerprint(
        JSON.stringify([
          projectId,
          launchId,
          messageId,
          text,
          input.fileRefs,
          input.agent,
          location,
        ]),
      );
      const replay = yield* runtime
        .replayMessage({ sessionId, messageId, fingerprint })
        .pipe(Effect.orElseSucceed(() => null));
      if (replay) return { sessionId };
      const choice = yield* catalog.agentChoice(input.agent);
      const modelSelection = yield* resolveInboxModel(runtime, choice).pipe(
        Effect.mapError(() => unavailable("The selected Agent or model is unavailable.")),
      );
      const resources = yield* files.chatResources(input.fileRefs);
      const startingState =
        location === "worktree" && projectId ? yield* worktreeStart(projectId) : null;
      const result = yield* runtime
        .launch({
          sessionId,
          projectId,
          launchId,
          acceptedAt,
          title: text.slice(0, 120) || "New chat",
          modelSelection,
          interactionMode: "default",
          runInTarget: location === "worktree" ? "newWorktree" : "localProject",
          ...(startingState ? { worktreeStartingState: startingState } : {}),
          message: { messageId, text },
          messageFingerprint: fingerprint,
          resources,
        })
        .pipe(Effect.catch((error) => Effect.flatMap(runtimeError(error), Effect.fail)));
      return { sessionId: result.sessionId };
    });
  const send: MobileHandlers["chat.send"] = (input) =>
    Effect.gen(function* () {
      const { text, fileRefs, messageId, delivery } = input;
      if (!text.trim() && !fileRefs.length)
        return yield* Effect.fail(invalid("Write a message or attach a file."));
      const target = yield* writable(input.sessionId);
      const fingerprint = platform.contentFingerprint(JSON.stringify([text, fileRefs, delivery]));
      const replay = yield* runtime
        .replayMessage({ ...target, messageId, fingerprint })
        .pipe(Effect.catch((error) => Effect.flatMap(runtimeError(error), Effect.fail)));
      if (replay) return {};
      const resources = yield* files.chatResources(fileRefs);
      const message = { messageId, text };
      if (delivery === "queue")
        yield* runtime
          .sendMessage({
            ...target,
            message,
            resources,
            mode: "queue",
            messageFingerprint: fingerprint,
          })
          .pipe(Effect.catch((error) => Effect.flatMap(runtimeError(error), Effect.fail)));
      else
        yield* runtime
          .message({
            ...target,
            message,
            resources,
            intent: "steer",
            messageFingerprint: fingerprint,
          })
          .pipe(Effect.catch((error) => Effect.flatMap(runtimeError(error), Effect.fail)));
      return {};
    });
  const respond: MobileHandlers["chat.respond"] = (input) =>
    Effect.gen(function* () {
      const { requestId, runId, submissionId, response } = input;
      const target = yield* writable(input.sessionId);
      const { snapshot } = yield* runtime
        .read(target)
        .pipe(Effect.catch((error) => Effect.flatMap(runtimeError(error), Effect.fail)));
      const item = snapshotTurnItems(snapshot.projection).find(
        (
          item,
        ): item is Extract<AgentTurnItem, { type: "approval_request" | "user_input_request" }> =>
          (item.type === "approval_request" || item.type === "user_input_request") &&
          item.requestId === requestId &&
          item.runId === runId,
      );
      if (!item)
        return yield* Effect.fail(rpcError("conflict", "This request is no longer available."));
      const base = { ...target, requestId, runId, submissionId };
      if (response.kind === "option" && item.type === "approval_request") {
        const option = approvalOptions(item).find(({ id }) => id === response.optionId);
        if (!option) return yield* Effect.fail(invalid("This approval choice is unavailable."));
        yield* runtime
          .respond({
            ...base,
            decision: option.decision,
            ...(option.optionId === undefined ? {} : { optionId: option.optionId }),
            ...(response.feedback === null ? {} : { feedback: response.feedback }),
          })
          .pipe(Effect.catch((error) => Effect.flatMap(runtimeError(error), Effect.fail)));
      } else if (response.kind === "answers" && item.type === "user_input_request") {
        if (item.questions.some((question) => question.isSecret))
          return yield* Effect.fail(rpcError("rejected", "Answer this question on your desktop."));
        const questions = new Map(item.questions.map((question) => [question.id, question]));
        for (const [id, answers] of Object.entries(response.answers)) {
          const question = questions.get(id);
          if (
            !question ||
            (!question.multiSelect && answers.length > 1) ||
            (question.allowCustomAnswer === false &&
              answers.some(
                (answer) =>
                  !question.options.some((option) => (option.value ?? option.label) === answer),
              ))
          )
            return yield* Effect.fail(invalid("An answer does not match the question."));
        }
        yield* runtime
          .respond({ ...base, answers: response.answers })
          .pipe(Effect.catch((error) => Effect.flatMap(runtimeError(error), Effect.fail)));
      } else {
        return yield* Effect.fail(invalid("This response does not match the request."));
      }
      return {};
    });

  return {
    session,
    handlers: {
      "chats.start": start,
      "chat.send": send,
      "chat.respond": respond,
      "chat.stop": ({ sessionId, runId }) =>
        writable(sessionId).pipe(
          Effect.flatMap((target) =>
            runtime
              .stop({ ...target, runId })
              .pipe(Effect.catch((error) => Effect.flatMap(runtimeError(error), Effect.fail))),
          ),
          Effect.as({}),
        ),
      "chat.markRead": ({ sessionId }) =>
        session(sessionId).pipe(
          Effect.flatMap((row) =>
            setUnread(row, false, createOperationId("mobile.chat.mark-read")),
          ),
          Effect.mapError(() => unavailable("The chat could not be marked read.")),
          Effect.as({}),
        ),
      "chat.setArchived": ({ sessionId, archived }) =>
        session(sessionId).pipe(
          Effect.flatMap((row) => {
            if (row.archived === archived) return Effect.void;
            const command = {
              operationId: createOperationId("mobile.chat.archive"),
              payload: { sessionId },
            };
            return (archived ? commands.archive(command) : commands.unarchive(command)).pipe(
              Effect.asVoid,
            );
          }),
          Effect.mapError(() => unavailable("The chat could not be moved.")),
          Effect.as({}),
        ),
    } satisfies Pick<
      MobileHandlers,
      | "chats.start"
      | "chat.send"
      | "chat.stop"
      | "chat.respond"
      | "chat.markRead"
      | "chat.setArchived"
    >,
  };
});
