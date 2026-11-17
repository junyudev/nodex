import { QueryClientContext, QueryObserver } from "@tanstack/react-query";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from "react";
import { modelPolicyOwnerFor } from "@/features/model-policy/model-policy";
import {
  agentModelKey,
  agentRuntimeQualifier,
  flattenAgentConfigOptions,
} from "@/lib/agent-model-selection";
import { agentEffortLabel } from "@/lib/agent-runtime-model-selection";
import {
  formatCodexModelLabel,
  resolveCodexReasoningEffortOptions,
  resolveCodexSpeedTiers,
  type CodexSpeedTierOption,
} from "@/lib/codex-thread-settings";
import { getIntl, useIntl, type IntlShape } from "@/lib/i18n";
import {
  resolveIntelligenceEffortPosition,
  resolveIntelligenceEffortStops,
  settleIntelligenceIntentOverlay,
  THINKING_OFF_EFFORT_STOP,
  type IntelligenceEffortStop,
  type IntelligenceIntentOverlay,
} from "@/lib/intelligence-effort";
import { listedModelCatalog } from "@/lib/listed-agent-model-catalog";
import type { AgentBackendBinding } from "../../../../shared/agent-backend";
import { agentRuntimePolicyProvider } from "../../../../shared/agent-runtime-provider";
import { isClaudeEffortLevel } from "../../../../shared/claude-models";
import { codexSpeed, type CodexSpeed } from "../../../../shared/codex-service-tier";
import { isModelOn } from "../../../../shared/model-policy";
import type {
  AgentIntelligenceDropdownProps,
  AgentNativeIntelligencePatch,
  AgentNativeIntelligencePresentation,
} from "./agent-intelligence-dropdown";
import type {
  AgentModelCatalogPresentation,
  AgentModelPickerEntry,
} from "./agent-model-catalog-presentation";
import type { IntelligenceModeIndicator } from "./intelligence-controls";

export type { AgentModelCatalogPresentation } from "./agent-model-catalog-presentation";

export interface AgentIntelligenceModelChoice {
  readonly key: string;
  readonly binding: AgentBackendBinding;
  readonly label: string;
  readonly detail: string | null;
  readonly tooltip: string | null;
  readonly searchText: string;
  readonly current: boolean;
  readonly disabled: boolean;
  readonly off: boolean;
  readonly opensSettings: boolean;
}

export interface AgentIntelligenceOptionChoice {
  readonly value: string;
  readonly label: string;
  readonly description: string | null;
  readonly current: boolean;
}

interface AgentIntelligenceOptionRow {
  readonly label: string;
  readonly value: string;
  readonly choices: readonly AgentIntelligenceOptionChoice[];
  readonly choose: ((value: string) => Promise<void>) | null;
}

interface AgentIntelligenceToggle {
  readonly on: boolean;
  readonly description: string;
  readonly set: (on: boolean) => Promise<void>;
}

export interface AgentIntelligenceMenu {
  readonly catalog: AgentModelCatalogPresentation;
  readonly modelLabel: string;
  readonly models: {
    readonly choices: readonly AgentIntelligenceModelChoice[];
    readonly loading: boolean;
    readonly error: string | null;
    readonly choose: (choice: AgentIntelligenceModelChoice) => Promise<void>;
    readonly currentKey: string;
  };
  readonly effort: {
    readonly label: string;
    readonly choices: readonly AgentIntelligenceOptionChoice[];
    readonly choose: (value: string) => Promise<void>;
  } | null;
  /** Codex's speeds: Standard and every faster tier the model offers. */
  readonly speed: {
    readonly tiers: readonly CodexSpeedTierOption[];
    readonly value: CodexSpeed | null;
    readonly choose: (value: CodexSpeed | null) => Promise<void>;
  } | null;
  /** An Agent's own Fast switch, where it has one instead of Codex's speeds. */
  readonly fast: AgentIntelligenceToggle | null;
  readonly ultracode:
    | (AgentIntelligenceToggle & {
        readonly unavailableReason: string | null;
      })
    | null;
  readonly thinking: AgentIntelligenceToggle | null;
  readonly effortSlider: {
    readonly stops: readonly IntelligenceEffortStop[];
    readonly value: string | null;
    readonly isDefault: boolean;
    /** The speed in force, which streams through the filled track. */
    readonly flow: CodexSpeed | null;
    readonly choose: (value: string) => Promise<void>;
  } | null;
  readonly reasoningLabel: string;
  readonly reasoningEffort: string;
  readonly indicators: readonly IntelligenceModeIndicator[];
  readonly context: AgentIntelligenceOptionRow | null;
  readonly configOptions: readonly (AgentIntelligenceOptionRow & { readonly id: string })[];
  readonly mode: AgentIntelligenceOptionRow | null;
  readonly hasOptions: boolean;
}

