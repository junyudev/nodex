import { createHash } from "node:crypto";
import { countWords } from "../../shared/word-count";
import {
  MAX_INBOX_ADDITION_CHARS,
  MAX_INBOX_ADDITIONS,
  type InboxAgentChoice,
  type InboxDispatchAction,
  type InboxEntryKind,
} from "../../shared/inbox";
import { isOfferedInboxChoice, type InboxAgentCandidate } from "./inbox-agent-candidates";
import type {
  CoreInboxDispatchContext,
  CoreInboxSuggestionInput,
  CoreInboxSuggestionRequest,

/** Identity depends only on the request fence, never on mutable routing context. */
export const inboxRoutingIdentity = (
  request: Pick<CoreInboxSuggestionRequest, "request_id" | "generation">,
  followup = false,
) => {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        "inbox-routing",
        request.request_id,
        request.generation,
        ...(followup ? ["followup"] : []),
      ]),
    )
    .digest("hex");
  return { messageId: `inbox-routing:${fingerprint}`, fingerprint };
};

/** The Runtime retains this message's admission and carrying Run across Host restarts. */
export const renderInboxRoutingFollowup = (request: CoreInboxSuggestionRequest) =>
  `Routing request ${request.request_id} (generation ${request.generation}) is still unanswered.${
    request.delivery?.last_refusal ? ` Last refusal: ${request.delivery.last_refusal}` : ""
  } Answer it with inbox_suggest using the original request's data and offered choices.`;

export const INBOX_SUGGESTION_BATCH = 8;
export const INBOX_SUGGESTION_MAX_OUTPUT_BYTES = 48 * 1024;
export const INBOX_SUGGESTION_MAX_INPUT_BYTES = 240 * 1024;
/** Looking things up can take as long as any utility request may run. */
export const INBOX_SUGGESTION_TIMEOUT_MS = 180_000;
export const INBOX_ROUTING_DEADLINE_MS = INBOX_SUGGESTION_TIMEOUT_MS + 120_000;
export const INBOX_ROUTING_HANDOVER_CAP_MS = 30 * 60_000;
export const inboxRoutingDeadline = (
  delivery: NonNullable<CoreInboxSuggestionRequest["delivery"]>,
) =>
  delivery.run_started_at_ms == null
    ? delivery.handed_over_at_ms + INBOX_ROUTING_HANDOVER_CAP_MS + (delivery.paused_ms ?? 0)
    : delivery.run_started_at_ms + INBOX_ROUTING_DEADLINE_MS + (delivery.paused_ms ?? 0);
export const INBOX_PROMPT_VERSION = "inbox-routing-v14";
export const INBOX_SCHEMA_VERSION = "inbox-routing-v8";
const MAX_PROMPT_CHARS = 2_000;
const MAX_SUMMARY_CHARS = 200;
const MAX_RATIONALE_CHARS = 600;
const MAX_TITLE_CHARS = 80;

export interface InboxSuggestionRequestIdentity {
  readonly requestId: string;
  readonly generation: number;
  readonly mode: "auto" | "grouped" | "refine";
  readonly correction?: string | null;
}

export { InboxSuggestionOutput } from "../../shared/nodex-app-tools/coordinator-schema";
import { InboxSuggestionOutput } from "../../shared/nodex-app-tools/coordinator-schema";

const clip = (text: string, maximum: number) =>
  text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;

/**
 * What a suggestion may run new chats on. Absent when the user keeps one Agent for every chat,
 * so the suggestion only routes.
 */
export interface InboxSuggestionAgents {
  readonly candidates: readonly InboxAgentCandidate[];
  /** What a new chat runs on when the suggestion leaves its Agent null. */
  readonly defaultChat: {
    readonly instance_id: string;
    readonly model: string;
    readonly effort: string | null;
  } | null;
}

