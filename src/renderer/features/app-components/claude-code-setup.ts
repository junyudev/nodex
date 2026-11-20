import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { IntlShape } from "@/lib/i18n";
import type { AppComponentState } from "../../../shared/app-components";
import { appComponentStatus } from "./app-component-status";
import { APP_COMPONENT_NAMES } from "./app-component-status-view";

type Provider = Pick<
  AgentRuntimeOperations["providers.read"]["output"][number],
  "enabled" | "installed" | "requiredComponent"
>;

export const waitsForClaudeCode = (provider: Provider | undefined): boolean =>
  provider?.requiredComponent === "claude-code" && provider.enabled && !provider.installed;

/** Invalidate provider reads on readiness changes, without reading again for every progress tick. */
export function claudeCodeComponentReadiness(component: AppComponentState | undefined) {
  if (!component) return null;
  if (!component.enabled) return "off";
  const status = appComponentStatus(component);
  if (status.kind === "installed" || status.kind === "failed" || status.kind === "on-demand")
    return status.kind;
  return "installing";
}

export function claudeCodeSetup(
  provider: Provider | undefined,
  component: AppComponentState | undefined,
  intl: IntlShape,
): {
  readonly title: string;
  readonly action: "settings" | "retry" | null;
  readonly actionLabel?: string;
} | null {
  if (!waitsForClaudeCode(provider)) return null;
  const name = intl.formatMessage(APP_COMPONENT_NAMES["claude-code"]);
  if (component && !component.enabled) {
    return {
      title: intl.formatMessage(
        { id: "appComponents.claudeSetup.off", defaultMessage: "{name} is turned off" },
        { name },
      ),
      action: "settings",
      actionLabel: intl.formatMessage({
        id: "conversation.agentReadinessNotice.settings",
        defaultMessage: "Settings",
      }),
    };
  }
  const status = component ? appComponentStatus(component) : null;
  if (status?.kind === "failed") {
    return {
      title: intl.formatMessage(
        { id: "appComponents.claudeSetup.failed", defaultMessage: "Couldn’t install {name}" },
        { name },
      ),
      action: "retry",
      actionLabel: intl.formatMessage({
        id: "appComponents.tryAgain",
        defaultMessage: "Try again",
      }),
    };
  }
  return {
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
  };
}