const CODEX_AGENT = { binding: { kind: "codex" }, label: "Codex" } as const;
const subscribeToNoPolicy = () => () => {};
const readNoPolicy = () => null;

/** Uses the supplied catalog, or projects a plain list through the shared Profile policy. */
export function useAgentModelCatalog(
  props: AgentIntelligenceDropdownProps,
): AgentModelCatalogPresentation {
  const queryClient = useContext(QueryClientContext);
  const supplied = props.provider?.modelCatalog;
  const owner = queryClient && !supplied ? modelPolicyOwnerFor(queryClient) : null;
  const snapshot = useSyncExternalStore(
    owner?.subscribe ?? subscribeToNoPolicy,
    owner?.getSnapshot ?? readNoPolicy,
    owner?.getSnapshot ?? readNoPolicy,
  );
  // Observe the same query as useModelPolicy, including invalidations from other windows.
  // The owner publishes the canonical value through its snapshot subscription above.
  useEffect(() => {
    if (!queryClient || !owner) return;
    const observer = new QueryObserver(queryClient, {
      queryKey: ["settings", "modelPolicy"],
      queryFn: owner.readCanonical,
      retry: false,
      staleTime: 0,
      refetchOnMount: "always",
    });
    return observer.subscribe(() => {});
  }, [queryClient, owner]);
  useLayoutEffect(() => {
    if (snapshot?.renderToken != null) owner?.markRendered(snapshot.renderToken);
  }, [owner, snapshot?.renderToken]);

  if (supplied) return supplied;
  const agent = props.agent ?? CODEX_AGENT;
  const provider = agentRuntimePolicyProvider(agent.binding);
  const models =
    snapshot && provider
      ? props.models.filter(
          // A saved choice stays visible, so turning it off never changes it silently.
          (model) =>
            isModelOn(snapshot.value, provider, model.id) || model.id === props.selection.model,
        )
      : props.models;
  return listedModelCatalog({
    binding: agent.binding,
    label: agent.label,
    models,
    selection: props.selection,
    onSelectionChange: props.onSelectionChange,
  });
}

interface NativeIntelligenceWrite {
  readonly patch: AgentNativeIntelligencePatch;
  readonly shown: IntelligenceIntentOverlay;
  readonly waiters: readonly { resolve: () => void; reject: (error: unknown) => void }[];
}

/** Keep queue-empty detection and worker release in the same continuation. */
async function drainNativeIntelligence({
  nativeRef,
  queued,
  draining,
  setOverlay,
}: {
  readonly nativeRef: { readonly current: AgentNativeIntelligencePresentation | undefined };
  readonly queued: { current: NativeIntelligenceWrite | null };
  readonly draining: { current: boolean };
  readonly setOverlay: Dispatch<SetStateAction<IntelligenceIntentOverlay>>;
}) {
  const readQueue = () => queued.current;
  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  if (draining.current) return;
  draining.current = true;
  try {
    while (true) {
      const next = readQueue();
      if (!next) {
        await nextFrame();
        // A choice can arrive during the idle frame. Check again before releasing the worker.
        if (readQueue()) continue;
        setOverlay({});
        return;
      }
      queued.current = null;
      try {
        const native = nativeRef.current;
        if (!native) {
          throw new Error(
            getIntl().formatMessage({
              id: "components.agentModelPicker.updateError",
              defaultMessage: "Could not update model options",
            }),
          );
        }
        await native.change(next.patch);
        for (const waiter of next.waiters) waiter.resolve();
      } catch (error) {
        const newer = readQueue();
        setOverlay((current) =>
          Object.fromEntries(
            Object.entries(current).filter(
              ([key]) => !(key in next.shown) || (newer && key in newer.shown),
            ),
          ),
        );
        for (const waiter of next.waiters) waiter.reject(error);
      }
      // The next change builds on this one once it has rendered.
      await nextFrame();
    }
  } finally {
    draining.current = false;
  }
}

