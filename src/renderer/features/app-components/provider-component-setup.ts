import type { IntlShape } from "@/lib/i18n";
import { agentReadinessActionLabel, agentReadinessView } from "@/lib/agent-readiness-view";
import { agentDefinition } from "../../../shared/agents/registry";
import { APP_COMPONENT_NAMES } from "./app-component-status-view";
import {
  agentReadiness,
  type AgentReadinessProvider,
  type AgentInstallationReadiness,
} from "../../../shared/agents/readiness";
import { isAppComponentId, type AppComponentState } from "../../../shared/app-components";
import { appComponentStatus } from "./app-component-status";

/** Invalidate provider reads on readiness changes, without reading again for every progress tick. */
export function providerComponentReadiness(component: AppComponentState | undefined) {
  if (!component) return null;
  if (!component.enabled) return "off";
  const status = appComponentStatus(component);
  if (status.kind === "installed" || status.kind === "failed" || status.kind === "on-demand")
    return status.kind;
  return "installing";
}

/** The Components owner is authoritative until the catalog sees the usable executable. */
export function componentInstallationReadiness(
  component: AppComponentState,
  installed: boolean,
): AgentInstallationReadiness | undefined {
  if (installed) return undefined;
  if (!component.enabled) return { problem: { kind: "turned-off", supplier: true } };
  const status = appComponentStatus(component);
  switch (status.kind) {
    case "on-demand":
      return { problem: { kind: "not-installed", onDemand: true } };
    case "installed":
      // The executable has been written, but the provider catalog has not adopted it yet.
      return { problem: { kind: "installing" } };
    case "retrying":
      return { problem: { kind: "installation-failed", retry: "automatic" } };
    case "failed":
      return { problem: { kind: "installation-failed", retry: "manual" }, detail: status.message };
    case "downloading":
      return { problem: { kind: "installing", progress: status.fraction } };
    default:
      return { problem: { kind: "installing" } };
  }
}

/** Names the actual executable when it is the source of the problem. */
export function componentReadinessLabel(
  provider: AgentReadinessProvider | undefined,
  fallback: string,
  intl: IntlShape,
): string {
  const source = provider?.installationSource;
  if (source?.kind !== "component" || provider?.installed || !isAppComponentId(source.id))
    return fallback;
  return intl.formatMessage(APP_COMPONENT_NAMES[source.id]);
}

/** Component controls project setup through the same readiness model as the Agent surfaces. */
export function providerComponentSetup(
  provider: AgentReadinessProvider | undefined,
  component: AppComponentState | undefined,
  intl: IntlShape,
) {
  if (
    !component ||
    provider?.installed ||
    (!provider && component.installation.status === "installed")
  )
    return null;
  if (
    provider?.installationSource &&
    (provider.installationSource.kind !== "component" ||
      provider.installationSource.id !== component.id)
  )
    return null;
  const installation = componentInstallationReadiness(component, false);
  if (
    !installation ||
    (installation.problem.kind === "not-installed" && installation.problem.onDemand)
  )
    return null;
  const source = { kind: "component", id: component.id } as const;
  const definition = agentDefinition(provider?.driver);
  const readiness = agentReadiness({ definition, provider, installation, source });
  if (!readiness || !readiness.blocksSend) return null;
  const label = intl.formatMessage(APP_COMPONENT_NAMES[component.id]);
  const view = agentReadinessView(label, readiness, intl);
  const action =
    readiness.action?.kind === "components"
      ? "settings"
      : readiness.action?.kind === "retry-installation"
        ? "retry"
        : null;
  return {
    id: component.id,
    title: view.title,
    modelHint: view.hint,
    tone: view.tone,
    action,
    ...(action && readiness.action
      ? { actionLabel: agentReadinessActionLabel(readiness.action, intl) }
      : {}),
  } as const;
}
