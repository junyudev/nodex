import { getIntl, type IntlShape } from "@/lib/i18n";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import {
  isFreeModel,
  isModelOn,
  spendsNodexCredit,
  type ModelPolicy,
} from "../../../shared/model-policy";
import { formatNodexCredits } from "../../../shared/nodex-models";
import type { ProjectCandidate } from "../../../shared/project-discovery";
import { localAgentDefinition, type LocalAgentFound } from "../../../shared/local-agents";
import { isManagedRuntimeInstanceId } from "../../../shared/managed-runtime-instances";
import type { ProviderKeyConnection, ProviderKeyPresetId } from "../../../shared/provider-keys";
import type { AcpInstanceStatus } from "../acp-agents/acp-agent-model";
import {
  localAgentFoundDetail,
  localAgentNeedsUpdateDetail,
} from "../local-agents/local-agents-model";
import { providerKeyReadyDetail } from "../provider-keys/provider-keys-model";
import {
  agentReadinessProblem,
  isAgentUnchecked,
  type AgentReadinessProblem,
} from "../local-conversation/agent-readiness-notice";

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

/**
 * A row's identity: a built-in Agent, an Agent found on this computer (`found:<id>`), an ACP
 * instance (`acp:<instance id>`), an API key connection (`key:<connection id>`) or the way to add
 * one (`api-key`).
 */
export type FirstRunAgentId = string;

export type FirstRunAgentAction =
  | "codex-sign-in"
  | "codex-cancel-sign-in"
  | "claude-sign-in"
  | "claude-install"
  | "nodex-sign-in"
  | "nodex-cancel-sign-in"
  | "opencode-install"
  | "opencode-use"
  | "local-agent-connect"
  | "acp-connect"
  | "acp-sign-in"
  | "api-key-add"
  | "check-again";

export type FirstRunAgentMark =
  | { readonly kind: "codex" | "claude" | "opencode" | "nodex" }
  | { readonly kind: "key"; readonly preset: ProviderKeyPresetId | null }
  | { readonly kind: "acp"; readonly agentDefinitionId: string };

export interface FirstRunAgentRow {
  readonly id: FirstRunAgentId;
  /**
   * Where the row sits once the order settles. A row that takes over from another, such as a
   * connected Agent from the one found on the computer, shares its slot and so its place.
   */
  readonly slot: string;
  readonly mark: FirstRunAgentMark;
  readonly label: string;
  readonly detail: string;
  readonly state: "checking" | "ready" | "action" | "waiting";
  /**
   * Something of this Agent is already on this computer or in this Profile, so finishing it is the
   * shortest way to a working Agent. Found rows sit above the ones that start from nothing.
   */
  readonly found: boolean;
  /** The Agent's own words about what went wrong, shown beneath the row. */
  readonly note?: string;
  readonly action: {
    readonly kind: FirstRunAgentAction;
    readonly label: string;
    /** The found Agent or ACP instance the action is for. */
    readonly target?: string;
  } | null;
  /** The ways to add credits open beneath the row. */
  readonly offersTopUp?: boolean;
}

/** An ACP instance the Profile already runs, with the status Settings shows for it. */
export interface FirstRunAcpAgent {
  readonly id: string;
  readonly label: string;
  readonly agentDefinitionId: string;
  readonly status: AcpInstanceStatus;
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
  /**
   * Recognized Agents found on this computer that the Profile doesn't run yet, including a version
   * too old to connect; null until scanned.
   */
  readonly localAgents: readonly LocalAgentFound[] | null;
  /** Null until ACP settings are read. */
  readonly acpAgents: readonly FirstRunAcpAgent[] | null;
  /** Null until API key connections are read. */
  readonly providerKeys: readonly ProviderKeyConnection[] | null;
}

const CLAUDE_DRIVER = "claudeAgent";
const OPENCODE_DRIVERS: readonly string[] = ["opencode", "opencode2"];

const builtIn = (id: "codex" | "claude" | "opencode" | "nodex") => ({
  id,
  slot: id,
  mark: { kind: id },
});

const checkingDetail = (intl: IntlShape) =>
  intl.formatMessage({ id: "firstRun.firstRunModel.checking", defaultMessage: "Checking…" });

const signInLabel = (intl: IntlShape) =>
  intl.formatMessage({ id: "firstRun.firstRunModel.signIn", defaultMessage: "Sign in" });

const connectLabel = (intl: IntlShape) =>
  intl.formatMessage({ id: "firstRun.firstRunModel.connect", defaultMessage: "Connect" });

