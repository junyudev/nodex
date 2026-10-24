import { useState } from "react";
import { ChevronRightIcon, SettingsAgentIcon } from "@/components/shared/icons";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import { NodexSettingsRow, NodexSettingsSection } from "@/components/ui/settings";
import { toast } from "@/components/ui/toast";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { openModal } from "@/lib/modal-registry";
import { cn } from "@/lib/utils";
import type { AcpAgentInstanceConfig } from "../../../shared/acp-agent-settings";
import { installReviewedVersion } from "./acp-agent-actions";
import { AcpAgentAddDialog } from "./acp-agent-add-dialog";
import { AcpAgentDetail } from "./acp-agent-detail";
import {
  ACP_STATUS_ACTION_LABELS,
  acpAgentAnchor,
  acpInstanceStatus,
  acpProgressFraction,
  acpSourceSummary,
} from "./acp-agent-model";
import { AcpStatusText } from "./acp-status-text";
import type { AcpAgentsOwner, AcpAgentsSnapshot } from "./acp-agents-owner";
import { acpAgentsOwner, useAcpAgents } from "./use-acp-agents";

function AgentRow({
  instance,
  snapshot,
  owner,
  expanded,
  onToggle,
  onCollapse,
}: {
  readonly instance: AcpAgentInstanceConfig;
  readonly snapshot: AcpAgentsSnapshot;
  readonly owner: AcpAgentsOwner;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onCollapse: () => void;
}) {
  const inspection = snapshot.inspections.get(instance.id);
  const provider = snapshot.providers.get(instance.id);
  const activity = snapshot.activities.get(instance.id);
  const status = acpInstanceStatus({ instance, inspection, provider, activity });
  const [toggling, setToggling] = useState(false);
  const fraction = activity?.kind === "install" ? acpProgressFraction(activity.progress) : null;
  const detailId = `${acpAgentAnchor(instance.id)}-detail`;

  const runAction = () => {
    switch (status.action) {
      case "install":
        void installReviewedVersion(
          owner,
          instance,
          inspection?.status === "ready" && "version" in inspection.value
            ? inspection.value.version
            : null,
        ).then((reason) => {
          if (reason) toast.danger(reason);
        });
        return;
      case "connect":
        owner.connect(instance.id);
        return;
      case "cancel":
        owner.cancel(instance.id);
        return;
      case "sign-in":
        if (!expanded) onToggle();
        return;
      case null:
        return;
    }
  };

  const setEnabled = async (enabled: boolean) => {
    setToggling(true);
    const outcome = await owner.setEnabled(instance.id, enabled);
    setToggling(false);
    if (!outcome.ok) toast.danger(outcome.message);
  };

  return (
    <div id={acpAgentAnchor(instance.id)} className="flex scroll-mt-4 flex-col">
      <div className="relative flex min-h-14 items-center gap-3 px-4 py-2.5">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={detailId}
          className="flex min-w-0 flex-1 cursor-interaction items-center gap-3 text-start outline-hidden focus-visible:ring-2 focus-visible:ring-token-focus-border rounded-md"
          onClick={onToggle}
        >
          <ChevronRightIcon
            className={cn(
              "icon-2xs shrink-0 text-token-description-foreground transition-transform duration-150",
              expanded && "rotate-90",
            )}
          />
          <SettingsAgentIcon className="icon-xs shrink-0 text-token-text-secondary" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-token-text-primary">
              {instance.displayName}
            </span>
            <span className="truncate font-mono text-xs text-token-description-foreground">
              {acpSourceSummary(instance, inspection?.status === "ready" ? inspection.value : null)}
            </span>
          </span>
        </button>
        <AcpStatusText
          status={status}
          pending={snapshot.deferred.has(instance.id)}
          className="max-w-[40%]"
        />
        {status.action && status.action !== "sign-in" ? (
          <NodexButton
            size="xs"
            variant={status.action === "cancel" ? "ghost" : "secondary"}
            disabled={activity?.cancelling === true}
            onClick={runAction}
          >
            {ACP_STATUS_ACTION_LABELS[status.action]}
          </NodexButton>
        ) : status.action === "sign-in" && !expanded ? (
          <NodexButton size="xs" variant="secondary" onClick={runAction}>
            {ACP_STATUS_ACTION_LABELS["sign-in"]}
          </NodexButton>
        ) : null}
        <NodexSwitch
          size="compact"
          ariaLabel={`${instance.enabled ? "Turn off" : "Turn on"} ${instance.displayName}`}
          checked={instance.enabled}
          disabled={toggling || snapshot.saving}
          onCheckedChange={(enabled) => void setEnabled(enabled)}
        />
        {fraction !== null ? (
          <div
            role="progressbar"
            aria-label={`Installing ${instance.displayName}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fraction * 100)}
            className="absolute inset-x-4 bottom-0 h-0.5 overflow-hidden bg-text/10"
          >
            <div className="h-full bg-text-info" style={{ width: `${fraction * 100}%` }} />
          </div>
        ) : null}
      </div>
      {status.tone === "danger" && status.detail ? (
        <p role="alert" className="-mt-1 px-4 pb-2.5 ps-[3.75rem] text-xs text-danger">
          {status.detail}
          {activity?.phase === "failed" ? (
            <button
              type="button"
              className="ms-2 cursor-interaction text-token-text-secondary underline-offset-2 hover:underline"
              onClick={() => owner.dismiss(instance.id)}
            >
              Dismiss
            </button>
          ) : null}
        </p>
      ) : null}
      {expanded ? (
        <div id={detailId}>
          <AcpAgentDetail
            key={instance.id}
            instance={instance}
            instances={snapshot.settings?.instances ?? []}
            status={status}
            inspection={inspection}
            provider={provider}
            activity={activity}
            deferred={snapshot.deferred.has(instance.id)}
            owner={owner}
            onRemoved={onCollapse}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * ACP instances in Settings > Agent: one row per instance with its live status and next step,
 * expanding in place to its account, installation and launch configuration.
 */
export function AcpAgentsSettingsSection({
  owner = acpAgentsOwner,
  anchor = null,
}: {
  readonly owner?: AcpAgentsOwner;
  readonly anchor?: string | null;
}) {
  const snapshot = useAcpAgents(owner);
  const appHandle = useScopeHandle(appScope);
  const instances = snapshot.settings?.instances ?? [];
  const anchored = instances.find(({ id }) => acpAgentAnchor(id) === anchor)?.id ?? null;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [openedAnchor, setOpenedAnchor] = useState<string | null>(null);
  // A deep link opens its instance once, when that instance first becomes known.
  if (anchored && anchored !== openedAnchor) {
    setOpenedAnchor(anchored);
    setExpanded(anchored);
  }

  return (
    <NodexSettingsSection id="acp" title="ACP Agents">
      <NodexSettingsRow
        label="Agent Client Protocol"
        description="Install Agents from the ACP Registry or run your own command. Each instance keeps its own account, models and history."
      >
        <NodexButton
          size="sm"
          variant="secondary"
          disabled={!snapshot.settings || instances.length >= 32}
          onClick={() =>
            openModal(appHandle, AcpAgentAddDialog, {
              owner,
              onAdded: (instanceId: string) => setExpanded(instanceId),
            })
          }
        >
          Add Agent
        </NodexButton>
      </NodexSettingsRow>
      {snapshot.configurationFailed ? (
        <div className="flex items-center gap-3 px-4 py-3">
          <p role="alert" className="min-w-0 flex-1 text-xs text-danger">
            Saved changes haven't reached the Agent runtime yet. Nodex keeps trying.
          </p>
          <NodexButton size="xs" variant="secondary" onClick={owner.checkConfiguration}>
            Try again
          </NodexButton>
        </div>
      ) : null}
      {snapshot.loadError && !snapshot.settings ? (
        <div className="flex items-center gap-3 px-4 py-3">
          <p role="alert" className="min-w-0 flex-1 text-xs text-danger">
            Couldn't load ACP Agents. {snapshot.loadError}
          </p>
          <NodexButton size="xs" variant="secondary" onClick={owner.refresh}>
            Try again
          </NodexButton>
        </div>
      ) : null}
      {instances.map((instance) => (
        <AgentRow
          key={instance.id}
          instance={instance}
          snapshot={snapshot}
          owner={owner}
          expanded={expanded === instance.id}
          onToggle={() => setExpanded((current) => (current === instance.id ? null : instance.id))}
          onCollapse={() => setExpanded(null)}
        />
      ))}
    </NodexSettingsSection>
  );
}
