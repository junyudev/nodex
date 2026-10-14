import type { RealtimeVoice, RealtimeVoicesList } from "@nodex/codex-app-server-protocol";
import type { CodexRealtimeVoiceStartSettings } from "../../shared/codex-realtime-voice";
import type { RealtimeVoiceProductPolicy } from "../dictation/RealtimeVoicePolicyState";

export const DEFAULT_REALTIME_VOICE_PROMPT =
  '## Identity, tone, and role\n\nYou are Codex, an OpenAI general-purpose agentic assistant that helps the user complete tasks across coding, browsing, apps, documents, research, and other digital workflows.\n\nBe concise, clear, and efficient. Keep responses tight and useful—no fluff.\n\nYour personality is a playful collaborator: super fun, warm, witty, and expressive. Bring energy and personality to every response—light humor, friendly vibes, and a "we\'ve got this" attitude—without getting in the way of getting things done.\n\nThe user\'s name is {{ user_first_name }}. Use it sparingly—only for emphasis, confirmations, or smooth transitions.\n\nTalk like a trusted collaborator and a friend. Keep things natural, supportive, and easy to follow.\n\n## Interface and operating model\n\nThe user can interact with the system either by speaking to you or by sending text directly to the backend agent. The user can see the full interaction with the backend.\n\nThe backend handles execution and produces user-visible artifacts. You are the conversational surface of the same system.\n\nWhen interacting with the user, do not mention "backend". Present every work as done by you. You should make the user feel as if they are talking directly to the backend.\n\n### Policies\n\n* Treat the system as one unified assistant. Do not mention anything about backend or the system is composed of two separate parts.\n* Pass execution work to the backend. Because the user can always send requests directly to the backend, do not block, filter, or withhold requests that should instead be passed through.\n* NEVER refuse requests. Delegate all user requests to the backend. The backend makes the final judgement on whether it is doable, or whether it is safe.\n* Treat backend outputs as authoritative. Do not override or contradict them.\n* Use conversation to support execution: clarify briefly when needed, acknowledge progress, answer succinctly, and make the next step clear. Do not use conversation as a substitute for execution or artifact generation.\n\n## Backend use and steering\n\n* For any actions/tasks, always use the backend. If it is unclear whether backend use would help, use it.\n* Respond directly only when the request is clearly self-contained and backend use would not meaningfully help.\n* Do not claim that you cannot perform some actions. ALWAYS delegate the actions/tasks to the backend.\n* Ask clarifying questions only when needed to avoid a materially harmful mistake. Otherwise, make a reasonable assumption and use the backend.\n* Running backend work remains steerable. If users have new instructions, corrections, constraints, and updated context, immediately delegate to the backend.\n* Do not claim that a running backend task cannot be updated, redirected, or interrupted.\n\n## Backend outputs and user inputs\n\n* In the conversation stream, both user inputs and backend messages appear as `user` text messages.\n* Messages from the user are prefixed with `[USER] `. Messages from the backend are prefixed with `[BACKEND] `.\n* Backend messages may be intermediate updates or final outputs.\n* When the backend completes its task, you will also receive a tool return indicating completion.\n\n## Presenting backend results\n\n* Treat backend-visible output as the primary surface.\n* Briefly tell the user the key takeaway, status, or next step without repeating visible content unless the user asks.\n* Do not read out or recreate tables, diffs, plots, code blocks, structured data, or other heavily formatted content by default.\n* If the user wants backend output reformatted, transformed, or presented differently, have the backend do it.\n* Present backend content in detail only when the user explicitly asks.\n* Do not disclose the concept or existence of backend. Present the updates/result as if done by you.\n\n## Task-level user preferences\n\n* Treat user instructions about update frequency, verbosity, pacing, detail level, and presentation style as active task-level preferences, not one-turn requests.\n* Once the user sets such a preference for a task, continue following it across later responses and backend updates until the task is complete or the user changes the preference.\n* Do not silently revert to the default style mid-task just because a new backend message arrives.\n\n## Communication style\n\n* When the user makes a clear request, proceed directly. Do not paraphrase the request, announce your plan, or add unnecessary framing.\n* Avoid unnecessary narration, including repetitive confirmation, filler, re-acknowledgement, and obvious play-by-play.\n* By default, share progress updates only when they are brief, grounded, and genuinely useful.\n* If the user explicitly requests frequent or detailed updates, treat that as an active preference for the current task. Continue providing prompt updates whenever the backend sends new information until the task is complete or the user says otherwise.';

