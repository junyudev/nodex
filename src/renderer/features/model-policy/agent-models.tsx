import { FormattedMessage, useIntl } from "@/lib/i18n";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { AgentProviderIcon, NodexLogoMarkIcon } from "@/components/shared/icons";
import { agentDefinition } from "../../../shared/agents/registry";
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
  NodexSettingsRevealRow,
  NodexSettingsRow,
  NodexSettingsSection,
  type NodexSettingsDisclosureState,
} from "@/components/ui/settings";
import { NodexRateMark } from "@/features/nodex-account/nodex-model-prices";
import { resolveNodexAccountView } from "@/features/nodex-account/nodex-account-identity";
import { useNodexAccount } from "@/features/nodex-account/use-nodex-account";
import { creditWorkStoppedBy, type StoppedCreditWork } from "@/lib/model-policy-stopped-work";
import { cn } from "@/lib/utils";
import {
  isModelOn,
  isFreeModel,
  isModelSwitchOn,
  setModelOn,
  setNodexOn,
  spendsNodexCredit,
  type ModelPolicy,
} from "../../../shared/model-policy";
import { nodexCreditBalance } from "../../../shared/nodex-account";
import { formatNodexCredits } from "../../../shared/nodex-models";
import { useModelPolicy, useModelPolicyCatalog } from "./model-policy";

/**
 * Which models are on, where each Agent is set up: Settings › Agents shows Nodex's models first
 * and each Agent's models inside its own card. Off models leave every picker, and nothing in Nodex
 * can start them.
 */

type CatalogData = NonNullable<ReturnType<typeof useModelPolicyCatalog>["data"]>;
type CatalogProvider = CatalogData["providers"][number];

/** Agents whose models start off, such as OpenCode's, offer to turn on only the free ones. */
const offersFreeOnly = (driver: string): boolean =>
  agentDefinition(driver).capabilities.modelsOptIn === true;

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
      className="h-6 cursor-interaction px-2 text-xs text-token-text-secondary outline-hidden first:rounded-s-md last:rounded-e-md hover:bg-token-foreground/5 hover:text-token-text-primary focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:ring-inset"
    >
      {children}
    </button>
  );
}

/** A list's whole-list moves, gathered into one hairline group so they read as one control. */
function ListActions({ children }: { readonly children: ReactNode }) {
  return (
    <span className="flex items-center divide-x divide-token-border rounded-md ring-[0.5px] ring-token-border ring-inset">
      {children}
    </span>
  );
}

/**
 * A long list stays one calm column of facts: its count on the left, and its whole-list moves
 * on the right.
 */
function ListHeader({ count, children }: { readonly count: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-3 px-4">
      <span className="text-xs text-token-text-secondary tabular-nums">{count}</span>
      {children}
    </div>
  );
}

/**
 * Rows flow down into two columns once the card is wide enough, so a long catalog stays one
 * screen tall and still reads in its own order, top to bottom.
 */
