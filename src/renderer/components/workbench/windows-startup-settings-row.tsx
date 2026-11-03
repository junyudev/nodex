import { NodexButton } from "@/components/ui/button";
import { readSettingsHostPresentation } from "@/lib/settings-host-presentation";
import { useWindowsStartupSettings } from "@/lib/windows-startup-runtime";
import { NodexSettingsRow } from "../ui/settings";

export function WindowsStartupSettingsRow({ open }: { readonly open: boolean }) {
  const available = readSettingsHostPresentation().launchAtLogin;
  if (!available) return null;
  return <WindowsStartupControl open={open} />;
}

function WindowsStartupControl({ open }: { readonly open: boolean }) {
  const startup = useWindowsStartupSettings(open);
  const status = startup.error
    ? "Startup status unavailable"
    : startup.loading
      ? "Checking startup status…"
      : !startup.status?.supported
        ? "Available in installed Nodex"
        : startup.status.enabled
          ? "On"
          : "Off";
  return (
    <NodexSettingsRow label="Launch at login" description={status}>
      <NodexButton variant="secondary" size="xs" disabled={startup.busy} onClick={startup.open}>
        Open Startup Apps
      </NodexButton>
    </NodexSettingsRow>
  );
}
