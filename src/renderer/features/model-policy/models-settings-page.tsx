import { useState, type ReactNode } from "react";
import {
  AgentProviderIcon,
  ClaudeIcon,
  NodexLogoMarkIcon,
  OpenAIIcon,
  SettingsSearchIcon,
} from "@/components/shared/icons";
import { NodexSwitch } from "@/components/ui/button";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import {
  NodexSettingsPageSurface,
  NodexSettingsRow,
  NodexSettingsSection,
  useNodexSettingsDisclosures,
  type NodexSettingsDisclosureState,
} from "@/components/ui/settings";
import type { SettingsSectionPageProps } from "@/components/workbench/workbench-settings-page-registry";
import { buildSettingsPath } from "@/components/workbench/workbench-settings-routes";
import { NodexRateMark } from "@/features/nodex-account/nodex-model-prices";
import { resolveNodexAccountView } from "@/features/nodex-account/nodex-account-identity";
import { useNodexAccount } from "@/features/nodex-account/use-nodex-account";
import { creditWorkStoppedBy, type StoppedCreditWork } from "@/lib/model-policy-stopped-work";
import { cn } from "@/lib/utils";
import { agentBackendKindOfRuntimeDriver } from "../../../shared/agent-backend";
import {
  isModelOn,
  isFreeModel,
  isModelSwitchOn,
  isProviderOn,
  policyProviderKey,
  setModelOn,
  setProviderOn,
  spendsNodexCredit,
  type ModelPolicy,
  type PolicyProvider,
} from "../../../shared/model-policy";
import { nodexCreditBalance } from "../../../shared/nodex-account";
import { formatNodexCredits } from "../../../shared/nodex-models";
import { useModelPolicy, useModelPolicyCatalog } from "./model-policy";

type CatalogData = NonNullable<ReturnType<typeof useModelPolicyCatalog>["data"]>;
type CatalogProvider = CatalogData["providers"][number];

/** Nodex is one choice however many runtimes serve it, and stays listed while none are running. */
const NODEX_POLICY_PROVIDER: PolicyProvider = {
  instanceId: "nodex",
  driver: "codex",
  source: "nodex",
};

const FREE_MODEL_DRIVERS: readonly string[] = ["opencode", "opencode2"];

function ListAction({
  children,
  onClick,
}: {
  readonly children: ReactNode;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-6 cursor-interaction rounded-md px-1.5 text-xs text-token-text-secondary hover:bg-token-foreground/5 hover:text-token-text-primary"
    >
      {children}
    </button>
  );
}

/** A long list stays one calm column: its count on the left, whole-list moves on the right. */
function ListHeader({ count, children }: { readonly count: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 px-4">
      <span className="text-xs text-token-description-foreground tabular-nums">{count}</span>
      <span className="-me-1.5 flex items-center">{children}</span>
    </div>
  );
}

function ModelRow({
  label,
  on,
  leading,
  multiplier,
  onChange,
}: {
  readonly label: string;
  readonly on: boolean;
  readonly leading?: ReactNode;
  readonly multiplier?: number | null;
  readonly onChange: (on: boolean) => void;
}) {
  return (
    <label className="flex min-h-8 cursor-interaction items-center gap-2 px-4 hover:bg-token-list-hover-background">
      {leading}
      <span
        className={cn(
          "min-w-0 truncate text-sm",
          on ? "text-token-text-primary" : "text-token-description-foreground",
        )}
      >
        {label}
      </span>
      {multiplier != null && multiplier !== 1 ? <NodexRateMark multiplier={multiplier} /> : null}
      <span className="ms-auto flex shrink-0">
        <NodexSwitch size="compact" ariaLabel={label} checked={on} onCheckedChange={onChange} />
      </span>
    </label>
  );
}

/** An off provider is one quiet line; its list comes back as it was when turned on again. */
function OffProviderCard({
  id,
  title,
  icon,
  description,
  onTurnOn,
}: {
  readonly id: string;
  readonly title: string;
  readonly icon: ReactNode;
  readonly description?: string;
  readonly onTurnOn: () => void;
}) {
  return (
    <NodexSettingsSection id={id}>
      <div className="flex min-h-14 items-center gap-3 px-4 py-3">
        <span
          aria-hidden="true"
          className="flex size-5 shrink-0 items-center justify-center text-token-text-secondary opacity-60 [&>svg]:size-[18px]"
        >
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="m-0 text-sm font-medium text-token-text-secondary">{title}</h2>
          {description ? (
            <span className="text-xs leading-4 text-balance text-token-text-secondary">
              {description}
            </span>
          ) : null}
        </span>
        <NodexSwitch ariaLabel={`Turn on ${title}`} checked={false} onCheckedChange={onTurnOn} />
      </div>
    </NodexSettingsSection>
  );
}

