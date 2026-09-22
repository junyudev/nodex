import { DictationPerformanceDetails } from "./dictation-performance-details";
import { DictationDiagnosticsRecorder } from "./dictation-diagnostics-recorder";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NodexButton } from "@/components/ui/button";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSelectedIcon,
  NodexSettingsDropdownTrigger,
} from "@/components/ui/dropdown";
import { HotkeySettingControl } from "@/components/ui/hotkey-setting-control";
import { Input } from "@/components/ui/input";
import {
  NodexSettingsPageSurface,
  NodexSettingsRow,
  NodexSettingsSection,
} from "@/components/ui/settings";
import { ConfigValueDropdown } from "@/components/workbench/config-value-dropdown";
import { TogglePill } from "@/components/workbench/workbench-settings-route-shell";
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
import { DICTATION_VOICE_LANGUAGES } from "../../../shared/dictation";
import {
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

const languageOptions = (): Array<{ value: string; label: string }> => {
  const names = new Intl.DisplayNames(undefined, { type: "language" });
  const collator = new Intl.Collator(undefined, { sensitivity: "base" });
  const overrides: Record<string, string> = {
    auto: "Auto-detect",
    yue: "Cantonese (Traditional Chinese)",
    zh: "Mandarin Chinese",
    "zh-cn": "Simplified Chinese",
    "zh-hk": "Traditional Chinese (Hong Kong)",
    "zh-tw": "Traditional Chinese (Taiwan)",
  };
  const seen = new Set<string>();
  return DICTATION_VOICE_LANGUAGES.flatMap((value) => {
    const label = overrides[value] ?? names.of(value) ?? value;
    if (seen.has(label)) return [];
    seen.add(label);
    return [{ value, label }];
  }).sort(
    (left, right) =>
      Number(left.value !== "auto") - Number(right.value !== "auto") ||
      collator.compare(left.label, right.label),
  );
};

const formatRecordingTimestamp = (createdAtMs: number): string =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(createdAtMs));

const recordingFallbackLabel = (
  status: "recording" | "completed" | "cancelled" | "interrupted",
): string => {
  if (status === "recording") return "Recording…";
  if (status === "cancelled") return "Recording cancelled";
  if (status === "interrupted") return "Recording interrupted";
  return "Recording saved";
};

