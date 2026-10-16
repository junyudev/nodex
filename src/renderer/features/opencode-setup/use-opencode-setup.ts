import { useEffect, useEffectEvent, useRef, useSyncExternalStore } from "react";
import type { AgentModelSetupPresentation } from "@/components/shared/agent-runtime/agent-model-picker";
import { toast } from "@/components/ui/toast";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { openCodeSetupRuntime } from "@/lib/opencode-setup-runtime";
import type { OpenCodeSetupState } from "../../../shared/opencode-setup";
import { openOpenCodeInstallDialog } from "./opencode-install-dialog";
import {
  OPENCODE_FREE_MODELS_LABEL,
  dependsOnHostOpenCode,
  openCodeInstallView,
  openCodeModelSetupEntry,
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
  if (view.kind === "ready") toast.success(`OpenCode ${view.version} is ready`);
  else if (view.kind === "outdated")
    toast.warning(`OpenCode ${view.version} needs ${view.minimumVersion} or newer`);
  else if (view.kind === "failed" || view.kind === "unusable")
    toast.danger("OpenCode installation failed", { description: view.message });
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
export function useOpenCodeModelSetup({
  instances,
  onReady,
  owner = openCodeSetupOwner,
}: {
  readonly instances: readonly OpenCodeSetupInstance[];
  readonly onReady: () => void;
  readonly owner?: OpenCodeSetupOwner;
}): { readonly setup: AgentModelSetupPresentation | null; readonly refresh: () => void } {
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
  const entry = openCodeModelSetupEntry(snapshot, instances);
  return {
    refresh: () => {
      if (relevant) owner.refresh();
    },
    setup: entry
      ? {
          kind: "opencode",
          label: OPENCODE_FREE_MODELS_LABEL,
          hint: entry.hint,
          tone: entry.tone,
          action:
            entry.action === "settings"
              ? { kind: "settings" }
              : {
                  kind: "open",
                  open: ({ showModels }) =>
                    openOpenCodeInstallDialog(appHandle, { owner, onShowModels: showModels }),
                },
        }
      : null,
  };
}
