import type { ChatQuestion } from "@nodex/mobile-protocol";

/** A single-choice question replaces its answer; a tap on the chosen option clears it. */
export const toggleSelection = (
  current: readonly string[],
  optionId: string,
  multiSelect: boolean,
): readonly string[] => {
  if (current.includes(optionId)) return current.filter((id) => id !== optionId);
  return multiSelect ? [...current, optionId] : [optionId];
};

export const isQuestionAnswered = (selected: readonly string[], text: string): boolean =>
  selected.length > 0 || text.trim().length > 0;

/** Answers by question id, with free text after any chosen options. */
export const answersFromSelections = (
  questions: readonly ChatQuestion[],
  selections: Readonly<Record<string, readonly string[]>>,
  texts: Readonly<Record<string, string>>,
): Record<string, string[]> => {
  const answers: Record<string, string[]> = {};
  for (const question of questions) {
    const text = texts[question.id]?.trim();
    answers[question.id] = [...(selections[question.id] ?? []), ...(text ? [text] : [])];
  }
  return answers;
};
