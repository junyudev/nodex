import { useMemo, useSyncExternalStore } from "react";
import { toast } from "@/components/ui/toast";
import { getIntl } from "@/lib/i18n";
import { isRemoteSpace } from "@/lib/renderer-space";
import { APP_COMPONENT_IDS, type AppComponentId } from "../../../shared/app-components";
import { appComponentsRuntime } from "../../lib/app-components-runtime";
import { providerComponentReadiness } from "./provider-component-setup";
import { APP_COMPONENT_NAMES } from "./app-component-status-view";
import { createAppComponentsOwner, type AppComponentsOwner } from "./app-components-owner";

const appComponentsOwner = createAppComponentsOwner(appComponentsRuntime);

export function useAppComponents(owner: AppComponentsOwner = appComponentsOwner) {
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  return { state, setEnabled: owner.setEnabled, request: owner.request, retry: owner.retry };
}

const offeredAppComponents = () =>
  appComponentsOwner
    .getSnapshot()
    ?.components.map(({ id }) => id)
    .join(",") ?? "";

const emptyOffer = {
  subscribe: () => () => undefined,
  read: () => "",
};

/** Search follows the Add-ons rows without rerendering on download progress. */
export function useOfferedAppComponentIds(enabled = true): readonly AppComponentId[] {
  const searchLocalSettings = enabled && !isRemoteSpace();
  const offered = useSyncExternalStore(
    searchLocalSettings ? appComponentsOwner.subscribe : emptyOffer.subscribe,
    searchLocalSettings ? offeredAppComponents : emptyOffer.read,
  );
  return useMemo(() => {
    const ids = new Set(offered.split(","));
    return APP_COMPONENT_IDS.filter((id) => ids.has(id));
  }, [offered]);
}

export function useAppComponent(id: AppComponentId) {
  return useSyncExternalStore(appComponentsOwner.subscribe, () =>
    appComponentsOwner.getSnapshot()?.components.find((component) => component.id === id),
  );
}

/** Provider catalogs follow readiness transitions while progress stays with the Component owner. */
export function subscribeProviderComponentReadiness(listener: () => void) {
  const read = () =>
    appComponentsOwner
      .getSnapshot()
      ?.components.map((component) => providerComponentReadiness(component))
      .join(",");
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