/** JSON data cannot escape a fabricated XML message wrapper; the prompt is not a permissions boundary. */
export const renderInboxRoutingRequest = (input: {
  readonly context: CoreInboxDispatchContext;
  readonly instructions: string;
  readonly request: InboxSuggestionRequestIdentity;
  readonly agents: InboxSuggestionAgents | null;
  readonly attachedImageMarkers?: readonly number[];
}): string => {
  const { context, request, agents } = input;
  const attached = new Set(input.attachedImageMarkers);
  let imageNumber = 0;
  const messages = context.entries.flatMap((entry) => {
    const markers = entry.images.map(() => ++imageNumber);
    return [
      {
        page_id: entry.page_id,
        page_key: entry.page_key,
        reply_to: entry.reply_to ?? null,
        handback: entry.handback ?? null,
        body: entry.body,
        source: entry.source,
        kind: entry.kind,
        submitted_at: entry.submitted_at,
        scope: entry.scope,
        basis: entry.basis,
        title_provisional: entry.title_provisional,
        attached_images: markers
          .filter((marker) => attached.has(marker))
          .map((marker) => `[Image #${marker}]`),
        unavailable_images: markers
          .filter((marker) => !attached.has(marker))
          .map((marker) => `[Image #${marker}]`),
      },
    ];
  });
  const data = {
    request: {
      schema_version: INBOX_SCHEMA_VERSION,
      request_id: request.requestId,
      generation: request.generation,
      mode: request.mode,
      scope: context.scope,
      allowed_actions:
        context.scope.kind === "project"
          ? ["keep", "new_chat", "send_to_chat", "plan"]
          : ["keep", "new_chat", "send_to_chat", "move_to_project", "plan"],
      budgets: {
        prompt: MAX_PROMPT_CHARS,
        summary: MAX_SUMMARY_CHARS,
        rationale: MAX_RATIONALE_CHARS,
        additions: { count: MAX_INBOX_ADDITIONS, chars: MAX_INBOX_ADDITION_CHARS },
      },
    },
    preferences: input.instructions,
    ...(agents ? { agents: agents.candidates, default_chat_agent: agents.defaultChat } : {}),
    projects: context.projects.map((project) => ({
      ...project,
      description: clip(project.description, 200),
    })),
    sessions: context.sessions.map((session) => ({
      ...session,
      title: clip(session.title, 120),
      preview: clip(session.preview, 600),
    })),
    messages,
    current_proposals: context.open_proposals.filter(
    ),
    correction: request.correction ?? null,
  };
  const prompt = `Routing request
Submit with inbox_suggest; echo request_id and generation exactly. Cover all page_ids exactly once, using only the supplied actions and target IDs. grouped/refine requires one action; a correction revises only its supplied proposal and members.
keep: null targets/prompt; new_chat: project_id (nullable in Library) and prompt; send_to_chat: only session_id and prompt; move_to_project: only project_id. Only new_chat sets chat_instance_id/chat_model/chat_effort, using an offered choice; otherwise these are null. Only chat actions have additions; otherwise []. explicit_request is a required boolean on every suggestion. plan: null targets/prompt/chat fields, no additions, explicit_request false, and steps [{key,project_id,title,body,agent:{instance_id,model,effort}|null,blocked_by:[key]}]. Plans have 2–8 unique step keys, only eligible Projects (a Project Inbox stays in its Project), offered Agent choices or null for the chat default, and acyclic prerequisites naming other steps. Step titles are at most 120 characters and bodies at most 4000. Only plans carry steps. Plans always wait for the user.
${agents === null ? "No Agent choices are offered for this request. chat_instance_id, chat_model and chat_effort must all be null, including for new_chat; every plan step agent must also be null. Choices from earlier requests or list_agent_models do not apply.\n" : ""}For explicit_request true, use at most 30 words in prompt and no additions.
Budgets: at most 16 suggestions/titles/members; prompt 2000, summary 200, rationale 600, provisional message title 80 characters; at most 12 additions of 600 characters. summary is nonempty; rationale may be null. Titles name only provisional messages. The whole response is at most 48 KiB.
Bodies use Nodex Markdown. [Image #N] marks its position. Attached images follow attached_images in message order; unavailable_images have no attachment. This request's data and scope supersede historical routing data.
JSON data:
${JSON.stringify(data)}`;
  if (Buffer.byteLength(prompt, "utf8") > INBOX_SUGGESTION_MAX_INPUT_BYTES)
    throw new Error("These messages exceed the suggestion input budget; select fewer messages");
  return prompt;
};

export interface ValidatedInboxSuggestion {
  readonly pageIds: readonly string[];
  readonly explicitRequest: boolean;
  readonly kind: InboxEntryKind;
  readonly action: InboxDispatchAction;
  readonly summary: string;
  readonly rationale: string | null;
}
export interface InboxSuggestionValidation {
  readonly suggestions: readonly ValidatedInboxSuggestion[];
  readonly titles: ReadonlyMap<string, string>;
}

const TRAILING_TITLE_PUNCTUATION = /[\s.,;:!?。，；：！？、…]+$/u;
const WRAPPING_QUOTES = /^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/gu;
export const cleanInboxTitle = (raw: string): string | null => {
  const title = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(WRAPPING_QUOTES, "")
    .replace(TRAILING_TITLE_PUNCTUATION, "")
    .trim();
  return title && title.length <= MAX_TITLE_CHARS ? title : null;
};

/**
 * A malformed decision invalidates the whole request; never silently repair authorization.
 * The Agent, model and effort a new chat names must be one it was offered, since Nodex starts
 * it exactly; how it chooses among them is its own judgment.
 */
