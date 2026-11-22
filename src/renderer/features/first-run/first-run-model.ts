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
import { isManagedRuntimeInstanceId } from "../../../shared/managed-runtime-instances";
import type { ProviderKeyConnection, ProviderKeyPresetId } from "../../../shared/provider-keys";
import { acpInstallationReadiness, type AcpInstanceStatus } from "../acp-agents/acp-agent-model";
import { providerKeyRuntimeInstanceId } from "../../../shared/provider-keys";
import type { AppComponentId, AppComponentState } from "../../../shared/app-components";
import {
  componentInstallationReadiness,
  componentReadinessLabel,
} from "../app-components/provider-component-setup";
import { providerKeyReadyDetail } from "../provider-keys/provider-keys-model";
import {
  agentDefinition,
  agentDefinitions,
  sameAgentDriver,
} from "../../../shared/agents/registry";
import type { AgentDefinition } from "../../../shared/agents/definition";
import type { AgentSetupTarget } from "@/lib/agent-settings-navigation";
import {
  agentReadiness,
  type AgentInstallationReadiness,
  type AgentReadiness,
  type AgentReadinessAction,
  type AgentReadinessProblem,
} from "../../../shared/agents/readiness";
import { agentReadinessActionLabel, agentReadinessView } from "@/lib/agent-readiness-view";
import { isAppComponentId } from "../../../shared/app-components";

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
 * A row's identity: a built-in Agent, an ACP
 * instance (`acp:<instance id>`), an API key connection (`key:<connection id>`) or the way to add
 * one (`api-key`).
 */
export type FirstRunAgentId = string;

export type FirstRunAgentAction =
  | "browser-sign-in"
  | "cancel-browser-sign-in"
  | "terminal-sign-in"
  | "terminal-install"
  | "nodex-sign-in"
  | "nodex-cancel-sign-in"
  | "use-free-models"
  | "agent-settings"
  | "connect"
  | "inline-sign-in"
  | "api-key-add"
  | "component-settings"
  | "component-retry"
  | "installer"
  | "check-again";

export type FirstRunAgentMark =
  | { readonly kind: "agent"; readonly driver: string }
  | { readonly kind: "nodex" }
  | { readonly kind: "key"; readonly preset: ProviderKeyPresetId | null }
  | { readonly kind: "registry"; readonly agentDefinitionId: string; readonly driver: string };

export interface FirstRunAgentRow {
  readonly id: FirstRunAgentId;
  /**
   * Where the row sits once the order settles. Rows sharing a slot keep their place.
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
    /** The configured instance the action is for. */
    readonly target?: string;
    readonly componentId?: AppComponentId;
    readonly binding?: AgentSetupTarget;
    readonly sourceId?: string;
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
  readonly pendingBrowserSignIn: string | null;
  readonly nodex: {
    readonly configured: boolean;
    readonly signedIn: boolean;
    readonly signingIn: boolean;
    readonly identity: string | null;
    /** Credits, or null until the wallet has been read. */
    readonly balance: number | null;
    readonly notice: string | null;
  };
  readonly installations: {
    readonly components: readonly AppComponentState[];
    readonly managed: Readonly<
      Record<string, (provider?: RuntimeProvider) => AgentInstallationReadiness | undefined>
    >;
  };
  /** Null until ACP settings are read. */
  readonly acpAgents: readonly FirstRunAcpAgent[] | null;
  /** Null until API key connections are read. */
  readonly providerKeys: readonly ProviderKeyConnection[] | null;
}

const checkingDetail = (intl: IntlShape) =>
  intl.formatMessage({ id: "firstRun.firstRunModel.checking", defaultMessage: "Checking…" });

