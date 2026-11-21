import {
  CodexExecutableSettingsControl,
  type CodexExecutableRuntime,
} from "./codex-executable-settings-control";
import { settingsMessages } from "./workbench-settings-search-catalog";
import { getIntl, useIntl } from "@/lib/i18n";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useState } from "react";
import type {
  CodexHomeSettingsSnapshot,
  CodexHomeSettingsUpdateInput,
} from "../../../shared/codex-home-settings";
import { useSettingsRead } from "../../lib/use-settings-read";
import { OpenAIIcon } from "../shared/icons";
import { NodexButton } from "../ui/button";
import { Input } from "../ui/input";
import {
  NodexSettingsRow,
  NodexSettingsSection,
  type NodexSettingsDisclosureState,
} from "../ui/settings";
import {
  CodexSetupImportControl,
  type CodexSetupImportRuntime,
} from "./codex-setup-import-control";
import { CodexSpeedSettingControl } from "./workbench-settings-controls";
import { readCodexHomeSettings, updateCodexHomeSettings } from "./workbench-settings-overlay-deps";

export interface CodexHomeSettingsRuntime {
  readonly read: () => Promise<CodexHomeSettingsSnapshot>;
  readonly update: (input: CodexHomeSettingsUpdateInput) => Promise<CodexHomeSettingsSnapshot>;
}

const defaultRuntime: CodexHomeSettingsRuntime = {
  read: readCodexHomeSettings,
  update: updateCodexHomeSettings,
};

/** What the collapsed Codex section says about the folders Codex runs from. */
export function codexHomeSummary(
  settings: CodexHomeSettingsSnapshot | null,
  intl = getIntl(),
): string | null {
  if (!settings) return null;
  if (settings.restartRequired)
    return intl.formatMessage({
      id: "settings.codex.restartToApply",
      defaultMessage: "Restart to apply",
    });
  const customHome = settings.source !== "default";
  const separateAccount = settings.activeAccountHomePath !== null;
  if (customHome && separateAccount)
    return intl.formatMessage({
      id: "settings.codex.customHomeSeparateAccount",
      defaultMessage: "Custom home · separate account",
    });
  if (customHome)
    return intl.formatMessage({
      id: "settings.codex.customHome",
      defaultMessage: "Custom home",
    });
  return separateAccount
    ? intl.formatMessage({
        id: "settings.codex.separateAccount",
        defaultMessage: "Separate account",
      })
    : intl.formatMessage({
        id: "settings.codex.defaultSetup",
        defaultMessage: "Default setup",
      });
}

function InUsePath({ path }: { readonly path: string | null | undefined }) {
  const intl = useIntl();
  if (!path) return null;
  return (
    <span className="block">
      {intl.formatMessage({ id: "settings.codex.inUse", defaultMessage: "In use: " })}
      <bdi className="font-mono">{path}</bdi>
    </span>
  );
}

/**
 * Settings > Agents > Codex: the speed new Codex chats start with, the native home and account
 * Codex runs from, and setup import.
 */