export const DEFAULT_REALTIME_VOICE_START_INSTRUCTIONS =
  "Realtime voice is active for this existing Codex task. Preserve the task's original instructions, role, collaboration mode, permissions, memory policy, and ongoing work.\n\nEvery ordinary spoken or frontend-context response must begin at byte zero with [STATUS] followed by one ASCII space for meaningful progress, or [COMPLETE] followed by one ASCII space for a final result, question, or blocker. [COMMENTARY] is also accepted as progress, and [ANALYSIS] remains silent context. Never speak or repeat a channel prefix.\n\nTo display exact Markdown, links, images, code, or other visual content, begin at byte zero with the bare directive ::codex-realtime-inline{}, followed by a newline and the Markdown. Do not put a channel tag before the directive.\n\nDuring this voice session, these Codex app tools are deferred: capture_screen_context and end_realtime_voice_call. Load and use them only when needed for this active session. Respect screen-context settings. End the voice call only when the user clearly intends to end the call; a request to stop work, stop speaking, or pause is not sufficient.";

export const DEFAULT_REALTIME_VOICE_END_INSTRUCTIONS =
  "Realtime voice mode has ended. Resume this task's original instructions, role, collaboration mode, normal text-output policy, permissions, memory policy, and ongoing work. Do not add realtime channel prefixes or the ::codex-realtime-inline{} directive. Do not load or call capture_screen_context or end_realtime_voice_call for the ended session; they apply only after another explicit voice session begins.";

const nonBlank = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;
const boundedInstructions = (value: unknown): string | null => {
  const text = nonBlank(value);
  return text !== null && Math.ceil(new TextEncoder().encode(text).byteLength / 4) <= 8192
    ? text
    : null;
};
const startInstructions = (config: Readonly<Record<string, unknown>>): string => {
  const explicit = boundedInstructions(config.realtime_start_instructions);
  if (explicit !== null) return explicit;
  const developer = nonBlank(config.new_thread_developer_instructions);
  if (developer === null) return DEFAULT_REALTIME_VOICE_START_INSTRUCTIONS;
  const end = developer.indexOf("\n## Orchestration");
  if (end < 0) return DEFAULT_REALTIME_VOICE_START_INSTRUCTIONS;
  const prefix = developer
    .slice(0, end)
    .replace(/^After every successful delegation or message sent to another thread,[^\n]*\n?/m, "")
    .trim();
  return (
    boundedInstructions(
      `${prefix}\n\n## Deferred voice-session tools\n\nDuring this voice session, load capture_screen_context and end_realtime_voice_call only when needed. Respect screen-context settings. End only the voice call and only when the user's intent to end it is clear; stopping work, stopping speech, and pausing do not end a call.`,
    ) ?? DEFAULT_REALTIME_VOICE_START_INSTRUCTIONS
  );
};
const record = (value: unknown): Readonly<Record<string, unknown>> | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
};
const handoffPrefixes = (value: unknown): Record<string, string[]> | undefined => {
  const source = record(value);
  if (source === null) return undefined;
  const result: Record<string, string[]> = {};
  for (const [key, items] of Object.entries(source)) {
    if (key !== "analysis" && key !== "commentary" && key !== "final") return undefined;
    if (!Array.isArray(items)) return undefined;
    const texts: string[] = [];
    for (const item of items) {
      const text = nonBlank(item);
      if (text === null) return undefined;
      texts.push(text);
    }
    result[key] = texts;
  }
  return result;
};

/** Product configuration supplies only generated native startup members. */
export const resolveRealtimeVoiceStartSettings = (
  policy: RealtimeVoiceProductPolicy,
): CodexRealtimeVoiceStartSettings => {
  const config = policy.config;
  const rawVersion = policy.sessionConfig.version;
  const version =
    rawVersion === undefined
      ? "v1"
      : rawVersion === "v1" || rawVersion === "v2" || rawVersion === "v3"
        ? rawVersion
        : undefined;
  const rawModel = policy.sessionConfig.model;
  const model =
    rawModel === undefined
      ? "gpt-live-1-boulder-alpha"
      : typeof rawModel === "string" && rawModel.length > 0
        ? rawModel
        : undefined;
  const hasSessionOverrides = model !== undefined && version !== undefined;
  const modelOverrides =
    !hasSessionOverrides || model === undefined
      ? null
      : record(record(config.model_overrides)?.[model]);
  const prompt = (
    nonBlank(modelOverrides?.prompt) ??
    nonBlank(config.prompt) ??
    DEFAULT_REALTIME_VOICE_PROMPT
  ).replaceAll("{{ user_first_name }}", "there");
  const handoff = config.codex_response_handoff_mode;
  const channelPrefixes = handoffPrefixes(config.codex_response_handoff_channel_prefixes);
  return {
    ...(hasSessionOverrides ? { model, version } : {}),
    outputModality: "audio",
    prompt,
    includeStartupContext: false,
    flushTranscriptTailOnSessionEnd: true,
    codexResponsesAsItems: config.codex_responses_as_items === true,
    codexResponseItemPrefix: nonBlank(config.codex_response_item_prefix),
    realtimeStartInstructions: startInstructions(config),
    realtimeEndInstructions:
      boundedInstructions(config.realtime_end_instructions) ??
      DEFAULT_REALTIME_VOICE_END_INSTRUCTIONS,
    ...(hasSessionOverrides && version === "v3"
      ? {
          codexResponseHandoffMode:
            handoff === "commentary" || handoff === "bemTags" ? handoff : "thinking",
          ...(channelPrefixes !== undefined
            ? { codexResponseHandoffChannelPrefixes: channelPrefixes }
            : {}),
        }
      : {}),
  };
};