function rowAction(
  action: AgentReadinessAction | null,
  binding: AgentSetupTarget,
  intl: IntlShape,
  problem?: AgentReadinessProblem,
): FirstRunAgentRow["action"] {
  if (!action) return null;
  const base = { label: agentReadinessActionLabel(action, intl), binding };
  switch (action.kind) {
    case "sign-in":
      if (action.via === "browser")
        return { ...base, kind: "browser-sign-in", sourceId: action.owner };
      if (action.via === "terminal")
        return { ...base, kind: "terminal-sign-in", sourceId: action.owner };
      if (action.via === "dialog" && binding.instanceId)
        return { ...base, kind: "inline-sign-in", target: binding.instanceId };
      return { ...base, kind: "agent-settings" };
    case "connect":
      return binding.instanceId ? { ...base, kind: "connect", target: binding.instanceId } : null;
    case "components":
      return { ...base, kind: "component-settings" };
    case "check-again":
      return { ...base, kind: "check-again" };
    case "retry-installation":
    case "install":
      if (isAppComponentId(action.sourceId))
        return { ...base, kind: "component-retry", componentId: action.sourceId };
      return { ...base, kind: "installer", sourceId: action.sourceId };
    case "settings":
      return {
        ...base,
        kind: "agent-settings",
        ...(problem?.kind === "not-installed"
          ? {
              label: intl.formatMessage({
                id: "conversation.agentReadinessNotice.setUp",
                defaultMessage: "Set up",
              }),
            }
          : {}),
      };
  }
}

function readinessRow(
  base: Pick<FirstRunAgentRow, "id" | "slot" | "mark" | "label">,
  readiness: AgentReadiness,
  binding: AgentSetupTarget,
  intl: IntlShape,
  provider?: RuntimeProvider,
): FirstRunAgentRow {
  const view = agentReadinessView(
    componentReadinessLabel(provider, base.label, intl),
    readiness,
    intl,
  );
  const state =
    readiness.problem.kind === "checking"
      ? "checking"
      : view.tone === "progress"
        ? "waiting"
        : "action";
  return {
    ...base,
    detail: view.title,
    state,
    found:
      state === "checking" ||
      (readiness.found &&
        !(
          readiness.problem.kind === "signed-out" &&
          readiness.action?.kind === "sign-in" &&
          readiness.action.via === "browser"
        )),
    ...(view.detail ? { note: view.detail } : {}),
    action:
      state === "waiting" ? null : rowAction(readiness.action, binding, intl, readiness.problem),
  };
}

function installationFor(
  input: FirstRunAgentInputs,
  definition: AgentDefinition,
  provider?: RuntimeProvider,
) {
  const declared = definition.setup?.installation;
  const fallback =
    declared?.kind === "component" &&
    !input.installations.components.some(({ id }) => id === declared.id)
      ? undefined
      : declared;
  const source =
    provider?.componentUnavailableReason === "external-unusable"
      ? undefined
      : (provider?.installationSource ?? fallback);
  const component =
    source?.kind === "component" &&
    input.installations.components.find(({ id }) => id === source.id);
  const installation = component
    ? componentInstallationReadiness(component, provider?.installed === true)
    : source?.kind === "managed"
      ? input.installations.managed[source.id]?.(provider)
      : undefined;
  return { source, installation };
}

const signedInDetail = (provider: RuntimeProvider, intl: IntlShape): string =>
  provider.auth.email ??
  provider.auth.label ??
  intl.formatMessage({ id: "firstRun.firstRunModel.signedIn", defaultMessage: "Signed in" });

function modelOptInRow(
  base: Pick<FirstRunAgentRow, "id" | "slot" | "mark" | "label">,
  providers: readonly RuntimeProvider[],
  policy: ModelPolicy,
  intl: IntlShape,
): FirstRunAgentRow {
  const models = providers.flatMap((provider) =>
    provider.models.map((model) => ({ provider, model })),
  );
  const onCount = models.filter(({ provider, model }) =>
    isModelOn(policy, provider, model.slug),
  ).length;
  if (onCount > 0)
    return {
      ...base,
      found: true,
      state: "ready",
      action: null,
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
    };
  if (!models.some(({ model }) => isFreeModel(model.slug)))
    return {
      ...base,
      found: true,
      state: "action",
      action: null,
      detail: intl.formatMessage({
        id: "firstRun.firstRunModel.signInToAModel",
        defaultMessage: "Sign in to a model provider in Settings",
      }),
    };
  return {
    ...base,
    found: true,
    state: "action",
    detail: intl.formatMessage({
      id: "firstRun.firstRunModel.freeNoAccountProvidersMay",
      defaultMessage: "Free, no account. Providers may keep what you send.",
    }),
    action: {
      kind: "use-free-models",
      binding: { driver: base.mark.kind === "agent" ? base.mark.driver : "" },
      label: intl.formatMessage({
        id: "firstRun.firstRunModel.useFreeModels",
        defaultMessage: "Use free models",
      }),
    },
  };
}

