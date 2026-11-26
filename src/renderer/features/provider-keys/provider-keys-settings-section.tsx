import { useAgentRuntimeProviders } from "@/lib/use-agent-runtime-providers";
import { useAppComponents } from "../app-components/use-app-components";
import { providerComponentSetup } from "../app-components/provider-component-setup";
import { providerKeyRuntimeInstanceId } from "../../../shared/provider-keys";

import { useState } from "react";
import { InstanceModels } from "@/features/model-policy/agent-models";
import { flushSync } from "react-dom";
import { defineMessages, FormattedMessage, useIntl } from "@/lib/i18n";
import { ApiKeyIcon, ProviderKeyIcon } from "@/components/shared/icons";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import {
  NodexSettingsAddRow,
  NodexSettingsExpandableRow,
  NodexSettingsRow,
  NodexSettingsSection,
  type NodexSettingsDisclosureState,
} from "@/components/ui/settings";
import { toast } from "@/components/ui/toast";
import { agentDefinition } from "../../../shared/agents/registry";
import {
  PROVIDER_KEY_API_NAMES,
  PROVIDER_KEY_LIMIT,
  providerKeyApi,
  providerKeyBaseUrl,
  providerKeyTarget,
  type ProviderKeyConnection,
  type ProviderKeyResult,
} from "../../../shared/provider-keys";
import { providerKeyAnchor, providerKeyConnectionOfAnchor } from "./provider-key-anchor";
import { ProviderKeyForm } from "./provider-key-form";
import { parseTypedModels } from "./provider-key-form-model";
import { providerKeyDetail, providerKeysSummary } from "./provider-keys-model";
import { providerKeyBalanceLabel } from "./provider-key-usage-model";
import { useProviderKeyUsageAccounts } from "./use-provider-key-usage-accounts";
import { useProviderKeys, type ProviderKeysController } from "./use-provider-keys";

const ADD_KEY_ID = "provider-key-add";

const messages = defineMessages({
  cancel: { id: "providerKeys.providerKeysSettingsSection.cancel", defaultMessage: "Cancel" },
  save: { id: "providerKeys.providerKeysSettingsSection.save", defaultMessage: "Save" },
  checking: {
    id: "providerKeys.providerKeysSettingsSection.checking",
    defaultMessage: "Checking",
  },
  remove: { id: "providerKeys.providerKeysSettingsSection.remove", defaultMessage: "Remove" },
  oneModelIdPerLine: {
    id: "providerKeys.providerKeysSettingsSection.oneModelIdPerLine",
    defaultMessage: "One model ID per line",
  },
});
const fieldClassName = "h-8 w-[min(22rem,40vw)] text-sm";

/** Reports a refused change where the person made it; a success needs no message. */
const reportFailure = (result: ProviderKeyResult) => {
  if (!result.ok) toast.danger(result.message);
  return result.ok;
};

function KeyRow({
  connection,
  keys,
}: {
  readonly connection: ProviderKeyConnection;
  readonly keys: ProviderKeysController;
}) {
  const intl = useIntl();
  const [replacing, setReplacing] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    const saved = reportFailure(await keys.update({ id: connection.id, apiKey: key.trim() }));
    setBusy(false);
    if (saved) {
      setReplacing(false);
      setKey("");
    }
  };
  return (
    <NodexSettingsRow
      variant="nested"
      label={intl.formatMessage({
        id: "providerKeys.providerKeysSettingsSection.apiKey",
        defaultMessage: "API key",
      })}
      description={
        connection.keyHint
          ? intl.formatMessage(
              {
                id: "providerKeys.providerKeysSettingsSection.keyEndsIn",
                defaultMessage: "Ends in {hint}. Stored encrypted with your system keychain.",
              },
              { hint: connection.keyHint },
            )
          : intl.formatMessage({
              id: "providerKeys.providerKeysSettingsSection.keyStoredEncrypted",
              defaultMessage: "Stored encrypted with your system keychain.",
            })
      }
    >
      {replacing ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Input
            variant="settings"
            aria-label={intl.formatMessage(
              {
                id: "providerKeys.providerKeysSettingsSection.newApiKey",
                defaultMessage: "New {name} API key",
              },
              { name: connection.displayName },
            )}
            autoFocus
            autoComplete="off"
            className={`${fieldClassName} font-mono`}
            spellCheck={false}
            type="password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <NodexButton
            size="toolbar"
            variant="secondary"
            type="submit"
            disabled={!key.trim() || busy}
          >
            {intl.formatMessage(busy ? messages.checking : messages.save)}
          </NodexButton>
          <NodexButton
            size="toolbar"
            variant="ghostSecondary"
            disabled={busy}
            onClick={() => {
              setReplacing(false);
              setKey("");
            }}
          >
            <FormattedMessage {...messages.cancel} />
          </NodexButton>
        </form>
      ) : (
        <NodexButton size="toolbar" variant="secondary" onClick={() => setReplacing(true)}>
          <FormattedMessage
            id="providerKeys.providerKeysSettingsSection.replace"
            defaultMessage="Replace"
          />
        </NodexButton>
      )}
    </NodexSettingsRow>
  );
}

