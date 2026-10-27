import type {
  OrchestrationV2UserInputQuestion,
  ProviderUserInputAnswers,
  UserInputAttachments,
  UserInputAttachmentAnswerPayload,
} from "@t3tools/contracts";

export interface AsyncQuestionReply {
  readonly question: OrchestrationV2UserInputQuestion;
  readonly answer: string;
}

/** A new submission sends only changed answers; omitted siblings retain their own lifetime. */
export function selectAsyncQuestionReplyBatch(input: {
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
  readonly answers: ProviderUserInputAnswers | undefined;
  readonly attachmentsByQuestionId: UserInputAttachments | undefined;
  readonly previous: UserInputAttachmentAnswerPayload | undefined;
}):
  | { readonly type: "answers"; readonly replies: Array<AsyncQuestionReply> }
  | { readonly type: "unchanged" }
  | { readonly type: "invalid"; readonly message: string } {
  const questionIds = new Set(input.questions.map((question) => question.id));
  if (Object.keys(input.answers ?? {}).some((id) => !questionIds.has(id)))
    return { type: "invalid", message: "An answer does not belong to this question request." };

  const replies: Array<AsyncQuestionReply> = [];
  for (const question of input.questions) {
    const submitted = input.answers?.[question.id];
    const answer =
      typeof submitted === "string"
        ? question.initialAnswer === undefined
          ? submitted.trim()
          : submitted
        : undefined;
    const previous = input.previous?.answers[question.id];
    if (answer === undefined || (question.initialAnswer === undefined && answer.length === 0)) {
      if (question.required !== false && previous === undefined)
        return { type: "invalid", message: "Answer each required question before sending." };
      continue;
    }
    const previousAttachments = input.previous?.attachmentsByQuestionId[question.id] ?? [];
    const attachments = input.attachmentsByQuestionId?.[question.id] ?? [];
    if (
      previous === answer &&
      previousAttachments.length === attachments.length &&
      previousAttachments.every((attachment, index) => attachment.id === attachments[index]?.id)
    )
      continue;
    replies.push({ question, answer });
  }
  if (replies.length > 0) return { type: "answers", replies };
  if (
    input.questions.some((question) => {
      const answer = input.answers?.[question.id];
      return (
        typeof answer === "string" &&
        (question.initialAnswer === undefined ? answer.trim() : answer) ===
          input.previous?.answers[question.id]
      );
    })
  )
    return { type: "unchanged" };
  return { type: "invalid", message: "Enter an answer before sending." };
}
