import type { components } from "@nodex/core-protocol";
export type WorkEvent = components["schemas"]["CoordinatorWorkEvent"];
export const MAX_WORK_EVENT_DETAIL_CHARS = 24000;
const line = (value: unknown, max = 600): string => {
  const text = (typeof value === "string" ? value : (JSON.stringify(value) ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated]`;
};
/** Payload is untrusted event data, kept separate from standing Host instructions. */
export const renderWorkEventMessage = (events: readonly WorkEvent[]): string =>
    .map((event) => {
      const chat = event.session_id
        ? `chat ${JSON.stringify(line(event.session_title ?? "Untitled", 160))} (session ${event.session_id})`
        : "";
      const page = event.page_id
        ? `${JSON.stringify(line(event.page_title ?? "Untitled", 160))} (${event.page_key ? `${event.page_key}, ` : ""}page ${event.page_id})`
        : "";
      const payload = event.payload as Record<string, unknown> | null;
      const detail =
        payload && typeof payload === "object"
          ? event.kind === "attention" && Array.isArray(payload.questions)
            ? { kind: payload.kind, questions: payload.questions }
            : (payload.summary ?? payload.question ?? payload.text ?? payload)
          : payload;
      const category = event.kind === "attention" ? payload?.kind : payload?.outcome;
      const outcome = typeof category === "string" ? ` · ${line(category, 40)}` : "";
      return `- eventId ${event.event_id} · ${event.kind}${outcome} — ${[page, chat].filter(Boolean).join(" in ")}: ${line(detail, event.kind === "attention" ? MAX_WORK_EVENT_DETAIL_CHARS : 600)}`;
    })
    .join("\n")}`;

/** Keep each delivered event intact while fitting Core's 64 KiB batch envelope. */
export function renderWorkEventBatch(candidates: readonly WorkEvent[]) {
  const events: WorkEvent[] = [];
  let body = renderWorkEventMessage(events);
  for (const candidate of candidates) {
    const next = renderWorkEventMessage([...events, candidate]);
    if (new TextEncoder().encode(next).byteLength > 64000) break;
    events.push(candidate);
    body = next;
  }
  return { events, body };
}