function builtInRow(
  definition: AgentDefinition,
  input: FirstRunAgentInputs,
  intl: IntlShape,
): FirstRunAgentRow | null {
  const setup = definition.setup;
  const id = definition.settingsAnchor ?? definition.driver;
  const label = definition.label;
  const base = { id, slot: id, label, mark: { kind: "agent", driver: definition.driver } } as const;
  const profiles = (input.providers ?? []).filter(
    (entry) =>
      sameAgentDriver(entry.driver, definition.driver) &&
      !spendsNodexCredit(entry) &&
      !isManagedRuntimeInstanceId(entry.instanceId),
  );
  const checked = profiles.map((provider) => ({
    provider,
    readiness: agentReadiness({
      definition,
      provider,
      ...installationFor(input, definition, provider),
    }),
  }));
  const ready = checked.filter(
    ({ provider, readiness }) =>
      !readiness &&
      (!setup?.firstRun?.requireKnownAccount || provider.auth.status === "authenticated"),
  );
  if (
    setup?.signIn?.via === "browser" &&
    input.pendingBrowserSignIn === setup.signIn.owner &&
    !checked.some(({ readiness }) => readiness?.blocksSend)
  )
    return {
      ...base,
      state: "waiting",
      found: false,
      detail: intl.formatMessage({
        id: "firstRun.firstRunModel.finishInBrowser",
        defaultMessage: "Finish signing in in your browser",
      }),
      action: {
        kind: "cancel-browser-sign-in",
        label: intl.formatMessage({
          id: "firstRun.firstRunModel.cancel",
          defaultMessage: "Cancel",
        }),
      },
    };
  if (ready.length)
    return definition.capabilities.modelsOptIn
      ? modelOptInRow(
          base,
          ready.map(({ provider }) => provider),
          input.policy,
          intl,
        )
      : {
          ...base,
          state: "ready",
          found: true,
          action: null,
          detail: signedInDetail(ready[0].provider, intl),
        };
  if (!input.providers || checked.some(({ readiness }) => readiness?.problem.kind === "checking"))
    return { ...base, detail: checkingDetail(intl), state: "checking", found: true, action: null };
  const candidate =
    checked.find(({ provider }) => provider.enabled && provider.installed) ?? checked[0];
  const provider = candidate?.provider;
  const binding = {
    driver: provider?.driver ?? definition.driver,
    ...(provider ? { instanceId: provider.instanceId } : {}),
  };
  const readiness = candidate
    ? candidate.readiness
    : agentReadiness({ definition, ...installationFor(input, definition) });
  if (
    readiness?.problem.kind === "turned-off" &&
    !readiness.problem.supplier &&
    !setup?.firstRun?.showWhenOff
  )
    return null;
  if (
    setup?.firstRun?.terminalInstall &&
    setup.signIn?.via === "terminal" &&
    (!readiness || readiness.problem.kind === "not-installed")
  ) {
    const install = { kind: "install", sourceId: "" } as const;
    return {
      ...base,
      state: "action",
      found: false,
      detail: intl.formatMessage(
        {
          id: "agentReadiness.installThenSignIn",
          defaultMessage: "Install {label}, then sign in",
        },
        { label },
      ),
      action: {
        kind: "terminal-install",
        sourceId: setup.signIn.owner,
        label: agentReadinessActionLabel(install, intl),
      },
    };
  }
  if (
    readiness &&
    !(
      readiness.problem.kind === "not-installed" &&
      readiness.problem.onDemand &&
      setup?.signIn?.via === "browser"
    )
  ) {
    const row = readinessRow(base, readiness, binding, intl, provider);
    if (
      row.action?.kind !== "installer" ||
      readiness.problem.kind !== "not-installed" ||
      !definition.capabilities.modelsOptIn
    )
      return row;
    return {
      ...row,
      detail: intl.formatMessage({
        id: "firstRun.firstRunModel.freeNoAccountProvidersMay",
        defaultMessage: "Free, no account. Providers may keep what you send.",
      }),
    };
  }
  if (definition.capabilities.modelsOptIn || !setup?.signIn) return null;
  // Before an account has been checked, offer setup without claiming a sign-out.
  return {
    ...base,
    state: "action",
    found: setup.signIn.via !== "browser" && provider?.installed === true,
    action: rowAction({ kind: "sign-in", ...setup.signIn }, binding, intl),
    detail: intl.formatMessage({
      id: "firstRun.firstRunModel.signInToUseItsModels",
      defaultMessage: "Sign in to use its models",
    }),
  };
}

