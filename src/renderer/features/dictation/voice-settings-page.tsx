import { settingsMessages } from "@/components/workbench/workbench-settings-search-catalog";
import {
  getIntl,
  useIntl,
  type IntlShape,
  defineMessage,
  type MessageDescriptor,
} from "@/lib/i18n";
import {
  AppComponentRequirement,
  useAppComponentRequirementDescription,
} from "@/features/app-components/app-component-requirement";
import { DictationPerformanceDetails } from "./dictation-performance-details";
import { DictationDiagnosticsRecorder } from "./dictation-diagnostics-recorder";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NodexButton } from "@/components/ui/button";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSelectedIcon,
  NodexDropdownSeparator,
  NodexSettingsDropdownTrigger,
} from "@/components/ui/dropdown";
import { HotkeySettingControl } from "@/components/ui/hotkey-setting-control";
import { Input } from "@/components/ui/input";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  NodexSettingsPageSurface,
  NodexSettingsRow,
  NodexSettingsSection,
} from "@/components/ui/settings";
import { ConfigValueDropdown } from "@/components/workbench/config-value-dropdown";
import { TogglePill } from "@/components/workbench/workbench-settings-controls";
import { toast } from "@/components/ui/toast";
import {
  DeleteIcon,
  DownloadIcon,
  CopyIcon,
  MoreActionsIcon,
  PlusIcon,
} from "@/components/shared/icons";
import { queryKeys } from "@/lib/query-keys";
import { updateCommandKeybinding, useCommandKeymapState } from "@/lib/use-command-keymap-state";
import {
  deleteDictationRecording,
  downloadDictationRecording,
  importDictationRecordingFile,
  listDictationRecordings,
  readDictationRecordingAudio,
  readDictationCapabilityState,
  readDictationSettings,
  requestMicrophoneAccess,
  setDictationRecordingTranscript,
  setDictationRecordingDiagnostics,
  updateDictationSettings,
} from "@/lib/api";
import type { DictationSettings } from "../../../shared/dictation";
import type { DictationRecordingMetadata } from "../../../shared/dictation-history";
import { DICTATION_HISTORY_MAX_RECORDINGS } from "../../../shared/dictation-history";
import { DICTATION_VOICE_LANGUAGES } from "../../../shared/dictation";
import {
  commandTitleMessage,
  findCommandKeybindingConflict,
  formatAcceleratorLabel,
  validateGlobalDictationShortcut,
  type CommandKeybindingUpdate,
  type CommandKeymapEntry,
} from "../../../shared/command-keybindings";
import { transcribeDictationBlob } from "./dictation-buffered-client";
import {
  captureGlobalDictationBareModifierHotkey,
  readDictationVoiceLanguage,
  updateDictationVoiceLanguage,
  subscribeDictationSettingsUpdates,
} from "./dictation-settings-runtime";

const DictationDictionaryDialog = lazy(() =>
  import("./dictation-dictionary-dialog").then((module) => ({
    default: module.DictationDictionaryDialog,
  })),
);

const SETTINGS_QUERY_KEY = ["settings", "dictation"] as const;
const HISTORY_QUERY_KEY = ["dictation", "history"] as const;
const CAPABILITY_QUERY_KEY = ["dictation", "capabilities"] as const;
const LANGUAGE_QUERY_KEY = ["dictation", "voice-language"] as const;
const EMPTY_DICTIONARY_ENTRY = "";
const DICTIONARY_PLACEHOLDERS = [
  "Jane Doe",
  "Acme Widget",
  "checkout-form.tsx",
  "useCartState",
] as const;
const MAX_DICTIONARY_ENTRIES = 100;

const LANGUAGE_OVERRIDES: Readonly<
  Partial<Record<string, MessageDescriptor & { defaultMessage: string }>>
> = {
  auto: defineMessage({
    id: "dictation.voiceSettingsPage.languageAuto",
    defaultMessage: "Auto-detect",
  }),
  yue: defineMessage({
    id: "dictation.voiceSettingsPage.languageCantonese",
    defaultMessage: "Cantonese (Traditional Chinese)",
  }),
  zh: defineMessage({
    id: "dictation.voiceSettingsPage.languageMandarin",
    defaultMessage: "Mandarin Chinese",
  }),
  "zh-cn": defineMessage({
    id: "dictation.voiceSettingsPage.languageSimplifiedChinese",
    defaultMessage: "Simplified Chinese",
  }),
  "zh-hk": defineMessage({
    id: "dictation.voiceSettingsPage.languageHongKong",
    defaultMessage: "Traditional Chinese (Hong Kong)",
  }),
  "zh-tw": defineMessage({
    id: "dictation.voiceSettingsPage.languageTaiwan",
    defaultMessage: "Traditional Chinese (Taiwan)",
  }),
};

