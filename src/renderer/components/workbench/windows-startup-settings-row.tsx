import { useIntl } from "@/lib/i18n";
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
  const intl = useIntl();
  const startup = useWindowsStartupSettings(open);
  const status = startup.error
    ? intl.formatMessage({
        id: "settings.windowsStartup.startupStatusUnavailable",
        defaultMessage: "Startup status unavailable",
      })
    : startup.loading
      ? intl.formatMessage({
          id: "settings.windowsStartup.checkingStartupStatus",
          defaultMessage: "Checking startup status…",
        })
      : !startup.status?.supported
        ? intl.formatMessage({
            id: "settings.windowsStartup.availableInInstalledNodex",
            defaultMessage: "Available in installed Nodex",
          })
        : startup.status.enabled
          ? intl.formatMessage({ id: "settings.windowsStartup.on", defaultMessage: "On" })
          : intl.formatMessage({ id: "settings.windowsStartup.off", defaultMessage: "Off" });
  return (
    <NodexSettingsRow
      label={intl.formatMessage({
        id: "settings.windowsStartup.launchAtLogin",
        defaultMessage: "Launch at login",
      })}
      description={status}
    >
      <NodexButton variant="secondary" size="xs" disabled={startup.busy} onClick={startup.open}>
        {intl.formatMessage({
          id: "settings.windowsStartup.openStartupApps",
          defaultMessage: "Open Startup Apps",
        })}
      </NodexButton>
    </NodexSettingsRow>
  );
}