const checkAgain = (intl: IntlShape): NonNullable<FirstRunAgentRow["action"]> => ({
  kind: "check-again",
  label: intl.formatMessage({
    id: "firstRun.firstRunModel.checkAgain",
    defaultMessage: "Check again",
  }),
});

const checking = (
  id: "codex" | "claude" | "opencode",
  label: string,
  intl: IntlShape,
): FirstRunAgentRow => ({
  ...builtIn(id),
  label,
  detail: checkingDetail(intl),
  state: "checking",
  // Until it answers, an Agent holds the place of one that is there.
  found: true,
  action: null,
});

const signedInDetail = (provider: RuntimeProvider, intl: IntlShape): string =>
  provider.auth.email ??
  provider.auth.label ??
  intl.formatMessage({ id: "firstRun.firstRunModel.signedIn", defaultMessage: "Signed in" });

/**
 * Who is signed in when the account itself couldn't be read: only this computer's sign-in is
 * known, so the row names its kind, such as `Signed in with ChatGPT`, unless it knows the person.
 */
const signedInOffline = (provider: RuntimeProvider, intl: IntlShape): string =>
  provider.auth.email ??
  (provider.auth.label
    ? intl.formatMessage(
        {
          id: "firstRun.firstRunModel.signedInWith",
          defaultMessage: "Signed in with {account}",
        },
        { account: provider.auth.label },
      )
    : intl.formatMessage({ id: "firstRun.firstRunModel.signedIn", defaultMessage: "Signed in" }));

const foundDetail = (rest: string, intl: IntlShape): string =>
  intl.formatMessage(
    {
      id: "firstRun.firstRunModel.foundOnThisComputer",
      defaultMessage: "Found on this computer · {command}",
    },
    { command: rest },
  );

type TroubledProblem = Extract<
  AgentReadinessProblem,
  "no-connection" | "not-responding" | "not-ready" | "not-installed"
>;

/**
 * An installed Agent that was checked and can't take a message: the row says which of the things a
 * person can act on went wrong, and checking again is always one click away. Whatever the Agent
 * said for itself sits beneath the row when the row's own words don't already cover it.
 */
function troubledRow(
  id: "codex" | "claude",
  label: string,
  provider: RuntimeProvider,
  problem: TroubledProblem,
  intl: IntlShape,
): FirstRunAgentRow {
  const row = {
    ...builtIn(id),
    label,
    state: "action",
    found: true,
    action: checkAgain(intl),
  } as const;
  const said =
    (provider.availability === "unavailable" ? provider.unavailableReason : null) ??
    provider.message;
  switch (problem) {
    case "no-connection":
      return {
        ...row,
        detail: intl.formatMessage(
          {
            id: "firstRun.firstRunModel.signedInCanTConnect",
            defaultMessage: "{account} · Can’t connect. Check your network or proxy.",
          },
          { account: signedInOffline(provider, intl) },
        ),
      };
    case "not-responding":
      return {
        ...row,
        detail: intl.formatMessage({
          id: "firstRun.firstRunModel.didnTRespondInTime",
          defaultMessage: "Didn’t respond in time",
        }),
      };
    default:
      return {
        ...row,
        detail: intl.formatMessage({
          id: "firstRun.firstRunModel.couldnTStart",
          defaultMessage: "Couldn’t start",
        }),
        ...(said ? { note: said } : {}),
      };
  }
}

const turnedOffDetail = (intl: IntlShape) =>
  intl.formatMessage({
    id: "firstRun.firstRunModel.turnedOffInSettings",
    defaultMessage: "Turned off in Settings → Agents",
  });

