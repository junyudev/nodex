export function normalizeAutomationRruleText(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

export function parseAutomationRruleFields(value: string | null | undefined): Map<string, string> {
  const fields = new Map<string, string>();
  const text = normalizeAutomationRruleText(value);
  if (!text) return fields;

  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || /^DTSTART(?:;|:|$)/iu.test(trimmed)) continue;

    const ruleBody = trimmed.toUpperCase().startsWith("RRULE:")
      ? trimmed.slice(trimmed.indexOf(":") + 1)
      : trimmed;
    for (const part of ruleBody.split(";")) {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex <= 0) continue;

      const key = part.slice(0, separatorIndex).trim().toUpperCase();
      const fieldValue = part
        .slice(separatorIndex + 1)
        .trim()
        .toUpperCase();
      if (!key || !fieldValue) continue;
      fields.set(key, fieldValue);
    }
  }

  return fields;
}

export function hasAutomationRruleFrequency(value: string | null | undefined): boolean {
  return parseAutomationRruleFields(value).has("FREQ");
}
