import type { CodexUserInputRequest } from "./types";

/** Every transcript presentation, including copied Markdown, hides private answers. */
export function visibleCodexUserInputAnswerValues(
  question: Pick<CodexUserInputRequest["questions"][number], "isSecret">,
  values: readonly string[],
): string[] {
  const answers = values.map((value) => value.trim()).filter((value) => value.length > 0);
  if (answers.length === 0 || !question.isSecret) return answers;
  return ["Hidden response"];
}
