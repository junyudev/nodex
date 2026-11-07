import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import {
  isFreeModel,
  isModelOn,
  spendsNodexCredit,
  type ModelPolicy,
} from "../../../shared/model-policy";
import { formatNodexCredits } from "../../../shared/nodex-models";
import type { ProjectCandidate } from "../../../shared/project-discovery";
import { agentReadinessProblem } from "../local-conversation/agent-readiness-notice";

export const FIRST_RUN_STEPS = ["agents", "projects"] as const;
export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number];

/** What the first task asks for, which depends on where the person chose to work. */
export type FirstTask = "existing-folder" | "empty-folder" | "no-project";

export interface FirstRunLanding {
  readonly projectId: string | null;
  readonly task: FirstTask;
}

/**
 * `first-run` is a new Profile's flow; `replay` is the person running it again; `connect` opens
 * only the Agents step, from a Composer that has no Agent to use.
 */
export type FirstRunEntry = "first-run" | "replay" | "connect";

export interface FirstRunState {
  readonly done: boolean;
  /** The step in progress, kept so that quitting part-way resumes there. */
  readonly step: FirstRunStep | null;
  readonly entry: FirstRunEntry;
}

export const INITIAL_FIRST_RUN_STATE: FirstRunState = {
  done: false,
  step: null,
  entry: "first-run",
};

const isStep = (value: unknown): value is FirstRunStep =>
  FIRST_RUN_STEPS.includes(value as FirstRunStep);

export function normalizeFirstRunState(value: unknown): FirstRunState {
  if (!value || typeof value !== "object") return INITIAL_FIRST_RUN_STATE;
  const record = value as Record<string, unknown>;
  return {
    done: record.done === true,
    step: isStep(record.step) ? record.step : null,
    entry: record.entry === "replay" || record.entry === "connect" ? record.entry : "first-run",
  };
}

export type FirstRunDecision = "undecided" | "show" | "hide";

/**
 * A Profile that already holds work never sees the flow, however that work got there. A failed read
 * opens the app: setup must never stand between a person and their Workbench.
 */
export function decideFirstRun(input: {
  readonly state: FirstRunState | null;
  readonly workspace: "empty" | "ready" | "unknown" | null;
}): FirstRunDecision {
  if (!input.state) return "undecided";
  if (input.state.done) return "hide";
  if (input.state.step) return "show";
  if (input.workspace === null) return "undecided";
  return input.workspace === "empty" ? "show" : "hide";
}

export const firstRunSteps = (entry: FirstRunEntry): readonly FirstRunStep[] =>
  entry === "connect" ? ["agents"] : FIRST_RUN_STEPS;

export function nextFirstRunStep(entry: FirstRunEntry, step: FirstRunStep): FirstRunStep | null {
  const steps = firstRunSteps(entry);
  return steps[steps.indexOf(step) + 1] ?? null;
}

export function previousFirstRunStep(
  entry: FirstRunEntry,
  step: FirstRunStep,
): FirstRunStep | null {
  const steps = firstRunSteps(entry);
  return steps[steps.indexOf(step) - 1] ?? null;
}

const FIRST_TASK_PROMPTS: Readonly<Record<FirstTask, string>> = {
  "existing-folder":
    "Get to know this project, then write a short brief as a Nodex Page and open it beside this chat: what it does, how it's organized, how to run it, and three things worth improving. Don't change any code.",
  "empty-folder":
    "Ask me what I'd like to make here, then build a small first version and tell me how to run it.",
  "no-project":
    "Ask me what I'm working on, then write a one-page plan for it as a Nodex Page and open it beside this chat.",
};

export const firstTaskPrompt = (task: FirstTask): string => FIRST_TASK_PROMPTS[task];

type RuntimeProvider = AgentRuntimeOperations["providers.read"]["output"][number];

export type FirstRunAgentId = "codex" | "claude" | "nodex" | "opencode";

export type FirstRunAgentAction =
  | "codex-sign-in"
  | "codex-cancel-sign-in"
  | "claude-sign-in"
  | "claude-install"
  | "nodex-sign-in"
  | "nodex-cancel-sign-in"
  | "opencode-install"
  | "opencode-use";

export interface FirstRunAgentRow {
  readonly id: FirstRunAgentId;
  readonly label: string;
  readonly detail: string;
  readonly state: "checking" | "ready" | "action" | "waiting";
  readonly action: { readonly kind: FirstRunAgentAction; readonly label: string } | null;
  /** The ways to add credits open beneath the row. */
  readonly offersTopUp?: boolean;
}

