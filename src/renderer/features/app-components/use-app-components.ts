import { useSyncExternalStore } from "react";
import { toast } from "@/components/ui/toast";
import { getIntl } from "@/lib/i18n";
import type { AppComponentId } from "../../../shared/app-components";
import { appComponentsRuntime } from "../../lib/app-components-runtime";
import { claudeCodeComponentReadiness } from "./claude-code-setup";
import { APP_COMPONENT_NAMES } from "./app-component-status-view";
import { createAppComponentsOwner, type AppComponentsOwner } from "./app-components-owner";

const appComponentsOwner = createAppComponentsOwner(appComponentsRuntime);

export function useAppComponents(owner: AppComponentsOwner = appComponentsOwner) {
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  return { state, setEnabled: owner.setEnabled, retry: owner.retry };
}

/** Provider catalogs follow readiness transitions while progress stays with the Component owner. */
export function subscribeClaudeCodeReadiness(listener: () => void) {
  const read = () =>
    claudeCodeComponentReadiness(
      appComponentsOwner.getSnapshot()?.components.find(({ id }) => id === "claude-code"),
    );
  let previous = read();
  return appComponentsOwner.subscribe(() => {
    const next = read();
    if (next === previous) return;
    previous = next;
    listener();
  });
}

function reportAppComponentChangeFailure(id: AppComponentId): void {
  const intl = getIntl();
  toast.danger(
    intl.formatMessage(
      { id: "appComponents.changeFailed", defaultMessage: "Couldn’t change {name}" },
      { name: intl.formatMessage(APP_COMPONENT_NAMES[id]) },
    ),
  );
}

/** Run a person's change to a component, holding its controls until Main answers. */
export async function runAppComponentChange(
  id: AppComponentId,
  setSaving: ((saving: boolean) => void) | undefined,
  action: () => Promise<void>,
): Promise<void> {
  setSaving?.(true);
  try {
    await action();
  } catch {
    reportAppComponentChangeFailure(id);
  } finally {
    setSaving?.(false);
  }
}