function ModelsRow({
  connection,
  keys,
}: {
  readonly connection: ProviderKeyConnection;
  readonly keys: ProviderKeysController;
}) {
  const intl = useIntl();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const run = async (work: () => Promise<ProviderKeyResult>) => {
    setBusy(true);
    const ok = reportFailure(await work());
    setBusy(false);
    return ok;
  };
  const typed = editing === null ? [] : parseTypedModels(connection.preset, editing);
  return (
    <>
      <NodexSettingsRow
        variant="nested"
        label={intl.formatMessage({
          id: "providerKeys.providerKeysSettingsSection.models",
          defaultMessage: "Models",
        })}
        description={
          connection.models.length
            ? intl.formatList(
                connection.models.map(({ name }) => name),
                { type: "conjunction", style: "narrow" },
              )
            : intl.formatMessage({
                id: "providerKeys.providerKeysSettingsSection.noModels",
                defaultMessage: "None",
              })
        }
      >
        {connection.preset === "custom" && editing === null ? (
          <NodexButton
            size="toolbar"
            variant="ghostSecondary"
            disabled={busy}
            onClick={() => setEditing(connection.models.map(({ id }) => id).join("\n"))}
          >
            <FormattedMessage
              id="providerKeys.providerKeysSettingsSection.edit"
              defaultMessage="Edit"
            />
          </NodexButton>
        ) : null}
        <NodexButton
          size="toolbar"
          variant="secondary"
          disabled={busy || editing !== null}
          onClick={() => void run(() => keys.refreshModels(connection.id))}
        >
          {busy && editing === null
            ? intl.formatMessage(messages.checking)
            : intl.formatMessage({
                id: "providerKeys.providerKeysSettingsSection.checkAgain",
                defaultMessage: "Check again",
              })}
        </NodexButton>
      </NodexSettingsRow>
      {editing !== null ? (
        <form
          className="flex flex-col gap-2 px-4 pb-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!typed.length) return;
            void run(() => keys.update({ id: connection.id, models: [...typed] })).then(
              (ok) => ok && setEditing(null),
            );
          }}
        >
          <Textarea
            variant="settings"
            aria-label={intl.formatMessage(
              {
                id: "providerKeys.providerKeysSettingsSection.modelIds",
                defaultMessage: "{name} model IDs",
              },
              { name: connection.displayName },
            )}
            autoFocus
            className="min-h-20 font-mono text-sm"
            placeholder={intl.formatMessage(messages.oneModelIdPerLine)}
            spellCheck={false}
            value={editing}
            onChange={(event) => setEditing(event.target.value)}
          />
          <div className="flex justify-end gap-2">
            <NodexButton size="toolbar" variant="ghostSecondary" onClick={() => setEditing(null)}>
              <FormattedMessage {...messages.cancel} />
            </NodexButton>
            <NodexButton
              size="toolbar"
              variant="secondary"
              type="submit"
              disabled={!typed.length || busy}
            >
              <FormattedMessage {...messages.save} />
            </NodexButton>
          </div>
        </form>
      ) : null}
    </>
  );
}