function nodexRow(input: FirstRunAgentInputs, intl: IntlShape): FirstRunAgentRow | null {
  const { nodex } = input;
  if (!nodex.configured) return null;
  // An account is signed in to, never found on a computer.
  const id = { id: "nodex", slot: "nodex", mark: { kind: "nodex" }, found: false } as const;
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
          ? agentReadinessActionLabel({ kind: "sign-in", via: "settings" }, intl)
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

/** ACP instances of the same Agent share a place in the setup list. */
const acpSlot = (agentDefinitionId: string) => `acp-agent:${agentDefinitionId}`;

function acpAgentRow(agent: FirstRunAcpAgent, intl: IntlShape): FirstRunAgentRow | null {
  const { status } = agent;
  if (status.kind === "off") return null;
  const definition = agentDefinitions.find(({ setup }) => setup?.models === "discover");
  if (!definition) return null;
  const binding = { driver: definition.driver, instanceId: agent.id };
  const base = {
    id: `acp:${agent.id}`,
    slot: acpSlot(agent.agentDefinitionId),
    mark: { kind: "registry", agentDefinitionId: agent.agentDefinitionId, driver: binding.driver },
    label: agent.label,
  } as const;
  if (status.kind === "ready")
    return {
      ...base,
      detail: status.detail ?? status.label,
      state: "ready",
      found: true,
      action: null,
    };
  const readiness = agentReadiness({ definition, installation: acpInstallationReadiness(status) });
  if (!readiness) return null;
  const row = readinessRow(base, readiness, binding, intl);
  // Registry installs still start from Settings or the setup dialog. A Connect action here
  // is only for an instance that the Registry has already prepared.
  return status.action === "connect" || status.action === "sign-in"
    ? row
    : { ...row, action: null };
}

function providerKeyRows(input: FirstRunAgentInputs, intl: IntlShape): readonly FirstRunAgentRow[] {
  const connections = (input.providerKeys ?? []).filter(({ enabled }) => enabled);
  return [
    ...connections.map((connection): FirstRunAgentRow => {
      const provider = input.providers?.find(
        ({ instanceId }) => instanceId === providerKeyRuntimeInstanceId(connection),
      );
      const definition = agentDefinition(provider?.driver);
      const readiness = provider
        ? agentReadiness({
            definition,
            provider,
            ...installationFor(input, definition, provider),
          })
        : null;
      const base = {
        id: `key:${connection.id}`,
        slot: "api-key",
        mark: { kind: "key", preset: connection.preset },
        label: connection.displayName,
      } as const;
      if (readiness && provider)
        return {
          ...readinessRow(
            base,
            readiness,
            { driver: provider.driver, instanceId: provider.instanceId },
            intl,
            provider,
          ),
          found: true,
        };
      return {
        ...base,
        detail: providerKeyReadyDetail(connection, intl),
        state: "ready",
        found: true,
        action: null,
      };
    }),
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
 * subscriptions they may already have, configured Agents, an API key, then free models.
 * {@link placeFirstRunAgents} then lifts the usable and the found ones above the rest.
 */
export function firstRunAgentRows(
  input: FirstRunAgentInputs,
  intl: IntlShape = getIntl(),
): readonly FirstRunAgentRow[] {
  const builtIns = agentDefinitions.flatMap((definition) => {
    if (!definition.setup?.firstRun) return [];
    const row = builtInRow(definition, input, intl);
    return row ? [{ order: definition.setup.firstRun.order, row }] : [];
  });
  return [
    ...builtIns,
    { order: 2, row: nodexRow(input, intl) },
    ...(input.acpAgents ?? []).map((agent) => ({ order: 3, row: acpAgentRow(agent, intl) })),
    ...providerKeyRows(input, intl).map((row) => ({ order: 5, row })),
  ]
    .toSorted((left, right) => left.order - right.order)
    .flatMap(({ row }) => (row ? [row] : []));
}

/** Whether every row has its first answer. */
export const firstRunAgentsSettled = (
  input: Pick<FirstRunAgentInputs, "acpAgents" | "providerKeys">,
  rows: readonly FirstRunAgentRow[],
) =>
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