const matches = (label: string, slug: string, query: string) => {
  const needle = query.trim().toLocaleLowerCase();
  return needle === "" || `${label} ${slug}`.toLocaleLowerCase().includes(needle);
};

function NodexCard({
  providers,
  loading,
  policy,
  balance,
  rateOf,
  query,
  disclosure,
  onPolicyChange,
  onOpenAccount,
}: {
  readonly providers: readonly CatalogProvider[];
  readonly loading: boolean;
  readonly policy: ModelPolicy;
  readonly balance: number | null;
  readonly rateOf: (modelId: string) => number | null;
  readonly query: string;
  readonly disclosure: NodexSettingsDisclosureState;
  readonly onPolicyChange: (next: ModelPolicy) => void;
  readonly onOpenAccount: () => void;
}) {
  if (!isProviderOn(policy, NODEX_POLICY_PROVIDER)) {
    return (
      <OffProviderCard
        id="nodex"
        title="Nodex"
        icon={<NodexLogoMarkIcon monochrome />}
        description="Off. Nothing on this computer can spend your credits."
        onTurnOn={() => onPolicyChange(setProviderOn(policy, NODEX_POLICY_PROVIDER, true))}
      />
    );
  }
  const models = providers.flatMap((provider) =>
    provider.models.map((model) => ({ provider, model })),
  );
  const count = models.filter(({ provider, model }) =>
    isModelSwitchOn(policy, provider, model.slug),
  ).length;
  return (
    <NodexSettingsSection
      id="nodex"
      title="Nodex"
      icon={<NodexLogoMarkIcon monochrome />}
      description={
        balance === null
          ? "Spends your credits."
          : `Spends your credits. ${formatNodexCredits(balance)} left.`
      }
      summary={policy.agentsMayChooseCredit ? "Agents can choose" : "Only you choose"}
      action={
        <NodexSwitch
          ariaLabel="Turn off all Nodex models"
          checked
          onCheckedChange={() =>
            onPolicyChange(setProviderOn(policy, NODEX_POLICY_PROVIDER, false))
          }
        />
      }
      disclosure={disclosure}
    >
      <NodexSettingsRow
        size="compact"
        label="Let Agents choose Nodex models"
        description={
          policy.agentsMayChooseCredit
            ? "Any Agent can start a subagent on the models below and spend credits."
            : "Credits are spent only on what you start. An Agent on another provider can't reach Nodex."
        }
      >
        <NodexSwitch
          ariaLabel="Let Agents choose Nodex models"
          checked={policy.agentsMayChooseCredit}
          onCheckedChange={(agentsMayChooseCredit) =>
            onPolicyChange({ ...policy, agentsMayChooseCredit })
          }
        />
      </NodexSettingsRow>
      <div className="flex flex-col pb-1.5">
        <ListHeader count={loading ? "Loading models…" : `${count} of ${models.length} on`}>
          <ListAction onClick={onOpenAccount}>Prices and top up</ListAction>
        </ListHeader>
        {models
          .filter(({ model }) => matches(model.name, model.slug, query))
          .map(({ provider, model }) => (
            <ModelRow
              key={`${provider.instanceId}:${model.slug}`}
              label={model.name}
              leading={
                provider.driver === "claudeAgent" ? (
                  <ClaudeIcon className="size-3.5" />
                ) : (
                  <OpenAIIcon className="size-3.5" />
                )
              }
              multiplier={rateOf(model.slug)}
              on={isModelSwitchOn(policy, provider, model.slug)}
              onChange={(next) => onPolicyChange(setModelOn(policy, provider, model.slug, next))}
            />
          ))}
      </div>
    </NodexSettingsSection>
  );
}

