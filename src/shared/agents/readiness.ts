import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { AgentDefinition, AgentSignIn } from "./definition";

export type AgentReadinessProvider = AgentRuntimeOperations["providers.read"]["output"][number];

export type AgentReadinessProblem =
  | { readonly kind: "checking" | "connecting" | "signed-out" | "no-connection" | "not-responding" }
  | { readonly kind: "turned-off"; readonly supplier?: true }
  /**
   * `onDemand` installs itself on first use; `manual` can't be installed here, so the person points
   * Settings at an executable instead.
   */
  | { readonly kind: "not-installed"; readonly onDemand?: true; readonly manual?: true }
  | { readonly kind: "installing"; readonly progress?: number }
  | { readonly kind: "installation-failed"; readonly retry: "automatic" | "manual" | "settings" }
  | { readonly kind: "needs-update"; readonly version: string }
  | { readonly kind: "no-models" | "choose-model" | "model-missing" }
  | { readonly kind: "not-connected" | "connection-failed" | "could-not-start" };

export type AgentReadinessAction =
  | { readonly kind: "settings" | "components" | "check-again" }
  | ({ readonly kind: "sign-in" } & AgentSignIn)
  | { readonly kind: "install" | "retry-installation"; readonly sourceId: string }
  | { readonly kind: "connect" };

export interface AgentInstallationReadiness {
  readonly problem: AgentReadinessProblem;
  readonly detail?: string;
  /** An executable is present even if it cannot run. */
  readonly found?: boolean;
}

export interface AgentReadiness {
  readonly problem: AgentReadinessProblem;
  readonly action: AgentReadinessAction | null;
  readonly detail: string | null;
  readonly found: boolean;
  readonly blocksSend: boolean;
}

type ReadinessInput = {
  readonly definition: AgentDefinition;
  readonly provider?: AgentReadinessProvider | undefined;
  readonly installation?: AgentInstallationReadiness | undefined;
  readonly source?: AgentReadinessProvider["installationSource"];
  /** Undefined when no particular model is being evaluated. */
  readonly model?: string;
};

function providerProblem({
  definition,
  provider,
  model,
}: ReadinessInput): AgentReadinessProblem | null {
  if (!provider)
    return model !== undefined && definition.setup?.models === "choose"
      ? { kind: "could-not-start" }
      : null;
  if (provider.componentUnavailableReason === "installing") return { kind: "installing" };
  if (provider.componentUnavailableReason === "turned-off")
    return { kind: "turned-off", supplier: true };
  if (provider.componentUnavailableReason === "not-installed") return { kind: "not-installed" };
  if (provider.availability === "unavailable") return { kind: "could-not-start" };
  if (!provider.enabled || provider.status === "disabled") return { kind: "turned-off" };
  if (provider.checkPending) return { kind: "checking" };
  const authStatus = provider.auth?.status ?? "unknown";
  if (authStatus === "unauthenticated") return { kind: "signed-out" };
  if (
    !provider.installed &&
    (provider.installationSource ||
      provider.status === "error" ||
      definition.setup?.models === "discover")
  )
    return { kind: "not-installed" };
  if (provider.issue === "account-unavailable") return { kind: "no-connection" };
  if (provider.issue === "unresponsive") return { kind: "not-responding" };
  if (provider.status === "error") return { kind: "could-not-start" };
  if (definition.setup?.models === "discover" && provider.discovery?.status !== "ready")
    return {
      kind: provider.discovery?.status === "failed" ? "connection-failed" : "not-connected",
    };
  const update = model && provider.updateRequiredModels?.find((entry) => entry.slug === model);
  if (update) return { kind: "needs-update", version: update.minVersion };
  if (definition.setup?.models !== "choose") return null;
  // Until the account has answered, a snapshot may have no model inventory to check.
  if (authStatus === "unknown" && !provider.models.length) return null;
  if (!provider.models.length) return { kind: "no-models" };
  if (model === "") return { kind: "choose-model" };
  if (model && !provider.models.some(({ slug }) => slug === model))
    return { kind: "model-missing" };
  return null;
}

function nextStep(
  definition: AgentDefinition,
  problem: AgentReadinessProblem,
  source: ReadinessInput["source"],
): AgentReadinessAction | null {
  switch (problem.kind) {
    case "checking":
    case "connecting":
      return null;
    case "installing":
      return source?.kind === "managed" ? { kind: "install", sourceId: source.id } : null;
    case "not-installed":
      if (definition.setup?.models === "discover") return { kind: "connect" };
      if (source?.kind === "component") return { kind: "components" };
      if (source?.kind === "managed")
        return problem.manual ? { kind: "settings" } : { kind: "install", sourceId: source.id };
      return { kind: "settings" };
    case "turned-off":
      return { kind: problem.supplier ? "components" : "settings" };
    case "installation-failed":
      if (problem.retry === "automatic") return null;
      if (problem.retry === "manual" && source && source.kind !== "external")
        return { kind: "retry-installation", sourceId: source.id };
      return { kind: "settings" };
    case "signed-out":
      return { kind: "sign-in", ...(definition.setup?.signIn ?? { via: "settings" }) };
    case "no-models":
    case "needs-update":
    case "choose-model":
    case "model-missing":
      return { kind: "settings" };
    case "not-connected":
    case "connection-failed":
      return { kind: definition.setup?.models === "discover" ? "connect" : "settings" };
    case "no-connection":
    case "not-responding":
    case "could-not-start":
      return definition.setup?.models === "discover"
        ? { kind: "connect" }
        : { kind: "check-again" };
  }
}

/**
 * The sign-in to offer for an Agent whose account has never answered. Nothing is wrong with it,
 * and until someone signs in it has no models to choose, so the offer is the only way to reach it.
 */
export function agentSignInOffer(
  definition: AgentDefinition,
  provider: AgentReadinessProvider,
): (AgentReadinessAction & { readonly kind: "sign-in" }) | null {
  const signIn = definition.setup?.signIn;
  if (!signIn || definition.setup?.models !== "choose") return null;
  if (!provider.enabled || !provider.installed || provider.models.length > 0) return null;
  return (provider.auth?.status ?? "unknown") === "unknown" ? { kind: "sign-in", ...signIn } : null;
}

/** Project one current problem from observed facts. An unverified account alone never prevents a send. */
export function agentReadiness(input: ReadinessInput): AgentReadiness | null {
  const { definition, provider, installation } = input;
  const source = input.source ?? provider?.installationSource;
  const runtimeProblem = providerProblem(input);
  const problem =
    runtimeProblem?.kind === "turned-off" && !runtimeProblem.supplier
      ? runtimeProblem
      : (installation?.problem ?? runtimeProblem);
  if (!problem) return null;
  const component = source?.kind === "component" && !provider?.installed;
  return {
    problem,
    action: nextStep(definition, problem, source),
    detail: installation?.detail ?? provider?.unavailableReason ?? provider?.message ?? null,
    found: installation?.found ?? provider?.installed ?? false,
    blocksSend:
      problem.kind !== "checking" &&
      ((component &&
        !(problem.kind === "not-installed" && problem.onDemand) &&
        !(problem.kind === "turned-off" && !problem.supplier)) ||
        (definition.setup?.models === "choose" && input.model !== undefined)),
  };
}