function useNativeIntelligenceWrites(native: AgentNativeIntelligencePresentation | undefined) {
  const [overlay, setOverlay] = useState<IntelligenceIntentOverlay>({});
  const nativeRef = useRef(native);
  useLayoutEffect(() => {
    nativeRef.current = native;
  });
  const queued = useRef<NativeIntelligenceWrite | null>(null);
  const draining = useRef(false);

  const changeNative = (
    patch: AgentNativeIntelligencePatch,
    shown: IntelligenceIntentOverlay = {},
  ) => {
    setOverlay((current) => ({ ...current, ...shown }));
    return new Promise<void>((resolve, reject) => {
      queued.current = {
        patch: { ...queued.current?.patch, ...patch },
        shown: { ...queued.current?.shown, ...shown },
        waiters: [...(queued.current?.waiters ?? []), { resolve, reject }],
      };
      void drainNativeIntelligence({ nativeRef, queued, draining, setOverlay });
    });
  };
  return { overlay, changeNative };
}

function modelChoice(
  entry: AgentModelPickerEntry,
  selectedKey: string,
  intl: IntlShape,
  off: boolean,
): AgentIntelligenceModelChoice {
  const { binding, label, model, unavailableReason } = entry;
  const key = agentModelKey(binding, model.id);
  const opensSettings = off && entry.spendsCredit === true;
  const stateLabel = off
    ? intl.formatMessage({ id: "components.agentModelPicker.off", defaultMessage: "Off" })
    : unavailableReason
      ? (entry.unavailableLabel ??
        intl.formatMessage({
          id: "components.agentModelPicker.unavailable",
          defaultMessage: "Unavailable",
        }))
      : null;
  return {
    key: off ? `off:${key}` : key,
    binding,
    label: model.displayName,
    detail: [agentRuntimeQualifier(binding, label), stateLabel].filter(Boolean).join(" · ") || null,
    tooltip: off
      ? opensSettings
        ? intl.formatMessage({
            id: "components.agentModelPicker.enableInSettings",
            defaultMessage: "Turn on in Settings",
          })
        : intl.formatMessage({
            id: "components.agentModelPicker.enableAndUse",
            defaultMessage: "Turn on and use",
          })
      : (unavailableReason ?? (model.description || model.id)),
    searchText: `${model.displayName} ${model.id} ${label} ${binding.kind}`,
    current: key === selectedKey,
    disabled: !off && unavailableReason !== undefined,
    off,
    opensSettings,
  };
}

function modelChoices(
  catalog: AgentModelCatalogPresentation,
  currentKey: string,
  intl: IntlShape,
): AgentIntelligenceMenu["models"] {
  const listed = catalog.entries.map((entry) => ({
    choice: modelChoice(entry, currentKey, intl, false),
    entry,
  }));
  const off =
    catalog.off?.entries.map((entry) => ({
      choice: modelChoice(entry, currentKey, intl, true),
      entry,
    })) ?? [];
  const rows = [...listed, ...off];
  return {
    currentKey,
    choices: rows.map(({ choice }) => choice),
    loading: catalog.loading,
    error: catalog.error ?? null,
    choose: async ({ key }) => {
      const row = rows.find(({ choice }) => choice.key === key);
      if (!row || row.choice.disabled) return;
      // Credit is only ever turned on deliberately, where its consequences are stated.
      if (row.choice.opensSettings) return catalog.manageModels?.("nodex");
      if (row.choice.off) return catalog.off?.choose(row.entry.selection);
      return catalog.choose(row.entry.selection);
    },
  };
}

function projectConfigOptions(catalog: AgentModelCatalogPresentation, intl: IntlShape) {
  const { changeConfig } = catalog;
  return (catalog.configOptions ?? [])
    .filter((option) => option.category !== "model")
    .map((option) => {
      const value = String(option.currentValue);
      const choices =
        option.type === "boolean"
          ? [
              {
                value: "true",
                label: intl.formatMessage({
                  id: "components.agentModelPicker.on",
                  defaultMessage: "On",
                }),
                description: null,
                current: value === "true",
              },
              {
                value: "false",
                label: intl.formatMessage({
                  id: "components.agentModelPicker.off",
                  defaultMessage: "Off",
                }),
                description: null,
                current: value === "false",
              },
            ]
          : flattenAgentConfigOptions(option).map((entry) => ({
              value: entry.value,
              label: entry.name,
              description: entry.description,
              current: value === entry.value,
            }));
      return {
        id: option.id,
        thoughtLevel: option.type === "select" && option.category === "thought_level",
        label: option.name,
        value,
        choices,
        choose: changeConfig
          ? async (value: string) =>
              changeConfig(option.id, option.type === "boolean" ? value === "true" : value)
          : null,
      };
    });
}

