import { FormattedMessage, useIntl } from "@/lib/i18n";
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AgentInstanceIcon, SettingsAgentIcon } from "@/components/shared/icons";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import {
  NodexSettingsAddRow,
  NodexSettingsExpandableRow,
  NodexSettingsRow,
  NodexSettingsSection,
  type NodexSettingsDisclosureState,
} from "@/components/ui/settings";
import { toast } from "@/components/ui/toast";
import { focusFallbackRef } from "@/lib/focus-fallback";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { openModal } from "@/lib/modal-registry";
import type { AcpAgentInstanceConfig } from "../../../shared/acp-agent-settings";
import { installReviewedVersion } from "./acp-agent-actions";
import { AcpAgentAddDialog } from "./acp-agent-add-dialog";
import { AcpAgentDetail } from "./acp-agent-detail";
import {
  ACP_ADD_AGENT_ID,
  ACP_STATUS_ACTION_LABELS,
  acpAgentAnchor,
  acpAgentsSummary,
  acpInstanceStatus,
  acpProgressFraction,
  acpSourceSummary,
} from "./acp-agent-model";
import { AcpStatusText } from "./acp-status-text";
import type { AcpAgentsOwner, AcpAgentsSnapshot } from "./acp-agents-owner";
import { acpAgentsOwner, useAcpAgents } from "./use-acp-agents";
import { localAgentDefinition } from "../../../shared/local-agents";
import {
  localAgentFoundDetail,
  localAgentNeedsUpdateDetail,
} from "../local-agents/local-agents-model";
import { useLocalAgentSuggestions } from "../local-agents/use-local-agents";

function AgentRow({
  instance,
  snapshot,
  owner,
  expanded,
  onToggle,
  onRemoved,
}: {
  readonly instance: AcpAgentInstanceConfig;
  readonly snapshot: AcpAgentsSnapshot;
  readonly owner: AcpAgentsOwner;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onRemoved: () => void;
}) {
  const intl = useIntl();
  const inspection = snapshot.inspections.get(instance.id);
  const provider = snapshot.providers.get(instance.id);
  const activity = snapshot.activities.get(instance.id);
  const status = acpInstanceStatus({ instance, inspection, provider, activity }, intl);
  const [toggling, setToggling] = useState(false);
  // A cancelled or failed install keeps its last progress; the bar belongs to Installing only.
  const fraction = status.kind === "installing" ? acpProgressFraction(activity?.progress) : null;
  const toggleRef = useRef<HTMLButtonElement>(null);
  // The quick action ends with its work (Ready, or Sign in opening the row); focus on it stays
  // in the row.
  const keepFocusInRow = focusFallbackRef(() => toggleRef.current);

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
    <NodexSettingsExpandableRow
      id={acpAgentAnchor(instance.id)}
      label={
        <span className="flex min-w-0 items-center gap-2">
          <AgentInstanceIcon
            binding={{ kind: "acp", agentDefinitionId: instance.agentDefinitionId }}
            className="size-3.5"
          />
          <span className="truncate">{instance.displayName}</span>
        </span>
      }
      detail={
        // Long commands keep their end visible: the script or flags identify the Agent.
        <span className="block min-w-0 truncate text-start font-mono [direction:rtl]">
          <bdi dir="ltr">
            {acpSourceSummary(instance, inspection?.status === "ready" ? inspection.value : null)}
          </bdi>
        </span>
      }
      expanded={expanded}
      onExpandedChange={onToggle}
      toggleRef={toggleRef}
      controls={
        <>
          <AcpStatusText
            status={status}
            pending={snapshot.deferred.has(instance.id)}
            className="max-w-[40%]"
          />
          {status.action && status.action !== "sign-in" ? (
            <NodexButton
              ref={keepFocusInRow}
              size="xs"
              variant={status.action === "cancel" ? "ghost" : "secondary"}
              // Cancelling keeps focus on Cancel, which becomes the next step once it settles.
              disabled={activity?.cancelling === true}
              focusableWhenDisabled
              onClick={runAction}
            >
              {intl.formatMessage(ACP_STATUS_ACTION_LABELS[status.action])}
            </NodexButton>
          ) : status.action === "sign-in" && !expanded ? (
            <NodexButton ref={keepFocusInRow} size="xs" variant="secondary" onClick={runAction}>
              {intl.formatMessage(ACP_STATUS_ACTION_LABELS["sign-in"])}
            </NodexButton>
          ) : null}
          <NodexSwitch
            size="compact"
            ariaLabel={intl.formatMessage(
              {
                id: "acpAgents.acpAgentsSettingsSection.toggleAgent",
                defaultMessage:
                  "{enabled, select, true {Turn off {agent}} other {Turn on {agent}}}",
              },
              { enabled: String(instance.enabled), agent: instance.displayName },
            )}
            checked={instance.enabled}
            disabled={toggling || snapshot.saving}
            onCheckedChange={(enabled) => void setEnabled(enabled)}
          />
        </>
      }
      progress={
        fraction !== null ? (
          <div
            role="progressbar"
            aria-label={intl.formatMessage(
              {
                id: "acpAgents.acpAgentsSettingsSection.installingValue",
                defaultMessage: "Installing {value1}",
              },
              { value1: instance.displayName },
            )}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fraction * 100)}
            className="absolute inset-x-4 bottom-0 h-0.5 overflow-hidden bg-text/10"
          >
            <div className="h-full bg-text-info" style={{ width: `${fraction * 100}%` }} />
          </div>
        ) : null
      }
      notice={
        status.tone === "danger" && status.detail ? (
          <p role="alert" className="-mt-1 px-4 pb-2.5 ps-10 text-xs text-danger">
            {status.detail}
            {activity?.phase === "failed" ? (
              <button
                type="button"
                className="ms-2 cursor-interaction text-token-text-secondary underline-offset-2 hover:underline"
                onClick={() => owner.dismiss(instance.id)}
              >
                <FormattedMessage
                  id="acpAgents.acpAgentsSettingsSection.dismiss"
                  defaultMessage="Dismiss"
                />
              </button>
            ) : null}
          </p>
        ) : null
      }
    >
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
        onRemoved={onRemoved}
      />
    </NodexSettingsExpandableRow>
  );
}

