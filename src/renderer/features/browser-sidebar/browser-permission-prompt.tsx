import {
  defineMessage,
  getIntl,
  useIntl,
  type MessageDescriptor,
  type IntlShape,
} from "@/lib/i18n";
import { useState, type ComponentType, type RefObject } from "react";
import { BellIcon, CloseIcon, MicIcon, OpenInIcon } from "@/components/shared/icons";
import {
  AppWindow,
  Box,
  Clipboard,
  Cookie,
  Glasses,
  Hand,
  Hourglass,
  MapPin,
  Maximize2,
  MonitorUp,
  Music,
  Network,
  Type,
  Video,
  Volume2,
} from "@/components/shared/icons/generic-icons";
import { NodexButton } from "@/components/ui/button";
import { NodexPopover, NodexPopoverContent } from "@/components/ui/popover";
import type {
  BrowserPermissionAction,
  BrowserPermissionDescriptor,
  BrowserPermissionPrompt,
  BrowserSitePermissionName,
} from "../../../shared/browser/browser-permissions";

type PermissionIcon = ComponentType<{ className?: string }>;

const PERMISSION_PRESENTATION: Readonly<
  Record<
    BrowserSitePermissionName,
    { readonly label: MessageDescriptor; readonly icon: PermissionIcon }
  >
> = {
  camera: {
    label: defineMessage({
      id: "browser.browserPermissionPrompt.useCamera",
      defaultMessage: "Use your cameras",
    }),
    icon: Video,
  },
  microphone: {
    label: defineMessage({
      id: "browser.browserPermissionPrompt.useMicrophone",
      defaultMessage: "Use your microphones",
    }),
    icon: MicIcon,
  },
  geolocation: {
    label: defineMessage({
      id: "browser.browserPermissionPrompt.useLocation",
      defaultMessage: "Know your location",
    }),
    icon: MapPin,
  },
  notifications: {
    label: defineMessage({
      id: "browser.browserPermissionPrompt.showNotifications",
      defaultMessage: "Show notifications",
    }),
    icon: BellIcon,
  },
  "clipboard-read": {
    label: defineMessage({
      id: "browser.browserPermissionPrompt.readClipboard",
      defaultMessage: "See text and images copied to the clipboard",
    }),
    icon: Clipboard,
  },
  "clipboard-write": {
    label: defineMessage({
      id: "browser.browserPermissionPrompt.writeClipboard",
      defaultMessage: "Copy text and images to the clipboard",
    }),
    icon: Clipboard,
  },
  midi: {
    label: defineMessage({
      id: "browser.browserPermissionPrompt.useMidi",
      defaultMessage: "Use your MIDI devices",
    }),
    icon: Music,
  },
  "midi-sysex": {
    label: defineMessage({
      id: "browser.browserPermissionPrompt.controlMidi",
      defaultMessage: "Control and reprogram your MIDI devices",
    }),
    icon: Music,
  },
  "window-management": {
    label: defineMessage({
      id: "browser.browserPermissionPrompt.manageWindows",
      defaultMessage: "Manage windows on all your displays",
    }),
    icon: AppWindow,
  },
  "idle-detection": {
    label: defineMessage({
      id: "browser.browserPermissionPrompt.detectIdle",
      defaultMessage: "Know when you’re actively using this device",
    }),
    icon: Hourglass,
  },
  "storage-access": {
    label: defineMessage({
      id: "browser.browserPermissionPrompt.accessStorage",
      defaultMessage: "Access cookies and site data",
    }),
    icon: Cookie,
  },
  "top-level-storage-access": {
    label: defineMessage({
      id: "browser.browserPermissionPrompt.accessOtherSiteStorage",
      defaultMessage: "Access cookies and site data for another site",
    }),
    icon: Cookie,
  },
  "open-external": {
    label: defineMessage({
      id: "browser.browserPermissionPrompt.openExternal",
      defaultMessage: "Open links with another app",
    }),
    icon: OpenInIcon,
  },
  "local-fonts": {
    label: defineMessage({
      id: "browser.browserPermissionPrompt.useLocalFonts",
      defaultMessage: "Use the fonts on your computer so you can create high-fidelity content",
    }),
    icon: Type,
  },
  "local-network": {
    label: defineMessage({
      id: "browser.browserPermissionPrompt.useLocalNetwork",
      defaultMessage: "Access other devices on your local network",
    }),
    icon: Network,
  },
  "speaker-selection": {
    label: defineMessage({
      id: "browser.browserPermissionPrompt.selectSpeaker",
      defaultMessage: "Select audio output devices",
    }),
    icon: Volume2,
  },
  "automatic-fullscreen": {
    label: defineMessage({
      id: "browser.browserPermissionPrompt.enterFullscreen",
      defaultMessage: "Enter fullscreen without a user action",
    }),
    icon: Maximize2,
  },
  "captured-surface-control": {
    label: defineMessage({
      id: "browser.browserPermissionPrompt.controlSharedTab",
      defaultMessage: "Scroll and zoom the contents of your shared tab",
    }),
    icon: MonitorUp,
  },
  ar: {
    label: defineMessage({
      id: "browser.browserPermissionPrompt.useAr",
      defaultMessage: "Create a 3D map of your surroundings and track camera position",
    }),
    icon: Box,
  },
  vr: {
    label: defineMessage({
      id: "browser.browserPermissionPrompt.useVr",
      defaultMessage: "Use virtual reality devices and data",
    }),
    icon: Glasses,
  },
  "hand-tracking": {
    label: defineMessage({
      id: "browser.browserPermissionPrompt.trackHands",
      defaultMessage: "Track your hands",
    }),
    icon: Hand,
  },
  "display-capture": {
    label: defineMessage({
      id: "browser.browserPermissionPrompt.captureScreen",
      defaultMessage: "Capture your screen",
    }),
    icon: MonitorUp,
  },
};