export function useAgentIntelligenceMenu(
  props: AgentIntelligenceDropdownProps & {
    readonly catalog: AgentModelCatalogPresentation;
    readonly modelOnly?: boolean;
  },
): AgentIntelligenceMenu {
  const intl = useIntl();
  const { catalog, selection, models, provider, onSelectionChange } = props;
  const isCodex = selection.kind === "codex";
  const hasNativeEffort = isCodex || selection.kind === "claude";
  const native = provider?.nativeIntelligence;
  const { overlay, changeNative } = useNativeIntelligenceWrites(native);
  const currentKey = agentModelKey(catalog.selected.binding, catalog.selected.model);
  const active = catalog.entries.find(
    (entry) => agentModelKey(entry.binding, entry.model.id) === currentKey,
  );
  const modelLabel =
    active?.model.displayName ??
    (selection.model
      ? formatCodexModelLabel(selection.model, models)
      : intl.formatMessage({
          id: "components.agentModelPicker.chooseModel",
          defaultMessage: "Choose model",
        }));
  const currentModel = models.find((model) => model.id === selection.model);
  // Codex offers its standard levels for a model the catalog does not describe.
  const reasoningOptions = isCodex
    ? resolveCodexReasoningEffortOptions(selection.model, models)
    : (currentModel?.supportedReasoningEfforts ?? []);
  const nativeControls = !props.modelOnly && hasNativeEffort;
  const stops = nativeControls
    ? resolveIntelligenceEffortStops(
        {
          efforts: reasoningOptions,
          label: (effort) => agentEffortLabel(selection.kind, effort, intl),
          canDisableThinking: native?.capabilities.disableThinking === true,
        },
        intl,
      )
    : [];
  const committedEffort = resolveIntelligenceEffortPosition({
    stops,
    selected: selection.reasoningEffort,
    modelDefault: currentModel?.defaultReasoningEffort,
    thinkingOff: native?.selected.thinking === false,
  });
  const codexTier = isCodex ? codexSpeed(selection.serviceTier) : null;
  const speedTiers =
    isCodex && !props.modelOnly ? resolveCodexSpeedTiers(selection.model, models) : [];
  const committedFast = isCodex ? codexTier !== null : native?.selected.fast === true;
  const committedUltracode =
    native?.capabilities.ultracode === true && native.selected.ultracode === true;
  const shown = settleIntelligenceIntentOverlay(overlay, {
    effort: committedEffort.value,
    fast: committedFast,
    ultracode: committedUltracode,
  });
  const position =
    shown.effort === undefined ? committedEffort : { value: shown.effort, isDefault: false };
  const fastOn = shown.fast ?? committedFast;
  const ultracodeOn = shown.ultracode ?? committedUltracode;
  const speedInForce = isCodex ? codexTier : fastOn ? "fast" : null;
  const indicators: AgentIntelligenceMenu["indicators"] = [
    ...(speedInForce ? [speedInForce] : []),
    ...(ultracodeOn ? (["ultracode"] as const) : []),
  ];
  const reasoningLabel =
    shown.effort !== undefined
      ? (stops.find((stop) => stop.value === shown.effort)?.label ?? "")
      : native?.selected.thinking === false
        ? intl.formatMessage({ id: "components.agentModelPicker.off", defaultMessage: "Off" })
        : selection.reasoningEffort !== "default" && selection.reasoningEffort !== "none"
          ? agentEffortLabel(selection.kind, selection.reasoningEffort, intl)
          : "";
  const reasoningEffort =
    shown.effort ??
    (native?.selected.thinking === false ? THINKING_OFF_EFFORT_STOP : selection.reasoningEffort);

  const chooseEffort = async (value: string) => {
    if (!stops.some((stop) => stop.value === value)) return;
    if (native && value === THINKING_OFF_EFFORT_STOP)
      return changeNative({ thinking: false }, { effort: value });
    if (native && isClaudeEffortLevel(value))
      return changeNative({ effort: value, thinking: true }, { effort: value });
    return onSelectionChange({ ...selection, reasoningEffort: value }, "reasoningEffort");
  };
  const effortSlider =
    stops.length > 1 ? { stops, ...position, flow: speedInForce, choose: chooseEffort } : null;
  const configOptions =
    props.modelOnly || hasNativeEffort ? [] : projectConfigOptions(catalog, intl);
  const thoughtLevel = configOptions.find((option) => option.thoughtLevel);
  const effort = effortSlider
    ? {
        label: reasoningLabel,
        choices: stops.map((stop) => ({
          value: stop.value,
          label: stop.label,
          description: stop.description ?? null,
          current: stop.value === position.value,
        })),
        choose: chooseEffort,
      }
    : thoughtLevel?.choose && thoughtLevel.choices.length > 1
      ? { label: reasoningLabel, choices: thoughtLevel.choices, choose: thoughtLevel.choose }
      : null;

  const speed =
    speedTiers.length > 0
      ? {
          tiers: speedTiers,
          value: codexTier,
          choose: async (serviceTier: CodexSpeed | null) =>
            onSelectionChange({ ...selection, serviceTier }, "serviceTier"),
        }
      : null;
  const fast =
    !props.modelOnly && !isCodex && native?.capabilities.fastMode
      ? {
          on: fastOn,
          description: intl.formatMessage({
            id: "components.agentModelPicker.fastDescription",
            defaultMessage: "Faster output. Uses more usage.",
          }),
          set: (fast: boolean) => changeNative({ fast }, { fast }),
        }
      : null;
  const unavailableReason = native?.capabilities.ultracodeUnavailableReason || null;
  const ultracode =
    !props.modelOnly && (native?.capabilities.ultracode || unavailableReason)
      ? {
          on: ultracodeOn && !unavailableReason,
          description: intl.formatMessage({
            id: "components.agentModelPicker.ultracodeDescription",
            defaultMessage:
              "Plans and runs a multi-agent workflow for each substantive task, at any effort. Uses usage much faster.",
          }),
          unavailableReason,
          set: async (ultracode: boolean) => {
            if (unavailableReason) return;
            return changeNative({ ultracode }, { ultracode });
          },
        }
      : null;
  // A model with a thinking switch but no effort levels shows that switch as a mode.
  const thinking =
    !props.modelOnly && native?.capabilities.disableThinking && reasoningOptions.length === 0
      ? {
          on: native.selected.thinking === true,
          description: intl.formatMessage({
            id: "components.agentModelPicker.thinkingDescription",
            defaultMessage: "Reason before answering.",
          }),
          set: (thinking: boolean) => changeNative({ thinking }),
        }
      : null;
  const contextWindows = [...new Set(native?.capabilities.contextWindows ?? [])];
  const contextValue = native?.selected.contextInherited
    ? "default"
    : (native?.selected.context ?? "");
  const context =
    contextWindows.length > 1
      ? {
          label: intl.formatMessage({
            id: "components.agentModelPicker.context",
            defaultMessage: "Context",
          }),
          value: contextValue,
          choices: [
            {
              value: "default",
              label: intl.formatMessage({
                id: "components.agentModelPicker.default",
                defaultMessage: "Default",
              }),
              description: null,
              current: contextValue === "default",
            },
            ...contextWindows.map((value) => ({
              value,
              label: value,
              description: null,
              current: value === contextValue,
            })),
          ],
          choose: (value: string) => changeNative({ context: value === "default" ? null : value }),
        }
      : null;
  const { modes, changeMode } = catalog;
  const mode =
    modes && modes.availableModes.length > 0 && changeMode
      ? {
          label: intl.formatMessage({
            id: "components.agentModelPicker.mode",
            defaultMessage: "Mode",
          }),
          value: modes.currentModeId,
          choices: modes.availableModes.map((mode) => ({
            value: mode.id,
            label: mode.name,
            description: mode.description,
            current: mode.id === modes.currentModeId,
          })),
          choose: changeMode,
        }
      : null;
  const hasOptions = nativeControls
    ? Boolean(effortSlider || thinking || speed || fast || ultracode || context)
    : configOptions.length > 0 || Boolean(modes?.availableModes.length);

  return {
    catalog,
    modelLabel,
    models: modelChoices(catalog, currentKey, intl),
    effort,
    effortSlider,
    speed,
    fast,
    ultracode,
    thinking,
    reasoningLabel,
    reasoningEffort,
    indicators,
    context,
    configOptions,
    mode,
    hasOptions,
  };
}