function codexRow(input: FirstRunAgentInputs, intl: IntlShape): FirstRunAgentRow {
  const label = "Codex";
  const provider = input.providers?.find((entry) => entry.instanceId === "codex");
  if (!input.providers || isAgentUnchecked(provider)) return checking("codex", label, intl);
  if (input.codexLoginPending)
    return {
      ...builtIn("codex"),
      label,
      detail: intl.formatMessage({
        id: "firstRun.firstRunModel.finishSigningInInYour",
        defaultMessage: "Finish signing in in your browser",
      }),
      state: "waiting",
      found: false,
      action: {
        kind: "codex-cancel-sign-in",
        label: intl.formatMessage({
          id: "firstRun.firstRunModel.cancel",
          defaultMessage: "Cancel",
        }),
      },
    };
  const problem = agentReadinessProblem(provider);
  if (provider && !problem)
    return {
      ...builtIn("codex"),
      label,
      detail: signedInDetail(provider, intl),
      state: "ready",
      found: true,
      action: null,
    };
  if (problem === "turned-off")
    return {
      ...builtIn("codex"),
      label,
      detail: turnedOffDetail(intl),
      state: "action",
      found: false,
      action: null,
    };
  // Codex ships with Nodex, so one that can't start is a fault to look at, never an install.
  if (provider && problem && problem !== "signed-out")
    return troubledRow("codex", label, provider, problem, intl);
  return {
    ...builtIn("codex"),
    label,
    detail: intl.formatMessage({
      id: "firstRun.firstRunModel.signInWithYourChatGPT",
      defaultMessage: "Sign in with your ChatGPT account",
    }),
    state: "action",
    found: false,
    action: { kind: "codex-sign-in", label: signInLabel(intl) },
  };
}

function claudeRow(input: FirstRunAgentInputs, intl: IntlShape): FirstRunAgentRow | null {
  const label = "Claude Code";
  if (!input.providers) return checking("claude", label, intl);
  // Nodex credits and API keys run on Claude Code too, but they are rows of their own.
  const profiles = input.providers.filter(
    (entry) =>
      entry.driver === CLAUDE_DRIVER &&
      !spendsNodexCredit(entry) &&
      !isManagedRuntimeInstanceId(entry.instanceId),
  );
  const ready = profiles.find((entry) => !isAgentUnchecked(entry) && !agentReadinessProblem(entry));
  if (ready)
    return {
      ...builtIn("claude"),
      label,
      detail: signedInDetail(ready, intl),
      state: "ready",
      found: true,
      action: null,
    };
  if (profiles.some(isAgentUnchecked)) return checking("claude", label, intl);
  const profile = profiles[0];
  const problem = agentReadinessProblem(profile);
  // Turning an Agent off is a choice this page doesn't argue with.
  if (problem === "turned-off") return null;
  if (problem === "signed-out")
    return {
      ...builtIn("claude"),
      label,
      detail: foundDetail(
        intl.formatMessage({
          id: "firstRun.firstRunModel.signInWithYourClaude",
          defaultMessage: "Sign in with your Claude account",
        }),
        intl,
      ),
      state: "action",
      found: true,
      action: { kind: "claude-sign-in", label: signInLabel(intl) },
    };
  if (profile && problem && problem !== "not-installed")
    return troubledRow("claude", label, profile, problem, intl);
  return {
    ...builtIn("claude"),
    label,
    detail: intl.formatMessage({
      id: "firstRun.firstRunModel.installClaudeCodeThenSign",
      defaultMessage: "Install Claude Code, then sign in",
    }),
    state: "action",
    found: false,
    action: {
      kind: "claude-install",
      label: intl.formatMessage({
        id: "firstRun.firstRunModel.install",
        defaultMessage: "Install",
      }),
    },
  };
}

function nodexRow(input: FirstRunAgentInputs, intl: IntlShape): FirstRunAgentRow | null {
  const { nodex } = input;
  if (!nodex.configured) return null;
  // An account is signed in to, never found on a computer.
  const id = { ...builtIn("nodex"), found: false };
  const label = intl.formatMessage({
    id: "firstRun.firstRunModel.nodexCredits",
    defaultMessage: "Nodex credits",
  });
  if (nodex.signingIn)
    return {
      ...id,
      label,
      detail:
        nodex.notice ??
        intl.formatMessage({
          id: "firstRun.firstRunModel.finishInBrowser",
          defaultMessage: "Finish signing in in your browser",
        }),
      state: "waiting",
      action: {
        kind: "nodex-cancel-sign-in",
        label: intl.formatMessage({
          id: "firstRun.firstRunModel.cancel",
          defaultMessage: "Cancel",
        }),
      },
    };
  if (!nodex.signedIn) {
    // The hosted page covers both a new account and an existing one, so the button doesn't choose.
    const returning = nodex.identity !== null;
    return {
      ...id,
      label,
      detail:
        nodex.notice ??
        (returning
          ? intl.formatMessage(
              {
                id: "firstRun.firstRunModel.valueSignInAgain",
                defaultMessage: "{value1} · Sign in again",
              },
              { value1: nodex.identity },
            )
          : intl.formatMessage({
              id: "firstRun.firstRunModel.gPTAndClaudeWithNo",
              defaultMessage: "GPT and Claude with no subscription. Pay as you go.",
            })),
      state: "action",
      action: {
        kind: "nodex-sign-in",
        label: returning
          ? signInLabel(intl)
          : intl.formatMessage({
              id: "firstRun.firstRunModel.getStarted",
              defaultMessage: "Get started",
            }),
      },
    };
  }
  // Only whole credits can be spent, so a fraction left over isn't a balance.
  const credits = nodex.balance === null ? null : Math.trunc(nodex.balance);
  if (credits !== null && credits > 0)
    return {
      ...id,
      label,
      detail: intl.formatMessage(
        { id: "firstRun.firstRunModel.valueCredits", defaultMessage: "{value1} credits" },
        { value1: formatNodexCredits(credits, intl.locale) },
      ),
      state: "ready",
      action: null,
    };
  const identity =
    nodex.identity ??
    intl.formatMessage({ id: "firstRun.firstRunModel.signedIn", defaultMessage: "Signed in" });
  return {
    ...id,
    label,
    detail:
      nodex.notice ??
      (credits === null
        ? identity
        : intl.formatMessage(
            {
              id: "firstRun.firstRunModel.valueNoCreditsYet",
              defaultMessage: "{value1} · No credits yet",
            },
            { value1: identity },
          )),
    state: "action",
    action: null,
    offersTopUp: credits !== null,
  };
}

