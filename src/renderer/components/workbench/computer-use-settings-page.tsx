import { useEffect, useState } from "react";
import { DeleteIcon } from "@/components/shared/icons";
import { LockKeyhole, MonitorCog, Volume2 } from "@/components/shared/icons/generic-icons";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSelectedIcon,
  NodexSettingsDropdownTrigger,
} from "@/components/ui/dropdown";
import {
  NodexSettingsPageSurface,
  NodexSettingsRow,
  NodexSettingsSection,
} from "@/components/ui/settings";
import { toast } from "@/components/ui/toast";
import {
  readComputerUseSettings,
  removeComputerUseAppApproval,
  removeComputerUseMessageApproval,
  setComputerUseAlwaysHidePictureInPicture,
  setComputerUseLockedUse,
  setComputerUseSoundMode,
} from "@/lib/computer-use-settings";
import type {
  ComputerUseSettingsSnapshot,
  ComputerUseSoundMode,
} from "../../../shared/computer-use-settings";

const SOUND_MODE_OPTIONS: ReadonlyArray<{
  label: string;
  value: ComputerUseSoundMode;
}> = [
  { label: "Play sounds for foreground clicks", value: "foregroundClicks" },
  {
    label: "Play sounds for foreground and background clicks",
    value: "foregroundAndBackgroundClicks",
  },
  { label: "Don’t play sounds", value: "off" },
];

type PendingComputerUseSetting =
  | "always-hide"
  | "locked-use"
  | "sound"
  | `app:${string}`
  | `message:${string}`
  | null;

export interface ComputerUseSettingsViewProps {
  readonly pending: PendingComputerUseSetting;
  readonly snapshot: ComputerUseSettingsSnapshot;
  readonly onRemoveAppApproval: (bundleIdentifier: string) => void;
  readonly onRemoveMessageApproval: (chatGuid: string) => void;
  readonly onSetAlwaysHidePictureInPicture: (value: boolean) => void;
  readonly onSetLockedUseEnabled: (value: boolean) => void;
  readonly onSetSoundMode: (value: ComputerUseSoundMode) => void;
}

function AvailabilityStatus({ snapshot }: { snapshot: ComputerUseSettingsSnapshot }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-token-text-secondary">
      <span
        className={
          snapshot.available
            ? "size-2 rounded-full bg-[var(--color-icon-success)]"
            : "size-2 rounded-full bg-token-error-foreground"
        }
      />
      {snapshot.available ? "Available" : "Unavailable"}
    </span>
  );
}

function EmptyApprovals() {
  return <div className="p-3 text-center text-sm text-token-text-secondary">None yet</div>;
}