const languageOptions = (intl: IntlShape): Array<{ value: string; label: string }> => {
  const names = new Intl.DisplayNames(intl.locale, { type: "language" });
  const originalNames = new Intl.DisplayNames(undefined, { type: "language" });
  const collator = new Intl.Collator(intl.locale, { sensitivity: "base" });
  const seen = new Set<string>();
  return DICTATION_VOICE_LANGUAGES.flatMap((value) => {
    const override = LANGUAGE_OVERRIDES[value];
    const originalLabel = override?.defaultMessage ?? originalNames.of(value) ?? value;
    if (seen.has(originalLabel)) return [];
    seen.add(originalLabel);
    const label = override ? intl.formatMessage(override) : (names.of(value) ?? value);
    return [{ value, label }];
  }).sort(
    (left, right) =>
      Number(left.value !== "auto") - Number(right.value !== "auto") ||
      collator.compare(left.label, right.label),
  );
};

const formatRecordingTimestamp = (createdAtMs: number, intl: IntlShape): string =>
  intl.formatDate(createdAtMs, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const recordingFallbackLabel = (
  status: "recording" | "completed" | "cancelled" | "interrupted",
  intl: IntlShape,
): string => {
  if (status === "recording")
    return intl.formatMessage({
      id: "dictation.voiceSettingsPage.recording",
      defaultMessage: "Recording…",
    });
  if (status === "cancelled")
    return intl.formatMessage({
      id: "dictation.voiceSettingsPage.recordingCancelled",
      defaultMessage: "Recording cancelled",
    });
  if (status === "interrupted")
    return intl.formatMessage({
      id: "dictation.voiceSettingsPage.recordingInterrupted",
      defaultMessage: "Recording interrupted",
    });
  return intl.formatMessage({
    id: "dictation.voiceSettingsPage.recordingSaved",
    defaultMessage: "Recording saved",
  });
};

const deviceOptions = (
  devices: readonly MediaDeviceInfo[],
  selectedId: string | null,
  intl: IntlShape,
): Array<{ value: string; label: string }> => {
  const inputs = devices.filter(
    (device) =>
      device.kind === "audioinput" && device.deviceId.length > 0 && device.deviceId !== "default",
  );
  const options = [
    {
      value: "",
      label: intl.formatMessage({
        id: "dictation.voiceSettingsPage.systemDefault",
        defaultMessage: "System default",
      }),
    },
    ...inputs.map((device, index) => ({
      value: device.deviceId,
      label:
        device.label.trim() ||
        intl.formatMessage(
          {
            id: "dictation.voiceSettingsPage.microphoneNumber",
            defaultMessage: "Microphone {number}",
          },
          { number: index + 1 },
        ),
    })),
  ];
  if (selectedId && !inputs.some((device) => device.deviceId === selectedId)) {
    options.push({
      value: selectedId,
      label:
        inputs.length === 0
          ? intl.formatMessage({
              id: "dictation.voiceSettingsPage.selectedMicrophone",
              defaultMessage: "Selected microphone",
            })
          : intl.formatMessage({
              id: "dictation.voiceSettingsPage.unavailableMicrophone",
              defaultMessage: "Unavailable microphone",
            }),
    });
  }
  return options;
};

export function VoiceSettingsPage({
  recordingId: requestedRecordingId,
  path = "/settings/voice",
}: {
  readonly onPathChange: (path: string) => void;
  readonly recordingId?: string;
  readonly path?: string;
}) {
  const intl = useIntl();
  const recordingId =
    requestedRecordingId ??
    new URL(path, "http://nodex.local").searchParams.get("recording") ??
    undefined;
  const queryClient = useQueryClient();
  const accountGenerationRef = useRef(0);
  const commandKeymapQuery = useCommandKeymapState();
  const settingsQuery = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: readDictationSettings,
  });
  const historyQuery = useQuery({
    queryKey: HISTORY_QUERY_KEY,
    queryFn: listDictationRecordings,
  });
  const capabilityQuery = useQuery({
    queryKey: CAPABILITY_QUERY_KEY,
    queryFn: readDictationCapabilityState,
  });
  const needsCodex = capabilityQuery.data?.componentUnavailableReason !== undefined;
  const requirementDescription = useAppComponentRequirementDescription("codex");
  const hasDictation =
    capabilityQuery.data?.capabilities.composer === true ||
    capabilityQuery.data?.capabilities.global === true;
  // Capture policy can change without removing the platform's configurable shortcuts.
  const globalShortcutEntries = (["globalDictationHold", "globalDictationToggle"] as const)
    .map((commandId) =>
      commandKeymapQuery.data?.entries.find((entry) => entry.id === commandId && entry.available),
    )
    .filter((entry) => entry !== undefined);
  const canConfigureGlobalDictation = globalShortcutEntries.length > 0;
  const primaryShortcutEntry = globalShortcutEntries.find(
    (entry) => entry.id === "globalDictationHold",
  );
  const singleTapShortcutEntry = globalShortcutEntries.find(
    (entry) => entry.id === "globalDictationToggle",
  );
  const hasDictationSettings =
    capabilityQuery.data?.capabilities.sounds === true || canConfigureGlobalDictation;
  const hasHistory = capabilityQuery.data?.capabilities.history === true;
  const canTranscribeRecordings = capabilityQuery.data?.capabilities.auth === "chatgpt";
  const languageQuery = useQuery({
    queryKey: LANGUAGE_QUERY_KEY,
    queryFn: async ({ signal }) => {
      const language = await readDictationVoiceLanguage();
      signal.throwIfAborted();
      return language;
    },
    enabled: hasDictation,
    staleTime: 60_000,
    refetchOnWindowFocus: "always",
  });
  const updateLanguage = useMutation({
    mutationFn: updateDictationVoiceLanguage,
    onMutate: () => accountGenerationRef.current,
    onSuccess: (language, _input, generation) => {
      if (generation === accountGenerationRef.current)
        queryClient.setQueryData(LANGUAGE_QUERY_KEY, language);
    },
    onError: () =>
      toast.danger(
        getIntl().formatMessage({
          id: "dictation.voiceSettingsPage.updateLanguageFailed",
          defaultMessage: "Could not update voice language",
        }),
      ),
  });
  const microphoneSelectionAvailable =
    typeof navigator.mediaDevices?.enumerateDevices === "function";
  const devicesQuery = useQuery({
    queryKey: ["dictation", "microphone-devices"],
    queryFn: () => navigator.mediaDevices.enumerateDevices(),
    enabled: microphoneSelectionAvailable,
    staleTime: 5_000,
  });
  const [shortcutCapture, setShortcutCapture] = useState<{
    readonly commandId: string;
    readonly conflict: string | null;
  } | null>(null);
  const [shortcutErrors, setShortcutErrors] = useState<Record<string, string>>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [dictionaryOpen, setDictionaryOpen] = useState(false);
  const [dictionaryDraft, setDictionaryDraft] = useState<readonly string[] | null>(null);
  const [historyAction, setHistoryAction] = useState<string | null>(null);
  const historyTaskRef = useRef<AbortController | null>(null);
  const suppressNextDictionaryBlurRef = useRef(false);
  const selectedRecordingRef = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      subscribeDictationSettingsUpdates((event) => {
        if (event.type === "capabilities") {
          if (event.state.capabilities.auth !== "chatgpt") historyTaskRef.current?.abort();
          void queryClient
            .cancelQueries({ queryKey: CAPABILITY_QUERY_KEY })
            .then(() => queryClient.setQueryData(CAPABILITY_QUERY_KEY, event.state));
          return;
        }
        accountGenerationRef.current += 1;
        historyTaskRef.current?.abort();
        setDictionaryOpen(false);
        void queryClient.resetQueries({ queryKey: LANGUAGE_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: CAPABILITY_QUERY_KEY });
      }),
    [queryClient],
  );

  useEffect(() => () => historyTaskRef.current?.abort(), []);

  useEffect(() => {
    if (!recordingId || historyQuery.isPending) return;
    selectedRecordingRef.current?.scrollIntoView({ block: "nearest" });
    selectedRecordingRef.current?.focus({ preventScroll: true });
  }, [recordingId, historyQuery.isPending]);

  const updateSettings = useMutation({
    mutationFn: updateDictationSettings,
    onSuccess: (settings) => queryClient.setQueryData(SETTINGS_QUERY_KEY, settings),
    onError: () =>
      toast.danger(
        getIntl().formatMessage({
          id: "dictation.voiceSettingsPage.saveSettingsFailed",
          defaultMessage: "Could not save Voice settings",
        }),
      ),
  });
  const updateShortcut = useMutation({
    mutationFn: (input: { readonly commandId: string; readonly update: CommandKeybindingUpdate }) =>
      updateCommandKeybinding(input.commandId, input.update),
    onSuccess: async (result) => {
      queryClient.setQueryData(queryKeys.settings.commandKeymap(), result.state);
      if (result.type === "applied") {
        await queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
      }
    },
  });
  const settings: DictationSettings | undefined = settingsQuery.data;
  const commandPlatform = commandKeymapQuery.data?.platform ?? "macOS";
  const dictionaryEntries = (() => {
    const entries = dictionaryDraft ?? settings?.dictionary ?? [];
    return entries.length > 0 ? entries : [EMPTY_DICTIONARY_ENTRY];
  })();

  const commitDictionary = async (entries: readonly string[]): Promise<void> => {
    const dictionary = entries
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 100);
    await updateSettings.mutateAsync({ dictionary });
    setDictionaryDraft(null);
  };

  const commitShortcut = async (
    entry: CommandKeymapEntry,
    accelerator: string | null,
  ): Promise<void> => {
    setShortcutErrors((current) => ({ ...current, [entry.id]: "" }));
    const existing = entry.keybindings[0]?.key ?? null;
    if (accelerator) {
      const validationError = validateGlobalDictationShortcut(accelerator, commandPlatform);
      if (validationError) {
        setShortcutCapture(null);
        setShortcutErrors((current) => ({ ...current, [entry.id]: validationError }));
        return;
      }
      const conflict = commandKeymapQuery.data
        ? findCommandKeybindingConflict(commandKeymapQuery.data, entry.id, accelerator)
        : null;
      if (conflict) {
        setShortcutCapture({ commandId: entry.id, conflict: conflict.commandTitle });
        return;
      }
    }

    setShortcutCapture(null);
    const update: CommandKeybindingUpdate = accelerator
      ? existing
        ? {
            type: "replace",
            oldKeybinding: { key: existing },
            newKeybinding: { key: accelerator },
          }
        : { type: "set", keybinding: { key: accelerator } }
      : existing
        ? { type: "remove", keybinding: { key: existing } }
        : { type: "set", keybinding: { key: null } };
    if (!accelerator && !existing) return;

    try {
      const result = await updateShortcut.mutateAsync({ commandId: entry.id, update });
      if (result.type === "rejected") {
        setShortcutErrors((current) => ({
          ...current,
          [entry.id]: result.reason.message,
        }));
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : getIntl().formatMessage({
              id: "dictation.voiceSettingsPage.updateShortcutFailed",
              defaultMessage: "Could not update shortcut",
            });
      setShortcutErrors((current) => ({
        ...current,
        [entry.id]: message,
      }));
    }
  };

  const renderShortcutSetting = (entry: CommandKeymapEntry, description: string) => {
    const label = intl.formatMessage(commandTitleMessage(entry));
    const error = shortcutErrors[entry.id];
    const accelerator = entry.keybindings[0]?.key ?? null;
    return (
      <NodexSettingsRow
        label={label}
        description={
          <div className="flex flex-col gap-1">
            <span>{description}</span>
            {error ? <span className="text-token-error-foreground">{error}</span> : null}
          </div>
        }
      >
        <HotkeySettingControl
          accelerator={accelerator}
          acceleratorLabel={
            accelerator ? formatAcceleratorLabel(accelerator, commandPlatform) : null
          }
          allowsBareModifiers
          captureAriaLabel={intl.formatMessage(
            {
              id: "dictation.voiceSettingsPage.captureShortcut",
              defaultMessage: "{label} capture",
            },
            { label },
          )}
          captureBareModifierHotkey={captureGlobalDictationBareModifierHotkey}
          conflict={shortcutCapture?.commandId === entry.id ? shortcutCapture.conflict : null}
          disabled={updateShortcut.isPending}
          emptyLabel={intl.formatMessage({
            id: "dictation.voiceSettingsPage.shortcutOff",
            defaultMessage: "Off",
          })}
          hotkeyName={label}
          isCapturing={shortcutCapture?.commandId === entry.id}
          onCancelCapture={() => setShortcutCapture(null)}
          onCapture={(nextAccelerator) => void commitShortcut(entry, nextAccelerator)}
          onClear={() => void commitShortcut(entry, null)}
          onStartCapture={() => {
            setShortcutErrors((current) => ({ ...current, [entry.id]: "" }));
            setShortcutCapture({ commandId: entry.id, conflict: null });
          }}
          platform={commandPlatform}
        />
      </NodexSettingsRow>
    );
  };

  const refreshMicrophones = async (): Promise<void> => {
    await requestMicrophoneAccess();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    await devicesQuery.refetch().finally(() => {
      stream?.getTracks().forEach((track) => track.stop());
    });
  };

  const updateRecording = (recording: DictationRecordingMetadata): void => {
    queryClient.setQueryData<DictationRecordingMetadata[]>(HISTORY_QUERY_KEY, (current = []) =>
      current.some((entry) => entry.id === recording.id)
        ? current.map((entry) => (entry.id === recording.id ? recording : entry))
        : [recording, ...current].slice(0, DICTATION_HISTORY_MAX_RECORDINGS),
    );
  };

  const beginHistoryAction = (action: string): AbortController | null => {
    if (historyTaskRef.current) return null;
    const controller = new AbortController();
    historyTaskRef.current = controller;
    setHistoryAction(action);
    return controller;
  };

  const finishHistoryAction = (controller: AbortController): void => {
    if (historyTaskRef.current !== controller) return;
    historyTaskRef.current = null;
    setHistoryAction(null);
  };

  const transcribeRecording = async (
    id: string,
    signal: AbortSignal,
    source: "file" | "recovery" = "recovery",
  ): Promise<void> => {
    signal.throwIfAborted();
    setHistoryAction(`retry:${id}`);
    const previousAttempt =
      historyQuery.data?.find((recording) => recording.id === id)?.diagnostics?.attempt ?? 0;
    const diagnostics = new DictationDiagnosticsRecorder(
      () => performance.now(),
      "history",
      source,
      previousAttempt + 1,
    );
    let outcome: "completed" | "failed" | "cancelled" = "failed";
    await readDictationRecordingAudio(id)
      .then(async (audio) => {
        signal.throwIfAborted();
        const rawTranscript = await diagnostics.measure("buffered", () =>
          transcribeDictationBlob(
            new Blob([Uint8Array.from(audio.bytes).buffer], { type: audio.recording.mimeType }),
            { filename: audio.recording.fileName, signal, onDiagnostics: diagnostics.request },
          ),
        );
        signal.throwIfAborted();
        recordBufferedTransport(diagnostics);
        const transcript = rawTranscript.trim();
        if (!transcript)
          throw new Error(
            getIntl().formatMessage({
              id: "dictation.voiceSettingsPage.emptyTranscript",
              defaultMessage: "The recording returned an empty transcript",
            }),
          );
        const recording = await diagnostics.measure("history", () =>
          setDictationRecordingTranscript({ id, transcript }),
        );
        updateRecording(recording);
        diagnostics.delivered();
        outcome = "completed";
        if (!signal.aborted)
          toast.success(
            getIntl().formatMessage({
              id: "dictation.voiceSettingsPage.transcribed",
              defaultMessage: "Recording transcribed",
            }),
          );
      })
      .catch(() => {
        if (signal.aborted) outcome = "cancelled";
        else
          toast.danger(
            getIntl().formatMessage({
              id: "dictation.voiceSettingsPage.transcribeFailed",
              defaultMessage: "Could not transcribe this recording",
            }),
          );
      })
      .finally(async () => {
        await setDictationRecordingDiagnostics({
          id,
          diagnostics: diagnostics.snapshot(outcome),
        }).catch(() => undefined);
        await queryClient.invalidateQueries({ queryKey: HISTORY_QUERY_KEY }).catch(() => undefined);
      });
  };

  const retryRecording = async (id: string): Promise<void> => {
    if (!canTranscribeRecordings) return;
    const controller = beginHistoryAction(`retry:${id}`);
    if (!controller) return;
    await transcribeRecording(id, controller.signal).finally(() => finishHistoryAction(controller));
  };

  const importRecording = async (): Promise<void> => {
    if (!canTranscribeRecordings) return;
    const controller = beginHistoryAction("import");
    if (!controller) return;
    await importDictationRecordingFile()
      .then(async (recording) => {
        if (!recording) return;
        await queryClient.cancelQueries({ queryKey: HISTORY_QUERY_KEY });
        updateRecording(recording);
        controller.signal.throwIfAborted();
        await transcribeRecording(recording.id, controller.signal, "file");
      })
      .catch(() => {
        if (!controller.signal.aborted)
          toast.danger(
            getIntl().formatMessage({
              id: "dictation.voiceSettingsPage.importFailed",
              defaultMessage: "Could not import this WebM file",
            }),
          );
      })
      .finally(() => finishHistoryAction(controller));
  };

  const downloadRecording = async (id: string): Promise<void> => {
    const controller = beginHistoryAction(`download:${id}`);
    if (!controller) return;
    await downloadDictationRecording(id)
      .catch(() => {
        toast.danger(
          getIntl().formatMessage({
            id: "dictation.voiceSettingsPage.downloadFailed",
            defaultMessage: "Could not download this recording",
          }),
        );
      })
      .finally(() => finishHistoryAction(controller));
  };

  const removeRecording = async (id: string): Promise<void> => {
    const controller = beginHistoryAction(`delete:${id}`);
    if (!controller) return;
    await deleteDictationRecording(id)
      .then(() => queryClient.invalidateQueries({ queryKey: HISTORY_QUERY_KEY }))
      .catch(() => {
        toast.danger(
          getIntl().formatMessage({
            id: "dictation.voiceSettingsPage.deleteFailed",
            defaultMessage: "Could not delete this recording",
          }),
        );
      })
      .finally(() => finishHistoryAction(controller));
  };

  const microphoneInputDeviceId = settings?.microphoneInputDeviceId ?? null;
  const microphoneOptions = deviceOptions(devicesQuery.data ?? [], microphoneInputDeviceId, intl);
  const microphoneValue = microphoneInputDeviceId ?? "";
  const selectedMicrophone = microphoneOptions.find((option) => option.value === microphoneValue);

  return (
    <NodexSettingsPageSurface
      title={intl.formatMessage({
        id: "dictation.voiceSettingsPage.title",
        defaultMessage: "Voice",
      })}
      subtitle={intl.formatMessage(settingsMessages.voiceSearchSubtitle)}
    >
      <NodexSettingsSection
        title={intl.formatMessage({
          id: "dictation.voiceSettingsPage.general",
          defaultMessage: "General",
        })}
      >
        <NodexSettingsRow
          label={intl.formatMessage({
            id: "dictation.voiceSettingsPage.microphone",
            defaultMessage: "Microphone",
          })}
          description={
            microphoneSelectionAvailable
              ? intl.formatMessage({
                  id: "dictation.voiceSettingsPage.microphoneDescription",
                  defaultMessage: "Used for voice chat and dictation",
                })
              : intl.formatMessage({
                  id: "dictation.voiceSettingsPage.microphoneUnavailable",
                  defaultMessage: "Microphone selection is not available on this device",
                })
          }
        >
          <NodexDropdownMenu
            align="end"
            contentWidth="sm"
            disabled={!microphoneSelectionAvailable || !settings}
            onOpenChange={(open) => {
              if (open) void refreshMicrophones().catch(() => undefined);
            }}
            triggerButton={
              <NodexSettingsDropdownTrigger>
                <span className="truncate">{selectedMicrophone?.label}</span>
              </NodexSettingsDropdownTrigger>
            }
          >
            {microphoneOptions
              .filter(
                (option) =>
                  option.value !== microphoneInputDeviceId ||
                  (devicesQuery.data ?? []).some((device) => device.deviceId === option.value),
              )
              .map((option) => (
                <NodexDropdownItem
                  key={option.value}
                  onSelect={() =>
                    updateSettings.mutate({ microphoneInputDeviceId: option.value || null })
                  }
                  rightSlot={
                    option.value === microphoneValue ? <NodexDropdownSelectedIcon /> : null
                  }
                >
                  {option.label}
                </NodexDropdownItem>
              ))}
            {devicesQuery.isFetching ? (
              <div className="px-2 py-1 text-xs text-token-text-tertiary">
                {intl.formatMessage({
                  id: "dictation.voiceSettingsPage.loadingMicrophones",
                  defaultMessage: "Loading microphones…",
                })}
              </div>
            ) : devicesQuery.isError ? (
              <div className="px-2 py-1 text-xs text-token-text-tertiary">
                {intl.formatMessage({
                  id: "dictation.voiceSettingsPage.loadMicrophonesFailed",
                  defaultMessage: "Could not load microphones",
                })}
              </div>
            ) : (devicesQuery.data ?? []).filter(
                (device) =>
                  device.kind === "audioinput" && device.deviceId && device.deviceId !== "default",
              ).length === 0 ? (
              <div className="px-2 py-1 text-xs text-token-text-tertiary">
                {intl.formatMessage({
                  id: "dictation.voiceSettingsPage.noMicrophones",
                  defaultMessage: "No microphones found",
                })}
              </div>
            ) : null}
          </NodexDropdownMenu>
        </NodexSettingsRow>
        {needsCodex ? (
          <NodexSettingsRow
            label={intl.formatMessage({
              id: "dictation.voiceSettingsPage.dictation",
              defaultMessage: "Dictation",
            })}
            description={requirementDescription}
          >
            <AppComponentRequirement
              id="codex"
              onInstalled={() => void capabilityQuery.refetch()}
            />
          </NodexSettingsRow>
        ) : hasDictation ? (
          <NodexSettingsRow
            label={intl.formatMessage({
              id: "dictation.voiceSettingsPage.language",
              defaultMessage: "Language",
            })}
          >
            {languageQuery.isError && languageQuery.data === undefined ? (
              <NodexButton
                size="toolbar"
                variant="secondary"
                onClick={() => void languageQuery.refetch()}
              >
                {intl.formatMessage({
                  id: "dictation.voiceSettingsPage.retry",
                  defaultMessage: "Retry",
                })}
              </NodexButton>
            ) : languageQuery.data === undefined ? (
              <NodexButton size="toolbar" variant="secondary" disabled>
                {intl.formatMessage({
                  id: "dictation.voiceSettingsPage.loading",
                  defaultMessage: "Loading…",
                })}
              </NodexButton>
            ) : (
              <ConfigValueDropdown
                value={languageQuery.data}
                options={languageOptions(intl)}
                disabled={updateLanguage.isPending}
                onSelect={(language) => updateLanguage.mutate(language)}
              />
            )}
          </NodexSettingsRow>
        ) : null}
      </NodexSettingsSection>

      {hasDictationSettings ? (
        <NodexSettingsSection
          title={intl.formatMessage({
            id: "dictation.voiceSettingsPage.dictation",
            defaultMessage: "Dictation",
          })}
        >
          {capabilityQuery.data?.capabilities.sounds ? (
            <NodexSettingsRow
              label={intl.formatMessage({
                id: "dictation.voiceSettingsPage.sounds",
                defaultMessage: "Dictation sounds",
              })}
              description={intl.formatMessage({
                id: "dictation.voiceSettingsPage.soundsDescription",
                defaultMessage: "Play sounds when dictation starts and stops",
              })}
            >
              <TogglePill
                ariaLabel={intl.formatMessage({
                  id: "dictation.voiceSettingsPage.toggleSounds",
                  defaultMessage: "Toggle dictation sounds",
                })}
                value={settings?.dictationSoundsEnabled ?? true}
                disabled={!settings || updateSettings.isPending}
                onChange={(value) => updateSettings.mutate({ dictationSoundsEnabled: value })}
              />
            </NodexSettingsRow>
          ) : null}
          {canConfigureGlobalDictation && primaryShortcutEntry
            ? renderShortcutSetting(
                primaryShortcutEntry,
                intl.formatMessage({
                  id: "dictation.voiceSettingsPage.holdShortcutDescription",
                  defaultMessage: "Hold to dictate, or double-tap for hands-free",
                }),
              )
            : null}
        </NodexSettingsSection>
      ) : null}

      {canConfigureGlobalDictation && singleTapShortcutEntry ? (
        <NodexSettingsSection
          title={intl.formatMessage({
            id: "dictation.voiceSettingsPage.advanced",
            defaultMessage: "Advanced",
          })}
          disclosureHeading="quiet"
          disclosure={{
            open: advancedOpen,
            onOpenChange: (open) => {
              if (!open && shortcutCapture?.commandId === singleTapShortcutEntry.id) {
                setShortcutCapture(null);
              }
              setAdvancedOpen(open);
            },
          }}
        >
          {advancedOpen
            ? renderShortcutSetting(
                singleTapShortcutEntry,
                intl.formatMessage({
                  id: "dictation.voiceSettingsPage.toggleShortcutDescription",
                  defaultMessage: "Press once to start, and again to finish",
                }),
              )
            : null}
        </NodexSettingsSection>
      ) : null}

      {capabilityQuery.data?.capabilities.voiceDictionary ? (
        <NodexSettingsSection>
          <NodexSettingsRow
            label={intl.formatMessage({
              id: "dictation.voiceSettingsPage.voiceDictionary",
              defaultMessage: "Voice dictionary",
            })}
            description={intl.formatMessage({
              id: "dictation.voiceSettingsPage.voiceDictionaryDescription",
              defaultMessage: "Words to recognize in your speech",
            })}
          >
            <NodexButton size="toolbar" variant="secondary" onClick={() => setDictionaryOpen(true)}>
              {intl.formatMessage({
                id: "dictation.voiceSettingsPage.manageDictionary",
                defaultMessage: "Manage",
              })}
            </NodexButton>
          </NodexSettingsRow>
        </NodexSettingsSection>
      ) : canConfigureGlobalDictation ? (
        <NodexSettingsSection>
          <NodexSettingsRow
            label={intl.formatMessage({
              id: "dictation.voiceSettingsPage.dictationDictionary",
              defaultMessage: "Dictation dictionary",
            })}
            description={intl.formatMessage({
              id: "dictation.voiceSettingsPage.dictationDictionaryDescription",
              defaultMessage: "Words or phrases dictation should recognize",
            })}
          >
            <NodexButton
              size="toolbar"
              variant="secondary"
              disabled={
                updateSettings.isPending || dictionaryEntries.length >= MAX_DICTIONARY_ENTRIES
              }
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const nextIndex = dictionaryEntries.length;
                setDictionaryDraft([...dictionaryEntries, EMPTY_DICTIONARY_ENTRY]);
                requestAnimationFrame(() => {
                  document
                    .querySelector<HTMLInputElement>(
                      `[data-dictation-dictionary-entry-index="${nextIndex}"]`,
                    )
                    ?.focus();
                });
              }}
            >
              <PlusIcon className="icon-2xs" />
              {intl.formatMessage({
                id: "dictation.voiceSettingsPage.addEntry",
                defaultMessage: "Add entry",
              })}
            </NodexButton>
          </NodexSettingsRow>
          {dictionaryEntries.map((entry, index) => (
            <div key={index} className="flex w-full items-center gap-2 px-4 py-2">
              <Input
                variant="settings"
                data-dictation-dictionary-entry-index={index}
                aria-label={intl.formatMessage(
                  {
                    id: "dictation.voiceSettingsPage.entryLabel",
                    defaultMessage: "Dictionary entry {number}",
                  },
                  { number: index + 1 },
                )}
                placeholder={DICTIONARY_PLACEHOLDERS[index] ?? DICTIONARY_PLACEHOLDERS[0] ?? ""}
                value={entry}
                disabled={updateSettings.isPending}
                onChange={(event) => {
                  const next = [...dictionaryEntries];
                  next[index] = event.currentTarget.value;
                  setDictionaryDraft(next);
                }}
                onBlur={() => {
                  if (suppressNextDictionaryBlurRef.current) {
                    suppressNextDictionaryBlurRef.current = false;
                    return;
                  }
                  void commitDictionary(dictionaryEntries);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || dictionaryEntries.length >= MAX_DICTIONARY_ENTRIES) {
                    return;
                  }
                  event.preventDefault();
                  const next = [
                    ...dictionaryEntries.slice(0, index + 1),
                    EMPTY_DICTIONARY_ENTRY,
                    ...dictionaryEntries.slice(index + 1),
                  ];
                  suppressNextDictionaryBlurRef.current = true;
                  setDictionaryDraft(next);
                  requestAnimationFrame(() => {
                    document
                      .querySelector<HTMLInputElement>(
                        `[data-dictation-dictionary-entry-index="${index + 1}"]`,
                      )
                      ?.focus();
                  });
                }}
                className="h-9 flex-1 rounded-lg px-3 text-sm"
              />
              <NodexButton
                aria-label={intl.formatMessage(
                  {
                    id: "dictation.voiceSettingsPage.removeEntry",
                    defaultMessage: "Remove dictionary entry {number}",
                  },
                  { number: index + 1 },
                )}
                size="icon-sm"
                variant="ghost"
                disabled={
                  updateSettings.isPending || (dictionaryEntries.length === 1 && entry.length === 0)
                }
                className="text-token-text-tertiary hover:text-token-text-primary"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  void commitDictionary(
                    dictionaryEntries.filter((_, entryIndex) => entryIndex !== index),
                  );
                }}
              >
                <DeleteIcon className="icon-2xs" />
              </NodexButton>
            </div>
          ))}
        </NodexSettingsSection>
      ) : null}

      {hasHistory ? (
        <NodexSettingsSection>
          <NodexSettingsRow
            label={intl.formatMessage({
              id: "dictation.voiceSettingsPage.recentRecordings",
              defaultMessage: "Recent recordings",
            })}
            description={intl.formatMessage({
              id: "dictation.voiceSettingsPage.historyDescription",
              defaultMessage: "Your last 20 recordings are saved on this device",
            })}
          >
            <NodexTooltip
              tooltipContent={
                canTranscribeRecordings
                  ? intl.formatMessage({
                      id: "dictation.voiceSettingsPage.importLimit",
                      defaultMessage: "Choose a WebM file up to 64 MiB",
                    })
                  : intl.formatMessage({
                      id: "dictation.voiceSettingsPage.signInToTranscribe",
                      defaultMessage: "Sign in with ChatGPT to transcribe audio",
                    })
              }
            >
              <NodexButton
                size="toolbar"
                variant="secondary"
                disabled={historyAction !== null || !canTranscribeRecordings}
                onClick={() => void importRecording()}
              >
                {intl.formatMessage({
                  id: "dictation.voiceSettingsPage.transcribeWebm",
                  defaultMessage: "Transcribe WebM…",
                })}
              </NodexButton>
            </NodexTooltip>
          </NodexSettingsRow>
          {historyQuery.isLoading ? (
            <div className="px-4 py-3 text-sm text-token-text-secondary">
              {intl.formatMessage({
                id: "dictation.voiceSettingsPage.loadingRecordings",
                defaultMessage: "Loading recordings…",
              })}
            </div>
          ) : historyQuery.data?.length ? (
            historyQuery.data.map((recording) => (
              <div
                key={recording.id}
                ref={recording.id === recordingId ? selectedRecordingRef : undefined}
                tabIndex={recording.id === recordingId ? -1 : undefined}
                className={
                  recording.id === recordingId ? "bg-token-list-hover-background" : undefined
                }
              >
                <NodexSettingsRow
                  label={
                    historyAction === `retry:${recording.id}`
                      ? intl.formatMessage({
                          id: "dictation.voiceSettingsPage.transcribing",
                          defaultMessage: "Transcribing…",
                        })
                      : recording.transcript?.trim() ||
                        recordingFallbackLabel(recording.status, intl)
                  }
                  description={
                    recording.fileName
                      ? `${recording.fileName} · ${formatRecordingTimestamp(recording.createdAtMs, intl)}`
                      : formatRecordingTimestamp(recording.createdAtMs, intl)
                  }
                  className="items-start whitespace-pre-wrap break-words"
                >
                  {recording.transcript ? (
                    <NodexButton
                      aria-label={intl.formatMessage({
                        id: "dictation.voiceSettingsPage.copyTranscript",
                        defaultMessage: "Copy transcript",
                      })}
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => void navigator.clipboard.writeText(recording.transcript ?? "")}
                    >
                      <CopyIcon className="icon-2xs" />
                    </NodexButton>
                  ) : recording.status !== "recording" && recording.sizeBytes > 0 ? (
                    <NodexButton
                      size="toolbar"
                      variant="secondary"
                      disabled={historyAction !== null || !canTranscribeRecordings}
                      onClick={() => void retryRecording(recording.id)}
                    >
                      {intl.formatMessage({
                        id: "dictation.voiceSettingsPage.retry",
                        defaultMessage: "Retry",
                      })}
                    </NodexButton>
                  ) : null}
                  {recording.sizeBytes > 0 || recording.status !== "recording" ? (
                    <NodexDropdownMenu
                      align="end"
                      disabled={historyAction !== null}
                      triggerButton={
                        <NodexButton
                          aria-label={intl.formatMessage({
                            id: "dictation.voiceSettingsPage.recordingActions",
                            defaultMessage: "Recording actions",
                          })}
                          size="icon-xs"
                          variant="ghost"
                        >
                          <MoreActionsIcon className="icon-2xs" />
                        </NodexButton>
                      }
                    >
                      {recording.sizeBytes > 0 ? (
                        <NodexDropdownItem
                          leftSlot={<DownloadIcon className="icon-xs" />}
                          onSelect={() => void downloadRecording(recording.id)}
                        >
                          {intl.formatMessage({
                            id: "dictation.voiceSettingsPage.downloadRecording",
                            defaultMessage: "Download recording",
                          })}
                        </NodexDropdownItem>
                      ) : null}
                      {recording.status !== "recording" ? (
                        <>
                          {recording.sizeBytes > 0 ? <NodexDropdownSeparator /> : null}
                          <NodexDropdownItem
                            tone="danger"
                            leftSlot={<DeleteIcon className="icon-xs" />}
                            onSelect={() => void removeRecording(recording.id)}
                          >
                            {intl.formatMessage({
                              id: "dictation.voiceSettingsPage.deleteRecording",
                              defaultMessage: "Delete recording",
                            })}
                          </NodexDropdownItem>
                        </>
                      ) : null}
                    </NodexDropdownMenu>
                  ) : null}
                </NodexSettingsRow>
                <DictationPerformanceDetails diagnostics={recording.diagnostics} />
              </div>
            ))
          ) : (
            <div className="px-4 py-3 text-sm text-token-text-secondary">
              {intl.formatMessage({
                id: "dictation.voiceSettingsPage.noRecordings",
                defaultMessage: "No recordings yet.",
              })}
            </div>
          )}
        </NodexSettingsSection>
      ) : null}
      {dictionaryOpen && capabilityQuery.data?.capabilities.voiceDictionary ? (
        <Suspense fallback={null}>
          <DictationDictionaryDialog onClose={() => setDictionaryOpen(false)} />
        </Suspense>
      ) : null}
    </NodexSettingsPageSurface>
  );
}

function recordBufferedTransport(diagnostics: DictationDiagnosticsRecorder): void {
  diagnostics.useTransport("buffered");
}
