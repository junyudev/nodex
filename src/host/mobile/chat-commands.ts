import * as Effect from "effect/Effect";
import type { AgentTurnItem } from "@nodex/agent-runtime/contracts";
import { resolveInboxModel } from "../inbox-application/InboxRuntimeSelection";
import { hostLocalCommit } from "../host-local-commit";
import type { ProjectWorkspaceCommandResult } from "../../main/project-application/ProjectWorkspace";
import { isUuidV7 } from "../../shared/uuid-v7";
import { approvalOptions, snapshotTurnItems } from "./transcript-projection";
import type { makeMobileCatalog } from "./catalog";
import { invalid, missing, rpcError, unavailable, type MobileHandlers } from "./rpc";

/** A phone sees a product sentence; the Runtime's own reason stays in the Host's log. */
const runtimeError = (error: { readonly admissionRejected?: boolean; readonly message: string }) =>
  error.admissionRejected
    ? Effect.succeed(rpcError("rejected", error.message))
    : Effect.logWarning(`Mobile chat command failed: ${error.message}`).pipe(
        Effect.as(unavailable("The Agent Runtime could not complete this request.")),
      );

export const makeMobileChatCommands = Effect.fn("MobileChatCommands.make")(function* (
  catalog: Effect.Success<typeof makeMobileCatalog>,
) {
  const runtime = yield* AgentRuntimeApplication;

  // A phone starts a chat as a desktop does, through the host's one owner of Members' chats.
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
      const choice = yield* catalog.agentChoice(input.agent);
      const modelSelection = yield* resolveInboxModel(runtime, choice).pipe(
        Effect.mapError(() => unavailable("The selected Agent or model is unavailable.")),
      );
      const started = yield* messages
        .start({
          sessionId,
          launchId,
          acceptedAt: Number.parseInt(launchId.slice(0, 8) + launchId.slice(9, 13), 16),
          projectId,
          title: text.slice(0, 120) || "New chat",
          modelSelection,
          interactionMode: "default",
          runInTarget: location === "worktree" ? "newWorktree" : "localProject",
          message: {
            messageId,
            text,
            ...(input.fileRefs.length ? { fileRefs: [...input.fileRefs] } : {}),
          },
        })
        .pipe(
          Effect.catch((error) =>
            error instanceof MemberMessageRefusal
              ? Effect.fail(refusal(error))
              : Effect.flatMap(runtimeError(error), Effect.fail),
          ),
        );
      return { sessionId: started.sessionId };
    });
  const send: MobileHandlers["chat.send"] = (input) =>
    Effect.gen(function* () {
      if (!text.trim() && !fileRefs.length)
        return yield* Effect.fail(invalid("Write a message or attach a file."));
        .send({
          sessionId,
          message: { messageId, text, ...(fileRefs.length ? { fileRefs: [...fileRefs] } : {}) },
          delivery,
        })
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
      // A desktop also releases its browser views and Sections; a host has only the Runtime's
      // lifecycle. Core admits either from the chat's owner or a Space Owner.
      "chat.setArchived": ({ sessionId, archived }) =>
        session(sessionId).pipe(
          Effect.flatMap((row) => {
            if (row.archived === archived) return Effect.void;
            const command = {
              operationId: createOperationId("mobile.chat.archive"),
              payload: { sessionId },
            };
            const settle = <E>(task: Effect.Effect<ProjectWorkspaceCommandResult<unknown>, E>) =>
              hostLocalCommit(task).pipe(
                Effect.mapError(() => unavailable("The chat could not be moved.")),
                Effect.flatMap((result) =>
                  result.ok ? Effect.void : Effect.fail(rpcError("rejected", result.error.message)),
                ),
            return Option.isSome(commands)
              ? settle(
                  archived ? commands.value.archive(command) : commands.value.unarchive(command),
                )
              : settle(
                  archived ? runtime.archiveSession(command) : runtime.unarchiveSession(command),
                );
          }),
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