function ModelGrid({ children }: { readonly children: ReactNode }) {
  return (
    <div className="@container">
      <div className="gap-x-2 px-2 @xl:columns-2">{children}</div>
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
    <label className="flex min-h-8 min-w-0 cursor-interaction break-inside-avoid items-center gap-2 rounded-md px-2 hover:bg-token-list-hover-background">
      {leading}
      <span
        className={cn(
          "min-w-0 truncate text-sm transition-colors duration-150",
          on ? "text-token-text-primary" : "text-token-text-secondary",
        )}
      >
        {label}
      </span>
      {multiplier != null && multiplier !== 1 ? <NodexRateMark multiplier={multiplier} /> : null}
      <span className="ms-auto flex shrink-0 ps-2">
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
  const intl = useIntl();
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
        <NodexSwitch
          ariaLabel={intl.formatMessage(
            {
              id: "modelPolicy.modelsSettingsPage.turnOnValue",
              defaultMessage: "Turn on {value1}",
            },
            { value1: title },
          )}
          checked={false}
          onCheckedChange={onTurnOn}
        />
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
  const intl = useIntl();
  if (policy.nodexOff) {
    return (
      <OffProviderCard
        id="nodex"
        title="Nodex"
        icon={<NodexLogoMarkIcon monochrome />}
        description={intl.formatMessage({
          id: "modelPolicy.modelsSettingsPage.offNothingOnThisComputer",
          defaultMessage: "Off. Nothing on this computer can spend your credits.",
        })}
        onTurnOn={() => onPolicyChange(setNodexOn(policy, true))}
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
          ? intl.formatMessage({
              id: "modelPolicy.modelsSettingsPage.spendsYourCredits",
              defaultMessage: "Spends your credits.",
            })
          : intl.formatMessage(
              {
                id: "modelPolicy.modelsSettingsPage.spendsYourCreditsValueLeft",
                defaultMessage: "Spends your credits. {value1} left.",
              },
              { value1: formatNodexCredits(balance, intl.locale) },
            )
      }
      summary={
        policy.agentsMayChooseCredit
          ? intl.formatMessage({
              id: "modelPolicy.modelsSettingsPage.agentsCanChoose",
              defaultMessage: "Agents can choose",
            })
          : intl.formatMessage({
              id: "modelPolicy.modelsSettingsPage.onlyYouChoose",
              defaultMessage: "Only you choose",
            })
      }
      action={
        <NodexSwitch
          ariaLabel={intl.formatMessage({
            id: "modelPolicy.modelsSettingsPage.turnOffAllNodexModels",
            defaultMessage: "Turn off all Nodex models",
          })}
          checked
          onCheckedChange={() => onPolicyChange(setNodexOn(policy, false))}
        />
      }
      disclosure={disclosure}
    >
      <NodexSettingsRow
        size="compact"
        label={intl.formatMessage({
          id: "modelPolicy.modelsSettingsPage.letAgentsChooseNodexModels",
          defaultMessage: "Let Agents choose Nodex models",
        })}
        description={
          policy.agentsMayChooseCredit
            ? intl.formatMessage({
                id: "modelPolicy.modelsSettingsPage.anyAgentCanStartA",
                defaultMessage:
                  "Any Agent can start a subagent on the models below and spend credits.",
              })
            : intl.formatMessage({
                id: "modelPolicy.modelsSettingsPage.creditsAreSpentOnlyOn",
                defaultMessage:
                  "Credits are spent only on what you start. An Agent on another provider can't reach Nodex.",
              })
        }
      >
        <NodexSwitch
          ariaLabel={intl.formatMessage({
            id: "modelPolicy.modelsSettingsPage.letAgentsChooseNodexModels",
            defaultMessage: "Let Agents choose Nodex models",
          })}
          checked={policy.agentsMayChooseCredit}
          onCheckedChange={(agentsMayChooseCredit) =>
            onPolicyChange({ ...policy, agentsMayChooseCredit })
          }
        />
      </NodexSettingsRow>
      <div className="flex flex-col pb-2">
        <ListHeader
          count={
            loading
              ? intl.formatMessage({
                  id: "modelPolicy.modelsSettingsPage.loadingModels",
                  defaultMessage: "Loading models…",
                })
              : intl.formatMessage(
                  {
                    id: "modelPolicy.modelsSettingsPage.valueOfValueOn",
                    defaultMessage: "{value1} of {value2} on",
                  },
                  { value1: count, value2: models.length },
                )
          }
        >
          <ListActions>
            <ListAction onClick={onOpenAccount}>
              <FormattedMessage
                id="modelPolicy.modelsSettingsPage.pricesAndTopUp"
                defaultMessage="Prices and top up"
              />
            </ListAction>
          </ListActions>
        </ListHeader>
        <ModelGrid>
          {models
            .filter(({ model }) => matches(model.name, model.slug, query))
            .map(({ provider, model }) => (
              <ModelRow
                key={`${provider.instanceId}:${model.slug}`}
                label={model.name}
                leading={<AgentProviderIcon kind={provider.driver} className="size-3.5" />}
                multiplier={rateOf(model.slug)}
                on={isModelSwitchOn(policy, provider, model.slug)}
                onChange={(next) => onPolicyChange(setModelOn(policy, provider, model.slug, next))}
              />
            ))}
        </ModelGrid>
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
  const intl = useIntl();
  const { chats, models, stopsAllowedModels } = stopped;
  return (
    <NodexDialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <NodexDialogContent size="compact" showCloseButton={false}>
        <NodexDialogFrame>
          <NodexDialogHeader>
            <NodexDialogTitle>
              {intl.formatMessage(
                {
                  id: "modelPolicy.modelsSettingsPage.stopChatsTitle",
                  defaultMessage:
                    "Stop {chats, plural, one {# chat} other {# chats}} and turn off {subject}?",
                },
                { chats, subject },
              )}
            </NodexDialogTitle>
            <NodexDialogDescription>
              {intl.formatMessage(
                {
                  id: "modelPolicy.modelsSettingsPage.runningOn",
                  defaultMessage:
                    "{chats, plural, one {It's} other {They're}} running on {models}.",
                },
                { chats, models: intl.formatList(models, { type: "unit" }) },
              )}
              {stopsAllowedModels
                ? intl.formatMessage({
                    id: "modelPolicy.modelsSettingsPage.claudeChatsOnNodexRestart",
                    defaultMessage:
                      " Claude chats on Nodex restart together when one of their models turns off.",
                  })
                : intl.formatMessage({
                    id: "modelPolicy.modelsSettingsPage.leftRunningItWouldKeep",
                    defaultMessage: " Left running, it would keep spending credits.",
                  })}{" "}
              {intl.formatMessage({
                id: "modelPolicy.modelsSettingsPage.keepHistory",
                defaultMessage: "The conversation stays, and you can continue it on another model.",
              })}
            </NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogFooter>
            <NodexDialogAction onClick={onCancel}>
              <FormattedMessage
                id="modelPolicy.modelsSettingsPage.keepOn"
                defaultMessage="Keep on"
              />
            </NodexDialogAction>
            <NodexDialogAction tone="danger" onClick={onConfirm}>
              <FormattedMessage
                id="modelPolicy.modelsSettingsPage.stopAndTurnOff"
                defaultMessage="Stop and turn off"
              />
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}

interface AgentModels {
  readonly policy: ModelPolicy;
  /** Providers that advertise at least one model. */
  readonly providers: readonly CatalogProvider[];
  readonly nodexProviders: readonly CatalogProvider[];
  readonly signedIn: boolean;
  readonly balance: number | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly rateOf: (modelId: string) => number | null;
  /** Saves a change that spends no credit. */
  readonly apply: (next: ModelPolicy) => void;
  /** Saves a Nodex change, first asking when it would stop a chat spending credits. */
  readonly changeCredit: (next: ModelPolicy) => void;
  readonly onOpenAccount: () => void;
}

const AgentModelsContext = createContext<AgentModels | null>(null);

function useAgentModels(): AgentModels {
  const models = useContext(AgentModelsContext);
  if (!models) throw new Error("Agent models are read inside AgentModelsProvider.");
  return models;
}

/** Loads the policy and every provider's models once for the Agent cards that show them. */
export function AgentModelsProvider({
  onOpenAccount,
  children,
}: {
  readonly onOpenAccount: () => void;
  readonly children: ReactNode;
}) {
  const intl = useIntl();
  const { settings: policy, isLoading, error: loadError, updateSettings } = useModelPolicy();
  const catalog = useModelPolicyCatalog();
  const account = useNodexAccount(true);
  const signedIn = resolveNodexAccountView(account, intl).signedIn;
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingCut, setPendingCut] = useState<{
    readonly next: ModelPolicy;
    readonly subject: string;
    readonly stopped: StoppedCreditWork;
  } | null>(null);

  const value = useMemo<AgentModels>(() => {
    const providers = (catalog.data?.providers ?? []).filter(
      (provider) => provider.models.length > 0,
    );
    const nodexProviders = providers.filter(spendsNodexCredit);
    const pricingGroup = account.snapshot?.modelStatus?.pricing?.groups[0];
    const apply = (next: ModelPolicy) => {
      setSaveError(null);
      void updateSettings(next).catch(() =>
        setSaveError(
          intl.formatMessage({
            id: "modelPolicy.modelsSettingsPage.couldNotSaveYourModel",
            defaultMessage: "Could not save your model choices.",
          }),
        ),
      );
    };
    return {
      policy,
      providers,
      nodexProviders,
      signedIn,
      balance: nodexCreditBalance(account.snapshot),
      loading: isLoading || catalog.isPending,
      error:
        saveError ??
        (loadError || catalog.error
          ? intl.formatMessage({
              id: "modelPolicy.modelsSettingsPage.couldNotLoadYourModel",
              defaultMessage: "Could not load your model choices.",
            })
          : null),
      rateOf: (modelId) =>
        pricingGroup?.models.find((model) => model.id === modelId)?.multiplier ?? null,
      apply,
      /** Turning off what a running chat is spending on has to stop that chat, so it asks first. */
      changeCredit: (next) => {
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
          subject: next.nodexOff ? "Nodex" : (turnedOff[0]?.name ?? "it"),
        });
      },
      onOpenAccount,
    };
  }, [
    account.snapshot,
    catalog.data,
    catalog.error,
    catalog.isPending,
    intl,
    isLoading,
    loadError,
    onOpenAccount,
    policy,
    saveError,
    signedIn,
    updateSettings,
  ]);
  return (
    <AgentModelsContext value={value}>
      {children}
      {value.error ? (
        <p role="alert" className="m-0 px-1 text-xs text-danger">
          {value.error}
        </p>
      ) : null}
      {pendingCut ? (
        <StopRunningDialog
          subject={pendingCut.subject}
          stopped={pendingCut.stopped}
          onCancel={() => setPendingCut(null)}
          onConfirm={() => {
            value.apply(pendingCut.next);
            setPendingCut(null);
          }}
        />
      ) : null}
    </AgentModelsContext>
  );
}

