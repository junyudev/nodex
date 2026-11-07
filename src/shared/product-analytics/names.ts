/**
 * Model identifiers that name public models. A private deployment or custom alias is reported as
 * `other`, so a user's model configuration can never leave the machine through analytics.
 */
const PUBLIC_MODEL_NAME =
  /^(?:gpt|o[1-9]|codex|claude|sonnet|opus|haiku|gemini|grok|deepseek|qwen|kimi|glm|llama|mistral|minimax)(?:[a-z0-9._:-]{0,47})$/i;

export const analyticsModelName = (model: string | null | undefined): string => {
  const name = model?.trim();
  return name && PUBLIC_MODEL_NAME.test(name) ? name.toLowerCase() : "other";
};

/** Runtime driver identifiers are not product vocabulary; analytics reports the Agent family. */
export const analyticsProviderName = (
  driver: string | null | undefined,
): "codex" | "claude" | "opencode" | "acp" | "other" => {
  if (driver === "codex") return "codex";
  if (driver === "claudeAgent") return "claude";
  if (driver === "opencode" || driver === "opencode2") return "opencode";
  if (driver === "acpRegistry") return "acp";
  return "other";
};

/** A reporting day is UTC so one installation counts once however it crosses time zones. */
export const analyticsDay = (epochMs: number): string =>
  new Date(epochMs).toISOString().slice(0, 10);

/** Fits a machine label to the catalog's code vocabulary; free text cannot survive it intact. */
export const analyticsCode = (value: string | null | undefined): string | undefined => {
  const code = value
    ?.trim()
    .replace(/[^a-zA-Z0-9_.:-]+/g, "_")
    .slice(0, 64);
  return code ? code : undefined;
};