export function ComputerUseSettingsView({
  pending,
  snapshot,
  onRemoveAppApproval,
  onRemoveMessageApproval,
  onSetAlwaysHidePictureInPicture,
  onSetLockedUseEnabled,
  onSetSoundMode,
}: ComputerUseSettingsViewProps) {
  const selectedSoundMode =
    SOUND_MODE_OPTIONS.find((option) => option.value === snapshot.soundMode) ??
    SOUND_MODE_OPTIONS[0];

  return (
    <NodexSettingsPageSurface
      title="Computer use"
      subtitle="Manage how Nodex uses other applications on your computer."
    >
      <NodexSettingsSection title="Control">
        <NodexSettingsRow
          label="Any app"
          description={snapshot.message ?? "Let Nodex control apps on your computer."}
        >
          <AvailabilityStatus snapshot={snapshot} />
        </NodexSettingsRow>
        {snapshot.lockedUseAllowed && snapshot.lockedUseEnabled !== null ? (
          <NodexSettingsRow
            label="Locked use"
            description="Let Nodex use your Mac when it is locked."
          >
            <LockKeyhole className="size-4 text-token-text-secondary" />
            <NodexSwitch
              ariaLabel="Enable Locked use"
              checked={snapshot.lockedUseEnabled}
              disabled={pending !== null}
              onCheckedChange={onSetLockedUseEnabled}
            />
          </NodexSettingsRow>
        ) : null}
      </NodexSettingsSection>

      <NodexSettingsSection title="Picture in picture">
        <NodexSettingsRow
          label="Always hide picture in picture"
          description="Prevent Nodex from showing computer-use activity in picture in picture."
        >
          <MonitorCog className="size-4 text-token-text-secondary" />
          <NodexSwitch
            ariaLabel="Always hide picture in picture"
            checked={snapshot.alwaysHidePictureInPicture}
            disabled={pending !== null}
            onCheckedChange={onSetAlwaysHidePictureInPicture}
          />
        </NodexSettingsRow>
      </NodexSettingsSection>

      {snapshot.available ? (
        <>
          <NodexSettingsSection title="Always-allowed apps">
            {snapshot.approvedApps.length === 0 ? (
              <EmptyApprovals />
            ) : (
              snapshot.approvedApps.map((approvedApp) => (
                <NodexSettingsRow
                  key={approvedApp.bundleIdentifier}
                  label={approvedApp.displayName}
                  description={approvedApp.bundleIdentifier}
                >
                  <NodexButton
                    aria-label={`Remove ${approvedApp.displayName}`}
                    disabled={pending !== null}
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => onRemoveAppApproval(approvedApp.bundleIdentifier)}
                  >
                    <DeleteIcon className="size-3.5" />
                  </NodexButton>
                </NodexSettingsRow>
              ))
            )}
          </NodexSettingsSection>

          {snapshot.approvedMessageThreads.length > 0 ? (
            <NodexSettingsSection title="Always allowed to send">
              {snapshot.approvedMessageThreads.map((thread) => (
                <NodexSettingsRow
                  key={thread.chatGuid}
                  label={thread.displayName}
                  description="Messages"
                >
                  <NodexButton
                    aria-label={`Remove ${thread.displayName}`}
                    disabled={pending !== null}
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => onRemoveMessageApproval(thread.chatGuid)}
                  >
                    <DeleteIcon className="size-3.5" />
                  </NodexButton>
                </NodexSettingsRow>
              ))}
            </NodexSettingsSection>
          ) : null}

          <NodexSettingsSection title="Sounds">
            <NodexSettingsRow
              label="Click sounds"
              description="Choose when Computer Use actions play an audible click."
            >
              <Volume2 className="size-4 text-token-text-secondary" />
              <NodexDropdownMenu
                align="end"
                contentWidth="menu"
                disabled={pending !== null}
                triggerButton={
                  <NodexSettingsDropdownTrigger className="min-w-60 max-w-[22rem]">
                    <span className="truncate">{selectedSoundMode.label}</span>
                  </NodexSettingsDropdownTrigger>
                }
              >
                {SOUND_MODE_OPTIONS.map((option) => (
                  <NodexDropdownItem
                    key={option.value}
                    onSelect={() => onSetSoundMode(option.value)}
                    rightSlot={
                      option.value === snapshot.soundMode ? <NodexDropdownSelectedIcon /> : null
                    }
                  >
                    {option.label}
                  </NodexDropdownItem>
                ))}
              </NodexDropdownMenu>
            </NodexSettingsRow>
          </NodexSettingsSection>
        </>
      ) : null}
    </NodexSettingsPageSurface>
  );
}

export function ComputerUseSettingsPage({ open }: { open: boolean }) {
  const [snapshot, setSnapshot] = useState<ComputerUseSettingsSnapshot | null>(null);
  const [pending, setPending] = useState<PendingComputerUseSetting>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setError(null);
    void readComputerUseSettings()
      .then((nextSnapshot) => {
        if (!disposed) setSnapshot(nextSnapshot);
      })
      .catch((cause) => {
        if (!disposed) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      disposed = true;
    };
  }, [open]);

  const mutate = (
    key: Exclude<PendingComputerUseSetting, null>,
    operation: () => Promise<ComputerUseSettingsSnapshot>,
    successMessage: string,
  ) => {
    if (pending !== null) return;
    setPending(key);
    setError(null);
    void operation()
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot);
        toast.success(successMessage);
      })
      .catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        toast.danger("Could not update Computer Use settings", {
          description: message,
        });
      })
      .finally(() => {
        setPending(null);
      });
  };

  if (!snapshot) {
    return (
      <NodexSettingsPageSurface
        title="Computer use"
        subtitle="Manage how Nodex uses other applications on your computer."
      >
        <NodexSettingsSection>
          <div className="p-3 text-sm text-token-text-secondary">
            {error ?? "Loading Computer Use settings…"}
          </div>
        </NodexSettingsSection>
      </NodexSettingsPageSurface>
    );
  }

  return (
    <>
      <ComputerUseSettingsView
        pending={pending}
        snapshot={snapshot}
        onRemoveAppApproval={(bundleIdentifier) =>
          mutate(
            `app:${bundleIdentifier}`,
            () => removeComputerUseAppApproval(bundleIdentifier),
            "Allowed app removed",
          )
        }
        onRemoveMessageApproval={(chatGuid) =>
          mutate(
            `message:${chatGuid}`,
            () => removeComputerUseMessageApproval(chatGuid),
            "Allowed message thread removed",
          )
        }
        onSetAlwaysHidePictureInPicture={(value) =>
          mutate(
            "always-hide",
            () => setComputerUseAlwaysHidePictureInPicture(value),
            value ? "Picture in picture hidden" : "Picture in picture enabled",
          )
        }
        onSetLockedUseEnabled={(value) =>
          mutate(
            "locked-use",
            () => setComputerUseLockedUse(value),
            value ? "Locked use enabled" : "Locked use disabled",
          )
        }
        onSetSoundMode={(value) =>
          mutate("sound", () => setComputerUseSoundMode(value), "Click sound setting saved")
        }
      />
      {error ? (
        <span className="sr-only" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}
