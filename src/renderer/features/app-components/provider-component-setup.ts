import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { IntlShape } from "@/lib/i18n";
import type { AppComponentId, AppComponentState } from "../../../shared/app-components";
import { appComponentStatus } from "./app-component-status";
import { APP_COMPONENT_NAMES } from "./app-component-status-view";

type Provider = Pick<
  AgentRuntimeOperations["providers.read"]["output"][number],
  "enabled" | "installed" | "requiredComponent"
>;

export const waitsForProviderComponent = (provider: Provider | undefined): boolean =>
  Boolean(provider?.requiredComponent && provider.enabled && !provider.installed);

/** Invalidate provider reads on readiness changes, without reading again for every progress tick. */
export function providerComponentReadiness(component: AppComponentState | undefined) {
  if (!component) return null;
  if (!component.enabled) return "off";
  const status = appComponentStatus(component);
  if (status.kind === "installed" || status.kind === "failed" || status.kind === "on-demand")
    return status.kind;
  return "installing";
}

export function providerComponentSetup(
  provider: Provider | undefined,
  component: AppComponentState | undefined,
  intl: IntlShape,
): {
  readonly id: AppComponentId;
  readonly title: string;
  readonly modelHint?: string;
  readonly tone: "progress" | "warning" | "danger";
  readonly action: "settings" | "retry" | null;
  readonly actionLabel?: string;
} | null {
  const id = provider?.requiredComponent ?? component?.id;
  if (!id || (component && component.id !== id) || provider?.installed) return null;
  if (component?.enabled !== false) {
    if (provider && !waitsForProviderComponent(provider)) return null;
    if (!provider && component?.installation.status === "installed") return null;
    if (id === "codex" && (!component || component.installation.status === "on-demand"))
      return null;
  }
  const name = intl.formatMessage(APP_COMPONENT_NAMES[id]);
  if (component && !component.enabled) {
    return {
      id,
      title: intl.formatMessage(
        { id: "appComponents.claudeSetup.off", defaultMessage: "{name} is turned off" },
        { name },
      ),
      action: "settings",
      tone: "warning",
      modelHint: intl.formatMessage({
        id: "appComponents.setup.turnedOff",
        defaultMessage: "Turned off",
      }),
      actionLabel: intl.formatMessage({
        id: "conversation.agentReadinessNotice.settings",
        defaultMessage: "Settings",
      }),
    };
  }
  const status = component ? appComponentStatus(component) : null;
  if (status?.kind === "failed") {
    return {
      id,
      title: intl.formatMessage(
        { id: "appComponents.claudeSetup.failed", defaultMessage: "Couldn’t install {name}" },
        { name },
      ),
      action: "retry",
      tone: "danger",
      actionLabel: intl.formatMessage({
        id: "appComponents.tryAgain",
        defaultMessage: "Try again",
      }),
    };
  }
  return {
    id,
    title:
      status?.kind === "downloading"
        ? intl.formatMessage(
            {
              id: "appComponents.claudeSetup.downloading",
              defaultMessage: "Installing {name}… {percent, number, percent}",
            },
            { name, percent: status.fraction },
          )
        : intl.formatMessage(
            { id: "appComponents.claudeSetup.installing", defaultMessage: "Installing {name}…" },
            { name },
          ),
    action: null,
    tone: "progress",
    modelHint: intl.formatMessage({
      id: "appComponents.setup.installing",
      defaultMessage: "Installing",
    }),
  };
}