function ProviderCard({
  provider,
  policy,
  query,
  disclosure,
  onPolicyChange,
}: {
  readonly provider: CatalogProvider;
  readonly policy: ModelPolicy;
  readonly query: string;
  readonly disclosure: NodexSettingsDisclosureState;
  readonly onPolicyChange: (next: ModelPolicy) => void;
}) {
  const title = provider.displayName ?? provider.instanceId;
  const kind = agentBackendKindOfRuntimeDriver(provider.driver) ?? "acp";
  const icon = <AgentProviderIcon kind={kind} />;
  const id = policyProviderKey(provider);
  if (!isProviderOn(policy, provider)) {
    return (
      <OffProviderCard
        id={id}
        title={title}
        icon={icon}
        onTurnOn={() => onPolicyChange(setProviderOn(policy, provider, true))}
      />
    );
  }
  const setAll = (pick: (slug: string) => boolean) =>
    onPolicyChange(
      provider.models.reduce(
        (next, model) => setModelOn(next, provider, model.slug, pick(model.slug)),
        policy,
      ),
    );
  const rows = provider.models.filter((model) => matches(model.name, model.slug, query));
  const count = provider.models.filter((model) =>
    isModelSwitchOn(policy, provider, model.slug),
  ).length;
  const searching = query.trim() !== "";
  return (
    <NodexSettingsSection
      id={id}
      title={title}
      icon={icon}
      summary={`${count} of ${provider.models.length} on`}
      action={
        <NodexSwitch
          ariaLabel={`Turn off all ${title} models`}
          checked
          onCheckedChange={() => onPolicyChange(setProviderOn(policy, provider, false))}
        />
      }
      disclosure={searching ? { ...disclosure, open: true } : disclosure}
    >
      <div className="flex flex-col pb-1.5">
        <ListHeader count={`${count} of ${provider.models.length} on`}>
          {FREE_MODEL_DRIVERS.includes(provider.driver) ? (
            <ListAction onClick={() => setAll(isFreeModel)}>Free only</ListAction>
          ) : null}
          <ListAction onClick={() => setAll(() => true)}>All on</ListAction>
          <ListAction onClick={() => setAll(() => false)}>All off</ListAction>
        </ListHeader>
        {rows.map((model) => (
          <ModelRow
            key={model.slug}
            label={model.name}
            on={isModelSwitchOn(policy, provider, model.slug)}
            onChange={(next) => onPolicyChange(setModelOn(policy, provider, model.slug, next))}
          />
        ))}
      </div>
    </NodexSettingsSection>
  );
}