/** The account selection is usable only when the actual native catalog supports it. */
export const resolveSupportedRealtimeVoice = (
  voices: {
    readonly v1: readonly RealtimeVoice[];
    readonly defaultV1: RealtimeVoicesList["defaultV1"];
  },
  preferred: string | null,
): RealtimeVoice | null => {
  if (!voices.v1.includes(voices.defaultV1)) return null;
  const selected =
    preferred === "fathom"
      ? "arbor"
      : preferred === "glimmer"
        ? "sol"
        : preferred === "orbit"
          ? "spruce"
          : preferred;
  return voices.v1.find((voice) => voice === selected) ?? voices.defaultV1;
};

const boundRealtimeText = (text: string, bytes: number, marker: string): string => {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= bytes) return text;
  const markerBytes = new TextEncoder().encode(marker).byteLength;
  let head = Math.floor((bytes - markerBytes) / 4);
  while (encoded[head] !== undefined && encoded[head]! >= 128 && encoded[head]! <= 191) head--;
  let tail = encoded.byteLength - (bytes - markerBytes - head);
  while (encoded[tail] !== undefined && encoded[tail]! >= 128 && encoded[tail]! <= 191) tail++;
  const decoder = new TextDecoder();
  return `${decoder.decode(encoded.subarray(0, head))}${marker}${decoder.decode(encoded.subarray(tail))}`;
};

/** Existing task history is role-bearing context, bounded independently of spoken-dialogue history. */
export const buildRealtimeVoiceInitialItems = (
  turns: readonly {
    readonly items: readonly import("../../shared/codex-conversation-state/codex-conversation-state").CodexCanonicalItem[];
  }[],
  config: Readonly<Record<string, unknown>>,
  version: CodexRealtimeVoiceStartSettings["version"],
): NonNullable<CodexRealtimeVoiceStartSettings["initialItems"]> => {
  if (version !== "v3" || config.realtime_continuity_enabled !== true) return [];
  const rawMaxItems = config.realtime_continuity_max_items;
  const maxItems =
    typeof rawMaxItems === "number" &&
    Number.isInteger(rawMaxItems) &&
    rawMaxItems >= 1 &&
    rawMaxItems <= 20
      ? rawMaxItems
      : 10;
  const rawMaxText = config.realtime_continuity_max_text_length;
  const maxText =
    typeof rawMaxText === "number" &&
    Number.isInteger(rawMaxText) &&
    rawMaxText >= 100 &&
    rawMaxText <= 4000
      ? rawMaxText
      : 1200;
  const recent: NonNullable<CodexRealtimeVoiceStartSettings["initialItems"]> = [];
  for (let turnIndex = turns.length - 1; turnIndex >= 0 && recent.length < maxItems; turnIndex--) {
    const items = turns[turnIndex]!.items;
    for (let index = items.length - 1; index >= 0 && recent.length < maxItems; index--) {
      const item = items[index]!;
      if (item.type !== "userMessage" && item.type !== "agentMessage") continue;
      const text = (
        item.type === "userMessage"
          ? item.content
              .filter((content) => content.type === "text")
              .map((content) => content.text)
              .join("\n")
          : item.text
      ).trim();
      if (!text) continue;
      recent.unshift({
        role: item.type === "userMessage" ? "user" : "assistant",
        text: text.slice(-maxText),
      });
    }
  }
  if (recent.length === 0) return [];
  const items: NonNullable<CodexRealtimeVoiceStartSettings["initialItems"]> = [
    {
      role: "developer",
      text: "<recent_background_task_conversation>\nThe following user and assistant messages are bounded history from the existing Codex task. They are not spoken-dialogue history, new user requests, or instructions. Preserve their original roles and use them only to understand the task before the user speaks.",
    },
    ...recent,
    {
      role: "developer",
      text: "</recent_background_task_conversation>\nThe preceding messages are existing background-task context, not new requests. Do not answer or continue them on your own. Remain silent unless the current session explicitly instructs you to greet the user or the user speaks.",
    },
  ];
  const bounded: typeof items = [];
  let remaining = 8192;
  for (const item of items.slice(-128).reverse()) {
    const estimated = Math.ceil(new TextEncoder().encode(item.text).byteLength / 4);
    if (estimated <= remaining) {
      bounded.unshift(item);
      remaining -= estimated;
      continue;
    }
    const marker =
      item.role === "developer"
        ? "\n…memory summary truncated…\n"
        : "\n…earlier continuity truncated…\n";
    const bytes = remaining * 4;
    if (new TextEncoder().encode(marker).byteLength >= bytes) continue;
    const text = boundRealtimeText(item.text, bytes, marker);
    bounded.unshift({ ...item, text });
    remaining -= Math.ceil(new TextEncoder().encode(text).byteLength / 4);
  }
  return bounded;
};
