import { FormattedMessage, getIntl, useIntl, type IntlShape } from "@/lib/i18n";
import { useId, useState, type ReactNode } from "react";
import { AgentEnvironmentEditor } from "@/components/workbench/agent-environment-editor";
import { NodexButton } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { NodexOptionPicker, NodexSettingsDropdownTrigger } from "@/components/ui/dropdown";
import { Input, Textarea } from "@/components/ui/input";
import { NodexCheckbox, NodexSettingsRow } from "@/components/ui/settings";
import { ACP_ENVIRONMENT_POLICY } from "@/lib/agent-environment-policies";
import type { AcpAgentInstanceConfig } from "../../../shared/acp-agent-settings";
import { AcpAgentAccount } from "./acp-agent-account";
import { AcpArgumentsEditor } from "./acp-arguments-editor";
import { installReviewedVersion } from "./acp-agent-actions";
import {
  acpDraftChanged,
  acpDraftInput,
  acpDraftProblem,
  acpAgentDraft,
  withAcpVariables,
  type AcpAgentDraft,
} from "./acp-agent-draft";
import {
  acpDistributionLabel,
  acpFailureText,
  acpUpdateVersion,
  type AcpActivity,
  type AcpDistributionChoice,
  type AcpInspectionState,
  type AcpInstanceStatus,
  type AcpProviderSnapshot,
} from "./acp-agent-model";
import type { AcpAgentsOwner } from "./acp-agents-owner";
import { AcpModelServices } from "./acp-model-services";

const fieldClassName = "h-8 w-[min(28rem,45vw)] text-sm";
const DISTRIBUTIONS: readonly AcpDistributionChoice[] = ["auto", "binary", "npx", "uvx"];

function Field({
  label,
  description,
  children,
}: {
  readonly label: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <NodexSettingsRow variant="nested" label={label} description={description}>
      {children}
    </NodexSettingsRow>
  );
}

const credentialsText = (instance: AcpAgentInstanceConfig, intl: IntlShape = getIntl()) =>
  instance.credentials.kind === "isolated-home"
    ? intl.formatMessage(
        {
          id: "acpAgents.acpAgentDetail.separateFolderValue",
          defaultMessage: "Separate folder · {value1}",
        },
        { value1: instance.credentials.home },
      )
    : intl.formatMessage({
        id: "acpAgents.acpAgentDetail.sharedWithYourUserAccount",
        defaultMessage: "Shared with your user account",
      });

/**
 * The latest save's own outcome. Whether saved changes are pending comes from Main's current
 * configuration status instead, so it clears when the Agent goes idle.
 */
type SaveNotice = { readonly kind: "saved" } | { readonly kind: "error"; readonly message: string };

/**
 * One instance's account, installation and launch configuration. Identity, the Registry Agent
 * and account storage are fixed after saving; another account needs another instance.
 */
