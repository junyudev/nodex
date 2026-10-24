import { useState, type ReactNode } from "react";
import { SettingsAgentIcon } from "@/components/shared/icons";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import type { ScopeHandle } from "@/lib/maitai";
import { openModal, type ModalCloseProps } from "@/lib/modal-registry";
import { AcpAgentAccount } from "./acp-agent-account";
import { installReviewedVersion } from "./acp-agent-actions";
import { acpInstanceStatus, type AcpInstanceStatus } from "./acp-agent-model";
import type { AcpAgentsOwner } from "./acp-agents-owner";
import { AcpStatusText } from "./acp-status-text";
import { useAcpAgents } from "./use-acp-agents";

export interface AcpAgentSetupDialogProps extends ModalCloseProps {
  readonly owner: AcpAgentsOwner;
  readonly instanceId: string;
  /** Reopens the model menu once the Agent's models are available. */
  readonly onShowModels?: () => void;
  /** Settings owns configuration, such as the environment an Agent asks for. */
  readonly onOpenSettings: () => void;
}

export function openAcpAgentSetupDialog(
  appHandle: ScopeHandle,
  props: Omit<AcpAgentSetupDialogProps, "onClose">,
): void {
  openModal(appHandle, AcpAgentSetupDialog, props);
}

const NEEDS_SETTINGS = new Set<AcpInstanceStatus["kind"]>([
  "needs-runner",
  "unsupported",
  "missing",
  "off",
  "pending",
]);

/**
 * Finishes one Agent's setup from where it was needed, without leaving the conversation:
 * install, connect or sign in. Closing it cancels an unfinished sign-in; installation and
 * connection continue and stay visible in Settings.
 */
export function AcpAgentSetupDialog({
  owner,
  instanceId,
  onShowModels,
  onOpenSettings,
  onClose,
}: AcpAgentSetupDialogProps) {
  const snapshot = useAcpAgents(owner);
  const [installError, setInstallError] = useState<string | null>(null);
  const instance = snapshot.settings?.instances.find(({ id }) => id === instanceId);
  const inspection = snapshot.inspections.get(instanceId);
  const provider = snapshot.providers.get(instanceId);
  const activity = snapshot.activities.get(instanceId);
  const status = instance ? acpInstanceStatus({ instance, inspection, provider, activity }) : null;
  const settings = () => {
    onClose();
    onOpenSettings();
  };

  let body: ReactNode = null;
  let primary: ReactNode = null;
  if (!snapshot.settings)
    body = (
      <p className="text-sm text-token-text-secondary">{snapshot.loadError ?? "Loading Agent…"}</p>
    );
  else if (!instance || !status)
    body = <p className="text-sm text-token-text-secondary">This Agent is no longer configured.</p>;
  else {
    if (status.kind === "sign-in" || status.kind === "ready")
      body = (
        <div className="-mx-4">
          <AcpAgentAccount
            instance={instance}
            status={status}
            provider={provider}
            activity={activity}
            owner={owner}
            onSetVariables={settings}
          />
        </div>
      );
    else if (status.detail)
      body = (
        <p
          role={status.tone === "danger" ? "alert" : undefined}
          className={
            status.tone === "danger" ? "text-sm text-danger" : "text-sm text-token-text-secondary"
          }
        >
          {status.detail}
        </p>
      );
    switch (status.action) {
      case "install":
        primary = (
          <NodexDialogAction
            tone="primary"
            onClick={() =>
              void installReviewedVersion(
                owner,
                instance,
                inspection?.status === "ready" && "version" in inspection.value
                  ? inspection.value.version
                  : null,
              ).then(setInstallError)
            }
          >
            Install and connect
          </NodexDialogAction>
        );
        break;
      case "connect":
        primary = (
          <NodexDialogAction tone="primary" onClick={() => owner.connect(instanceId)}>
            {status.kind === "failed" ? "Try again" : "Connect"}
          </NodexDialogAction>
        );
        break;
      case "cancel":
        primary = (
          <NodexDialogAction
            disabled={activity?.cancelling === true}
            onClick={() => owner.cancel(instanceId)}
          >
            Cancel
          </NodexDialogAction>
        );
        break;
      case "sign-in":
      case null:
        if (status.kind === "ready")
          primary = (
            <NodexDialogAction
              tone="primary"
              onClick={() => {
                onClose();
                onShowModels?.();
              }}
            >
              {onShowModels ? "Show models" : "Done"}
            </NodexDialogAction>
          );
        else if (NEEDS_SETTINGS.has(status.kind))
          primary = (
            <NodexDialogAction tone="primary" onClick={settings}>
              Open settings
            </NodexDialogAction>
          );
    }
  }

  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <NodexDialogContent size="default">
        <NodexDialogFrame>
          <NodexDialogHeader>
            <NodexDialogTitle className="flex items-center gap-2">
              <SettingsAgentIcon className="icon-sm" />
              <span className="min-w-0 truncate">{instance?.displayName ?? "Agent"}</span>
            </NodexDialogTitle>
            {status ? <AcpStatusText status={status} /> : null}
          </NodexDialogHeader>
          <NodexDialogBody className="gap-2">
            {body}
            {installError ? (
              <p role="alert" className="text-sm text-danger">
                {installError}
              </p>
            ) : null}
          </NodexDialogBody>
          <NodexDialogFooter>
            {instance && !NEEDS_SETTINGS.has(status?.kind ?? "off") ? (
              <NodexDialogAction onClick={settings}>Settings</NodexDialogAction>
            ) : null}
            {primary ?? <NodexDialogAction onClick={onClose}>Close</NodexDialogAction>}
          </NodexDialogFooter>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}
