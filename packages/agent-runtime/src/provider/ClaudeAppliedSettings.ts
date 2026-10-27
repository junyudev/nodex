/** What Claude Code reports a session actually runs with (`get_settings().applied`). */
export interface ClaudeAppliedSettings {
  readonly model: string | null;
  readonly effort: string | null;
  /** Ultracode is running, not merely requested. */
  readonly ultracode: boolean;
  readonly ultracodeRequested: boolean;
  /** Dynamic workflows are on and the session's model supports Ultracode. */
  readonly ultracodeAvailable: boolean | null;
}

/** Reads `applied` from a get_settings answer, whose fields Claude Code adds over time. */
export function readClaudeAppliedSettings(response: unknown): ClaudeAppliedSettings | null {
  const applied =
    typeof response === "object" && response !== null ? Reflect.get(response, "applied") : null;
  if (typeof applied !== "object" || applied === null) return null;
  const text = (key: string) => {
    const value = Reflect.get(applied, key);
    return typeof value === "string" ? value : null;
  };
  const flag = (key: string) => Reflect.get(applied, key) === true;
  const available = Reflect.get(applied, "ultracodeAvailable");
  return {
    model: text("model"),
    effort: text("effort"),
    ultracode: flag("ultracode"),
    ultracodeRequested: flag("ultracodeRequested"),
    ultracodeAvailable: typeof available === "boolean" ? available : null,
  };
}

/** The SDK answers get_settings at runtime without declaring it on Query. */
export async function queryClaudeAppliedSettings(
  query: object,
): Promise<ClaudeAppliedSettings | null> {
  const getSettings: unknown = Reflect.get(query, "getSettings");
  return typeof getSettings === "function"
    ? readClaudeAppliedSettings(await getSettings.call(query))
    : null;
}