function openCodeRow(input: FirstRunAgentInputs, intl: IntlShape): FirstRunAgentRow | null {
  const label = "OpenCode";
  const detail = intl.formatMessage({
    id: "firstRun.firstRunModel.freeNoAccountProvidersMay",
    defaultMessage: "Free, no account. Providers may keep what you send.",
  });
  if (input.openCodeInstall === "unavailable") return null;
  if (input.openCodeInstall === "checking" || !input.providers)
    return checking("opencode", label, intl);
  if (input.openCodeInstall === "installing")
    return {
      ...builtIn("opencode"),
      label,
      detail: intl.formatMessage({
        id: "firstRun.firstRunModel.installing",
        defaultMessage: "Installing…",
      }),
      state: "waiting",
      found: false,
      action: null,
    };
  if (input.openCodeInstall === "installable")
    return {
      ...builtIn("opencode"),
      label,
      detail,
      state: "action",
      found: false,
      action: {
        kind: "opencode-install",
        label: intl.formatMessage({
          id: "firstRun.firstRunModel.install",
          defaultMessage: "Install",
        }),
      },
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
      ...builtIn("opencode"),
      label,
      detail:
        onCount === 1
          ? intl.formatMessage({
              id: "firstRun.firstRunModel.label1ModelOn",
              defaultMessage: "1 model on",
            })
          : intl.formatMessage(
              { id: "firstRun.firstRunModel.valueModelsOn", defaultMessage: "{value1} models on" },
              { value1: onCount },
            ),
      state: "ready",
      found: true,
      action: null,
    };
  if (freeModels.length === 0)
    return {
      ...builtIn("opencode"),
      label,
      detail: intl.formatMessage({
        id: "firstRun.firstRunModel.signInToAModel",
        defaultMessage: "Sign in to a model provider in Settings",
      }),
      state: "action",
      found: true,
      action: null,
    };
  return {
    ...builtIn("opencode"),
    label,
    detail,
    state: "action",
    found: true,
    action: {
      kind: "opencode-use",
      label: intl.formatMessage({
        id: "firstRun.firstRunModel.useFreeModels",
        defaultMessage: "Use free models",
      }),
    },
  };
}

/** An ACP Agent's place is its software, so connecting a found one keeps the row where it was. */
const acpSlot = (agentDefinitionId: string) => `acp-agent:${agentDefinitionId}`;

function foundAgentRow(agent: LocalAgentFound, intl: IntlShape): FirstRunAgentRow {
  const definition = localAgentDefinition(agent.id);
  const row = {
    id: `found:${agent.id}`,
    slot: acpSlot(definition.agentDefinitionId),
    mark: { kind: "acp", agentDefinitionId: definition.agentDefinitionId },
    label: definition.name,
    state: "action",
    found: true,
  } as const;
  // Saying what was found and what it needs beats leaving an installed Agent off the page.
  if (!agent.supported)
    return {
      ...row,
      detail: localAgentNeedsUpdateDetail(agent, intl),
      action: checkAgain(intl),
    };
  return {
    ...row,
    detail: foundDetail(localAgentFoundDetail(agent), intl),
    action: { kind: "local-agent-connect", label: connectLabel(intl), target: agent.id },
  };
}