/** Credits keep spending while a turn runs, so off means stopped, and stopping is confirmed. */
function StopRunningDialog({
  subject,
  stopped,
  onCancel,
  onConfirm,
}: {
  readonly subject: string;
  readonly stopped: StoppedCreditWork;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { chats, models, stopsAllowedModels } = stopped;
  return (
    <NodexDialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <NodexDialogContent size="compact" showCloseButton={false}>
        <NodexDialogFrame>
          <NodexDialogHeader>
            <NodexDialogTitle>
              Stop {chats === 1 ? "1 chat" : `${chats} chats`} and turn off {subject}?
            </NodexDialogTitle>
            <NodexDialogDescription>
              {chats === 1 ? "It's" : "They're"} running on {models.join(", ")}.
              {stopsAllowedModels
                ? " Claude chats on Nodex restart together when one of their models turns off."
                : " Left running, it would keep spending credits."}{" "}
              The conversation stays, and you can continue it on another model.
            </NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogFooter>
            <NodexDialogAction onClick={onCancel}>Keep on</NodexDialogAction>
            <NodexDialogAction tone="danger" onClick={onConfirm}>
              Stop and turn off
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}

export function ModelsSettingsPage({
  open,
  settingsAnchor,
  onPathChange,
}: SettingsSectionPageProps) {
  if (!open) return null;
  return (
    <ModelsSettingsContent
      anchor={settingsAnchor ?? null}
      onOpenAccount={() => onPathChange(buildSettingsPath("account"))}
    />
  );
}

function ModelsSettingsContent({
  anchor,
  onOpenAccount,
}: {
  readonly anchor: string | null;
  readonly onOpenAccount: () => void;
}) {
  const { settings: policy, isLoading, error: loadError, updateSettings } = useModelPolicy();
  const catalog = useModelPolicyCatalog();
  const account = useNodexAccount(true);
  const signedIn = resolveNodexAccountView(account).signedIn;
  const [query, setQuery] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingCut, setPendingCut] = useState<{
    readonly next: ModelPolicy;
    readonly subject: string;
    readonly stopped: StoppedCreditWork;
  } | null>(null);
  const disclosure = useNodexSettingsDisclosures(anchor ?? "nodex");

  const providers = (catalog.data?.providers ?? []).filter(
    (provider) => provider.models.length > 0,
  );
  const nodexProviders = providers.filter(spendsNodexCredit);
  const otherProviders = providers.filter((provider) => !spendsNodexCredit(provider));
  const pricingGroup = account.snapshot?.modelStatus?.pricing?.groups[0];
  const rateOf = (modelId: string) =>
    pricingGroup?.models.find((model) => model.id === modelId)?.multiplier ?? null;

  const apply = (next: ModelPolicy) => {
    setSaveError(null);
    void updateSettings(next).catch(() => setSaveError("Could not save your model choices."));
  };
  /** Turning off what a running chat is spending on has to stop that chat, so it asks first. */
  const changeCredit = (next: ModelPolicy) => {
    const stopped = creditWorkStoppedBy({
      work: catalog.data?.runningOnCredit ?? [],
      providers: nodexProviders,
      current: policy,
      next,
    });
    if (!stopped) return apply(next);
    const turnedOff = nodexProviders.flatMap(({ models, ...provider }) =>
      models.filter(
        ({ slug }) => isModelOn(policy, provider, slug) && !isModelOn(next, provider, slug),
      ),
    );
    setPendingCut({
      next,
      stopped,
      subject: isProviderOn(next, NODEX_POLICY_PROVIDER) ? (turnedOff[0]?.name ?? "it") : "Nodex",
    });
  };

  const error =
    saveError ?? (loadError || catalog.error ? "Could not load your model choices." : null);
  const searching = query.trim() !== "";
  const nodexMatches = nodexProviders.some((provider) =>
    provider.models.some((model) => matches(model.name, model.slug, query)),
  );
  return (
    <NodexSettingsPageSurface
      title="Models"
      subtitle="Off models leave every picker, and nothing in Nodex can start them."
      action={
        <div className="flex h-7 w-44 items-center rounded-lg border border-token-border bg-token-bg-fog">
          <SettingsSearchIcon className="icon-xs ms-2 shrink-0 text-token-input-placeholder-foreground" />
          <input
            type="text"
            role="searchbox"
            aria-label="Filter models"
            placeholder="Filter models"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            className="ms-1 w-full min-w-0 appearance-none border-none bg-transparent pe-1.5 text-sm text-token-foreground ring-0 outline-none placeholder:text-token-input-placeholder-foreground"
          />
        </div>
      }
    >
      <div className="flex flex-col gap-1.5" aria-busy={isLoading || catalog.isPending}>
        <div className="flex flex-col gap-3">
          {signedIn && (!searching || nodexMatches) ? (
            <NodexCard
              providers={nodexProviders}
              loading={catalog.isPending}
              policy={policy}
              balance={nodexCreditBalance(account.snapshot)}
              rateOf={rateOf}
              query={query}
              disclosure={searching ? { ...disclosure("nodex"), open: true } : disclosure("nodex")}
              onPolicyChange={changeCredit}
              onOpenAccount={onOpenAccount}
            />
          ) : null}
          {otherProviders
            .filter(
              (provider) =>
                !searching ||
                provider.models.some((model) => matches(model.name, model.slug, query)),
            )
            .map((provider) => (
              <ProviderCard
                key={provider.instanceId}
                provider={provider}
                policy={policy}
                query={query}
                disclosure={disclosure(policyProviderKey(provider))}
                onPolicyChange={apply}
              />
            ))}
        </div>
        {error ? (
          <p role="alert" className="m-0 px-1 pt-1 text-xs text-danger">
            {error}
          </p>
        ) : null}
        <p className="m-0 px-1 pt-1 text-xs leading-4 text-token-description-foreground">
          A chat's built-in subagents use the same account as the chat, so only a chat you started
          on Nodex can spend credits this way. Codex can still choose an off model for them.
        </p>
      </div>
      {pendingCut ? (
        <StopRunningDialog
          subject={pendingCut.subject}
          stopped={pendingCut.stopped}
          onCancel={() => setPendingCut(null)}
          onConfirm={() => {
            apply(pendingCut.next);
            setPendingCut(null);
          }}
        />
      ) : null}
    </NodexSettingsPageSurface>
  );
}