/** Nodex's card, first among the Agents for someone signed in to Nodex. */
export function NodexModelsSection({
  disclosure,
}: {
  readonly disclosure: NodexSettingsDisclosureState;
}) {
  const models = useAgentModels();
  if (!models.signedIn) return null;
  return (
    <NodexCard
      providers={models.nodexProviders}
      loading={models.loading}
      policy={models.policy}
      balance={models.balance}
      rateOf={models.rateOf}
      query=""
      disclosure={disclosure}
      onPolicyChange={models.changeCredit}
      onOpenAccount={models.onOpenAccount}
    />
  );
}

/** An Agent's whole-list moves: All on, All off, and Free only where its models start off. */
function ProviderModelActions({ provider }: { readonly provider: CatalogProvider }) {
  const { policy, apply } = useAgentModels();
  const setAll = (pick: (slug: string) => boolean) =>
    apply(
      provider.models.reduce(
        (next, model) => setModelOn(next, provider, model.slug, pick(model.slug)),
        policy,
      ),
    );
  return (
    <ListActions>
      {offersFreeOnly(provider.driver) ? (
        <ListAction onClick={() => setAll(isFreeModel)}>
          <FormattedMessage
            id="modelPolicy.modelsSettingsPage.freeOnly"
            defaultMessage="Free only"
          />
        </ListAction>
      ) : null}
      <ListAction onClick={() => setAll(() => true)}>
        <FormattedMessage id="modelPolicy.modelsSettingsPage.allOn" defaultMessage="All on" />
      </ListAction>
      <ListAction onClick={() => setAll(() => false)}>
        <FormattedMessage id="modelPolicy.modelsSettingsPage.allOff" defaultMessage="All off" />
      </ListAction>
    </ListActions>
  );
}