export interface FirstRunAgentInputs {
  /** Null until the first catalog read has answered. */
  readonly providers: readonly RuntimeProvider[] | null;
  readonly policy: ModelPolicy;
  readonly codexLoginPending: boolean;
  readonly nodex: {
    readonly configured: boolean;
    readonly signedIn: boolean;
    readonly signingIn: boolean;
    readonly identity: string | null;
    /** Credits, or null until the wallet has been read. */
    readonly balance: number | null;
    readonly notice: string | null;
  };
  readonly openCodeInstall: "checking" | "installing" | "installable" | "installed" | "unavailable";
}

const NOT_READY_DETAIL = "Isn’t ready. See Settings → Agents.";
const CLAUDE_DRIVER = "claudeAgent";
const OPENCODE_DRIVERS: readonly string[] = ["opencode", "opencode2"];

const checking = (id: FirstRunAgentId, label: string): FirstRunAgentRow => ({
  id,
  label,
  detail: "Checking…",
  state: "checking",
  action: null,
});

const signedInDetail = (provider: RuntimeProvider): string =>
  provider.auth.email ?? provider.auth.label ?? "Signed in";

function codexRow(input: FirstRunAgentInputs): FirstRunAgentRow {
  const label = "Codex";
  const provider = input.providers?.find((entry) => entry.instanceId === "codex");
  if (!input.providers) return checking("codex", label);
  if (input.codexLoginPending)
    return {
      id: "codex",
      label,
      detail: "Finish signing in in your browser",
      state: "waiting",
      action: { kind: "codex-cancel-sign-in", label: "Cancel" },
    };
  const problem = agentReadinessProblem(provider);
  if (provider && !problem)
    return { id: "codex", label, detail: signedInDetail(provider), state: "ready", action: null };
  if (problem === "not-ready" || problem === "turned-off")
    return { id: "codex", label, detail: NOT_READY_DETAIL, state: "action", action: null };
  return {
    id: "codex",
    label,
    detail: "Sign in with your ChatGPT account",
    state: "action",
    action: { kind: "codex-sign-in", label: "Sign in" },
  };
}

function claudeRow(input: FirstRunAgentInputs): FirstRunAgentRow | null {
  const label = "Claude Code";
  if (!input.providers) return checking("claude", label);
  const profiles = input.providers.filter(
    (entry) => entry.driver === CLAUDE_DRIVER && !spendsNodexCredit(entry),
  );
  const ready = profiles.find((entry) => !agentReadinessProblem(entry));
  if (ready)
    return { id: "claude", label, detail: signedInDetail(ready), state: "ready", action: null };
  const problem = agentReadinessProblem(profiles[0]);
  // Turning an Agent off is a choice this page doesn't argue with.
  if (problem === "turned-off") return null;
  if (problem === "not-ready")
    return { id: "claude", label, detail: NOT_READY_DETAIL, state: "action", action: null };
  if (problem === "signed-out")
    return {
      id: "claude",
      label,
      detail: "Sign in with your Claude account",
      state: "action",
      action: { kind: "claude-sign-in", label: "Sign in" },
    };
  return {
    id: "claude",
    label,
    detail: "Install Claude Code, then sign in",
    state: "action",
    action: { kind: "claude-install", label: "Install" },
  };
}

function nodexRow(input: FirstRunAgentInputs): FirstRunAgentRow | null {
  const { nodex } = input;
  if (!nodex.configured) return null;
  const id = "nodex";
  const label = "Nodex credits";
  if (nodex.signingIn)
    return {
      id,
      label,
      detail: nodex.notice ?? "Finish signing in in your browser",
      state: "waiting",
      action: { kind: "nodex-cancel-sign-in", label: "Cancel" },
    };
  if (!nodex.signedIn) {
    // The hosted page covers both a new account and an existing one, so the button doesn't choose.
    const returning = nodex.identity !== null;
    return {
      id,
      label,
      detail:
        nodex.notice ??
        (returning
          ? `${nodex.identity} · Sign in again`
          : "GPT and Claude with no subscription. Pay as you go."),
      state: "action",
      action: { kind: "nodex-sign-in", label: returning ? "Sign in" : "Get started" },
    };
  }
  // Only whole credits can be spent, so a fraction left over isn't a balance.
  const credits = nodex.balance === null ? null : Math.trunc(nodex.balance);
  if (credits !== null && credits > 0)
    return {
      id,
      label,
      detail: `${formatNodexCredits(credits)} credits`,
      state: "ready",
      action: null,
    };
  const identity = nodex.identity ?? "Signed in";
  return {
    id,
    label,
    detail: nodex.notice ?? (credits === null ? identity : `${identity} · No credits yet`),
    state: "action",
    action: null,
    offersTopUp: credits !== null,
  };
}