function acpAgentRow(agent: FirstRunAcpAgent, intl: IntlShape): FirstRunAgentRow | null {
  const { status } = agent;
  // Turning an Agent off is a choice this page doesn't argue with.
  if (status.kind === "off") return null;
  const row = {
    id: `acp:${agent.id}`,
    slot: acpSlot(agent.agentDefinitionId),
    mark: { kind: "acp", agentDefinitionId: agent.agentDefinitionId } as const,
    label: agent.label,
    // The Profile already runs it, so it is as much here as an Agent found on the computer.
    found: true,
  };
  switch (status.kind) {
    case "ready":
      return { ...row, detail: status.detail ?? status.label, state: "ready", action: null };
    case "checking":
      return { ...row, detail: checkingDetail(intl), state: "checking", action: null };
    case "connecting":
    case "installing":
    case "pending":
      return {
        ...row,
        detail: intl.formatMessage(
          { id: "firstRun.firstRunModel.statusInProgress", defaultMessage: "{status}…" },
          { status: status.label },
        ),
        state: "waiting",
        action: null,
      };
    case "sign-in":
      return {
        ...row,
        detail: intl.formatMessage({
          id: "firstRun.firstRunModel.signInToUseItsModels",
          defaultMessage: "Sign in to use its models",
        }),
        state: "action",
        action: { kind: "acp-sign-in", label: signInLabel(intl), target: agent.id },
      };
    default:
      return {
        ...row,
        detail: status.detail ?? status.label,
        state: "action",
        action:
          status.action === "connect"
            ? { kind: "acp-connect", label: connectLabel(intl), target: agent.id }
            : null,
      };
  }
}

function providerKeyRows(input: FirstRunAgentInputs, intl: IntlShape): readonly FirstRunAgentRow[] {
  const connections = (input.providerKeys ?? []).filter(({ enabled }) => enabled);
  return [
    ...connections.map((connection): FirstRunAgentRow => ({
      id: `key:${connection.id}`,
      slot: "api-key",
      mark: { kind: "key", preset: connection.preset },
      label: connection.displayName,
      detail: providerKeyReadyDetail(connection, intl),
      state: "ready",
      found: true,
      action: null,
    })),
    {
      id: "api-key",
      slot: "api-key",
      mark: { kind: "key", preset: null },
      label: connections.length
        ? intl.formatMessage({
            id: "firstRun.firstRunModel.anotherApiKey",
            defaultMessage: "Another API key",
          })
        : intl.formatMessage({ id: "firstRun.firstRunModel.apiKey", defaultMessage: "API key" }),
      detail: intl.formatMessage({
        id: "firstRun.firstRunModel.apiKeyProviders",
        defaultMessage: "DeepSeek, Kimi, GLM, MiniMax or your own endpoint",
      }),
      state: "action",
      found: false,
      action: {
        kind: "api-key-add",
        label: intl.formatMessage({
          id: "firstRun.firstRunModel.addKey",
          defaultMessage: "Add key",
        }),
      },
    },
  ];
}

/**
 * The Agents the first step offers, in the order a person is most likely to want them: the
 * subscriptions they may already have, Agents found on this computer, an API key, then free models.
 * {@link placeFirstRunAgents} then lifts the usable and the found ones above the rest.
 */
export function firstRunAgentRows(
  input: FirstRunAgentInputs,
  intl: IntlShape = getIntl(),
): readonly FirstRunAgentRow[] {
  const configured = new Set((input.acpAgents ?? []).map((agent) => agent.agentDefinitionId));
  return [
    codexRow(input, intl),
    claudeRow(input, intl),
    nodexRow(input, intl),
    ...(input.acpAgents ?? []).map((agent) => acpAgentRow(agent, intl)),
    ...(input.localAgents ?? [])
      .filter((agent) => !configured.has(localAgentDefinition(agent.id).agentDefinitionId))
      .map((agent) => foundAgentRow(agent, intl)),
    ...providerKeyRows(input, intl),
    openCodeRow(input, intl),
  ].flatMap((row) => (row ? [row] : []));
}

/** Whether every row has its first answer. */
export const firstRunAgentsSettled = (
  input: Pick<FirstRunAgentInputs, "acpAgents" | "providerKeys" | "localAgents">,
  rows: readonly FirstRunAgentRow[],
) =>
  input.localAgents !== null &&
  input.acpAgents !== null &&
  input.providerKeys !== null &&
  rows.every((row) => row.state !== "checking");

