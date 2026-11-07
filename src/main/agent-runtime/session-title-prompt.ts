import { z } from "zod";
import {
  cleanCodexAutoTitlePrompt,
  normalizeCodexGeneratedThreadTitle,
} from "../../shared/codex-thread-title";

export const SESSION_TITLE_TIMEOUT_MS = 30_000;

export const SESSION_TITLE_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { title: { type: "string", minLength: 1, maxLength: 36 } },
  required: ["title"],
  additionalProperties: false,
};

/** A model held to the schema only by its prompt can run long, so normalizing shortens the title. */
const SessionTitleResponseSchema = z.object({ title: z.string() });

export function buildSessionTitlePrompt(userPrompt: string): string {
  const titlePromptInput = cleanCodexAutoTitlePrompt(userPrompt).trim();
  if (!titlePromptInput) return "";
  return [
    "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.",
    "The tasks typically have to do with coding-related tasks, for example requests for bug fixes or questions about a codebase. The title you generate will be shown in the UI to represent the prompt.",
    "Generate a concise UI title (up to 36 characters) for this task.",
    "Fill the structured title field with plain text.",
    "Do not include quotes, markdown, formatting characters, or trailing punctuation.",
    "If the task includes a ticket reference (e.g. ABC-123), include it verbatim.",
    "",
    "Generate a clear, informative task title based solely on the prompt provided. Follow the rules below to ensure consistency, readability, and usefulness.",
    "",
    "How to write a good title:",
    "Generate a single-line title that captures the question or core change requested. The title should be easy to scan and useful in changelogs or review queues.",
    '- Use an imperative verb first: "Add", "Fix", "Update", "Refactor", "Remove", "Locate", "Find", etc.',
    "- Keep it under 36 characters and under 5 words where possible.",
    "- If the user's prompt is already a short clear title, reuse it verbatim.",
    "- Capitalize only the first word (unless locale requires otherwise).",
    "- Write the title in the user's locale.",
    "- Do not use punctuation at the end.",
    "- Output the title as plain text with no surrounding quotes or backticks.",
    "- Use precise, non-redundant language.",
    '- Translate fixed phrases into the user\'s locale (e.g., "Fix bug" -> "Corrige el error" in Spanish-ES), but leave code terms in English unless a widely adopted translation exists.',
    "- If the user provides a title explicitly, reuse it (translated if needed) and skip generation logic.",
    '- Make it clear when the user is requesting changes (use verbs like "Fix", "Add", etc) vs asking a question (use verbs like "Find", "Locate", "Count").',
    "- Do NOT respond to the user, answer questions, or attempt to solve the problem; just write a title that can represent the user's query.",
    "",
    "Examples:",
    '- User: "Can we add dark-mode support to the settings page?" -> Add dark-mode support',
    '- User: "Fehlerbehebung: Beim Anmelden erscheint 500." (de-DE) -> Login-Fehler 500 beheben',
    '- User: "Refactoriser le composant sidebar pour réduire le code dupliqué." (fr-FR) -> Refactoriser composant sidebar',
    '- User: "How do I fix our login bug?" -> Troubleshoot login bug',
    '- User: "Where in the codebase is foo_bar created" -> Locate foo_bar',
    '- User: "what\'s 2+2" -> Calculate 2+2',
    "",
    "By following these conventions, your titles will be readable, changelog-friendly, and helpful to both users and downstream tools.",
    "",
    "User prompt:",
    titlePromptInput,
  ].join("\n");
}

/** The title in a generation's structured output, or null when it holds none. */
export function parseGeneratedSessionTitle(output: unknown): string | null {
  const result = SessionTitleResponseSchema.safeParse(output);
  return result.success ? normalizeCodexGeneratedThreadTitle(result.data.title) : null;
}
