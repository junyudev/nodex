import { useEffect, useEffectEvent, useState } from "react";
import { NodexButton } from "@/components/ui/button";
import { defineMessage, useIntl } from "@/lib/i18n";
import type { AppComponentId } from "../../../shared/app-components";
import { appComponentStatus } from "./app-component-status";
import {
  APP_COMPONENT_NAMES,
  AppComponentRetryButton,
  AppComponentStatusLine,
} from "./app-component-status-view";
import { runAppComponentChange, useAppComponents } from "./use-app-components";

export const NEEDS_CODEX = defineMessage({
  id: "appComponents.needsCodex",
  defaultMessage: "Needs Codex",
});

/**
 * Stands in for a feature's own readiness where it is waiting on a component: what is happening
 * to the install, and the one step a person can take. Renders nothing on a build that ships the
 * component inside the app.
 */
export function AppComponentRequirement({
  id,
  onInstalled,
}: {
  id: AppComponentId;
  /** The feature read its readiness before the install finished; it reads again here. */
  onInstalled?: () => void;
}) {
  const intl = useIntl();
  const { state, setEnabled, request, retry } = useAppComponents();
  const [saving, setSaving] = useState(false);
  const component = state?.components.find((candidate) => candidate.id === id);
  const status = component ? appComponentStatus(component) : null;
  const installed = status?.kind === "installed";
  const announceInstalled = useEffectEvent(() => onInstalled?.());
  useEffect(() => {
    if (installed) announceInstalled();
  }, [installed]);
  if (!status) return null;
  const run = (action: () => Promise<void>) => runAppComponentChange(id, setSaving, action);
  return (
    <>
      <AppComponentStatusLine status={status} />
      <AppComponentRetryButton
        status={status}
        disabled={saving}
        onRetry={() => void run(() => retry(id))}
      />
      {status.kind === "not-installed" || status.kind === "on-demand" ? (
        <NodexButton
          size="xs"
          variant="secondary"
          disabled={saving}
          onClick={() =>
            void run(() =>
              status.kind === "on-demand" ? request(id) : setEnabled({ id, enabled: true }),
            )
          }
        >
          {intl.formatMessage(
            { id: "appComponents.install", defaultMessage: "Install {name}" },
            { name: intl.formatMessage(APP_COMPONENT_NAMES[id]) },
          )}
        </NodexButton>
      ) : null}
    </>
  );
}

/** The sentence a feature's row shows while its component is missing. */
export function useAppComponentRequirementDescription(id: AppComponentId): string {
  const intl = useIntl();
  return intl.formatMessage(
    { id: "appComponents.requirement", defaultMessage: "Needs the {name} component." },
    { name: intl.formatMessage(APP_COMPONENT_NAMES[id]) },
  );
}