/**
 * How close a row is to a working Agent: usable now, already here and needing one more step, or
 * starting from nothing.
 */
const rowTier = (row: FirstRunAgentRow): number => (row.state === "ready" ? 0 : row.found ? 1 : 2);

/** Where a slot settled, with the tier it settled in so that a later slot can find its place. */
export interface FirstRunAgentPlace {
  readonly slot: string;
  readonly tier: number;
}

/**
 * Gives every slot a place the first time it is seen and never moves it again, so a row holds
 * still under the pointer. Usable Agents come first, then the ones found here, then the rest; a
 * slot that arrives later joins the end of its tier instead of the end of the page.
 */
export function placeFirstRunAgents(
  places: readonly FirstRunAgentPlace[],
  rows: readonly FirstRunAgentRow[],
): readonly FirstRunAgentPlace[] {
  const known = new Set(places.map((place) => place.slot));
  const arrivals = new Map<string, number>();
  for (const row of rows) {
    if (known.has(row.slot)) continue;
    arrivals.set(row.slot, Math.min(arrivals.get(row.slot) ?? Infinity, rowTier(row)));
  }
  if (arrivals.size === 0) return places;
  const next = [...places];
  for (const [slot, tier] of arrivals) {
    const after = next.findLastIndex((place) => place.tier <= tier);
    next.splice(after + 1, 0, { slot, tier });
  }
  return next;
}

/** Rows in their settled places, with rows sharing a slot in their own order. */
export function arrangeFirstRunAgents(
  rows: readonly FirstRunAgentRow[],
  places: readonly FirstRunAgentPlace[] | null,
): readonly FirstRunAgentRow[] {
  if (!places) return rows;
  const rank = (row: FirstRunAgentRow) => {
    const index = places.findIndex((place) => place.slot === row.slot);
    return index === -1 ? places.length : index;
  };
  return rows.toSorted((left, right) => rank(left) - rank(right));
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

/** How the person lists the folders on offer: last used first, or most chats first. */
export type FirstRunCandidateOrder = "recent" | "chats";

const candidateOrders: Readonly<
  Record<FirstRunCandidateOrder, (left: ProjectCandidate, right: ProjectCandidate) => number>
> = {
  recent: (left, right) =>
    right.lastActiveAt - left.lastActiveAt || right.chatCount - left.chatCount,
  chats: (left, right) =>
    right.chatCount - left.chatCount || right.lastActiveAt - left.lastActiveAt,
};

/**
 * Folders the Profile doesn't work in yet, strictly in the order the person chose. The scan's own
 * ranking only decides which folders are offered; once listed, a Git repository gets no head start.
 */
export function offeredCandidates(
  candidates: readonly ProjectCandidate[],
  projectRoots: ReadonlySet<string>,
  order: FirstRunCandidateOrder,
): readonly ProjectCandidate[] {
  return candidates
    .filter((candidate) => !projectRoots.has(candidate.path))
    .toSorted(candidateOrders[order]);
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
export function candidateActivity(
  candidate: ProjectCandidate,
  now: number,
  intl: IntlShape = getIntl(),
): string {
  const chats =
    candidate.chatCount === 1
      ? intl.formatMessage({
          id: "firstRun.firstRunModel.label1Chat",
          defaultMessage: "1 chat",
        })
      : intl.formatMessage(
          { id: "firstRun.firstRunModel.valueChats", defaultMessage: "{value1} chats" },
          { value1: candidate.chatCount },
        );
  const elapsed = Math.max(0, now - candidate.lastActiveAt);
  const unit = relativeUnits.find((entry) => elapsed < entry.limit);
  if (!unit)
    return intl.formatMessage(
      {
        id: "firstRun.firstRunModel.valueOverAYearAgo",
        defaultMessage: "{value1} · over a year ago",
      },
      { value1: chats },
    );
  const count = Math.floor(elapsed / unit.size);
  if (count === 0)
    return intl.formatMessage(
      { id: "firstRun.firstRunModel.valueJustNow", defaultMessage: "{value1} · just now" },
      { value1: chats },
    );
  return intl.formatMessage(
    { id: "firstRun.firstRunModel.chatActivity", defaultMessage: "{chats} · {elapsed}" },
    {
      chats,
      elapsed: intl.formatRelativeTime(-count, unit.unit),
    },
  );
}