/** One provider's models, each with its own switch. */
function ProviderModelGrid({
  provider,
  query = "",
}: {
  readonly provider: CatalogProvider;
  readonly query?: string;
}) {
  const { policy, apply } = useAgentModels();
  return (
    <ModelGrid>
      {provider.models
        .filter((model) => matches(model.name, model.slug, query))
        .map((model) => (
          <ModelRow
            key={model.slug}
            label={model.name}
            on={isModelSwitchOn(policy, provider, model.slug)}
            onChange={(next) => apply(setModelOn(policy, provider, model.slug, next))}
          />
        ))}
    </ModelGrid>
  );
}

function modelsOnSummary(
  policy: ModelPolicy,
  provider: CatalogProvider,
  intl: ReturnType<typeof useIntl>,
): string {
  return intl.formatMessage(
    {
      id: "modelPolicy.modelsSettingsPage.valueOfValueOn",
      defaultMessage: "{value1} of {value2} on",
    },
    {
      value1: provider.models.filter((model) => isModelSwitchOn(policy, provider, model.slug))
        .length,
      value2: provider.models.length,
    },
  );
}

/**
 * A closed list says which models are on, not just how many, while some are on and some off:
 * the count alone makes a person open the list to find out what an Agent can run.
 */
function modelsOnPreview(
  policy: ModelPolicy,
  provider: CatalogProvider,
  intl: ReturnType<typeof useIntl>,
): string {
  const on = provider.models.filter((model) => isModelSwitchOn(policy, provider, model.slug));
  const count = modelsOnSummary(policy, provider, intl);
  if (on.length === 0 || on.length === provider.models.length) return count;
  return `${count} · ${intl.formatList(
    on.map((model) => model.name),
    { type: "unit" },
  )}`;
}

