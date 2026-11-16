import { settingsMessages } from "./workbench-settings-search-catalog";
import { defineMessage, useIntl, type MessageDescriptor } from "@/lib/i18n";
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
  setComputerUseEnabled,
  setComputerUseSoundMode,
} from "@/lib/computer-use-settings";
import type {
  ComputerUseSettingsSnapshot,
  ComputerUseSoundMode,
} from "../../../shared/computer-use-settings";

const SOUND_MODE_OPTIONS: ReadonlyArray<{
  label: MessageDescriptor;
  value: ComputerUseSoundMode;
}> = [
  {
    label: defineMessage({
      id: "settings.computerUse.playSoundsForForegroundClicks",
      defaultMessage: "Play sounds for foreground clicks",
    }),
    value: "foregroundClicks",
  },
  {
    label: defineMessage({
      id: "settings.computerUse.playSoundsForForegroundAndBackground",
      defaultMessage: "Play sounds for foreground and background clicks",
    }),
    value: "foregroundAndBackgroundClicks",
  },
  {
    label: defineMessage({
      id: "settings.computerUse.dontPlaySounds",
      defaultMessage: "Don’t play sounds",
    }),
    value: "off",
  },
];

type PendingComputerUseSetting =
  | "enabled"
  | "always-hide"
  | "locked-use"
  | "sound"
  | `app:${string}`
  | `message:${string}`
  | null;

export interface ComputerUseSettingsViewProps {
  readonly pending: PendingComputerUseSetting;
  readonly snapshot: ComputerUseSettingsSnapshot;
  readonly onSetWindowsEnabled?: (value: boolean) => void;
  readonly onRemoveAppApproval: (bundleIdentifier: string) => void;
  readonly onRemoveMessageApproval: (chatGuid: string) => void;
  readonly onSetAlwaysHidePictureInPicture: (value: boolean) => void;
  readonly onSetLockedUseEnabled: (value: boolean) => void;
  readonly onSetSoundMode: (value: ComputerUseSoundMode) => void;
}

function AvailabilityStatus({ snapshot }: { snapshot: ComputerUseSettingsSnapshot }) {
  const intl = useIntl();
  return (
    <span className="inline-flex items-center gap-2 text-sm text-token-text-secondary">
      <span
        className={
          snapshot.available
            ? "size-2 rounded-full bg-(--color-background-success-indicator)"
            : "size-2 rounded-full bg-token-error-foreground"
        }
      />
      {snapshot.available
        ? intl.formatMessage({ id: "settings.computerUse.available", defaultMessage: "Available" })
        : intl.formatMessage({
            id: "settings.computerUse.unavailable",
            defaultMessage: "Unavailable",
          })}
    </span>
  );
}

function EmptyApprovals() {
  const intl = useIntl();
  return (
    <div className="p-3 text-center text-sm text-token-text-secondary">
      {intl.formatMessage({ id: "settings.computerUse.noneYet", defaultMessage: "None yet" })}
    </div>
  );
}

function AppApprovals({
  pending,
  snapshot,
  onRemoveAppApproval,
}: Pick<ComputerUseSettingsViewProps, "pending" | "snapshot" | "onRemoveAppApproval">) {
  const intl = useIntl();
  return (
    <NodexSettingsSection title={intl.formatMessage(settingsMessages.computerUseAlwaysAllowedApps)}>
      {snapshot.approvedApps.length === 0 ? (
        <EmptyApprovals />
      ) : (
        snapshot.approvedApps.map((app) => (
          <NodexSettingsRow
            key={app.bundleIdentifier}
            label={app.displayName}
            description={snapshot.windows ? undefined : app.bundleIdentifier}
          >
            <NodexButton
              aria-label={intl.formatMessage(
                { id: "settings.computerUse.remove", defaultMessage: "Remove {displayName}" },
                { displayName: app.displayName },
              )}
              disabled={pending !== null}
              size="icon-xs"
              variant="ghost"
              onClick={() => onRemoveAppApproval(app.bundleIdentifier)}
            >
              <DeleteIcon className="size-3.5" />
            </NodexButton>
          </NodexSettingsRow>
        ))
      )}
    </NodexSettingsSection>
  );
}