export const validateInboxSuggestions = (
  supplied: unknown,
  context: CoreInboxDispatchContext,
  entries: readonly CoreInboxSuggestionInput[],
  request: InboxSuggestionRequestIdentity,
  candidates: readonly InboxAgentCandidate[] = [],
): InboxSuggestionValidation => {
  if (Buffer.byteLength(JSON.stringify(supplied) ?? "", "utf8") > INBOX_SUGGESTION_MAX_OUTPUT_BYTES)
    throw new Error("Invalid Inbox suggestion: output exceeds the 48 KiB budget");
  const output = InboxSuggestionOutput.parse(supplied);
  const reject = (reason: string): never => {
    throw new Error(`Invalid Inbox suggestion: ${reason}`);
  };
  if (output.request_id !== request.requestId || output.generation !== request.generation)
    reject("request identity changed");
  if (request.mode !== "auto" && output.suggestions.length !== 1)
    reject("a selected group needs one decision");
  const entryIds = new Set(entries.map((entry) => entry.page_id));
  const projectIds = new Set(context.projects.map((project) => project.project_id));
  const projectId = context.scope.kind === "project" ? context.scope.project_id : null;
  const sessionIds = new Set(
    context.sessions
      .filter((session) => projectId === null || session.project_id === projectId)
      .map((session) => session.session_id),
  );
  const claimed = new Set<string>();
  const suggestions: ValidatedInboxSuggestion[] = [];
  const offered = (instanceId: string, model: string | null, effort: string | null) => {
    const agent: InboxAgentChoice = {
      instanceId,
      model,
      reasoningEffort: effort,
      serviceTier: null,
    };
    if (!isOfferedInboxChoice(candidates, agent))
      reject("an Agent, model or effort was not offered");
    return agent;
  };
  for (const raw of output.suggestions) {
    for (const id of raw.page_ids) {
      if (!entryIds.has(id) || claimed.has(id)) reject("unknown or duplicate member");
      claimed.add(id);
    }
    if (!raw.summary.trim()) reject("missing summary");
    const prompt = raw.prompt?.trim();
    if (raw.explicit_request && (raw.action === "new_chat" || raw.action === "send_to_chat")) {
      const count = countWords(prompt ?? "");
      if (count > 30 || raw.additions.length > 0)
        reject(
          `an explicit request has a ${count}-word routing note and ${raw.additions.length} additions; use at most 30 words and no additions`,
        );
    }
    const chooses =
      raw.chat_instance_id !== null || raw.chat_model !== null || raw.chat_effort !== null;
    if (raw.action !== "new_chat" && chooses) reject("only a new chat chooses Agents");
    const additions = raw.additions.map((addition) => addition.trim());
    if (additions.some((addition) => !addition)) reject("an empty addition");
    if (raw.action !== "new_chat" && raw.action !== "send_to_chat" && additions.length > 0)
      reject("only a chat prompt has additions");
    if (raw.action !== "plan" && raw.steps !== undefined) reject("only plans carry steps");
    let action: InboxDispatchAction;
    switch (raw.action) {
      case "plan": {
        if (
          raw.explicit_request ||
          raw.project_id !== null ||
          raw.session_id !== null ||
          raw.prompt !== null ||
          !raw.steps
        )
          reject("plans require user confirmation and only step destinations");
        const steps = raw.steps!;
        const keys = new Set(steps.map((step) => step.key));
        if (keys.size !== steps.length) reject("duplicate plan step keys");
        for (const step of steps) {
          if (
            !projectIds.has(step.project_id) ||
            (projectId !== null && step.project_id !== projectId)
          )
            reject("invalid plan Project");
          if (step.agent) offered(step.agent.instance_id, step.agent.model, step.agent.effort);
          if (
            new Set(step.blocked_by).size !== step.blocked_by.length ||
            step.blocked_by.some((key) => !keys.has(key) || key === step.key)
          )
            reject("invalid plan prerequisite key");
        }
        const complete = new Set<string>();
        const visit = (key: string, visiting: Set<string>): void => {
          if (visiting.has(key)) reject("plan prerequisites contain a cycle");
          if (complete.has(key)) return;
          const next = new Set(visiting).add(key);
          for (const blocker of steps.find((step) => step.key === key)!.blocked_by)
            visit(blocker, next);
          complete.add(key);
        };
        for (const key of keys) visit(key, new Set());
        action = {
          type: "plan",
          summary: raw.summary.trim(),
          steps: steps.map((step) => ({
            key: step.key,
            projectId: step.project_id,
            title: step.title,
            body: step.body,
            agent: step.agent
              ? {
                  instanceId: step.agent.instance_id,
                  model: step.agent.model,
                  effort: step.agent.effort,
                }
              : null,
            blockedBy: step.blocked_by,
          })),
        };
        break;
      }
      case "keep":
        if (raw.project_id !== null || raw.session_id !== null || raw.prompt !== null)
          reject("keep has execution fields");
        action = { type: "keep" };
        break;
      case "new_chat":
        if (
          !prompt ||
          raw.session_id !== null ||
          (raw.project_id !== null && !projectIds.has(raw.project_id)) ||
          (projectId !== null && raw.project_id !== projectId)
        )
          reject("invalid new chat destination or prompt");
        if (raw.chat_instance_id === null && (raw.chat_model !== null || raw.chat_effort !== null))
          reject("a chat model needs its Agent");
        action = {
          type: "new_chat",
          projectId: raw.project_id,
          prompt: prompt!,
          agent:
            raw.chat_instance_id === null
              ? null
              : offered(raw.chat_instance_id, raw.chat_model, raw.chat_effort),
          additions,
        };
        break;
      case "send_to_chat":
        if (
          !prompt ||
          raw.project_id !== null ||
          raw.session_id === null ||
          !sessionIds.has(raw.session_id)
        )
          reject("invalid existing chat destination or prompt");
        action = { type: "send_to_chat", sessionId: raw.session_id!, prompt: prompt!, additions };
        break;
      case "move_to_project":
        if (
          projectId !== null ||
          raw.project_id === null ||
          !projectIds.has(raw.project_id) ||
          raw.session_id !== null ||
          raw.prompt !== null
        )
          reject("invalid move destination");
        action = { type: "move_to_project", projectId: raw.project_id! };
        break;
    }
    suggestions.push({
      explicitRequest: raw.explicit_request,
      pageIds: raw.page_ids,
      kind: raw.kind,
      action,
      summary: raw.summary.trim(),
      rationale: raw.rationale?.trim() || null,
    });
  }
  if (claimed.size !== entryIds.size) reject("missing members");
  const provisional = new Set(
    entries.filter((entry) => entry.title_provisional).map((entry) => entry.page_id),
  );
  const titles = new Map<string, string>();
  for (const raw of output.titles) {
    const title = cleanInboxTitle(raw.title);
    if (!provisional.has(raw.page_id) || titles.has(raw.page_id) || !title)
      reject("invalid title member or title");
    titles.set(raw.page_id, title!);
  }
  return { suggestions, titles };
};