export function AcpAgentDetail({
  instance,
  instances,
  status,
  inspection,
  provider,
  activity,
  deferred,
  owner,
  onRemoved,
}: {
  readonly instance: AcpAgentInstanceConfig;
  readonly instances: readonly AcpAgentInstanceConfig[];
  readonly status: AcpInstanceStatus;
  readonly inspection: AcpInspectionState | undefined;
  readonly provider: AcpProviderSnapshot | undefined;
  readonly activity: AcpActivity | undefined;
  readonly deferred: boolean;
  readonly owner: AcpAgentsOwner;
  readonly onRemoved: () => void;
}) {
  const intl = useIntl();
  const [draft, setDraft] = useState<AcpAgentDraft>(() => acpAgentDraft(instance));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<SaveNotice | null>(null);
  // Kept returns focus to Remove; the confirmation itself starts on Keep, the safe answer.
  const [removal, setRemoval] = useState<"idle" | "confirming" | "kept">("idle");
  const [uninstallToo, setUninstallToo] = useState(true);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const changed = acpDraftChanged(instance, draft);
  const problem = changed ? acpDraftProblem(instance, draft, intl) : null;
  const problemId = useId();
  // The message stays beside Save; the field that blocks it is marked and described by it.
  const marking = { "aria-invalid": true, "aria-describedby": problemId } as const;
  const problemOf = (field: "name" | "executable") => (problem?.field === field ? marking : {});
  const change = (patch: Partial<AcpAgentDraft>) => {
    setNotice(null);
    setDraft((current) => ({ ...current, ...patch }));
  };
  const inspected = inspection?.status === "ready" ? inspection.value : null;
  const installed = inspected?.status === "ready";
  const updateVersion = acpUpdateVersion(instance, inspected);
  const source = instance.source;
  const running = activity?.phase === "running" || activity?.phase === "starting";
  // Another instance of the same Registry Agent keeps using its installed files.
  const sharedInstall =
    source.kind === "registry" &&
    instances.some(
      (other) =>
        other.id !== instance.id &&
        other.source.kind === "registry" &&
        other.source.agentId === source.agentId,
    );
  const [updateError, setUpdateError] = useState<string | null>(null);
  const update = async (version: string) => {
    setUpdateError(null);
    setUpdateError(await installReviewedVersion(owner, instance, version));
  };

  const save = async () => {
    if (saving || !changed || problem) return;
    setSaving(true);
    const outcome = await owner.updateInstance(instance.id, (saved) => acpDraftInput(saved, draft));
    setSaving(false);
    if (!outcome.ok) {
      setNotice({ kind: "error", message: outcome.message });
      return;
    }
    setNotice({ kind: "saved" });
    const saved = owner.getSnapshot().settings?.instances.find(({ id }) => id === instance.id);
    if (saved) setDraft(acpAgentDraft(saved));
  };

  const remove = async () => {
    setSaving(true);
    setRemoveError(null);
    const outcome = await owner.removeInstance(instance.id);
    if (!outcome.ok) {
      setSaving(false);
      setRemoveError(outcome.message);
      return;
    }
    // The instance is gone either way; uninstalling finishes in the background and reports only
    // a refusal, since this row no longer exists to show it.
    if (source.kind === "registry" && uninstallToo && !sharedInstall) {
      const name = instance.displayName;
      void owner.uninstall(source.agentId).then((result) => {
        if (!result.ok)
          toast.danger(
            intl.formatMessage(
              {
                id: "acpAgents.acpAgentDetail.couldnTUninstallValue",
                defaultMessage: "Couldn't uninstall {value1}",
              },
              { value1: name },
            ),
            {
              description: acpFailureText(result.error, "uninstall"),
            },
          );
      });
    }
    setSaving(false);
    onRemoved();
  };

  return (
    <div className="flex flex-col bg-token-foreground/[0.015]">
      {instance.enabled && installed ? (
        <AcpAgentAccount
          instance={instance}
          status={status}
          provider={provider}
          activity={activity}
          owner={owner}
          documentationUrl={
            inspected?.status === "ready" ? (inspected.documentationUrl ?? null) : null
          }
          onSetVariables={(names) =>
            change({ environment: withAcpVariables(draft.environment, names) })
          }
        />
      ) : null}
      {source.kind === "registry" ? (
        <Field
          label={intl.formatMessage({
            id: "acpAgents.acpAgentDetail.installation",
            defaultMessage: "Installation",
          })}
          description={
            inspected && "version" in inspected && inspected.version
              ? `v${inspected.version}${
                  inspected.status === "ready" && inspected.distribution !== "local"
                    ? ` · ${acpDistributionLabel(inspected.distribution, intl)}`
                    : ""
                }${inspected.status === "ready" ? "" : intl.formatMessage({ id: "acpAgents.acpAgentDetail.notInstalled", defaultMessage: " · Not installed" })}`
              : intl.formatMessage({
                  id: "acpAgents.acpAgentDetail.managedByNodexInThis",
                  defaultMessage: "Managed by Nodex in this Profile",
                })
          }
        >
          {updateVersion ? (
            <NodexButton
              size="toolbar"
              variant="secondary"
              disabled={running || !instance.enabled}
              onClick={() => void update(updateVersion)}
            >
              {intl.formatMessage(
                { id: "acpAgents.acpAgentDetail.updateTo", defaultMessage: "Update to v{version}" },
                { version: updateVersion },
              )}
            </NodexButton>
          ) : null}
          {updateError ? (
            <span role="alert" className="text-xs text-danger">
              {updateError}
            </span>
          ) : null}
        </Field>
      ) : null}
      <Field
        label={intl.formatMessage({ id: "acpAgents.acpAgentDetail.name", defaultMessage: "Name" })}
      >
        <Input
          variant="settings"
          {...problemOf("name")}
          aria-label={intl.formatMessage({
            id: "acpAgents.acpAgentDetail.agentName",
            defaultMessage: "Agent name",
          })}
          className={fieldClassName}
          value={draft.displayName}
          maxLength={128}
          disabled={saving}
          onChange={(event) => change({ displayName: event.target.value })}
        />
      </Field>
      {source.kind === "local" ? (
        <>
          <Field
            label={intl.formatMessage({
              id: "acpAgents.acpAgentDetail.executable",
              defaultMessage: "Executable",
            })}
            description={intl.formatMessage({
              id: "acpAgents.acpAgentDetail.anAbsolutePathOrA",
              defaultMessage: "An absolute path or a command on PATH.",
            })}
          >
            <Input
              variant="settings"
              {...problemOf("executable")}
              aria-label={intl.formatMessage({
                id: "acpAgents.acpAgentDetail.executable",
                defaultMessage: "Executable",
              })}
              className={`${fieldClassName} font-mono text-xs`}
              value={draft.executable}
              spellCheck={false}
              disabled={saving}
              onChange={(event) => change({ executable: event.target.value })}
            />
          </Field>
          <Field
            label={intl.formatMessage({
              id: "acpAgents.acpAgentDetail.arguments",
              defaultMessage: "Arguments",
            })}
            description={intl.formatMessage({
              id: "acpAgents.acpAgentDetail.eachPassedExactlyAsWritten",
              defaultMessage: "Each passed exactly as written, without a shell.",
            })}
          >
            <AcpArgumentsEditor
              className="w-[min(28rem,45vw)]"
              value={draft.arguments}
              disabled={saving}
              marked={
                problem?.field === "argument" ? { index: problem.index, props: marking } : null
              }
              onChange={(next) => change({ arguments: next })}
            />
          </Field>
        </>
      ) : (
        <>
          <Field
            label={intl.formatMessage({
              id: "acpAgents.acpAgentDetail.distribution",
              defaultMessage: "Distribution",
            })}
            description={intl.formatMessage({
              id: "acpAgents.acpAgentDetail.changingItInstallsTheAgent",
              defaultMessage: "Changing it installs the Agent again from the Registry.",
            })}
          >
            <NodexOptionPicker
              value={draft.distribution}
              options={DISTRIBUTIONS.map((value) => ({
                value,
                label: acpDistributionLabel(value, intl),
              }))}
              disabled={saving}
              onValueChange={(value) => change({ distribution: value as AcpDistributionChoice })}
              triggerButton={
                <NodexSettingsDropdownTrigger
                  aria-label={intl.formatMessage({
                    id: "acpAgents.acpAgentDetail.distribution",
                    defaultMessage: "Distribution",
                  })}
                >
                  {acpDistributionLabel(draft.distribution, intl)}
                </NodexSettingsDropdownTrigger>
              }
            />
          </Field>
          <Field
            label={intl.formatMessage({
              id: "acpAgents.acpAgentDetail.executableOverride",
              defaultMessage: "Executable override",
            })}
            description={intl.formatMessage({
              id: "acpAgents.acpAgentDetail.runsThisExecutableInsteadOf",
              defaultMessage:
                "Runs this executable instead of the installed one, with the same arguments.",
            })}
          >
            <Input
              variant="settings"
              aria-label={intl.formatMessage({
                id: "acpAgents.acpAgentDetail.executableOverride",
                defaultMessage: "Executable override",
              })}
              className={`${fieldClassName} font-mono text-xs`}
              placeholder={intl.formatMessage({
                id: "acpAgents.acpAgentDetail.installedExecutable",
                defaultMessage: "Installed executable",
              })}
              value={draft.executableOverride}
              spellCheck={false}
              disabled={saving}
              onChange={(event) => change({ executableOverride: event.target.value })}
            />
          </Field>
        </>
      )}
      <Field
        label={intl.formatMessage({
          id: "acpAgents.acpAgentDetail.customModels",
          defaultMessage: "Custom models",
        })}
        description={intl.formatMessage({
          id: "acpAgents.acpAgentDetail.modelIDsToOfferEven",
          defaultMessage: "Model IDs to offer even when the Agent doesn't list them. One per line.",
        })}
      >
        <Textarea
          variant="settings"
          aria-label={intl.formatMessage({
            id: "acpAgents.acpAgentDetail.customModels",
            defaultMessage: "Custom models",
          })}
          className="w-[min(28rem,45vw)] font-mono text-xs"
          rows={2}
          value={draft.customModelsText}
          spellCheck={false}
          disabled={saving}
          onChange={(event) => change({ customModelsText: event.target.value })}
        />
      </Field>
      <AgentEnvironmentEditor
        rows={draft.environment}
        disabled={saving}
        policy={ACP_ENVIRONMENT_POLICY}
        onChange={(environment) => change({ environment })}
      />
      <Field
        label={intl.formatMessage({
          id: "acpAgents.acpAgentDetail.accountStorage",
          defaultMessage: "Account storage",
        })}
        description={intl.formatMessage({
          id: "acpAgents.acpAgentDetail.fixedForThisInstanceAdd",
          defaultMessage:
            "Fixed for this instance. Add another instance to use a different account.",
        })}
      >
        <span className="max-w-[min(28rem,45vw)] truncate text-sm text-token-text-secondary">
          {credentialsText(instance, intl)}
        </span>
      </Field>
      <Field
        label={intl.formatMessage({
          id: "acpAgents.acpAgentDetail.systemProxy",
          defaultMessage: "System proxy",
        })}
      >
        <NodexOptionPicker
          value={draft.proxy}
          options={[
            {
              value: "inherit-host",
              label: intl.formatMessage({
                id: "acpAgents.acpAgentDetail.useSystemProxy",
                defaultMessage: "Use system proxy",
              }),
            },
            {
              value: "isolated",
              label: intl.formatMessage({
                id: "acpAgents.acpAgentDetail.donTUseAProxy",
                defaultMessage: "Don't use a proxy",
              }),
            },
          ]}
          disabled={saving}
          onValueChange={(value) =>
            change({ proxy: value === "isolated" ? "isolated" : "inherit-host" })
          }
          triggerButton={
            <NodexSettingsDropdownTrigger
              aria-label={intl.formatMessage({
                id: "acpAgents.acpAgentDetail.systemProxy",
                defaultMessage: "System proxy",
              })}
            >
              {draft.proxy === "isolated"
                ? intl.formatMessage({
                    id: "acpAgents.acpAgentDetail.donTUseAProxy",
                    defaultMessage: "Don't use a proxy",
                  })
                : intl.formatMessage({
                    id: "acpAgents.acpAgentDetail.useSystemProxy",
                    defaultMessage: "Use system proxy",
                  })}
            </NodexSettingsDropdownTrigger>
          }
        />
      </Field>
      {instance.enabled && provider?.configurableProviders ? (
        <AcpModelServices instanceId={instance.id} owner={owner} />
      ) : null}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        {removal === "confirming" ? (
          <>
            <span className="text-sm">
              <FormattedMessage id="acpAgents.acpAgentDetail.remove" defaultMessage="Remove" />{" "}
              {instance.displayName}?
            </span>
            {source.kind === "registry" && !sharedInstall ? (
              <label className="flex items-center gap-1.5 text-xs text-token-text-secondary">
                <NodexCheckbox
                  ariaLabel={intl.formatMessage({
                    id: "acpAgents.acpAgentDetail.alsoUninstall",
                    defaultMessage: "Also uninstall",
                  })}
                  checked={uninstallToo}
                  disabled={saving}
                  onCheckedChange={setUninstallToo}
                />
                <FormattedMessage
                  id="acpAgents.acpAgentDetail.alsoUninstall"
                  defaultMessage="Also uninstall"
                />
              </label>
            ) : null}
            <NodexButton
              size="toolbar"
              variant="destructive"
              disabled={saving}
              onClick={() => void remove()}
            >
              <FormattedMessage id="acpAgents.acpAgentDetail.remove" defaultMessage="Remove" />
            </NodexButton>
            <NodexButton
              size="toolbar"
              variant="ghost"
              autoFocus
              disabled={saving}
              onClick={() => setRemoval("kept")}
            >
              <FormattedMessage id="acpAgents.acpAgentDetail.keep" defaultMessage="Keep" />
            </NodexButton>
          </>
        ) : (
          <NodexButton
            size="toolbar"
            variant="ghost"
            className="text-danger"
            autoFocus={removal === "kept"}
            disabled={saving}
            onClick={() => setRemoval("confirming")}
          >
            <FormattedMessage id="acpAgents.acpAgentDetail.remove" defaultMessage="Remove" />
          </NodexButton>
        )}
        <span className="min-w-0 flex-1 text-end text-xs">
          {removeError ? (
            <span role="alert" className="text-danger">
              {removeError}
            </span>
          ) : problem ? (
            <span id={problemId} role="alert" className="text-danger">
              {problem.message}
            </span>
          ) : notice?.kind === "error" ? (
            <span role="alert" className="text-danger">
              {notice.message}
            </span>
          ) : deferred ? (
            <span role="status" className="text-token-text-secondary">
              <FormattedMessage
                id="acpAgents.acpAgentDetail.savedChangesApplyWhenIts"
                defaultMessage="Saved. Changes apply when its current work finishes."
              />
            </span>
          ) : notice ? (
            <span role="status" className="text-token-text-secondary">
              <FormattedMessage id="acpAgents.acpAgentDetail.saved" defaultMessage="Saved" />
            </span>
          ) : null}
        </span>
        {changed ? (
          <NodexButton
            size="toolbar"
            variant="ghost"
            disabled={saving}
            onClick={() => {
              setDraft(acpAgentDraft(instance));
              setNotice(null);
            }}
          >
            <FormattedMessage id="acpAgents.acpAgentDetail.discard" defaultMessage="Discard" />
          </NodexButton>
        ) : null}
        <NodexButton
          size="toolbar"
          variant="secondary"
          disabled={saving || !changed || problem !== null}
          onClick={() => void save()}
        >
          {saving
            ? intl.formatMessage({
                id: "acpAgents.acpAgentDetail.saving",
                defaultMessage: "Saving…",
              })
            : intl.formatMessage({ id: "acpAgents.acpAgentDetail.save", defaultMessage: "Save" })}
        </NodexButton>
      </div>
    </div>
  );
}
