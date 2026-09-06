import { DictationPerformanceDetails } from "./dictation-performance-details";
import { DictationDiagnosticsRecorder } from "./dictation-diagnostics-recorder";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NodexButton } from "@/components/ui/button";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
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
  LinkToolbarCopyIcon,
  MoreActionsIcon,
  PlusIcon,
} from "@/components/shared/icons";
import { queryKeys } from "@/lib/query-keys";
import { updateCommandKeybinding, useCommandKeymapState } from "@/lib/use-command-keymap-state";
import {
  deleteDictationRecording,
  downloadDictationRecording,
  listDictationRecordings,
  openGlobalDictationAccessibilitySettings,
  openGlobalDictationInputMonitoringSettings,
  openMicrophoneSettings,
  readDictationRecordingAudio,
  readDictationCapabilityState,
  readDictationSettings,
  readGlobalDictationPermissions,
  readMicrophoneAccess,
  requestMicrophoneAccess,
  requestGlobalDictationAccessibility,
  requestGlobalDictationInputMonitoring,
  setDictationRecordingTranscript,
  setDictationRecordingDiagnostics,
  updateDictationSettings,
} from "@/lib/api";
import type { DictationSettings, MicrophoneAccessStatus } from "../../../shared/dictation";
import {
  findCommandKeybindingConflict,
  formatAcceleratorLabel,
  validateGlobalDictationShortcut,
  type CommandKeybindingUpdate,
  type CommandKeymapEntry,
} from "../../../shared/command-keybindings";
import { transcribeDictationBlob } from "./dictation-buffered-client";
import { cleanupDictationTranscript } from "./dictation-cleanup-client";
import { captureGlobalDictationFnHotkey } from "./dictation-settings-runtime";

const SETTINGS_QUERY_KEY = ["settings", "dictation"] as const;
const HISTORY_QUERY_KEY = ["dictation", "history"] as const;
const GLOBAL_PERMISSIONS_QUERY_KEY = ["dictation", "global-permissions"] as const;
const CAPABILITY_QUERY_KEY = ["dictation", "capabilities"] as const;
const EMPTY_DICTIONARY_ENTRY = "";
const DICTIONARY_PLACEHOLDERS = [
  "Jane Doe",
  "Acme Widget",
  "checkout-form.tsx",
  "useCartState",
] as const;
const MAX_DICTIONARY_ENTRIES = 100;

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
    (device) => device.kind === "audioinput" && device.deviceId !== "default",
  );
  const options = [
    { value: "", label: "System default" },
    ...inputs.map((device, index) => ({
      value: device.deviceId,
      label: device.label.trim() || `Microphone ${index + 1}`,
    })),
  ];
  if (selectedId && !inputs.some((device) => device.deviceId === selectedId)) {
    options.push({ value: selectedId, label: "Unavailable microphone" });
  }
  return options;
};