const PERMISSION_SHORT_LABEL: Readonly<Record<BrowserSitePermissionName, MessageDescriptor>> = {
  camera: defineMessage({ id: "browser.browserPermissionPrompt.camera", defaultMessage: "Camera" }),
  microphone: defineMessage({
    id: "browser.browserPermissionPrompt.microphone",
    defaultMessage: "Microphone",
  }),
  geolocation: defineMessage({
    id: "browser.browserPermissionPrompt.location",
    defaultMessage: "Location",
  }),
  notifications: defineMessage({
    id: "browser.browserPermissionPrompt.notifications",
    defaultMessage: "Notifications",
  }),
  "clipboard-read": defineMessage({
    id: "browser.browserPermissionPrompt.clipboard",
    defaultMessage: "Clipboard",
  }),
  "clipboard-write": defineMessage({
    id: "browser.browserPermissionPrompt.clipboardWrite",
    defaultMessage: "Clipboard writes",
  }),
  midi: defineMessage({
    id: "browser.browserPermissionPrompt.midi",
    defaultMessage: "MIDI devices",
  }),
  "midi-sysex": defineMessage({
    id: "browser.browserPermissionPrompt.midiControl",
    defaultMessage: "MIDI device control",
  }),
  "window-management": defineMessage({
    id: "browser.browserPermissionPrompt.windowManagement",
    defaultMessage: "Window management",
  }),
  "idle-detection": defineMessage({
    id: "browser.browserPermissionPrompt.idleDetection",
    defaultMessage: "Your device use",
  }),
  "storage-access": defineMessage({
    id: "browser.browserPermissionPrompt.storage",
    defaultMessage: "Cookies and site data",
  }),
  "top-level-storage-access": defineMessage({
    id: "browser.browserPermissionPrompt.otherSiteStorage",
    defaultMessage: "Cookies for another site",
  }),
  "open-external": defineMessage({
    id: "browser.browserPermissionPrompt.externalLinks",
    defaultMessage: "Links that open apps",
  }),
  "local-fonts": defineMessage({
    id: "browser.browserPermissionPrompt.fonts",
    defaultMessage: "Fonts",
  }),
  "local-network": defineMessage({
    id: "browser.browserPermissionPrompt.localNetwork",
    defaultMessage: "Local network",
  }),
  "speaker-selection": defineMessage({
    id: "browser.browserPermissionPrompt.audioOutput",
    defaultMessage: "Audio output",
  }),
  "automatic-fullscreen": defineMessage({
    id: "browser.browserPermissionPrompt.automaticFullscreen",
    defaultMessage: "Automatic fullscreen",
  }),
  "captured-surface-control": defineMessage({
    id: "browser.browserPermissionPrompt.sharedTabControl",
    defaultMessage: "Shared tab control",
  }),
  ar: defineMessage({
    id: "browser.browserPermissionPrompt.augmentedReality",
    defaultMessage: "Augmented reality",
  }),
  vr: defineMessage({
    id: "browser.browserPermissionPrompt.virtualReality",
    defaultMessage: "Virtual reality",
  }),
  "hand-tracking": defineMessage({
    id: "browser.browserPermissionPrompt.handTracking",
    defaultMessage: "Hand tracking",
  }),
  "display-capture": defineMessage({
    id: "browser.browserPermissionPrompt.screenCapture",
    defaultMessage: "Screen capture",
  }),
};

