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
  Record<BrowserSitePermissionName, { readonly label: string; readonly icon: PermissionIcon }>
> = {
  camera: { label: "Use your cameras", icon: Video },
  microphone: { label: "Use your microphones", icon: MicIcon },
  geolocation: { label: "Know your location", icon: MapPin },
  notifications: { label: "Show notifications", icon: BellIcon },
  "clipboard-read": { label: "See text and images copied to the clipboard", icon: Clipboard },
  "clipboard-write": { label: "Copy text and images to the clipboard", icon: Clipboard },
  midi: { label: "Use your MIDI devices", icon: Music },
  "midi-sysex": { label: "Control and reprogram your MIDI devices", icon: Music },
  "window-management": { label: "Manage windows on all your displays", icon: AppWindow },
  "idle-detection": { label: "Know when you’re actively using this device", icon: Hourglass },
  "storage-access": { label: "Access cookies and site data", icon: Cookie },
  "top-level-storage-access": {
    label: "Access cookies and site data for another site",
    icon: Cookie,
  },
  "open-external": { label: "Open links with another app", icon: OpenInIcon },
  "local-fonts": {
    label: "Use the fonts on your computer so you can create high-fidelity content",
    icon: Type,
  },
  "local-network": { label: "Access other devices on your local network", icon: Network },
  "speaker-selection": { label: "Select audio output devices", icon: Volume2 },
  "automatic-fullscreen": { label: "Enter fullscreen without a user action", icon: Maximize2 },
  "captured-surface-control": {
    label: "Scroll and zoom the contents of your shared tab",
    icon: MonitorUp,
  },
  ar: {
    label: "Create a 3D map of your surroundings and track camera position",
    icon: Box,
  },
  vr: { label: "Use virtual reality devices and data", icon: Glasses },
  "hand-tracking": { label: "Track your hands", icon: Hand },
  "display-capture": { label: "Capture your screen", icon: MonitorUp },
};

const PERMISSION_SHORT_LABEL: Readonly<Record<BrowserSitePermissionName, string>> = {
  camera: "Camera",
  microphone: "Microphone",
  geolocation: "Location",
  notifications: "Notifications",
  "clipboard-read": "Clipboard",
  "clipboard-write": "Clipboard writes",
  midi: "MIDI devices",
  "midi-sysex": "MIDI device control",
  "window-management": "Window management",
  "idle-detection": "Your device use",
  "storage-access": "Cookies and site data",
  "top-level-storage-access": "Cookies for another site",
  "open-external": "Links that open apps",
  "local-fonts": "Fonts",
  "local-network": "Local network",
  "speaker-selection": "Audio output",
  "automatic-fullscreen": "Automatic fullscreen",
  "captured-surface-control": "Shared tab control",
  ar: "Augmented reality",
  vr: "Virtual reality",
  "hand-tracking": "Hand tracking",
  "display-capture": "Screen capture",
};

const ACTION_ORDER: readonly BrowserPermissionAction[] = ["allow", "allow-this-time", "deny"];

/** The name a site's saved permission goes by in site information. */
export function permissionShortLabel(name: BrowserSitePermissionName): string {
  return PERMISSION_SHORT_LABEL[name];
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
): string {
  const temporary = prompt.actions.includes("allow-this-time");
  if (action === "allow") return temporary ? "Allow while visiting the site" : "Allow";
  if (action === "allow-this-time") return "Allow this time";
  if (action === "deny") return temporary ? "Never allow" : "Block";
  return "OK";
}

export function permissionDescriptorLabel(descriptor: BrowserPermissionDescriptor): string {
  if (descriptor.name === "open-external" && descriptor.externalUrl) {
    try {
      return `Open ${new URL(descriptor.externalUrl).protocol} links with another app`;
    } catch {
      // Fall through to the generic wording.
    }
  }
  return PERMISSION_PRESENTATION[descriptor.name].label;
}

function promptHeading(prompt: BrowserPermissionPrompt, site: string): string {
  return prompt.variant === "os-system-settings"
    ? `Your system settings block these permissions for ${site}`
    : `${site} wants to`;
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
      aria-label={`Website permission request from ${site}`}
      className="w-80 gap-3 px-3 py-3"
      initialFocus={false}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-all text-sm font-medium text-token-text-primary select-text">
          {promptHeading(prompt, site)}
        </p>
        {prompt.actions.includes("dismiss") ? (
          <button
            type="button"
            aria-label="Close permission request"
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
              <span className="min-w-0">{permissionDescriptorLabel(descriptor)}</span>
            </li>
          );
        })}
      </ul>
      {failed ? (
        <p role="alert" className="text-sm text-token-charts-red">
          Couldn’t send your choice. Try again
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
            {permissionActionLabel(prompt, action)}
          </NodexButton>
        ))}
        {prompt.variant === "os-system-settings" ? (
          <NodexButton
            variant="secondary"
            className="w-full justify-center"
            disabled={pending !== null}
            onClick={() => void run("settings")}
          >
            Open system settings
          </NodexButton>
        ) : null}
      </div>
    </NodexPopoverContent>
  );
}
