/** Provider invocation identity. Keep aligned with nodex_markdown::valid_skill_name. */
export function isSkillMentionName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9:_-]*$/u.test(value) &&
    /[A-Za-z]/u.test(value)
  );
}

/** Join text runs without letting their punctuation attach to a skill invocation. */
export function joinSkillMentionText(parts: readonly (string | { name: string })[]): string {
  let text = "";
  let afterSkill = false;
  for (const part of parts) {
    if (part === "") continue;
    const skill = typeof part !== "string";
    const next = skill ? `$${part.name}` : part;
    if ((skill || afterSkill) && /\S/u.test(text.at(-1) ?? "") && /\S/u.test(next[0] ?? ""))
      text += " ";
    text += next;
    afterSkill = skill;
  }
  return text;
}

/** Whether a parsed Block tree has any skill atoms. */
export function containsSkillMention(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSkillMention);
  if (!value || typeof value !== "object") return false;
  return (
    ("type" in value && value.type === "skillMention") ||
    Object.values(value).some(containsSkillMention)
  );
}