const ACTION_ORDER: readonly BrowserPermissionAction[] = ["allow", "allow-this-time", "deny"];

/** The name a site's saved permission goes by in site information. */
export function permissionShortLabel(
  name: BrowserSitePermissionName,
  intl: IntlShape = getIntl(),
): string {
  return intl.formatMessage(PERMISSION_SHORT_LABEL[name]);
}

export function readPermissionSiteLabel(origin: string): string {
  try {
    const url = new URL(origin);
    return url.host || origin;
  } catch {
    return origin;
  }
}

/** Button wording follows the choices the request offers. */
export function permissionActionLabel(
  prompt: Pick<BrowserPermissionPrompt, "actions">,
  action: BrowserPermissionAction,
  intl: IntlShape = getIntl(),
): string {
  const temporary = prompt.actions.includes("allow-this-time");
  if (action === "allow")
    return temporary
      ? intl.formatMessage({
          id: "browser.browserPermissionPrompt.allowWhileVisiting",
          defaultMessage: "Allow while visiting the site",
        })
      : intl.formatMessage({
          id: "browser.browserPermissionPrompt.allow",
          defaultMessage: "Allow",
        });
  if (action === "allow-this-time")
    return intl.formatMessage({
      id: "browser.browserPermissionPrompt.allowOnce",
      defaultMessage: "Allow this time",
    });
  if (action === "deny")
    return temporary
      ? intl.formatMessage({
          id: "browser.browserPermissionPrompt.neverAllow",
          defaultMessage: "Never allow",
        })
      : intl.formatMessage({
          id: "browser.browserPermissionPrompt.block",
          defaultMessage: "Block",
        });
  return intl.formatMessage({
    id: "browser.browserPermissionPrompt.confirm",
    defaultMessage: "OK",
  });
}

export function permissionDescriptorLabel(
  descriptor: BrowserPermissionDescriptor,
  intl: IntlShape = getIntl(),
): string {
  if (descriptor.name === "open-external" && descriptor.externalUrl) {
    try {
      return intl.formatMessage(
        {
          id: "browser.browserPermissionPrompt.openProtocol",
          defaultMessage: "Open {protocol} links with another app",
        },
        { protocol: new URL(descriptor.externalUrl).protocol },
      );
    } catch {
      // Fall through to the generic wording.
    }
  }
  return intl.formatMessage(PERMISSION_PRESENTATION[descriptor.name].label);
}

function promptHeading(
  prompt: BrowserPermissionPrompt,
  site: string,
  intl: IntlShape = getIntl(),
): string {
  return prompt.variant === "os-system-settings"
    ? intl.formatMessage(
        {
          id: "browser.browserPermissionPrompt.blockedHeading",
          defaultMessage: "Your system settings block these permissions for {site}",
        },
        { site },
      )
    : intl.formatMessage(
        { id: "browser.browserPermissionPrompt.requestHeading", defaultMessage: "{site} wants to" },
        { site },
      );
}

export interface BrowserPermissionPromptProps {
  readonly prompt: BrowserPermissionPrompt | null;
  /** The address bar the request hangs from. */
  readonly anchor: RefObject<HTMLElement | null>;
  readonly onRespond: (
    prompt: BrowserPermissionPrompt,
    action: BrowserPermissionAction,
  ) => Promise<boolean>;
  readonly onOpenSystemSettings: (prompt: BrowserPermissionPrompt) => Promise<boolean>;
}