/**
 * An Agent instance's models inside its card: one row saying which are on, opening to the list
 * with its whole-list moves beside the row's Hide. Absent until the Agent advertises models, such
 * as before it signs in.
 */
export function InstanceModels({
  instanceId,
  variant = "default",
}: {
  readonly instanceId: string;
  /** Nested inside an open profile or connection, among its lighter rows. */
  readonly variant?: "default" | "nested";
}) {
  const intl = useIntl();
  // A card shown outside Settings › Agents, such as in setup, has no model list of its own.
  const models = useContext(AgentModelsContext);
  const [expanded, setExpanded] = useState(false);
  const provider = models?.providers.find((entry) => entry.instanceId === instanceId);
  if (!models || !provider) return null;
  const { policy } = models;
  return (
    <NodexSettingsRevealRow
      variant={variant}
      label={intl.formatMessage({
        id: "modelPolicy.agentModels.models",
        defaultMessage: "Models",
      })}
      description={
        expanded ? modelsOnSummary(policy, provider, intl) : modelsOnPreview(policy, provider, intl)
      }
      open={expanded}
      onOpenChange={setExpanded}
      actions={expanded ? <ProviderModelActions provider={provider} /> : null}
    >
      <div className="pb-2">
        <ProviderModelGrid provider={provider} />
      </div>
    </NodexSettingsRevealRow>
  );
}

/** What a model filter finds across Nodex and every Agent, each under the provider that runs it. */
export function ModelFilterResults({ query }: { readonly query: string }) {
  const intl = useIntl();
  const models = useAgentModels();
  const nodexMatches =
    models.signedIn &&
    models.nodexProviders.some((provider) =>
      provider.models.some((model) => matches(model.name, model.slug, query)),
    );
  const others = models.providers.filter(
    (provider) =>
      !spendsNodexCredit(provider) &&
      provider.models.some((model) => matches(model.name, model.slug, query)),
  );
  if (!nodexMatches && others.length === 0)
    return (
      <p className="m-0 px-1 text-sm text-token-text-secondary">
        {intl.formatMessage({
          id: "modelPolicy.agentModels.noModelsMatch",
          defaultMessage: "No models match.",
        })}
      </p>
    );
  return (
    <div className="flex flex-col gap-3">
      {nodexMatches ? (
        <NodexCard
          providers={models.nodexProviders}
          loading={models.loading}
          policy={models.policy}
          balance={models.balance}
          rateOf={models.rateOf}
          query={query}
          disclosure={{ open: true, onOpenChange: () => undefined }}
          onPolicyChange={models.changeCredit}
          onOpenAccount={models.onOpenAccount}
        />
      ) : null}
      {others.map((provider) => (
        <NodexSettingsSection
          key={provider.instanceId}
          title={provider.displayName ?? provider.instanceId}
        >
          <div className="flex flex-col pb-2">
            <ListHeader count={modelsOnSummary(models.policy, provider, intl)}>
              <ProviderModelActions provider={provider} />
            </ListHeader>
            <ProviderModelGrid provider={provider} query={query} />
          </div>
        </NodexSettingsSection>
      ))}
    </div>
  );
}
