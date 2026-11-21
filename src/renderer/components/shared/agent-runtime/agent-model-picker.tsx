import { useIntl } from "@/lib/i18n";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useRef, useState, type ReactElement } from "react";
import { agentModelKey } from "@/lib/agent-model-selection";
import {
  AgentInstanceIcon,
  AgentProviderIcon,
  ChevronDownIcon,
  RefreshIcon,
  SettingsGeneralIcon,
} from "@/components/shared/icons";
import { NodexIconButton, NodexSwitchTrack } from "@/components/ui/button";
import { NodexMenuRowContent } from "@/components/ui/menu-row";
import {
  NodexDropdownActionRow,
  NodexDropdownButtonTrigger,
  NodexDropdownSeparator,
  NodexDropdownMessage,
  NodexOptionPicker,
  NodexSettingsDropdownTrigger,
  type NodexOptionPickerOption,
} from "@/components/ui/dropdown";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/toast";
import {
  IntelligenceSelectorTrigger,
  INTELLIGENCE_SELECTOR_SIDE_OFFSET_PX,
} from "./intelligence-selector-trigger";
import {
  IntelligenceControlsHeader,
  IntelligenceEffortSlider,
  intelligenceEffortEmphasis,
  IntelligenceModeIndicatorIcon,
  IntelligenceModeToggle,
  IntelligenceSpeedControl,
} from "./intelligence-controls";
import type { AgentIntelligenceDropdownProps } from "./agent-intelligence-dropdown";
import type { AgentModelCatalogPresentation } from "./agent-model-catalog-presentation";
import {
  useAgentIntelligenceMenu,
  type AgentIntelligenceMenu,
  type AgentIntelligenceModelChoice,
  type AgentIntelligenceOptionChoice,
} from "./use-agent-intelligence-menu";

export type {
  AgentModelCatalogPresentation,
  AgentModelPickerEntry,
  AgentModelSetupPresentation,
} from "./agent-model-catalog-presentation";

function OptionRow({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly AgentIntelligenceOptionChoice[];
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value)?.label ?? value;
  return (
    <NodexOptionPicker
      search="none"
      value={value}
      options={options.map(({ value, label, description }) => ({
        value,
        label,
        tooltipText: description,
        disabled,
      }))}
      open={open}
      onOpenChange={(next) => setOpen(next && !disabled)}
      onValueChange={(value) => {
        // Keep the popup mounted so its dismissal completes while the write is pending.
        setOpen(false);
        onChange(value);
      }}
      side="left"
      align="end"
      triggerButton={
        <NodexDropdownButtonTrigger
          chrome="transparent"
          showChevron={false}
          disabled={disabled}
          className="w-full gap-3 px-[var(--padding-row-x)] hover:bg-token-list-hover-background aria-expanded:bg-token-list-hover-background"
          aria-label={`${label} ${selected}`}
        >
          <span className="shrink-0">{label}</span>
          <span className="ms-auto min-w-0 truncate text-token-description-foreground">
            {selected || "—"}
          </span>
          <ChevronDownIcon className="icon-2xs text-token-input-placeholder-foreground" />
        </NodexDropdownButtonTrigger>
      }
    />
  );
}

/** Not an `agentModelKey`, which is always a JSON array. */
const INHERIT_OPTION_VALUE = "inherit";

function pickerOption(choice: AgentIntelligenceModelChoice): NodexOptionPickerOption {
  const { key, binding, label, detail, tooltip, searchText, disabled, off } = choice;
  return {
    value: key,
    leftSlot: (
      <AgentInstanceIcon binding={binding} className={cn("size-3.5", off && "opacity-60")} />
    ),
    label: detail ? (
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className={cn("truncate", off && "text-token-description-foreground")}>{label}</span>
        <span className="min-w-0 truncate text-xs text-token-description-foreground">{detail}</span>
      </span>
    ) : (
      label
    ),
    searchText,
    tooltipText: tooltip,
    disabled,
  };
}

type AgentModelPickerViewProps = AgentIntelligenceDropdownProps & {
  /** Replaces the composer or settings trigger, such as a split button's menu half. */
  readonly triggerButton?: ReactElement;
  readonly additionalOptions?: readonly NodexOptionPickerOption[];
  readonly additionalValue?: string;
  readonly onAdditionalChoice?: (value: string) => void;
  /** Renames the inherited choice `allowInherit` lists. */
  readonly inheritLabel?: string;
};

export function AgentModelPicker(
  props: AgentModelPickerViewProps & {
    readonly catalog: AgentModelCatalogPresentation;
    /** Chooses a model and nothing else, where Nodex decides its effort and speed. */
    readonly modelOnly?: boolean;
  },
) {
  const menu = useAgentIntelligenceMenu(props);
  return <AgentModelPickerView {...props} menu={menu} />;
}