function openCodeRow(input: FirstRunAgentInputs): FirstRunAgentRow | null {
  const label = "OpenCode";
  const detail = "Free, no account. Providers may keep what you send.";
  if (input.openCodeInstall === "unavailable") return null;
  if (input.openCodeInstall === "checking" || !input.providers) return checking("opencode", label);
  if (input.openCodeInstall === "installing")
    return { id: "opencode", label, detail: "Installing…", state: "waiting", action: null };
  if (input.openCodeInstall === "installable")
    return {
      id: "opencode",
      label,
      detail,
      state: "action",
      action: { kind: "opencode-install", label: "Install" },
    };
  const providers = input.providers.filter(
    (entry) => OPENCODE_DRIVERS.includes(entry.driver) && !agentReadinessProblem(entry),
  );
  const freeModels = providers.flatMap((provider) =>
    provider.models
      .filter((model) => isFreeModel(model.slug))
      .map((model) => ({ provider, model })),
  );
  const onCount = providers
    .flatMap((provider) => provider.models.map((model) => ({ provider, model })))
    .filter(({ provider, model }) => isModelOn(input.policy, provider, model.slug)).length;
  if (onCount > 0)
    return {
      id: "opencode",
      label,
      detail: onCount === 1 ? "1 model on" : `${onCount} models on`,
      state: "ready",
      action: null,
    };
  if (freeModels.length === 0)
    return {
      id: "opencode",
      label,
      detail: "Sign in to a model provider in Settings",
      state: "action",
      action: null,
    };
  return {
    id: "opencode",
    label,
    detail,
    state: "action",
    action: { kind: "opencode-use", label: "Use free models" },
  };
}

/** The Agents the first step offers, in the order a person is most likely to want them. */
export function firstRunAgentRows(input: FirstRunAgentInputs): readonly FirstRunAgentRow[] {
  return [codexRow(input), claudeRow(input), nodexRow(input), openCodeRow(input)].flatMap((row) =>
    row ? [row] : [],
  );
}

/** Rows that are already usable come first; the order then holds still as others change. */
export function orderFirstRunAgents(rows: readonly FirstRunAgentRow[]): readonly FirstRunAgentId[] {
  return rows
    .toSorted((left, right) => Number(right.state === "ready") - Number(left.state === "ready"))
    .map((row) => row.id);
}

export interface FirstRunFolderChoice {
  readonly key: string;
  readonly kind: "candidate" | "folder" | "empty";
  readonly name: string;
  readonly path: string | null;
  readonly candidate: ProjectCandidate | null;
}

export const candidateChoice = (candidate: ProjectCandidate): FirstRunFolderChoice => ({
  key: candidate.path,
  kind: "candidate",
  name: candidate.repository ?? candidate.name,
  path: candidate.path,
  candidate,
});

/** Folders the Profile doesn't work in yet, keeping the scan's most-useful-first order. */
export function offeredCandidates(
  candidates: readonly ProjectCandidate[],
  projectRoots: ReadonlySet<string>,
): readonly ProjectCandidate[] {
  return candidates.filter((candidate) => !projectRoots.has(candidate.path));
}

export function firstTaskForChoice(choice: FirstRunFolderChoice | null): FirstTask {
  if (!choice) return "no-project";
  return choice.kind === "empty" ? "empty-folder" : "existing-folder";
}

const relativeUnits = [
  { limit: 60 * 60_000, size: 60_000, unit: "minute" },
  { limit: 24 * 60 * 60_000, size: 60 * 60_000, unit: "hour" },
  { limit: 30 * 24 * 60 * 60_000, size: 24 * 60 * 60_000, unit: "day" },
  { limit: 365 * 24 * 60 * 60_000, size: 30 * 24 * 60 * 60_000, unit: "month" },
] as const;

/** `3 chats · 2 days ago`, the row detail for a folder an Agent has worked in. */
export function candidateActivity(candidate: ProjectCandidate, now: number): string {
  const chats = candidate.chatCount === 1 ? "1 chat" : `${candidate.chatCount} chats`;
  const elapsed = Math.max(0, now - candidate.lastActiveAt);
  const unit = relativeUnits.find((entry) => elapsed < entry.limit);
  if (!unit) return `${chats} · over a year ago`;
  const count = Math.floor(elapsed / unit.size);
  if (count === 0) return `${chats} · just now`;
  return `${chats} · ${count} ${unit.unit}${count === 1 ? "" : "s"} ago`;
}