export function CodexAgentSettingsSection({
  open,
  disclosure,
  unavailable,
  setupAction,
  runtime = defaultRuntime,
  importRuntime,
  executableRuntime,
}: {
  readonly open: boolean;
  readonly disclosure: NodexSettingsDisclosureState;
  readonly unavailable?: string;
  readonly setupAction?: { readonly label: string; readonly run: () => void } | null;
  readonly runtime?: CodexHomeSettingsRuntime;
  readonly importRuntime?: CodexSetupImportRuntime;
  readonly executableRuntime?: CodexExecutableRuntime;
}) {
  const intl = useIntl();
  const [settings, setSettings] = useState<CodexHomeSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [accountDraft, setAccountDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accept = (value: CodexHomeSettingsSnapshot) => {
    setSettings(value);
    setDraft(value.homePath);
    setAccountDraft(value.accountHomePath);
  };
  const {
    reading,
    error: loadError,
    retry,
    serialize,
  } = useSettingsRead(open, () => runtime.read(), accept);
  const editable = settings !== null && !reading && loadError === null && !saving;

  const changed = Boolean(
    settings &&
    (draft.trim() !== settings.homePath || accountDraft.trim() !== settings.accountHomePath),
  );
  const save = async () => {
    if (!editable || !changed) return;
    setSaving(true);
    setError(null);
    return runWithCleanup(
      async () => {
        accept(
          await serialize(() => runtime.update({ homePath: draft, accountHomePath: accountDraft })),
        );
      },
      {
        onError: (cause) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        },
        cleanup: () => {
          setSaving(false);
        },
      },
    );
  };
  const saveOnEnter = (event: { key: string; preventDefault: () => void }) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void save();
  };

  return (
    <NodexSettingsSection
      id="codex"
      title="Codex"
      icon={<OpenAIIcon />}
      description={intl.formatMessage({
        id: "settings.codex.openAIsCodingAgentNodexSharesIts",
        defaultMessage:
          "OpenAI's coding agent. Nodex shares its setup and history with the Codex app and CLI.",
      })}
      summary={
        loadError
          ? intl.formatMessage({
              id: "settings.codex.couldntLoad",
              defaultMessage: "Couldn't load",
            })
          : (unavailable ?? codexHomeSummary(settings, intl))
      }
      disclosure={disclosure}
    >
      {setupAction && unavailable ? (
        <NodexSettingsRow label={unavailable}>
          <NodexButton size="sm" variant="secondary" onClick={setupAction.run}>
            {setupAction.label}
          </NodexButton>
        </NodexSettingsRow>
      ) : null}
      <NodexSettingsRow
        label={intl.formatMessage(settingsMessages.codexSpeed)}
        description={intl.formatMessage(settingsMessages.codexTheSpeedNewCodexChatsStart)}
      >
        <CodexSpeedSettingControl />
      </NodexSettingsRow>
      <CodexExecutableSettingsControl open={open && disclosure.open} runtime={executableRuntime} />
      <NodexSettingsRow
        label={intl.formatMessage(settingsMessages.codexCodexHome)}
        description={
          <>
            {intl.formatMessage(settingsMessages.codexSettingsSkillsAndConversationHistory)}
            <InUsePath path={settings?.activeHomePath} />
          </>
        }
      >
        <Input
          aria-label={intl.formatMessage(settingsMessages.codexCodexHome)}
          className="w-64 max-w-full"
          value={draft}
          placeholder={intl.formatMessage({
            id: "settings.codex.default",
            defaultMessage: "Default",
          })}
          disabled={!editable}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={saveOnEnter}
        />
      </NodexSettingsRow>
      <NodexSettingsRow
        label={intl.formatMessage(settingsMessages.codexAccountDirectory)}
        description={
          <>
            {intl.formatMessage({
              id: "settings.codex.aSeparateFolderForAnotherCodex",
              defaultMessage: "A separate folder for another Codex sign-in. History stays shared.",
            })}
            <InUsePath path={settings?.activeAccountHomePath} />
          </>
        }
      >
        <Input
          aria-label={intl.formatMessage({
            id: "settings.codex.codexAccountDirectory",
            defaultMessage: "Codex account directory",
          })}
          className="w-64 max-w-full"
          value={accountDraft}
          placeholder={intl.formatMessage({
            id: "settings.codex.sameAsCodexHome",
            defaultMessage: "Same as Codex home",
          })}
          disabled={!editable}
          spellCheck={false}
          onChange={(event) => setAccountDraft(event.target.value)}
          onKeyDown={saveOnEnter}
        />
      </NodexSettingsRow>
      {loadError ? (
        <div className="flex items-center gap-3 px-4 py-3">
          <p role="alert" className="min-w-0 flex-1 text-xs text-danger">
            {intl.formatMessage({
              id: "settings.codex.couldntLoadTheCodexFolders",
              defaultMessage: "Couldn't load the Codex folders. ",
            })}
            {loadError}
          </p>
          <NodexButton size="xs" variant="secondary" onClick={retry}>
            {intl.formatMessage({ id: "settings.codex.tryAgain", defaultMessage: "Try again" })}
          </NodexButton>
        </div>
      ) : changed || settings?.restartRequired || error ? (
        <div className="flex min-h-12 flex-wrap items-center justify-end gap-2 px-4 py-2.5">
          <span className="min-w-0 flex-1 text-xs">
            {error ? (
              <span role="alert" className="text-danger">
                {error}
              </span>
            ) : changed ? (
              <span className="text-token-text-secondary">
                {intl.formatMessage({
                  id: "settings.codex.appliesAfterRestartingNodex",
                  defaultMessage: "Applies after restarting Nodex.",
                })}
              </span>
            ) : (
              <span role="status" className="text-token-text-secondary">
                {intl.formatMessage({
                  id: "settings.codex.restartNodexToApplyTheSaved",
                  defaultMessage: "Restart Nodex to apply the saved directories.",
                })}
              </span>
            )}
          </span>
          {changed ? (
            <>
              <NodexButton
                variant="ghost"
                size="sm"
                disabled={!editable}
                onClick={() => {
                  if (!settings) return;
                  setDraft(settings.homePath);
                  setAccountDraft(settings.accountHomePath);
                  setError(null);
                }}
              >
                {intl.formatMessage({ id: "settings.codex.discard", defaultMessage: "Discard" })}
              </NodexButton>
              <NodexButton
                variant="secondary"
                size="sm"
                disabled={!editable}
                onClick={() => void save()}
              >
                {saving
                  ? intl.formatMessage({ id: "settings.codex.saving", defaultMessage: "Saving…" })
                  : intl.formatMessage({ id: "settings.codex.save", defaultMessage: "Save" })}
              </NodexButton>
            </>
          ) : null}
        </div>
      ) : null}
      <CodexSetupImportControl open={open} runtime={importRuntime} />
    </NodexSettingsSection>
  );
}