const MAX_FAILURE_CHARS = 160;
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

const GENERATION_FAILURE_PREFIX = /^Text generation failed in [^:]+: /;
const CLI_FAILURE = /^(.*?CLI command failed): ([\s\S]*)$/;

/**
 * A runtime failure reduced to what may be logged or shown. A CLI's own output can echo the
 * captured text it was given, so only its final line is kept, and only when it reads as an error.
 */
export const loggableInboxRuntimeFailure = (reason: string): string => {
  const stripped = reason.replace(GENERATION_FAILURE_PREFIX, "");
  const cli = CLI_FAILURE.exec(stripped);
  if (!cli) return (stripped.split("\n")[0] ?? "").trim().slice(0, 500);
  const last =
    cli[2]!
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? "";
  return /error|fail|status|denied|refused|unauthori[sz]ed|disconnect/i.test(last)
    ? `${cli[1]}: ${last.slice(0, 300)}`
    : cli[1]!;
};

/** Turns runtime failures into one short reason the stream can show beside a message. */
export const describeInboxRuntimeFailure = (
  message: string,
  subject: "suggestion" | "dispatch",
): string => {
  const agent = subject === "suggestion" ? "the suggestion agent" : "the chat runtime";
  if (/\b401\b|unauthori[sz]ed|not (?:logged|signed) in|missing bearer|api key/i.test(message)) {
    return `Sign in to ${agent} first`;
  }
  if (/timed? ?out|deadline/i.test(message)) return `${capitalize(agent)} timed out`;
  if (/rate.?limit|\b429\b/i.test(message)) return `${capitalize(agent)} is rate limited`;
  if (/exceeded (?:its|their) .*budget/i.test(message)) {
    return `${capitalize(agent)} answered at more length than Nodex reads`;
  }
  if (/invalid (?:structured output|suggestion)|without a structured answer/i.test(message)) {
    return `${capitalize(agent)} answered in a form Nodex couldn’t read`;
  }
  const firstLine = loggableInboxRuntimeFailure(message);
  if (!firstLine) return subject === "suggestion" ? "The suggestion failed" : "The chat failed";
  return firstLine.length <= MAX_FAILURE_CHARS
    ? firstLine
    : `${firstLine.slice(0, MAX_FAILURE_CHARS - 1).trimEnd()}…`;
};