export function VoiceSettingsPage(_props: { readonly onPathChange: (path: string) => void }) {
  const queryClient = useQueryClient();
  const commandKeymapQuery = useCommandKeymapState();
  const settingsQuery = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: readDictationSettings,
  });
  const historyQuery = useQuery({
    queryKey: HISTORY_QUERY_KEY,
    queryFn: listDictationRecordings,
  });
  const globalPermissionsQuery = useQuery({
    queryKey: GLOBAL_PERMISSIONS_QUERY_KEY,
    queryFn: readGlobalDictationPermissions,
  });
  const capabilityQuery = useQuery({
    queryKey: CAPABILITY_QUERY_KEY,
    queryFn: readDictationCapabilityState,
  });
  const [permissionStatus, setPermissionStatus] = useState<MicrophoneAccessStatus>("unknown");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [shortcutCapture, setShortcutCapture] = useState<{
    readonly commandId: string;
    readonly conflict: string | null;
  } | null>(null);
  const [shortcutErrors, setShortcutErrors] = useState<Record<string, string>>({});
  const [dictionaryDraft, setDictionaryDraft] = useState<readonly string[] | null>(null);
  const [historyAction, setHistoryAction] = useState<string | null>(null);
  const suppressNextDictionaryBlurRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void readMicrophoneAccess().then((status) => {
      if (!cancelled) setPermissionStatus(status);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (permissionStatus !== "granted") {
      setDevices([]);
      return;
    }
    let cancelled = false;
    void navigator.mediaDevices
      .enumerateDevices()
      .then((nextDevices) => {
        if (!cancelled) setDevices(nextDevices);
      })
      .catch(() => {
        if (!cancelled) setDevices([]);
      });
    return () => {
      cancelled = true;
    };
  }, [permissionStatus]);

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

  const requestPermission = async (): Promise<void> => {
    const result = await requestMicrophoneAccess();
    setPermissionStatus(
      result.kind === "granted"
        ? "granted"
        : result.kind === "blocked"
          ? result.status
          : result.kind === "unavailable"
            ? result.status
            : "unknown",
    );
    if (result.kind === "blocked") {
      toast.warning("Microphone access is blocked", {
        description: "Open System Settings, allow Nodex, then relaunch the app.",
        action: { label: "Open settings", onClick: () => void openMicrophoneSettings() },
      });
    }
  };

  const requestGlobalPermission = async (
    kind: "input-monitoring" | "accessibility",
  ): Promise<void> => {
    const next =
      kind === "input-monitoring"
        ? await requestGlobalDictationInputMonitoring()
        : await requestGlobalDictationAccessibility();
    queryClient.setQueryData(GLOBAL_PERMISSIONS_QUERY_KEY, next);
    const granted = kind === "input-monitoring" ? next.inputMonitoring : next.accessibility;
    if (granted) return;
    toast.warning(
      kind === "input-monitoring"
        ? "Input Monitoring still needs approval"
        : "Accessibility still needs approval",
      {
        description: "Allow Nodex in System Settings, then return to Voice settings.",
        action: {
          label: "Open settings",
          onClick: () =>
            void (kind === "input-monitoring"
              ? openGlobalDictationInputMonitoringSettings()
              : openGlobalDictationAccessibilitySettings()),
        },
      },
    );
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
      const transcript = await diagnostics.measure("cleanup", () =>
        cleanupDictationTranscript(rawTranscript, { onDiagnostics: diagnostics.request }),
      );
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
      {capabilityQuery.data && capabilityQuery.data.capabilities.auth !== "chatgpt" ? (
        <div className="mx-4 rounded-xl border border-token-border bg-token-list-hover-background px-4 py-3 text-sm text-token-text-secondary">
          Dictation requires a ChatGPT login. API-key sessions cannot use Voice transcription.
        </div>
      ) : null}
      <NodexSettingsSection title="General">
        <NodexSettingsRow label="Microphone" description="Used for voice chat and dictation">
          {permissionStatus === "granted" && settings ? (
            <ConfigValueDropdown
              value={settings.microphoneInputDeviceId ?? ""}
              options={deviceOptions(devices, settings.microphoneInputDeviceId)}
              disabled={updateSettings.isPending}
              onSelect={(value) => {
                updateSettings.mutate({ microphoneInputDeviceId: value || null });
              }}
            />
          ) : permissionStatus === "denied" || permissionStatus === "restricted" ? (
            <NodexButton
              size="xs"
              variant="secondary"
              onClick={() => void openMicrophoneSettings()}
            >
              Open settings
            </NodexButton>
          ) : (
            <NodexButton size="xs" variant="secondary" onClick={() => void requestPermission()}>
              Allow access
            </NodexButton>
          )}
        </NodexSettingsRow>
      </NodexSettingsSection>

      <NodexSettingsSection title="Dictation">
        {(["globalDictationHold", "globalDictationToggle"] as const).map((commandId) => {
          const entry = commandKeymapQuery.data?.entries.find(
            (candidate) => candidate.id === commandId,
          );
          if (!entry) return null;
          const isToggle = commandId === "globalDictationToggle";
          const description = isToggle
            ? "Press once anywhere on desktop to dictate, then press again to stop"
            : "Hold anywhere on desktop to dictate where your cursor is";
          const error = shortcutErrors[commandId];
          const accelerator = entry.keybindings[0]?.key ?? null;
          return (
            <NodexSettingsRow
              key={commandId}
              label={isToggle ? "Toggle dictation hotkey" : "Hold-to-dictate hotkey"}
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
                  isToggle ? "Toggle dictation hotkey capture" : "Hold-to-dictate hotkey capture"
                }
                captureFnHotkey={captureGlobalDictationFnHotkey}
                conflict={
                  shortcutCapture?.commandId === commandId ? shortcutCapture.conflict : null
                }
                disabled={updateShortcut.isPending}
                emptyLabel="Off"
                hotkeyName={isToggle ? "Toggle dictation hotkey" : "Hold-to-dictate hotkey"}
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
        <NodexSettingsRow
          label="Keep dictation bar visible"
          description="Show a small shortcut reminder when dictation isn't recording"
        >
          <TogglePill
            ariaLabel="Keep global dictation bar visible"
            value={settings?.keepGlobalBarVisible ?? false}
            disabled={!settings || updateSettings.isPending}
            onChange={(value) => updateSettings.mutate({ keepGlobalBarVisible: value })}
          />
        </NodexSettingsRow>
        <NodexSettingsRow
          label="Play dictation sounds"
          description="Play tones when dictation starts and stops"
        >
          <TogglePill
            ariaLabel="Play dictation sounds"
            value={(settings?.playStartSound ?? true) && (settings?.playStopSound ?? true)}
            disabled={!settings || updateSettings.isPending}
            onChange={(value) =>
              updateSettings.mutate({ playStartSound: value, playStopSound: value })
            }
          />
        </NodexSettingsRow>
      </NodexSettingsSection>

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

      {globalPermissionsQuery.data?.available &&
      (!globalPermissionsQuery.data.inputMonitoring ||
        !globalPermissionsQuery.data.accessibility) ? (
        <NodexSettingsSection title="Permissions">
          {!globalPermissionsQuery.data.inputMonitoring ? (
            <NodexSettingsRow
              label="Input Monitoring"
              description="Allow global hold and toggle shortcuts outside Nodex."
            >
              <NodexButton
                size="xs"
                variant="secondary"
                onClick={() => void requestGlobalPermission("input-monitoring")}
              >
                Allow
              </NodexButton>
            </NodexSettingsRow>
          ) : null}
          {!globalPermissionsQuery.data.accessibility ? (
            <NodexSettingsRow
              label="Accessibility"
              description="Allow completed dictation to be pasted into the original app."
            >
              <NodexButton
                size="xs"
                variant="secondary"
                onClick={() => void requestGlobalPermission("accessibility")}
              >
                Allow
              </NodexButton>
            </NodexSettingsRow>
          ) : null}
        </NodexSettingsSection>
      ) : null}

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
            <div key={recording.id}>
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
                    <LinkToolbarCopyIcon className="icon-2xs" />
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
    </NodexSettingsPageSurface>
  );
}
