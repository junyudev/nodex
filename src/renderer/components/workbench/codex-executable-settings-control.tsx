import { useState } from "react";
import { useIntl, type IntlShape } from "@/lib/i18n";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useSettingsRead } from "@/lib/use-settings-read";
import { readCodexExecutable, updateCodexExecutable } from "@/lib/workbench-settings-runtime";
import { type CodexExecutableSettings } from "../../../shared/codex-executable-settings";
import { CODEX_APP_SERVER_MINIMUM_VERSION } from "../../../shared/codex-app-server-version";
import { Input } from "../ui/input";
import { NodexSettingsRow } from "../ui/settings";
import { settingsMessages } from "./workbench-settings-search-catalog";

export interface CodexExecutableRuntime {
  readonly read: typeof readCodexExecutable;
  readonly update: typeof updateCodexExecutable;
}

const defaultRuntime = { read: readCodexExecutable, update: updateCodexExecutable };

function versionStatus(settings: CodexExecutableSettings | null, intl: IntlShape) {
  const probe = settings?.probe;
  switch (probe?.status) {
    case "ready":
      return probe.version === settings?.pinnedVersion
        ? intl.formatMessage(
            { id: "settings.codex.executableVersion", defaultMessage: "Codex {version}" },
            { version: probe.version },
          )
        : intl.formatMessage(
            {
              id: "settings.codex.executableDifferentVersion",
              defaultMessage:
                "Nodex is tested with Codex {pinned}. Yours is {version}; some features may not work.",
            },
            { pinned: settings?.pinnedVersion ?? "", version: probe.version },
          );
    case "too-old":
      return intl.formatMessage(
        {
          id: "settings.codex.executableTooOld",
          defaultMessage: "Codex {version} · Too old: needs {minimum} or newer",
        },
        { version: probe.version, minimum: CODEX_APP_SERVER_MINIMUM_VERSION },
      );
    case "not-found":
      return intl.formatMessage({
        id: "settings.codex.executableNotFound",
        defaultMessage: "Not found",
      });
    case "invalid-version":
      return intl.formatMessage({
        id: "settings.codex.executableUnknownVersion",
        defaultMessage: "Version not recognized",
      });
    case "probe-failed":
      return intl.formatMessage({
        id: "settings.codex.executableProbeFailed",
        defaultMessage: "Couldn’t check the version",
      });
    default:
      return null;
  }
}

export function CodexExecutableSettingsControl({
  open,
  runtime = defaultRuntime,
}: {
  readonly open: boolean;
  readonly runtime?: CodexExecutableRuntime;
}) {
  const intl = useIntl();
  const [settings, setSettings] = useState<CodexExecutableSettings | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const accept = (value: CodexExecutableSettings) => {
    setSettings(value);
    setDraft(value.executable);
  };
  const { reading, error, serialize } = useSettingsRead(open, runtime.read, accept);
  const editable = settings !== null && !reading && !saving && !error;
  const save = () => {
    const next = draft.trim();
    if (!editable || next === settings.executable) return;
    setSaving(true);
    setSaveError(null);
    void runWithCleanup(async () => accept(await serialize(() => runtime.update(next))), {
      onError: (cause) => setSaveError(cause instanceof Error ? cause.message : String(cause)),
      cleanup: () => setSaving(false),
    });
  };
  const status = saveError ?? error ?? versionStatus(settings, intl);
  return (
    <NodexSettingsRow
      id="codex-executable"
      label={intl.formatMessage(settingsMessages.codexExecutable)}
      description={
        <>
          {intl.formatMessage(settingsMessages.codexExecutableDescription)}
          {status ? (
            <span className="block tabular-nums" role="status">
              {status}
            </span>
          ) : null}
          {settings?.probe?.status === "ready" || settings?.activeExecutable ? (
            <span className="block">
              {intl.formatMessage({
                id: "settings.codex.executableDesktopTools",
                defaultMessage:
                  "Desktop Tools stay off in Codex chats while you use your own Codex.",
              })}
            </span>
          ) : null}
          {settings && settings.executable !== settings.activeExecutable ? (
            <span className="block">
              {intl.formatMessage({
                id: "settings.codex.executableRestart",
                defaultMessage: "Applies after restarting Nodex",
              })}
            </span>
          ) : null}
        </>
      }
    >
      <Input
        aria-label={intl.formatMessage(settingsMessages.codexExecutable)}
        className="w-64 max-w-full"
        value={draft}
        disabled={!editable}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          event.currentTarget.blur();
        }}
      />
    </NodexSettingsRow>
  );
}
