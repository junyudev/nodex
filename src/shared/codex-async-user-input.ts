import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import {
  codexAsyncQuestionId,
  decodeCodexAsyncQuestionReplies,
  type CodexAsyncQuestionReply,
} from "@nodex/agent-runtime/codex-conventions";
import type {
  CodexCanonicalItem,
  CodexCanonicalTurnState,
} from "./codex-conversation-state/codex-conversation-state";
import type { CodexCollaborationModeKind, CodexServiceTier } from "./types";
import { projectCodexMarkdownToPlainText } from "./codex-markdown-text";

/** A display identity is stable even when one tool call asks several questions. */
export interface CodexAsyncQuestion {
  id: string;
  sourceItemId: string;
  questionIndex: number | null;
  title: string;
  options: readonly string[];
  sourceTurnId?: string;
  sourceEntityKey?: string;
  isSecret?: boolean;
  initialAnswer?: string;
  required?: boolean;
}

/** Answers keep their source identity even when another Turn receives the message. */
export interface CodexAsyncQuestionResponseInput {
  readonly threadId: string;
  readonly submissionId: string;
  readonly sourceTurnIds: readonly string[];
  readonly replies: readonly CodexAsyncQuestionReply[];
  readonly collaborationMode?: CodexCollaborationModeKind | null;
  readonly serviceTier?: CodexServiceTier;
}

/** Resolve question wording from its admitted source, without requiring that source to run. */
export function resolveCodexAsyncQuestionResponse(
  turns: readonly Pick<CodexCanonicalTurnState, "turnId" | "items">[],
  input: Pick<CodexAsyncQuestionResponseInput, "sourceTurnIds" | "replies">,
): CodexAsyncQuestionReply[] {
  if (!input.sourceTurnIds.length || !input.replies.length)
    throw new Error("Choose a question and enter an answer before sending");
  const sourceIds = new Set(input.sourceTurnIds);
  const sources = turns.filter((turn) => turn.turnId !== null && sourceIds.has(turn.turnId));
  if (sources.length !== sourceIds.size)
    throw new Error("The question's source is no longer available");
  const questions = sources.flatMap((turn) => turn.items.flatMap(expandCodexAsyncQuestions));
  const answered = new Set<string>();
  return input.replies.map((reply) => {
    if (
      typeof reply?.questionItemId !== "string" ||
      typeof reply.answer !== "string" ||
      !reply.answer.trim() ||
      answered.has(reply.questionItemId)
    )
      throw new Error("Each question needs one nonempty answer");
    const matches = questions.filter((question) => question.id === reply.questionItemId);
    const question = matches[0];
    if (matches.length !== 1 || !question)
      throw new Error("The answer does not belong to its question's source");
    answered.add(reply.questionItemId);
    return {
      questionItemId: question.id,
      question: question.title,
      answer: reply.answer.trim(),
    };
  });
}

export {
  decodeCodexAsyncQuestionReplies,
  encodeCodexAsyncQuestionReplies,
  type CodexAsyncQuestionReply,
} from "@nodex/agent-runtime/codex-conventions";

export function expandCodexAsyncQuestions(
  item: CodexCanonicalItem | ThreadItem,
): CodexAsyncQuestion[] {
  if (item.type !== "agentMessage" || item.delivery !== "async") return [];
  if (!item.questions?.length) {
    return [
      { id: item.id, sourceItemId: item.id, questionIndex: null, title: item.text, options: [] },
    ];
  }
  return item.questions.map((question, questionIndex) => ({
    id: codexAsyncQuestionId(item.id, questionIndex),
    sourceItemId: item.id,
    questionIndex,
    title: question.title,
    options: question.options ?? [],
  }));
}

/** One reply text may travel with attachments; ordinary prose stays ordinary prose. */
export function readCodexAsyncQuestionReplies(
  item: CodexCanonicalItem | ThreadItem,
): CodexAsyncQuestionReply[] | null {
  if (item.type === "steeringUserMessage" && item.status !== "accepted") return null;
  const content =
    item.type === "userMessage"
      ? item.content
      : item.type === "steeringUserMessage"
        ? item.input
        : [];
  const texts = content.filter((entry) => entry.type === "text");
  const first = texts[0];
  if (texts.length !== 1 || !first) return null;
  return decodeCodexAsyncQuestionReplies(first.text);
}

/** Attribute an echoed user message to its original steer position within this Turn. */
export function collectCodexAsyncQuestionAnswers(
  items: readonly CodexCanonicalItem[],
): Map<string, string> {
  const questionPositions = new Map(
    items.flatMap((item, index) =>
      expandCodexAsyncQuestions(item).map((question) => [question.id, index] as const),
    ),
  );
  const questionIds = new Set(questionPositions.keys());
  const candidates = items.flatMap((item, index) => {
    if (item.type !== "userMessage" && item.type !== "steeringUserMessage") return [];
    const input = item.type === "userMessage" ? item.content : item.input;
    const texts = input.filter((entry) => entry.type === "text");
    if (texts.length !== 1 || !texts[0]) return [];
    const text = texts[0].text;
    const replies = decodeCodexAsyncQuestionReplies(text);
    return replies?.some((reply) => questionIds.has(reply.questionItemId))
      ? [{ item, index, text, replies }]
      : [];
  });
  const answers = new Map<string, { answer: string; index: number }>();
  for (const candidate of candidates) {
    const { item, index, replies, text } = candidate;
    if (item.type === "steeringUserMessage" && item.status !== "accepted") continue;
    const origin =
      item.type === "userMessage"
        ? (candidates.find(
            (previous) =>
              previous.index < index &&
              previous.item.type === "steeringUserMessage" &&
              (previous.item.serverUserMessageId != null
                ? previous.item.serverUserMessageId === item.id
                : previous.item.clientUserMessageId !== null && item.clientId !== null
                  ? previous.item.clientUserMessageId === item.clientId
                  : previous.text === text),
          )?.index ?? index)
        : index;
    for (const reply of replies) {
      if (
        !questionIds.has(reply.questionItemId) ||
        origin <= (questionPositions.get(reply.questionItemId) ?? -1) ||
        origin <= (answers.get(reply.questionItemId)?.index ?? -1)
      )
        continue;
      answers.set(reply.questionItemId, { answer: reply.answer, index: origin });
    }
  }
  return new Map([...answers].map(([id, { answer }]) => [id, answer]));
}

export function formatCodexAsyncQuestionReplies(
  replies: readonly CodexAsyncQuestionReply[],
): string {
  return replies
    .map((reply) => `**${projectCodexMarkdownToPlainText(reply.question)}**\n${reply.answer}`)
    .join("\n\n");
}