export function ComputerUseSettingsView({
  pending,
  snapshot,
  onSetWindowsEnabled,
  onRemoveAppApproval,
  onRemoveMessageApproval,
  onSetAlwaysHidePictureInPicture,
  onSetLockedUseEnabled,
  onSetSoundMode,
}: ComputerUseSettingsViewProps) {
  const intl = useIntl();
  if (snapshot.windows) {
    const { enabled } = snapshot.windows;
    return (
      <NodexSettingsPageSurface title={intl.formatMessage(settingsMessages.computerUseTitle)}>
        <NodexSettingsSection
          title={intl.formatMessage({
            id: "settings.computerUse.control",
            defaultMessage: "Control",
          })}
        >
          <NodexSettingsRow
            label={intl.formatMessage(settingsMessages.computerUseAnyApp)}
            description={enabled ? snapshot.message : null}
          >
            {enabled ? <AvailabilityStatus snapshot={snapshot} /> : null}
            {onSetWindowsEnabled ? (
              <NodexSwitch
                ariaLabel={intl.formatMessage({
                  id: "settings.computerUse.enableComputerUse",
                  defaultMessage: "Enable Computer Use",
                })}
                checked={enabled}
                disabled={pending !== null}
                onCheckedChange={onSetWindowsEnabled}
              />
            ) : null}
          </NodexSettingsRow>
        </NodexSettingsSection>
        {snapshot.available || snapshot.approvedApps.length > 0 ? (
          <AppApprovals {...{ pending, snapshot, onRemoveAppApproval }} />
        ) : null}
      </NodexSettingsPageSurface>
    );
  }
  const selectedSoundMode =
    SOUND_MODE_OPTIONS.find((option) => option.value === snapshot.soundMode) ??
    SOUND_MODE_OPTIONS[0];

  return (
    <NodexSettingsPageSurface
      title={intl.formatMessage(settingsMessages.computerUseTitle)}
      subtitle={intl.formatMessage({
        id: "settings.computerUse.manageHowNodexUsesOtherApplications",
        defaultMessage: "Manage how Nodex uses other applications on your computer.",
      })}
    >
      <NodexSettingsSection
        title={intl.formatMessage({
          id: "settings.computerUse.control",
          defaultMessage: "Control",
        })}
      >
        <NodexSettingsRow
          label={intl.formatMessage(settingsMessages.computerUseAnyApp)}
          description={
            snapshot.message ??
            intl.formatMessage({
              id: "settings.computerUse.letNodexControlAppsOnYour",
              defaultMessage: "Let Nodex control apps on your computer.",
            })
          }
        >
          <AvailabilityStatus snapshot={snapshot} />
        </NodexSettingsRow>
        {snapshot.lockedUseAllowed && snapshot.lockedUseEnabled !== null ? (
          <NodexSettingsRow
            label={intl.formatMessage(settingsMessages.computerUseLockedUse)}
            description={intl.formatMessage({
              id: "settings.computerUse.letNodexUseYourMacWhen",
              defaultMessage: "Let Nodex use your Mac when it is locked.",
            })}
          >
            <LockKeyhole className="size-4 text-token-text-secondary" />
            <NodexSwitch
              ariaLabel={intl.formatMessage({
                id: "settings.computerUse.enableLockedUse",
                defaultMessage: "Enable Locked use",
              })}
              checked={snapshot.lockedUseEnabled}
              disabled={pending !== null}
              onCheckedChange={onSetLockedUseEnabled}
            />
          </NodexSettingsRow>
        ) : null}
      </NodexSettingsSection>

      <NodexSettingsSection
        title={intl.formatMessage(settingsMessages.computerUsePictureInPicture)}
      >
        <NodexSettingsRow
          label={intl.formatMessage(settingsMessages.computerUseAlwaysHidePictureInPicture)}
          description={intl.formatMessage({
            id: "settings.computerUse.preventNodexFromShowingComputerUse",
            defaultMessage:
              "Prevent Nodex from showing computer-use activity in picture in picture.",
          })}
        >
          <MonitorCog className="size-4 text-token-text-secondary" />
          <NodexSwitch
            ariaLabel={intl.formatMessage(settingsMessages.computerUseAlwaysHidePictureInPicture)}
            checked={snapshot.alwaysHidePictureInPicture}
            disabled={pending !== null}
            onCheckedChange={onSetAlwaysHidePictureInPicture}
          />
        </NodexSettingsRow>
      </NodexSettingsSection>

      {snapshot.available ? (
        <>
          <AppApprovals {...{ pending, snapshot, onRemoveAppApproval }} />

          {snapshot.approvedMessageThreads.length > 0 ? (
            <NodexSettingsSection
              title={intl.formatMessage(settingsMessages.computerUseAlwaysAllowedToSend)}
            >
              {snapshot.approvedMessageThreads.map((thread) => (
                <NodexSettingsRow
                  key={thread.chatGuid}
                  label={thread.displayName}
                  description={intl.formatMessage({
                    id: "settings.computerUse.messages",
                    defaultMessage: "Messages",
                  })}
                >
                  <NodexButton
                    aria-label={intl.formatMessage(
                      { id: "settings.computerUse.remove", defaultMessage: "Remove {displayName}" },
                      { displayName: thread.displayName },
                    )}
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

          <NodexSettingsSection
            title={intl.formatMessage({
              id: "settings.computerUse.sounds",
              defaultMessage: "Sounds",
            })}
          >
            <NodexSettingsRow
              label={intl.formatMessage(settingsMessages.computerUseClickSounds)}
              description={intl.formatMessage({
                id: "settings.computerUse.chooseWhenComputerUseActionsPlay",
                defaultMessage: "Choose when Computer Use actions play an audible click.",
              })}
            >
              <Volume2 className="size-4 text-token-text-secondary" />
              <NodexDropdownMenu
                align="end"
                contentWidth="menu"
                disabled={pending !== null}
                triggerButton={
                  <NodexSettingsDropdownTrigger className="min-w-60 max-w-[22rem]">
                    <span className="truncate">{intl.formatMessage(selectedSoundMode.label)}</span>
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
                    {intl.formatMessage(option.label)}
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
  const intl = useIntl();
  const [snapshot, setSnapshot] = useState<ComputerUseSettingsSnapshot | null>(null);
  const [pending, setPending] = useState<PendingComputerUseSetting>(null);
  const [error, setError] = useState<string | null>(null);

  const [previousOpen, setPreviousOpen] = useState(open);
  if (previousOpen !== open) {
    setPreviousOpen(open);
    if (open) setError(null);
  }
  useEffect(() => {
    if (!open) return;
    let disposed = false;
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
        toast.danger(
          intl.formatMessage({
            id: "settings.computerUse.couldNotUpdateComputerUseSettings",
            defaultMessage: "Could not update Computer Use settings",
          }),
          {
            description: message,
          },
        );
      })
      .finally(() => {
        setPending(null);
      });
  };

  if (!snapshot) {
    return (
      <NodexSettingsPageSurface
        title={intl.formatMessage(settingsMessages.computerUseTitle)}
        subtitle={intl.formatMessage({
          id: "settings.computerUse.manageHowNodexUsesOtherApplications",
          defaultMessage: "Manage how Nodex uses other applications on your computer.",
        })}
      >
        <NodexSettingsSection>
          <div className="p-3 text-sm text-token-text-secondary">
            {error ??
              intl.formatMessage({
                id: "settings.computerUse.loadingComputerUseSettings",
                defaultMessage: "Loading Computer Use settings…",
              })}
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
        onSetWindowsEnabled={(value) =>
          mutate(
            "enabled",
            () => setComputerUseEnabled(value),
            value
              ? intl.formatMessage({
                  id: "settings.computerUse.computerUseEnabled",
                  defaultMessage: "Computer Use enabled",
                })
              : intl.formatMessage({
                  id: "settings.computerUse.computerUseTurnedOff",
                  defaultMessage: "Computer Use turned off",
                }),
          )
        }
        onRemoveAppApproval={(bundleIdentifier) =>
          mutate(
            `app:${bundleIdentifier}`,
            () => removeComputerUseAppApproval(bundleIdentifier),
            intl.formatMessage({
              id: "settings.computerUse.allowedAppRemoved",
              defaultMessage: "Allowed app removed",
            }),
          )
        }
        onRemoveMessageApproval={(chatGuid) =>
          mutate(
            `message:${chatGuid}`,
            () => removeComputerUseMessageApproval(chatGuid),
            intl.formatMessage({
              id: "settings.computerUse.allowedMessageThreadRemoved",
              defaultMessage: "Allowed message thread removed",
            }),
          )
        }
        onSetAlwaysHidePictureInPicture={(value) =>
          mutate(
            "always-hide",
            () => setComputerUseAlwaysHidePictureInPicture(value),
            value
              ? intl.formatMessage({
                  id: "settings.computerUse.pictureInPictureHidden",
                  defaultMessage: "Picture in picture hidden",
                })
              : intl.formatMessage({
                  id: "settings.computerUse.pictureInPictureEnabled",
                  defaultMessage: "Picture in picture enabled",
                }),
          )
        }
        onSetLockedUseEnabled={(value) =>
          mutate(
            "locked-use",
            () => setComputerUseLockedUse(value),
            value
              ? intl.formatMessage({
                  id: "settings.computerUse.lockedUseEnabled",
                  defaultMessage: "Locked use enabled",
                })
              : intl.formatMessage({
                  id: "settings.computerUse.lockedUseDisabled",
                  defaultMessage: "Locked use disabled",
                }),
          )
        }
        onSetSoundMode={(value) =>
          mutate(
            "sound",
            () => setComputerUseSoundMode(value),
            intl.formatMessage({
              id: "settings.computerUse.clickSoundSettingSaved",
              defaultMessage: "Click sound setting saved",
            }),
          )
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
