import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import type { CodexCanonicalItem } from "./codex-conversation-state/codex-conversation-state";

/** A display identity is stable even when one tool call asks several questions. */
export interface CodexAsyncQuestion {
  id: string;
  sourceItemId: string;
  questionIndex: number | null;
  title: string;
  options: readonly string[];
}

export interface CodexAsyncQuestionReply {
  questionItemId: string;
  question: string;
  answer: string;
}

const OPEN = "<send_user_message_question_reply>";
const CLOSE = "</send_user_message_question_reply>";

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
    id: JSON.stringify(["request_user_input_async", item.id, questionIndex]),
    sourceItemId: item.id,
    questionIndex,
    title: question.title,
    options: question.options ?? [],
  }));
}

export function encodeCodexAsyncQuestionReplies(
  replies: readonly CodexAsyncQuestionReply[],
): string {
  return `${OPEN}\n${JSON.stringify(replies)}\n${CLOSE}`;
}

export function decodeCodexAsyncQuestionReplies(text: string): CodexAsyncQuestionReply[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(OPEN) || !trimmed.endsWith(CLOSE)) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(OPEN.length, -CLOSE.length));
    const replies: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    if (!replies.length || !replies.every(isReply)) return null;
    return replies;
  } catch {
    return null;
  }
}

function isReply(value: unknown): value is CodexAsyncQuestionReply {
  if (!value || typeof value !== "object") return false;
  return (
    "questionItemId" in value &&
    typeof value.questionItemId === "string" &&
    "question" in value &&
    typeof value.question === "string" &&
    "answer" in value &&
    typeof value.answer === "string"
  );
}

/** Only a single text input is a question envelope; ordinary prose stays ordinary prose. */
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
  const first = content[0];
  if (content.length !== 1 || first?.type !== "text") return null;
  return decodeCodexAsyncQuestionReplies(first.text);
}

/** Attribute an echoed user message to its original steer position within this Turn. */
export function collectCodexAsyncQuestionAnswers(
  items: readonly CodexCanonicalItem[],
): Map<string, string> {
  const questionIds = new Set(
    items.flatMap(expandCodexAsyncQuestions).map((question) => question.id),
  );
  const candidates = items.flatMap((item, index) => {
    if (item.type !== "userMessage" && item.type !== "steeringUserMessage") return [];
    const input = item.type === "userMessage" ? item.content : item.input;
    if (input.length !== 1 || input[0]?.type !== "text") return [];
    const text = input[0].text;
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
  return replies.map((reply) => `**${reply.question}**\n${reply.answer}`).join("\n\n");
}