function ConnectionDetail({
  connection,
  keys,
  onRemoved,
}: {
  readonly connection: ProviderKeyConnection;
  readonly keys: ProviderKeysController;
  readonly onRemoved: () => void;
}) {
  const intl = useIntl();
  const [name, setName] = useState(connection.displayName);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const rename = async () => {
    const next = name.trim();
    if (!next || next === connection.displayName) return setName(connection.displayName);
    if (!reportFailure(await keys.update({ id: connection.id, displayName: next })))
      setName(connection.displayName);
  };
  return (
    <>
      <NodexSettingsRow
        variant="nested"
        label={intl.formatMessage({
          id: "providerKeys.providerKeysSettingsSection.name",
          defaultMessage: "Name",
        })}
        description={intl.formatMessage({
          id: "providerKeys.providerKeysSettingsSection.howTheModelMenuNamesIt",
          defaultMessage: "How the model menu names it.",
        })}
      >
        <Input
          variant="settings"
          aria-label={intl.formatMessage(
            {
              id: "providerKeys.providerKeysSettingsSection.connectionName",
              defaultMessage: "{name} name",
            },
            { name: connection.displayName },
          )}
          className={fieldClassName}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => void rename()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </NodexSettingsRow>
      <KeyRow connection={connection} keys={keys} />
      <ModelsRow connection={connection} keys={keys} />
      <NodexSettingsRow
        variant="nested"
        label={intl.formatMessage({
          id: "providerKeys.providerKeysSettingsSection.endpoint",
          defaultMessage: "Endpoint",
        })}
        description={intl.formatMessage(
          {
            id: "providerKeys.providerKeysSettingsSection.runsOnBuiltInAgent",
            defaultMessage: "Runs on Nodex’s built-in {agent}, through the {api}.",
          },
          {
            agent: agentDefinition(connection.agent).label,
            api: PROVIDER_KEY_API_NAMES[providerKeyApi(connection.agent)],
          },
        )}
      >
        <span className="max-w-[min(22rem,40vw)] truncate font-mono text-xs text-token-text-secondary">
          {providerKeyBaseUrl(providerKeyTarget(connection))}
        </span>
      </NodexSettingsRow>
      {/* The same closing strip as other Agents' settings: Remove, then Keep as the safe answer. */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        {confirming ? (
          <>
            <span className="text-sm">
              <FormattedMessage
                id="providerKeys.providerKeysSettingsSection.removeConnection"
                defaultMessage="Remove {name}?"
                values={{ name: connection.displayName }}
              />
            </span>
            <span className="text-xs text-token-text-secondary">
              <FormattedMessage
                id="providerKeys.providerKeysSettingsSection.itsEncryptedKeyIsDeletedToo"
                defaultMessage="Its encrypted key is deleted too."
              />
            </span>
            <NodexButton
              size="toolbar"
              variant="destructive"
              disabled={removing}
              onClick={() => {
                setRemoving(true);
                void keys
                  .remove(connection.id)
                  .then(onRemoved, (cause: unknown) =>
                    toast.danger(cause instanceof Error ? cause.message : String(cause)),
                  )
                  .finally(() => setRemoving(false));
              }}
            >
              <FormattedMessage {...messages.remove} />
            </NodexButton>
            <NodexButton
              size="toolbar"
              variant="ghost"
              autoFocus
              disabled={removing}
              onClick={() => setConfirming(false)}
            >
              <FormattedMessage
                id="providerKeys.providerKeysSettingsSection.keep"
                defaultMessage="Keep"
              />
            </NodexButton>
          </>
        ) : (
          <NodexButton
            size="toolbar"
            variant="ghost"
            className="text-danger"
            onClick={() => setConfirming(true)}
          >
            <FormattedMessage {...messages.remove} />
          </NodexButton>
        )}
      </div>
    </>
  );
}

function ConnectionRow({
  connection,
  componentStatus,
  balance,
  keys,
  expanded,
  onToggle,
  onRemoved,
}: {
  readonly connection: ProviderKeyConnection;
  readonly componentStatus?: string;
  /** What the provider says is left, such as `¥2.90 left`; null when it says nothing. */
  readonly balance: string | null;
  readonly keys: ProviderKeysController;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onRemoved: () => void;
}) {
  const intl = useIntl();
  const [toggling, setToggling] = useState(false);
  return (
    <NodexSettingsExpandableRow
      id={providerKeyAnchor(connection.id)}
      label={
        <span className="flex min-w-0 items-center gap-2">
          <ProviderKeyIcon preset={connection.preset} className="size-3.5" />
          <span className="truncate">{connection.displayName}</span>
        </span>
      }
      detail={componentStatus ?? providerKeyDetail(connection, intl, balance)}
      expanded={expanded}
      onExpandedChange={onToggle}
      controls={
        <NodexSwitch
          size="compact"
          ariaLabel={intl.formatMessage(
            {
              id: "providerKeys.providerKeysSettingsSection.toggleConnection",
              defaultMessage: "{enabled, select, true {Turn off {name}} other {Turn on {name}}}",
            },
            { enabled: String(connection.enabled), name: connection.displayName },
          )}
          checked={connection.enabled}
          disabled={toggling}
          onCheckedChange={(enabled) => {
            setToggling(true);
            void keys
              .update({ id: connection.id, enabled })
              .then(reportFailure)
              .finally(() => setToggling(false));
          }}
        />
      }
    >
      <InstanceModels instanceId={providerKeyRuntimeInstanceId(connection)} variant="nested" />
      <ConnectionDetail
        key={connection.id}
        connection={connection}
        keys={keys}
        onRemoved={onRemoved}
      />
    </NodexSettingsExpandableRow>
  );
}

/**
 * Settings > Agents > API keys: model providers connected with the person's own key, one row each,
 * expanding to its key, models and endpoint. Adding one checks the key before saving it.
 */
export function ProviderKeysSettingsSection({
  anchor = null,
  disclosure,
}: {
  readonly anchor?: string | null;
  readonly disclosure: NodexSettingsDisclosureState;
}) {
  const intl = useIntl();
  const keys = useProviderKeys();
  const connections = keys.settings?.connections ?? [];
  const providers = useAgentRuntimeProviders();
  const components = useAppComponents();
  const usage = useProviderKeyUsageAccounts();
  const runtimeOf = (connection: ProviderKeyConnection) =>
    providers.data?.find(
      ({ instanceId }) => instanceId === providerKeyRuntimeInstanceId(connection),
    );
  // Each connection waits on the Component that supplies the Agent it runs on.
  const component = (connection: ProviderKeyConnection) => {
    const source = runtimeOf(connection)?.installationSource;
    return source?.kind === "component"
      ? components.state?.components.find(({ id }) => id === source.id)
      : undefined;
  };
  const anchored = providerKeyConnectionOfAnchor(anchor);
  const [expanded, setExpanded] = useState<string | null>(anchored);
  const [adding, setAdding] = useState(false);
  const [openedAnchor, setOpenedAnchor] = useState(anchored);
  // A deep link opens its connection once, when it changes.
  if (anchored !== openedAnchor) {
    setOpenedAnchor(anchored);
    if (anchored) setExpanded(anchored);
  }
  const empty = keys.settings !== null && connections.length === 0;
  return (
    <NodexSettingsSection
      id="keys"
      title={intl.formatMessage({
        id: "providerKeys.providerKeysSettingsSection.title",
        defaultMessage: "API keys",
      })}
      icon={<ApiKeyIcon />}
      description={intl.formatMessage({
        id: "providerKeys.providerKeysSettingsSection.description",
        defaultMessage: "DeepSeek, Kimi, GLM, MiniMax or your own endpoint, with your own key.",
      })}
      summary={
        keys.loadError && !keys.settings
          ? intl.formatMessage({
              id: "providerKeys.providerKeysSettingsSection.couldNotLoad",
              defaultMessage: "Couldn’t load",
            })
          : providerKeysSummary(keys.settings?.connections ?? null, intl)
      }
      disclosure={disclosure}
    >
      {connections.map((connection) => (
        <ConnectionRow
          key={connection.id}
          connection={connection}
          componentStatus={
            providerComponentSetup(runtimeOf(connection), component(connection), intl)?.title
          }
          balance={providerKeyBalanceLabel(
            usage?.accounts.find((account) => account.connection.id === connection.id)?.usage,
            intl,
          )}
          keys={keys}
          expanded={expanded === connection.id}
          onToggle={() =>
            setExpanded((current) => (current === connection.id ? null : connection.id))
          }
          onRemoved={() => {
            flushSync(() => setExpanded(null));
            document.getElementById(ADD_KEY_ID)?.focus();
          }}
        />
      ))}
      {empty || adding ? (
        <div className="px-4 py-3">
          <ProviderKeyForm
            // A setup-sized form, not stretched across a wide Settings page.
            className="max-w-[560px]"
            keys={keys}
            autoFocus={adding}
            onCancel={adding ? () => setAdding(false) : undefined}
            onConnected={(connectionId) => {
              setAdding(false);
              setExpanded(connectionId);
            }}
          />
        </div>
      ) : keys.settings ? (
        <NodexSettingsAddRow
          id={ADD_KEY_ID}
          label={intl.formatMessage({
            id: "providerKeys.providerKeysSettingsSection.addApiKey",
            defaultMessage: "Add API key",
          })}
          disabled={connections.length >= PROVIDER_KEY_LIMIT}
          onClick={() => setAdding(true)}
        />
      ) : null}
    </NodexSettingsSection>
  );
}