const deviceOptions = (
  devices: readonly MediaDeviceInfo[],
  selectedId: string | null,
): Array<{ value: string; label: string }> => {
  const inputs = devices.filter(
    (device) =>
      device.kind === "audioinput" && device.deviceId.length > 0 && device.deviceId !== "default",
  );
  const options = [
    { value: "", label: "System default" },
    ...inputs.map((device, index) => ({
      value: device.deviceId,
      label: device.label.trim() || `Microphone ${index + 1}`,
    })),
  ];
  if (selectedId && !inputs.some((device) => device.deviceId === selectedId)) {
    options.push({
      value: selectedId,
      label: inputs.length === 0 ? "Selected microphone" : "Unavailable microphone",
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
  const hasDictation =
    capabilityQuery.data?.capabilities.composer === true ||
    capabilityQuery.data?.capabilities.global === true;
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
    onError: () => toast.danger("Could not update voice language"),
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
  const [dictionaryOpen, setDictionaryOpen] = useState(false);
  const [dictionaryDraft, setDictionaryDraft] = useState<readonly string[] | null>(null);
  const [historyAction, setHistoryAction] = useState<string | null>(null);
  const suppressNextDictionaryBlurRef = useRef(false);
  const selectedRecordingRef = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      subscribeDictationSettingsUpdates((event) => {
        if (event.type === "capabilities") {
          void queryClient
            .cancelQueries({ queryKey: CAPABILITY_QUERY_KEY })
            .then(() => queryClient.setQueryData(CAPABILITY_QUERY_KEY, event.state));
          return;
        }
        accountGenerationRef.current += 1;
        setDictionaryOpen(false);
        void queryClient.resetQueries({ queryKey: LANGUAGE_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: CAPABILITY_QUERY_KEY });
      }),
    [queryClient],
  );

  useEffect(() => {
    if (!recordingId || historyQuery.isPending) return;
    selectedRecordingRef.current?.scrollIntoView({ block: "nearest" });
    selectedRecordingRef.current?.focus({ preventScroll: true });
  }, [recordingId, historyQuery.isPending]);

  const updateSettings = useMutation({
    mutationFn: updateDictationSettings,
    onSuccess: (settings) => queryClient.setQueryData(SETTINGS_QUERY_KEY, settings),
    onError: () => toast.danger("Could not save Voice settings"),
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
      setShortcutErrors((current) => ({
        ...current,
        [entry.id]: error instanceof Error ? error.message : "Could not update shortcut",
      }));
    }
  };

  const refreshMicrophones = async (): Promise<void> => {
    await requestMicrophoneAccess();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    try {
      await devicesQuery.refetch();
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
    }
  };

  const retryRecording = async (id: string): Promise<void> => {
    setHistoryAction(`retry:${id}`);
    const previousAttempt =
      historyQuery.data?.find((recording) => recording.id === id)?.diagnostics?.attempt ?? 0;
    const diagnostics = new DictationDiagnosticsRecorder(
      () => performance.now(),
      "history",
      "recovery",
      previousAttempt + 1,
    );
    let outcome: "completed" | "failed" = "failed";
    try {
      const audio = await readDictationRecordingAudio(id);
      const rawTranscript = await diagnostics.measure("buffered", () =>
        transcribeDictationBlob(
          new Blob([Uint8Array.from(audio.bytes).buffer], { type: audio.recording.mimeType }),
          { onDiagnostics: diagnostics.request },
        ),
      );
      diagnostics.useTransport("buffered");
      const transcript = rawTranscript.trim();
      if (!transcript) throw new Error("The recording returned an empty transcript");
      await diagnostics.measure("history", () =>
        setDictationRecordingTranscript({ id, transcript }),
      );
      diagnostics.delivered();
      outcome = "completed";
      toast.success("Recording transcribed");
    } catch {
      toast.danger("Could not transcribe this recording");
    } finally {
      await setDictationRecordingDiagnostics({
        id,
        diagnostics: diagnostics.snapshot(outcome),
      }).catch(() => undefined);
      await queryClient.invalidateQueries({ queryKey: HISTORY_QUERY_KEY });
      setHistoryAction(null);
    }
  };

  const downloadRecording = async (id: string): Promise<void> => {
    setHistoryAction(`download:${id}`);
    try {
      await downloadDictationRecording(id);
    } catch {
      toast.danger("Could not download this recording");
    } finally {
      setHistoryAction(null);
    }
  };

  const removeRecording = async (id: string): Promise<void> => {
    setHistoryAction(`delete:${id}`);
    try {
      await deleteDictationRecording(id);
      await queryClient.invalidateQueries({ queryKey: HISTORY_QUERY_KEY });
    } catch {
      toast.danger("Could not delete this recording");
    } finally {
      setHistoryAction(null);
    }
  };

  return (
    <NodexSettingsPageSurface title="Voice">
      <NodexSettingsSection title="General">
        <NodexSettingsRow
          label="Microphone"
          description={
            microphoneSelectionAvailable
              ? "Used for voice chat and dictation"
              : "Microphone selection is not available on this device"
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
                <span className="truncate">
                  {
                    deviceOptions(
                      devicesQuery.data ?? [],
                      settings?.microphoneInputDeviceId ?? null,
                    ).find((option) => option.value === (settings?.microphoneInputDeviceId ?? ""))
                      ?.label
                  }
                </span>
              </NodexSettingsDropdownTrigger>
            }
          >
            {deviceOptions(devicesQuery.data ?? [], settings?.microphoneInputDeviceId ?? null)
              .filter(
                (option) =>
                  option.value !== settings?.microphoneInputDeviceId ||
                  (devicesQuery.data ?? []).some((device) => device.deviceId === option.value),
              )
              .map((option) => (
                <NodexDropdownItem
                  key={option.value}
                  onSelect={() =>
                    updateSettings.mutate({ microphoneInputDeviceId: option.value || null })
                  }
                  rightSlot={
                    option.value === (settings?.microphoneInputDeviceId ?? "") ? (
                      <NodexDropdownSelectedIcon />
                    ) : null
                  }
                >
                  {option.label}
                </NodexDropdownItem>
              ))}
            {devicesQuery.isFetching ? (
              <div className="px-2 py-1 text-xs text-token-text-tertiary">Loading microphones…</div>
            ) : devicesQuery.isError ? (
              <div className="px-2 py-1 text-xs text-token-text-tertiary">
                Could not load microphones
              </div>
            ) : (devicesQuery.data ?? []).filter(
                (device) =>
                  device.kind === "audioinput" && device.deviceId && device.deviceId !== "default",
              ).length === 0 ? (
              <div className="px-2 py-1 text-xs text-token-text-tertiary">No microphones found</div>
            ) : null}
          </NodexDropdownMenu>
        </NodexSettingsRow>
        {hasDictation ? (
          <NodexSettingsRow label="Language">
            {languageQuery.isError && languageQuery.data === undefined ? (
              <NodexButton
                size="xs"
                variant="secondary"
                onClick={() => void languageQuery.refetch()}
              >
                Retry
              </NodexButton>
            ) : languageQuery.data === undefined ? (
              <NodexButton size="xs" variant="secondary" disabled>
                Loading…
              </NodexButton>
            ) : (
              <ConfigValueDropdown
                value={languageQuery.data}
                options={languageOptions()}
                disabled={updateLanguage.isPending}
                onSelect={(language) => updateLanguage.mutate(language)}
              />
            )}
          </NodexSettingsRow>
        ) : null}
      </NodexSettingsSection>

      {hasDictation ? (
        <NodexSettingsSection title="Dictation">
          {capabilityQuery.data?.capabilities.sounds ? (
            <NodexSettingsRow
              label="Dictation sounds"
              description="Play sounds when dictation starts and stops"
            >
              <TogglePill
                ariaLabel="Toggle dictation sounds"
                value={settings?.dictationSoundsEnabled ?? true}
                disabled={!settings || updateSettings.isPending}
                onChange={(value) => updateSettings.mutate({ dictationSoundsEnabled: value })}
              />
            </NodexSettingsRow>
          ) : null}
          {(capabilityQuery.data?.capabilities.global
            ? (["globalDictationHold", "globalDictationToggle"] as const)
            : []
          ).map((commandId) => {
            const entry = commandKeymapQuery.data?.entries.find(
              (candidate) => candidate.id === commandId,
            );
            if (!entry) return null;
            const isToggle = commandId === "globalDictationToggle";
            const description = isToggle
              ? "Double-tap anywhere on desktop to dictate, then press again to stop"
              : "Hold anywhere on desktop to dictate where your cursor is";
            const error = shortcutErrors[commandId];
            const accelerator = entry.keybindings[0]?.key ?? null;
            return (
              <NodexSettingsRow
                key={commandId}
                label={isToggle ? "Hands-free dictation hotkey" : "Hold-to-dictate hotkey"}
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
                  captureAriaLabel={
                    isToggle
                      ? "Hands-free dictation hotkey capture"
                      : "Hold-to-dictate hotkey capture"
                  }
                  captureBareModifierHotkey={captureGlobalDictationBareModifierHotkey}
                  conflict={
                    shortcutCapture?.commandId === commandId ? shortcutCapture.conflict : null
                  }
                  disabled={updateShortcut.isPending}
                  emptyLabel="Off"
                  hotkeyName={isToggle ? "Hands-free dictation hotkey" : "Hold-to-dictate hotkey"}
                  isCapturing={shortcutCapture?.commandId === commandId}
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
          })}
        </NodexSettingsSection>
      ) : null}

      {capabilityQuery.data?.capabilities.voiceDictionary ? (
        <NodexSettingsSection>
          <NodexSettingsRow
            label="Voice dictionary"
            description="Words to recognize in your speech"
          >
            <NodexButton size="xs" variant="secondary" onClick={() => setDictionaryOpen(true)}>
              Manage
            </NodexButton>
          </NodexSettingsRow>
        </NodexSettingsSection>
      ) : capabilityQuery.data?.capabilities.global ? (
        <NodexSettingsSection>
          <NodexSettingsRow
            label="Dictation dictionary"
            description="Words or phrases dictation should recognize"
          >
            <NodexButton
              size="sm"
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
              Add entry
            </NodexButton>
          </NodexSettingsRow>
          {dictionaryEntries.map((entry, index) => (
            <div key={index} className="flex w-full items-center gap-2 px-4 py-2">
              <Input
                data-dictation-dictionary-entry-index={index}
                aria-label={`Dictionary entry ${index + 1}`}
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
                aria-label={`Remove dictionary entry ${index + 1}`}
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

      {hasDictation ? (
        <NodexSettingsSection>
          <NodexSettingsRow
            label="Recent recordings"
            description="Your last 20 recordings are saved on this device"
          >
            {null}
          </NodexSettingsRow>
          {historyQuery.isLoading ? (
            <div className="px-4 py-3 text-sm text-token-text-secondary">Loading recordings…</div>
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
                  label={recording.transcript?.trim() || recordingFallbackLabel(recording.status)}
                  description={formatRecordingTimestamp(recording.createdAtMs)}
                >
                  {recording.transcript ? (
                    <NodexButton
                      aria-label="Copy transcript"
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => void navigator.clipboard.writeText(recording.transcript ?? "")}
                    >
                      <CopyIcon className="icon-2xs" />
                    </NodexButton>
                  ) : recording.status !== "recording" && recording.sizeBytes > 0 ? (
                    <NodexButton
                      size="xs"
                      variant="secondary"
                      disabled={historyAction !== null}
                      onClick={() => void retryRecording(recording.id)}
                    >
                      Retry
                    </NodexButton>
                  ) : null}
                  <NodexDropdownMenu
                    align="end"
                    disabled={historyAction !== null}
                    triggerButton={
                      <NodexButton aria-label="Recording actions" size="icon-xs" variant="ghost">
                        <MoreActionsIcon className="icon-2xs" />
                      </NodexButton>
                    }
                  >
                    {recording.sizeBytes > 0 ? (
                      <NodexDropdownItem
                        leftSlot={<DownloadIcon className="icon-xs" />}
                        onSelect={() => void downloadRecording(recording.id)}
                      >
                        Download recording
                      </NodexDropdownItem>
                    ) : null}
                    <NodexDropdownItem
                      className="text-token-error-foreground"
                      disabled={recording.status === "recording"}
                      leftSlot={<DeleteIcon className="icon-xs" />}
                      onSelect={() => void removeRecording(recording.id)}
                    >
                      Delete recording
                    </NodexDropdownItem>
                  </NodexDropdownMenu>
                </NodexSettingsRow>
                <DictationPerformanceDetails diagnostics={recording.diagnostics} />
              </div>
            ))
          ) : (
            <div className="px-4 py-3 text-sm text-token-text-secondary">No recordings yet.</div>
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
