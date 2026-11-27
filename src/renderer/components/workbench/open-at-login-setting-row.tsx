import { useIntl } from "@/lib/i18n";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import { readSettingsHostPresentation } from "@/lib/settings-host-presentation";
import { useOpenAtLoginSettings } from "@/lib/open-at-login-settings";
import { NodexSettingsRow } from "../ui/settings";
import { settingsMessages } from "./workbench-settings-search-catalog";

export function OpenAtLoginSettingRow({ open }: { readonly open: boolean }) {
  if (!readSettingsHostPresentation().launchAtLogin) return null;
  return <OpenAtLoginControl open={open} />;
}

function OpenAtLoginControl({ open }: { readonly open: boolean }) {
  const intl = useIntl();
  const login = useOpenAtLoginSettings(open);
  const label = intl.formatMessage(settingsMessages.generalOpenAtLogin);
  const description = intl.formatMessage(settingsMessages.generalOpenAtLoginDescription);
  const needsApproval = login.status === "requires-approval";
  let feedback: string | undefined;
  if (login.openFailed) {
    feedback = intl.formatMessage({
      id: "settings.openAtLogin.openFailed",
      defaultMessage: "Couldn’t open System Settings.",
    });
  } else if (login.changeFailed) {
    feedback = intl.formatMessage({
      id: "settings.openAtLogin.changeFailed",
      defaultMessage: "Couldn’t change the login item.",
    });
  } else if (login.readFailed) {
    feedback = intl.formatMessage({
      id: "settings.openAtLogin.readFailed",
      defaultMessage: "Login item status unavailable.",
    });
  } else if (needsApproval) {
    feedback = intl.formatMessage({
      id: "settings.openAtLogin.approvalRequired",
      defaultMessage: "Allow Nodex under Login Items in System Settings.",
    });
  } else if (login.status === "unavailable") {
    feedback = intl.formatMessage({
      id: "settings.openAtLogin.unavailable",
      defaultMessage: "Login item unavailable.",
    });
  }
  return (
    <NodexSettingsRow
      label={label}
      description={
        <>
          {description}
          {feedback ? <span role="status"> {feedback}</span> : null}
        </>
      }
    >
      {needsApproval ? (
        <NodexButton
          variant="secondary"
          size="xs"
          disabled={login.openingSettings}
          onClick={() => login.openSettings()}
        >
          {intl.formatMessage({
            id: "settings.openAtLogin.openSystemSettings",
            defaultMessage: "Open System Settings",
          })}
        </NodexButton>
      ) : null}
      <NodexSwitch
        ariaLabel={label}
        checked={login.status === "enabled" || needsApproval}
        disabled={
          login.saving || login.readFailed || !login.status || login.status === "unavailable"
        }
        onCheckedChange={(enabled) => login.set(enabled)}
      />
    </NodexSettingsRow>
  );
}
