import { useState } from "react";
import { NodexSwitch } from "@/components/ui/button";
import { NodexSettingsRow, NodexSettingsSection } from "@/components/ui/settings";
import { defineMessages, useIntl } from "@/lib/i18n";
import type { AppComponentId, AppComponentState } from "../../../shared/app-components";
import { appComponentProgress, appComponentStatus } from "./app-component-status";
import {
  APP_COMPONENT_NAMES,
  AppComponentRetryButton,
  AppComponentStatusLine,
} from "./app-component-status-view";
import { runAppComponentChange, useAppComponents } from "./use-app-components";

export const APP_COMPONENTS_SETTINGS_ANCHOR = "components";

const descriptions = defineMessages({
  "desktop-tools": {
    id: "appComponents.desktopTools.description",
    defaultMessage: "Browser, Chrome and Computer Use for Agents.",
  },
  "claude-code": {
    id: "appComponents.claudeCode.description",
    defaultMessage: "Runs Claude with an API key or Nodex credits.",
  },
  "document-tools": {
    id: "appComponents.documentTools.description",
    defaultMessage: "Word, PowerPoint, Excel and PDF files for Agents.",
  },
}) satisfies Record<AppComponentId, unknown>;

function AppComponentRow({
  component,
  onEnabledChange,
  onRetry,
}: {
  component: AppComponentState;
  onEnabledChange: (enabled: boolean) => Promise<void>;
  onRetry: () => Promise<void>;
}) {
  const intl = useIntl();
  const [saving, setSaving] = useState(false);
  const name = intl.formatMessage(APP_COMPONENT_NAMES[component.id]);
  const status = appComponentStatus(component);
  const progress = appComponentProgress(status);
  const run = (action: () => Promise<void>) =>
    runAppComponentChange(component.id, setSaving, action);

  return (
    <div className="relative" data-app-component-row="">
      <NodexSettingsRow label={name} description={intl.formatMessage(descriptions[component.id])}>
        <AppComponentStatusLine status={status} />
        <AppComponentRetryButton
          status={status}
          disabled={saving}
          onRetry={() => void run(onRetry)}
        />
        <NodexSwitch
          ariaLabel={intl.formatMessage(
            {
              id: "appComponents.toggle",
              defaultMessage: "{enabled, select, true {Remove {name}} other {Install {name}}}",
            },
            { enabled: String(component.enabled), name },
          )}
          checked={component.enabled}
          disabled={saving}
          onCheckedChange={(enabled) => void run(() => onEnabledChange(enabled))}
        />
      </NodexSettingsRow>
      {progress !== null ? (
        <div
          role="progressbar"
          aria-label={intl.formatMessage(
            { id: "appComponents.progressLabel", defaultMessage: "Installing {name}" },
            { name },
          )}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          className="absolute inset-x-4 bottom-0 h-0.5 overflow-hidden bg-text/10"
        >
          <div
            className="h-full bg-text-info transition-[width] duration-300 ease-out"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The parts of Nodex this build installs after the app. Absent where everything ships inside it. */
export function AppComponentsSettingsSection() {
  const intl = useIntl();
  const { state, setEnabled, retry } = useAppComponents();
  if (!state || state.components.length === 0) return null;
  return (
    <NodexSettingsSection
      id={APP_COMPONENTS_SETTINGS_ANCHOR}
      title={intl.formatMessage({ id: "appComponents.title", defaultMessage: "Components" })}
      // These switches remove files, which no other Settings switch does.
      footnote={intl.formatMessage({
        id: "appComponents.footnote",
        defaultMessage:
          "Parts of Nodex that install after the app. Turn one off to remove it and free its space.",
      })}
    >
      {state.components.map((component) => (
        <AppComponentRow
          key={component.id}
          component={component}
          onEnabledChange={(enabled) => setEnabled({ id: component.id, enabled })}
          onRetry={() => retry(component.id)}
        />
      ))}
    </NodexSettingsSection>
  );
}