/**
 * ACP instances in Settings > Agents > Other agents: one row per instance with its live status and
 * next step, expanding in place to its account, installation and launch configuration.
 */
export function AcpAgentsSettingsSection({
  owner = acpAgentsOwner,
  anchor = null,
  disclosure,
}: {
  readonly owner?: AcpAgentsOwner;
  readonly anchor?: string | null;
  readonly disclosure: NodexSettingsDisclosureState;
}) {
  const intl = useIntl();
  const snapshot = useAcpAgents(owner);
  const local = useLocalAgentSuggestions(owner);
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

  const summary = snapshot.settings
    ? acpAgentsSummary(
        instances.map((instance) =>
          acpInstanceStatus(
            {
              instance,
              inspection: snapshot.inspections.get(instance.id),
              provider: snapshot.providers.get(instance.id),
              activity: snapshot.activities.get(instance.id),
            },
            intl,
          ),
        ),
        intl,
      )
    : null;
  const addAgent = () =>
    openModal(appHandle, AcpAgentAddDialog, {
      owner,
      onAdded: (instanceId: string) => setExpanded(instanceId),
    });

  return (
    <NodexSettingsSection
      id="acp"
      title={intl.formatMessage({
        id: "acpAgents.acpAgentsSettingsSection.otherAgents",
        defaultMessage: "Other agents",
      })}
      icon={<SettingsAgentIcon />}
      description={intl.formatMessage({
        id: "acpAgents.acpAgentsSettingsSection.agentsThatSupportTheAgent",
        defaultMessage:
          "Agents that support the Agent Client Protocol (ACP), from the ACP Registry or your own command.",
      })}
      summary={
        summary ? (
          <>
            {instances.length === 0 && local.suggestions[0]
              ? intl.formatMessage(
                  {
                    id: "acpAgents.acpAgentsSettingsSection.agentFound",
                    defaultMessage: "{agent} found",
                  },
                  { agent: localAgentDefinition(local.suggestions[0].id).name },
                )
              : summary.text}
            {summary.attention ? <span className="text-danger"> · {summary.attention}</span> : null}
          </>
        ) : snapshot.loadError ? (
          intl.formatMessage({
            id: "acpAgents.acpAgentsSettingsSection.couldnTLoad",
            defaultMessage: "Couldn't load",
          })
        ) : null
      }
      disclosure={disclosure}
    >
      {snapshot.configurationFailed ? (
        <div className="flex items-center gap-3 px-4 py-3">
          <p role="alert" className="min-w-0 flex-1 text-xs text-danger">
            <FormattedMessage
              id="acpAgents.acpAgentsSettingsSection.savedChangesHavenTReached"
              defaultMessage="Saved changes haven't reached the Agent runtime yet. Nodex keeps trying."
            />
          </p>
          <NodexButton size="xs" variant="secondary" onClick={owner.checkConfiguration}>
            <FormattedMessage
              id="acpAgents.acpAgentsSettingsSection.tryAgain"
              defaultMessage="Try again"
            />
          </NodexButton>
        </div>
      ) : null}
      {snapshot.loadError && !snapshot.settings ? (
        <div className="flex items-center gap-3 px-4 py-3">
          <p role="alert" className="min-w-0 flex-1 text-xs text-danger">
            <FormattedMessage
              id="acpAgents.acpAgentsSettingsSection.couldnTLoadACPAgents"
              defaultMessage="Couldn't load ACP Agents."
            />{" "}
            {snapshot.loadError}
          </p>
          <NodexButton
            size="xs"
            variant="secondary"
            onClick={() => {
              owner.refresh();
              void local.rescan();
            }}
          >
            <FormattedMessage
              id="acpAgents.acpAgentsSettingsSection.tryAgain"
              defaultMessage="Try again"
            />
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
          onRemoved={() => {
            // The removed row took focus with it; continue from Add agent, which ends every list.
            flushSync(() => setExpanded(null));
            document.getElementById(ACP_ADD_AGENT_ID)?.focus();
          }}
        />
      ))}
      {local.found.map((agent) => {
        const definition = localAgentDefinition(agent.id);
        return (
          <NodexSettingsRow
            key={agent.id}
            label={
              <span className="flex items-center gap-2">
                <AgentInstanceIcon
                  binding={{ kind: "acp", agentDefinitionId: definition.agentDefinitionId }}
                  className="size-3.5"
                />
                {definition.name}
              </span>
            }
            description={
              agent.supported
                ? intl.formatMessage(
                    {
                      id: "acpAgents.acpAgentsSettingsSection.foundOnThisComputer",
                      defaultMessage:
                        "Found on this computer · {command}. Connects with its existing sign-in.",
                    },
                    { command: localAgentFoundDetail(agent) },
                  )
                : localAgentNeedsUpdateDetail(agent, intl)
            }
          >
            {agent.supported ? (
              <NodexButton
                size="sm"
                variant="secondary"
                disabled={local.connecting !== null}
                onClick={() =>
                  void local.connect(agent).then((instanceId) => {
                    if (instanceId) setExpanded(instanceId);
                  })
                }
              >
                {local.connecting === agent.id
                  ? intl.formatMessage({
                      id: "acpAgents.acpAgentsSettingsSection.connecting",
                      defaultMessage: "Connecting",
                    })
                  : intl.formatMessage({
                      id: "acpAgents.acpAgentsSettingsSection.connect",
                      defaultMessage: "Connect",
                    })}
              </NodexButton>
            ) : (
              // Updating happens in a terminal; this looks again once it is done.
              <NodexButton size="sm" variant="secondary" onClick={() => void local.rescan()}>
                <FormattedMessage
                  id="acpAgents.acpAgentsSettingsSection.checkAgain"
                  defaultMessage="Check again"
                />
              </NodexButton>
            )}
          </NodexSettingsRow>
        );
      })}
      {snapshot.settings ? (
        instances.length === 0 ? (
          <NodexSettingsRow
            label={intl.formatMessage({
              id: "acpAgents.acpAgentsSettingsSection.addAnAgent",
              defaultMessage: "Add an agent",
            })}
            description={intl.formatMessage({
              id: "acpAgents.acpAgentsSettingsSection.installOneFromTheACP",
              defaultMessage:
                "Install one from the ACP Registry, or run your own command that speaks ACP.",
            })}
          >
            <NodexButton id={ACP_ADD_AGENT_ID} size="sm" variant="secondary" onClick={addAgent}>
              <FormattedMessage
                id="acpAgents.acpAgentsSettingsSection.addAgent"
                defaultMessage="Add agent"
              />
            </NodexButton>
          </NodexSettingsRow>
        ) : (
          <NodexSettingsAddRow
            id={ACP_ADD_AGENT_ID}
            label={intl.formatMessage({
              id: "acpAgents.acpAgentsSettingsSection.addAgent",
              defaultMessage: "Add agent",
            })}
            disabled={instances.length >= 32}
            onClick={addAgent}
          />
        )
      ) : null}
    </NodexSettingsSection>
  );
}