export function AgentModelPickerView({
  menu,
  ...props
}: AgentModelPickerViewProps & { readonly menu: AgentIntelligenceMenu }) {
  const intl = useIntl();
  const { triggerRef } = props;
  const {
    catalog,
    models,
    modelLabel,
    reasoningLabel,
    reasoningEffort,
    indicators,
    effortSlider,
    speed,
    fast,
    ultracode,
    thinking,
    context,
    configOptions,
    mode,
    hasOptions,
  } = menu;
  const [pending, setPending] = useState(false);
  const [offQuery, setOffQuery] = useState("");
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  // A footer action that opens another surface waits until this menu has closed.
  const afterClose = useRef<(() => void) | null>(null);
  const open = props.open ?? uncontrolledOpen;
  const requestOpenChange = props.onOpenChange ?? setUncontrolledOpen;
  // A provider may have become available since the last read, such as once its service is
  // reachable again, so opening shows the catalog as it is now.
  const changeOpen = (next: boolean) => {
    if (next && !open) catalog.reload?.();
    requestOpenChange(next);
  };
  const setups = catalog.setups ?? [];
  const { refresh } = catalog;
  // The gear leads to what this menu lists; a provider's setup row keeps going to its Agent.
  const manage = catalog.manageModels ?? catalog.manage;
  const reportError = (error: unknown, id?: string) => {
    toast.danger(
      error instanceof Error
        ? error.message
        : intl.formatMessage({
            id: "components.agentModelPicker.updateError",
            defaultMessage: "Could not update model options",
          }),
      { id },
    );
  };
  const reportNativeError = (error: unknown) =>
    reportError(error, "agent-model-picker-native-intelligence");
  const run = async (operation: () => Promise<void> | void) => {
    if (pending) return;
    setPending(true);
    await runWithCleanup(
      async () => {
        await operation();
      },
      {
        onError: reportError,
        cleanup: () => setPending(false),
      },
    );
  };
  const offCount = catalog.off?.count ?? 0;
  const inherited = props.allowInherit === true && props.inheritance === "inherited";
  const inheritLabel =
    props.inheritLabel ??
    intl.formatMessage({
      id: "components.agentModelPicker.inherit",
      defaultMessage: "Use current/default",
    });
  // An inherited choice names no modes of its own.
  const settingsIndicators = inherited ? [] : indicators;
  const inheritOptions: readonly NodexOptionPickerOption[] = props.allowInherit
    ? [
        {
          value: INHERIT_OPTION_VALUE,
          // Keeps the label in line with the model names beside their provider marks.
          leftSlot: <span aria-hidden="true" className="size-3.5" />,
          label: inheritLabel,
        },
      ]
    : [];
  // Off models answer a search and nothing else, so the list stays what the person kept.
  const modelOptions = models.choices
    .filter((choice) => !choice.off || offQuery.trim() !== "")
    .map((choice) => ({
      ...pickerOption(choice),
      ...(props.additionalOptions && !choice.off
        ? {
            group: intl.formatMessage({
              id: "components.agentModelPicker.agents",
              defaultMessage: "Agents",
            }),
          }
        : {}),
    }));
  // Effort and modes are optimistic, so a pending write never dims them; option menus that
  // wait on their Agent stay locked until it answers.
  const disabled = props.disabled === true;
  const optionsDisabled = disabled || pending;
  const modeToggles =
    thinking || speed || fast || ultracode ? (
      <>
        {thinking ? (
          <IntelligenceModeToggle
            mode="thinking"
            description={thinking.description}
            pressed={thinking.on}
            disabled={disabled}
            onPressedChange={(on) => void thinking.set(on).catch(reportNativeError)}
          />
        ) : null}
        {speed ? (
          <IntelligenceSpeedControl
            tiers={speed.tiers}
            value={speed.value}
            disabled={disabled}
            onChange={(value) => void speed.choose(value).catch(reportNativeError)}
          />
        ) : fast ? (
          <IntelligenceModeToggle
            mode="fast"
            description={fast.description}
            pressed={fast.on}
            disabled={disabled}
            onPressedChange={(on) => void fast.set(on).catch(reportNativeError)}
          />
        ) : null}
        {ultracode ? (
          <IntelligenceModeToggle
            mode="ultracode"
            description={ultracode.description}
            pressed={ultracode.on}
            disabled={disabled}
            unavailableReason={ultracode.unavailableReason ?? undefined}
            onPressedChange={(on) => void ultracode.set(on).catch(reportNativeError)}
          />
        ) : null}
      </>
    ) : null;
  const runtimeOptions = catalog.runtimeOptions ?? [];
  return (
    <NodexOptionPicker
      search="filter"
      searchPlaceholder={intl.formatMessage({
        id: "components.agentModelPicker.searchPlaceholder",
        defaultMessage: "Search models…",
      })}
      searchAriaLabel={intl.formatMessage({
        id: "components.agentModelPicker.searchLabel",
        defaultMessage: "Search models",
      })}
      searchTrailingContent={
        refresh || manage ? (
          <span className="-me-1 flex items-center">
            {refresh ? (
              <NodexIconButton
                size="xs"
                ariaLabel={intl.formatMessage({
                  id: "components.agentModelPicker.refresh",
                  defaultMessage: "Refresh models",
                })}
                icon={RefreshIcon}
                className={cn(models.loading && "[&_svg]:animate-spin")}
                disabled={models.loading || pending}
                onClick={refresh}
              />
            ) : null}
            {manage ? (
              <NodexIconButton
                size="xs"
                ariaLabel={
                  catalog.manageModels
                    ? intl.formatMessage({
                        id: "components.agentModelPicker.manageModels",
                        defaultMessage: "Manage models",
                      })
                    : intl.formatMessage({
                        id: "components.agentModelPicker.manageProviders",
                        defaultMessage: "Manage providers",
                      })
                }
                icon={SettingsGeneralIcon}
                onClick={() => {
                  changeOpen(false);
                  manage();
                }}
              />
            ) : null}
          </span>
        ) : undefined
      }
      value={props.additionalValue ?? (inherited ? INHERIT_OPTION_VALUE : models.currentKey)}
      options={[...(props.additionalOptions ?? []), ...inheritOptions, ...modelOptions]}
      {...(catalog.off ? { onSearchChange: setOffQuery } : {})}
      emptyMessage={
        models.loading
          ? intl.formatMessage({
              id: "components.agentModelPicker.loading",
              defaultMessage: "Loading models…",
            })
          : intl.formatMessage({
              id: "components.agentModelPicker.empty",
              defaultMessage: "No models available",
            })
      }
      noResultsMessage={intl.formatMessage({
        id: "components.agentModelPicker.noMatches",
        defaultMessage: "No matching models",
      })}
      disabled={props.disabled}
      open={open}
      onOpenChange={changeOpen}
      finalFocus={() => {
        const action = afterClose.current;
        afterClose.current = null;
        action?.();
        return true;
      }}
      side={props.triggerStyle === "settings" ? "bottom" : "top"}
      align="end"
      sideOffset={INTELLIGENCE_SELECTOR_SIDE_OFFSET_PX}
      contentClassName="w-[288px]"
      triggerButton={
        props.triggerButton ??
        (props.triggerStyle === "settings" ? (
          <NodexSettingsDropdownTrigger
            ref={triggerRef}
            aria-label={intl.formatMessage({
              id: "components.agentModelPicker.intelligence",
              defaultMessage: "Agent intelligence",
            })}
            className="w-full min-w-0 justify-between"
            data-fast-mode-indicator={settingsIndicators.includes("fast") ? "true" : undefined}
            data-ultrafast-mode-indicator={
              settingsIndicators.includes("ultrafast") ? "true" : undefined
            }
            data-ultracode-indicator={settingsIndicators.includes("ultracode") ? "true" : undefined}
          >
            {settingsIndicators.map((mode) => (
              <IntelligenceModeIndicatorIcon key={mode} mode={mode} />
            ))}
            <span className="min-w-0 flex-1 truncate text-start">
              {inherited ? (
                inheritLabel
              ) : (
                <>
                  {modelLabel}
                  {reasoningLabel ? (
                    <>
                      {" · "}
                      <span className={intelligenceEffortEmphasis(reasoningEffort)}>
                        {reasoningLabel}
                      </span>
                    </>
                  ) : null}
                </>
              )}
            </span>
          </NodexSettingsDropdownTrigger>
        ) : (
          <IntelligenceSelectorTrigger
            ref={triggerRef}
            modelLabel={modelLabel}
            reasoningLabel={reasoningLabel}
            reasoningEffort={reasoningEffort}
            indicators={indicators}
            aria-keyshortcuts={props.shortcut?.ariaKeyShortcuts}
          />
        ))
      }
      onValueChange={(value) => {
        if (props.additionalOptions?.some((option) => option.value === value)) {
          props.onAdditionalChoice?.(value);
          return;
        }
        if (value === INHERIT_OPTION_VALUE) return props.onInherit?.();
        const choice = models.choices.find((candidate) => candidate.key === value);
        if (!choice) return;
        if (choice.opensSettings) {
          void models.choose(choice).catch(reportError);
          return;
        }
        void run(() => models.choose(choice));
      }}
      footer={
        <>
          {offCount > 0 || setups.length > 0 ? <NodexDropdownSeparator /> : null}
          {offCount > 0 && catalog.manageModels ? (
            <NodexDropdownActionRow
              disabled={pending}
              onClick={() => {
                afterClose.current = () => catalog.manageModels?.();
                changeOpen(false);
              }}
            >
              <span className="text-token-description-foreground">
                {intl.formatMessage(
                  {
                    id: "components.agentModelPicker.offCount",
                    defaultMessage: "{count, plural, one {# model off} other {# models off}}",
                  },
                  { count: offCount },
                )}
              </span>
            </NodexDropdownActionRow>
          ) : null}
          {setups.map((setup) => (
            <NodexDropdownActionRow
              key={setup.instanceId ?? `${setup.kind}:${setup.label}`}
              className="items-center gap-1.5"
              disabled={pending}
              onClick={() => {
                const { action } = setup;
                afterClose.current =
                  action.kind === "settings"
                    ? (catalog.manage ?? null)
                    : () =>
                        action.open({
                          // Setup returns to the model list; the choice is unchanged.
                          showModels: () => changeOpen(true),
                        });
                changeOpen(false);
              }}
            >
              <AgentProviderIcon kind={setup.kind} className="size-3.5 text-token-text-secondary" />
              <span className="min-w-0 truncate">{setup.label}</span>{" "}
              <span
                className={cn(
                  "ms-auto shrink-0 ps-2 text-xs tabular-nums",
                  setup.tone === "danger" ? "text-danger" : "text-token-description-foreground",
                )}
              >
                {setup.hint}
              </span>
            </NodexDropdownActionRow>
          ))}
          {props.additionalValue === undefined ? (
            <>
              {hasOptions ? <NodexDropdownSeparator /> : null}
              {effortSlider ? (
                <IntelligenceEffortSlider
                  stops={effortSlider.stops}
                  value={effortSlider.value}
                  isDefault={effortSlider.isDefault}
                  flow={effortSlider.flow}
                  disabled={disabled}
                  accessory={modeToggles}
                  onChange={(value) => void effortSlider.choose(value).catch(reportNativeError)}
                />
              ) : modeToggles ? (
                <div className="px-[var(--padding-row-x)]">
                  <IntelligenceControlsHeader accessory={modeToggles} />
                </div>
              ) : null}
              {context ? (
                <OptionRow
                  label={context.label}
                  value={context.value}
                  options={context.choices}
                  disabled={optionsDisabled}
                  onChange={(value) => void context.choose?.(value).catch(reportNativeError)}
                />
              ) : null}
              {configOptions.map((option) => (
                <OptionRow
                  key={option.id}
                  label={option.label}
                  value={option.value}
                  disabled={optionsDisabled || !option.choose}
                  options={option.choices}
                  onChange={(value) => void run(() => option.choose?.(value))}
                />
              ))}
              {mode ? (
                <OptionRow
                  label={mode.label}
                  value={mode.value}
                  options={mode.choices}
                  disabled={optionsDisabled}
                  onChange={(value) => void run(() => mode.choose?.(value))}
                />
              ) : null}
            </>
          ) : null}
          {catalog.toggles?.length ? <NodexDropdownSeparator /> : null}
          {catalog.toggles?.map((toggle) => (
            <NodexDropdownActionRow
              key={toggle.label}
              role="switch"
              aria-checked={toggle.checked}
              disabled={pending}
              onClick={() => toggle.change(!toggle.checked)}
            >
              <NodexMenuRowContent
                trailing={<NodexSwitchTrack checked={toggle.checked} size="compact" />}
              >
                {toggle.label}
              </NodexMenuRowContent>
            </NodexDropdownActionRow>
          ))}
          {catalog.actions?.length ? <NodexDropdownSeparator /> : null}
          {catalog.actions?.map((action) => (
            <NodexDropdownActionRow
              key={action.label}
              disabled={pending}
              onClick={() => {
                afterClose.current = action.run;
                changeOpen(false);
              }}
            >
              {action.label}
            </NodexDropdownActionRow>
          ))}
          {runtimeOptions.length > 0 || models.error ? <NodexDropdownSeparator /> : null}
          {runtimeOptions.map((runtime) => (
            <NodexDropdownActionRow
              key={agentModelKey(runtime.binding, "")}
              className="items-center gap-1.5"
              onClick={() => {
                changeOpen(false);
                catalog.chooseRuntime?.(runtime.binding);
              }}
            >
              <AgentInstanceIcon
                binding={runtime.binding}
                className="size-3.5 text-token-text-secondary"
              />
              <span className="min-w-0 truncate">
                {intl.formatMessage(
                  {
                    id: "components.agentModelPicker.startWith",
                    defaultMessage: "Start with {runtime}",
                  },
                  { runtime: runtime.label },
                )}
              </span>
            </NodexDropdownActionRow>
          ))}
          {models.error ? (
            <NodexDropdownMessage compact tone="error">
              {models.error}
            </NodexDropdownMessage>
          ) : null}
        </>
      }
    />
  );
}
