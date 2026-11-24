import { useRef, useState } from "react";
import { FormattedMessage, useIntl } from "@/lib/i18n";
import { ActivitySpinnerIcon, AgentProviderIcon, ProviderKeyIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { agentDefinition } from "../../../shared/agents/registry";
import {
  PROVIDER_KEY_AGENTS,
  PROVIDER_KEY_API_EXAMPLE_URLS,
  PROVIDER_KEY_API_NAMES,
  providerKeyApi,
  PROVIDER_KEY_PRESETS,
  PROVIDER_KEY_REGION_MESSAGES,
  providerKeyPreset,
  type ProviderKeyFailureReason,
  type ProviderKeyPresetId,
} from "../../../shared/provider-keys";
import {
  initialProviderKeyDraft,
  providerKeyConnectInput,
  providerKeyDraftProblem,
  providerKeyEndpoint,
  providerKeyFailureField,
  type ProviderKeyDraft,
} from "./provider-key-form-model";
import type { ProviderKeysController } from "./use-provider-keys";

type Field = "baseUrl" | "apiKey" | "models";

/**
 * One choice among a few, as a segmented control: a recessed track with the chosen segment raised
 * on it, so the choice reads at a glance without another bordered box.
 */
function Segmented<Value extends string>({
  label,
  value,
  options,
  small = false,
  fill = false,
  onChange,
}: {
  readonly label: string;
  readonly value: Value;
  readonly options: readonly {
    readonly value: Value;
    readonly label: string;
    readonly icon?: React.ReactNode;
  }[];
  readonly small?: boolean;
  /** Segments share the full width equally; otherwise the track fits its segments. */
  readonly fill?: boolean;
  readonly onChange: (value: Value) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "flex max-w-full items-center gap-px rounded-[9px] bg-token-foreground/[0.05] p-0.5",
        fill ? "w-full" : "w-fit",
      )}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex min-w-0 cursor-interaction items-center justify-center gap-1.5 rounded-[7px] text-xs whitespace-nowrap outline-none transition-[background-color,color,box-shadow] duration-100",
              fill && "flex-1",
              small ? "h-6 px-2" : "h-7 px-2.5",
              "focus-visible:ring-2 focus-visible:ring-token-focus-border",
              checked
                ? cn(
                    "bg-token-dropdown-background font-medium text-token-text-primary shadow-[0_1px_2px_rgba(0,0,0,0.08)] ring-[0.5px] ring-token-border",
                    // On a dark track the raised segment is lighter, not darker.
                    "dark:bg-token-foreground/[0.12] electron-dark:bg-token-foreground/[0.12]",
                  )
                : "text-token-text-secondary hover:text-token-text-primary",
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Connects a model provider with an API key: choose the provider, paste the key, and Nodex checks
 * it and lists the provider's models. Used by setup and Settings alike.
 */
export function ProviderKeyForm({
  keys,
  onConnected,
  onCancel,
  autoFocus = true,
  className,
}: {
  readonly keys: Pick<ProviderKeysController, "connect">;
  readonly onConnected: (connectionId: string) => void;
  readonly onCancel?: () => void;
  readonly autoFocus?: boolean;
  readonly className?: string;
}) {
  const intl = useIntl();
  const [draft, setDraft] = useState<ProviderKeyDraft>(() => initialProviderKeyDraft());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{
    readonly field: Field | null;
    readonly message: string;
    readonly reason: ProviderKeyFailureReason | null;
  } | null>(null);
  const [askModels, setAskModels] = useState(false);
  const baseUrlRef = useRef<HTMLInputElement>(null);
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const modelsRef = useRef<HTMLTextAreaElement>(null);
  // The field may only appear with this change, so focus waits for it to render.
  const focusField = (field: Field) =>
    requestAnimationFrame(() =>
      (field === "baseUrl"
        ? baseUrlRef
        : field === "apiKey"
          ? apiKeyRef
          : modelsRef
      ).current?.focus(),
    );
  const language = intl.locale;
  const preset = providerKeyPreset(draft.preset);
  const endpoint = providerKeyEndpoint(draft, language);

  const change = (patch: Partial<ProviderKeyDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setFailure(null);
  };
  const choosePreset = (id: ProviderKeyPresetId) => {
    change({ preset: id });
    setAskModels(false);
    // The next field to fill takes focus: the endpoint for a custom one, otherwise the key.
    focusField(id === "custom" ? "baseUrl" : "apiKey");
  };
  const fail = (field: Field | null, message: string, reason: ProviderKeyFailureReason | null) => {
    setFailure({ field, message, reason });
    if (field) focusField(field);
  };

  const submit = async () => {
    if (busy) return;
    const problem = providerKeyDraftProblem(draft);
    if (problem) return fail(problem.field, intl.formatMessage(problem.message), null);
    setBusy(true);
    await Promise.resolve()
      .then(() => keys.connect(providerKeyConnectInput(draft, language)))
      .then((result) => {
        if (result.ok) {
          setDraft(initialProviderKeyDraft(draft.preset));
          setAskModels(false);
          setFailure(null);
          onConnected(result.connectionId);
          return;
        }
        if (result.reason === "no-models") setAskModels(true);
        fail(providerKeyFailureField(result.reason, draft.preset), result.message, result.reason);
      })
      .catch((cause: unknown) => {
        fail(null, cause instanceof Error ? cause.message : String(cause), null);
      })
      .finally(() => setBusy(false));
  };

  const invalid = (field: Field) => (failure?.field === field ? true : undefined);
  const runsOn = intl.formatMessage({
    id: "providerKeys.providerKeyForm.runsOn",
    defaultMessage: "Runs on",
  });
  const apiKeyLabel = intl.formatMessage({
    id: "providerKeys.providerKeyForm.apiKey",
    defaultMessage: "API key",
  });
  return (
    <form
      className={cn("flex flex-col gap-2.5", className)}
      aria-label={intl.formatMessage({
        id: "providerKeys.providerKeyForm.connectWithAnApiKey",
        defaultMessage: "Connect with an API key",
      })}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Segmented
        label={intl.formatMessage({
          id: "providerKeys.providerKeyForm.provider",
          defaultMessage: "Provider",
        })}
        fill
        value={draft.preset}
        options={PROVIDER_KEY_PRESETS.map((option) => ({
          value: option.id,
          label:
            option.id === "custom"
              ? intl.formatMessage({
                  id: "providerKeys.providerKeyForm.otherProvider",
                  defaultMessage: "Other",
                })
              : option.name,
          icon: <ProviderKeyIcon preset={option.id} className="size-3.5" />,
        }))}
        onChange={choosePreset}
      />
      {draft.preset === "custom" ? (
        <Input
          ref={baseUrlRef}
          aria-label={intl.formatMessage({
            id: "providerKeys.providerKeyForm.baseUrl",
            defaultMessage: "Base URL",
          })}
          aria-invalid={invalid("baseUrl")}
          className="h-8 text-sm"
          placeholder={PROVIDER_KEY_API_EXAMPLE_URLS[providerKeyApi(draft.agent)]}
          spellCheck={false}
          value={draft.baseUrl}
          onChange={(event) => change({ baseUrl: event.target.value })}
        />
      ) : null}
      <div className="flex items-center gap-2">
        <Input
          ref={apiKeyRef}
          aria-label={
            preset.id === "custom"
              ? apiKeyLabel
              : intl.formatMessage(
                  {
                    id: "providerKeys.providerKeyForm.providerApiKey",
                    defaultMessage: "{provider} API key",
                  },
                  { provider: preset.name },
                )
          }
          aria-invalid={invalid("apiKey")}
          autoFocus={autoFocus && draft.preset !== "custom"}
          autoComplete="off"
          className="h-8 flex-1 text-sm"
          placeholder={preset.keyPlaceholder ?? apiKeyLabel}
          spellCheck={false}
          type="password"
          value={draft.apiKey}
          onChange={(event) => change({ apiKey: event.target.value })}
        />
        <NodexButton size="sm" variant="secondary" type="submit" disabled={busy}>
          {busy ? <ActivitySpinnerIcon className="icon-xs" /> : null}
          {busy
            ? intl.formatMessage({
                id: "providerKeys.providerKeyForm.checking",
                defaultMessage: "Checking",
              })
            : intl.formatMessage({
                id: "providerKeys.providerKeyForm.connect",
                defaultMessage: "Connect",
              })}
        </NodexButton>
        {onCancel ? (
          <NodexButton size="sm" variant="ghostSecondary" disabled={busy} onClick={onCancel}>
            <FormattedMessage id="providerKeys.providerKeyForm.cancel" defaultMessage="Cancel" />
          </NodexButton>
        ) : null}
      </div>
      {askModels ? (
        <Textarea
          ref={modelsRef}
          aria-label={intl.formatMessage({
            id: "providerKeys.providerKeyForm.modelIds",
            defaultMessage: "Model IDs",
          })}
          aria-invalid={invalid("models")}
          className="min-h-16 font-mono text-sm"
          placeholder={intl.formatMessage({
            id: "providerKeys.providerKeyForm.oneModelIdPerLine",
            defaultMessage: "One model ID per line",
          })}
          spellCheck={false}
          value={draft.modelsText}
          onChange={(event) => change({ modelsText: event.target.value })}
        />
      ) : null}
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex items-center gap-2 text-xs text-token-description-foreground">
          <span aria-hidden="true">{runsOn}</span>
          <Segmented
            label={runsOn}
            small
            value={draft.agent}
            options={PROVIDER_KEY_AGENTS.map((agent) => ({
              value: agent,
              label: agentDefinition(agent).label,
              icon: <AgentProviderIcon kind={agent} className="size-3 shrink-0" />,
            }))}
            onChange={(agent) => change({ agent })}
          />
        </div>
        {preset.endpoints.length > 1 && endpoint ? (
          <Segmented
            label={intl.formatMessage({
              id: "providerKeys.providerKeyForm.region",
              defaultMessage: "Region",
            })}
            small
            value={endpoint.id}
            options={preset.endpoints.map((option) => ({
              value: option.id,
              label: intl.formatMessage(PROVIDER_KEY_REGION_MESSAGES[option.id]),
            }))}
            onChange={(id) => change({ endpoints: { ...draft.endpoints, [draft.preset]: id } })}
          />
        ) : null}
      </div>
      <div className="flex min-h-5 items-center text-xs">
        {failure ? (
          <p role="alert" className="m-0 min-w-0 flex-1 text-danger">
            {failure.message}
          </p>
        ) : (
          <p className="m-0 min-w-0 flex-1 text-token-description-foreground">
            {endpoint ? (
              <a
                href={endpoint.keyUrl}
                target="_blank"
                rel="noreferrer"
                className="text-token-text-link-foreground hover:underline"
              >
                <FormattedMessage
                  id="providerKeys.providerKeyForm.getAKey"
                  defaultMessage="Get a {provider} key"
                  values={{ provider: preset.name }}
                />
              </a>
            ) : (
              <FormattedMessage
                id="providerKeys.providerKeyForm.anyApiEndpoint"
                defaultMessage="Any {api} endpoint"
                values={{ api: PROVIDER_KEY_API_NAMES[providerKeyApi(draft.agent)] }}
              />
            )}
            {" · "}
            <FormattedMessage
              id="providerKeys.providerKeyForm.encryptedWithYourKeychain"
              defaultMessage="Encrypted with your keychain"
            />
          </p>
        )}
      </div>
    </form>
  );
}
