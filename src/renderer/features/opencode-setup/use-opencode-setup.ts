import { getIntl } from "@/lib/i18n";
import { useEffect, useEffectEvent, useRef, useSyncExternalStore } from "react";
import { toast } from "@/components/ui/toast";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { openCodeSetupRuntime } from "@/lib/opencode-setup-runtime";
import type { OpenCodeSetupState } from "../../../shared/opencode-setup";
import { openOpenCodeInstallDialog } from "./opencode-install-dialog";
import {
  dependsOnHostOpenCode,
  openCodeInstallView,
  openCodeInstallationReadiness,
  type OpenCodeSetupInstance,
} from "./opencode-setup-model";
import {
  EMPTY_OPENCODE_SETUP_SNAPSHOT,
  createOpenCodeSetupOwner,
  type OpenCodeSetupOwner,
  type OpenCodeSetupSnapshot,
} from "./opencode-setup-owner";

/** Reports an installation that finished after its dialog was dismissed. */
function announceOpenCodeSetupOutcome(state: OpenCodeSetupState): void {
  const view = openCodeInstallView({ ...EMPTY_OPENCODE_SETUP_SNAPSHOT, state });
  if (view.kind === "ready")
    toast.success(
      getIntl().formatMessage(
        {
          id: "opencodeSetup.useOpencodeSetup.openCodeValueIsReady",
          defaultMessage: "OpenCode {value1} is ready",
        },
        { value1: view.version },
      ),
    );
  else if (view.kind === "outdated")
    toast.warning(
      getIntl().formatMessage(
        {
          id: "opencodeSetup.useOpencodeSetup.openCodeValueNeedsValueOr",
          defaultMessage: "OpenCode {value1} needs {value2} or newer",
        },
        { value1: view.version, value2: view.minimumVersion },
      ),
    );
  else if (view.kind === "failed" || view.kind === "unusable")
    toast.danger(
      getIntl().formatMessage({
        id: "opencodeSetup.useOpencodeSetup.openCodeInstallationFailed",
        defaultMessage: "OpenCode installation failed",
      }),
      { description: view.message },
    );
}

export const openCodeSetupOwner = createOpenCodeSetupOwner(
  openCodeSetupRuntime,
  announceOpenCodeSetupOutcome,
);

const subscribeNothing = () => () => {};
const readNothing = () => EMPTY_OPENCODE_SETUP_SNAPSHOT;

/** Host setup is read only while a caller depends on it; unrelated surfaces never probe the host. */
export function useOpenCodeSetup(
  owner: OpenCodeSetupOwner,
  enabled: boolean,
): OpenCodeSetupSnapshot {
  return useSyncExternalStore(
    enabled ? owner.subscribe : subscribeNothing,
    enabled ? owner.getSnapshot : readNothing,
  );
}

/**
 * The model menu's OpenCode setup entry. `onReady` runs when the host executable becomes ready
 * while observed, so the caller can reload its catalog without touching the current selection.
 */
export function useHostOpenCodeInstallation({
  instances,
  onReady,
  owner = openCodeSetupOwner,
}: {
  readonly instances: readonly OpenCodeSetupInstance[];
  readonly onReady: () => void;
  readonly owner?: OpenCodeSetupOwner;
}) {
  const relevant = dependsOnHostOpenCode(instances);
  const snapshot = useOpenCodeSetup(owner, relevant);
  const appHandle = useScopeHandle(appScope);
  const ready = useEffectEvent(onReady);
  const observedEpoch = useRef<number | null>(null);
  useEffect(() => {
    if (!relevant) {
      observedEpoch.current = null;
      return;
    }
    const previous = observedEpoch.current;
    observedEpoch.current = snapshot.readyEpoch;
    if (previous !== null && previous !== snapshot.readyEpoch) ready();
  }, [relevant, snapshot.readyEpoch]);
  const view = openCodeInstallView(snapshot);
  return {
    relevant,
    installation:
      relevant && view.kind !== "unreadable" && (snapshot.state?.supported || !snapshot.state)
        ? openCodeInstallationReadiness(view)
        : undefined,
    refresh: () => {
      if (relevant) owner.refresh();
    },
    open: (onShowModels?: () => void) =>
      openOpenCodeInstallDialog(appHandle, {
        owner,
        ...(onShowModels ? { onShowModels } : {}),
      }),
  };
}