/** A site's pending permission request for the visible tab, answered in place. */
export function BrowserPermissionPromptPopover({
  prompt,
  anchor,
  onRespond,
  onOpenSystemSettings,
}: BrowserPermissionPromptProps) {
  return (
    <NodexPopover
      open={prompt !== null}
      onOpenChange={(open, details) => {
        if (open || !prompt) return;
        // Only Escape or the close button set the request aside; page clicks leave it pending.
        if (details.reason === "escape" && prompt.actions.includes("dismiss")) {
          void onRespond(prompt, "dismiss");
          return;
        }
        details.cancel();
      }}
    >
      {prompt ? (
        <PermissionPromptContent
          key={prompt.id}
          prompt={prompt}
          anchor={anchor}
          onRespond={onRespond}
          onOpenSystemSettings={onOpenSystemSettings}
        />
      ) : null}
    </NodexPopover>
  );
}

function PermissionPromptContent({
  prompt,
  anchor,
  onRespond,
  onOpenSystemSettings,
}: Omit<BrowserPermissionPromptProps, "prompt"> & { readonly prompt: BrowserPermissionPrompt }) {
  const intl = useIntl();
  const [pending, setPending] = useState<BrowserPermissionAction | "settings" | null>(null);
  const [failed, setFailed] = useState(false);
  const site = readPermissionSiteLabel(prompt.origin);
  const run = async (choice: BrowserPermissionAction | "settings") => {
    setPending(choice);
    setFailed(false);
    const sent =
      choice === "settings"
        ? await onOpenSystemSettings(prompt).catch(() => false)
        : await onRespond(prompt, choice).catch(() => false);
    setPending(null);
    if (!sent) setFailed(true);
  };
  const actions = ACTION_ORDER.filter((action) => prompt.actions.includes(action));
  return (
    <NodexPopoverContent
      anchor={anchor}
      align="start"
      sideOffset={6}
      role="dialog"
      aria-label={intl.formatMessage(
        {
          id: "browser.browserPermissionPrompt.requestAria",
          defaultMessage: "Website permission request from {site}",
        },
        { site },
      )}
      className="w-80 gap-3 px-3 py-3"
      initialFocus={false}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-all text-sm font-medium text-token-text-primary select-text">
          {promptHeading(prompt, site, intl)}
        </p>
        {prompt.actions.includes("dismiss") ? (
          <button
            type="button"
            aria-label={intl.formatMessage({
              id: "browser.browserPermissionPrompt.close",
              defaultMessage: "Close permission request",
            })}
            className="-me-1 -mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-token-text-tertiary hover:bg-token-foreground/5 hover:text-token-text-primary"
            disabled={pending !== null}
            onClick={() => void run("dismiss")}
          >
            <CloseIcon className="icon-xs" />
          </button>
        ) : null}
      </div>
      <ul className="flex flex-col gap-2">
        {prompt.permissions.map((descriptor) => {
          const Icon = PERMISSION_PRESENTATION[descriptor.name].icon;
          return (
            <li
              key={`${descriptor.name}:${descriptor.externalUrl ?? ""}`}
              className="flex items-start gap-2 text-sm text-token-text-secondary"
            >
              <Icon className="icon-sm mt-px shrink-0" />
              <span className="min-w-0">{permissionDescriptorLabel(descriptor, intl)}</span>
            </li>
          );
        })}
      </ul>
      {failed ? (
        <p role="alert" className="text-sm text-token-charts-red">
          {intl.formatMessage({
            id: "browser.browserPermissionPrompt.respondFailed",
            defaultMessage: "Couldn’t send your choice. Try again",
          })}
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        {actions.map((action) => (
          <NodexButton
            key={action}
            variant="secondary"
            className="w-full justify-center"
            disabled={pending !== null}
            onClick={() => void run(action)}
          >
            {permissionActionLabel(prompt, action, intl)}
          </NodexButton>
        ))}
        {prompt.variant === "os-system-settings" ? (
          <NodexButton
            variant="secondary"
            className="w-full justify-center"
            disabled={pending !== null}
            onClick={() => void run("settings")}
          >
            {intl.formatMessage({
              id: "browser.browserPermissionPrompt.openSettings",
              defaultMessage: "Open system settings",
            })}
          </NodexButton>
        ) : null}
      </div>
    </NodexPopoverContent>
  );
}
