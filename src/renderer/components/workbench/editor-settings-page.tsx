import type { ReactNode } from "react";
import { useIntl } from "@/lib/i18n";
import {
  NodexSettingsPageSurface as SettingsPageSurface,
  NodexSettingsRow as SettingRow,
  NodexSettingsSection as SectionBlock,
} from "../ui/settings";
import {
  CopyFileReferencesAsLocalPathsSettingControl,
  FileLinkOpenerSettingControl,
  NfmAutolinkBareDomainsSettingControl,
  NfmAutolinkPasteSettingControl,
  NfmAutolinkTypingSettingControl,
  PasteResourceDescriptionSoftLimitSettingControl,
  PasteResourceTextThresholdSettingControl,
  SpellcheckSettingControl,
  TaskShorthandPagePromotionSettingControl,
} from "./workbench-settings-controls";
import { settingsMessages } from "./workbench-settings-search-catalog";
import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";

/** Settings › Editor: how typing, pasting and links behave in Pages and chats. */
export function EditorSettingsPage({
  onTaskShorthandPagePromotionEnabledChange,
  taskShorthandPagePromotionEnabled,
}: SettingsSectionPageProps) {
  const intl = useIntl();
  const row = (
    label: keyof typeof settingsMessages,
    description: keyof typeof settingsMessages,
    control: ReactNode,
  ) => (
    <SettingRow
      label={intl.formatMessage(settingsMessages[label])}
      description={intl.formatMessage(settingsMessages[description])}
    >
      {control}
    </SettingRow>
  );
  return (
    <SettingsPageSurface
      title={intl.formatMessage(settingsMessages.editorTitle)}
      subtitle={intl.formatMessage(settingsMessages.editorSubtitle)}
    >
      <SectionBlock id="typing" title={intl.formatMessage(settingsMessages.editorTyping)}>
        {row(
          "generalSpellcheck",
          "generalMarkMisspelledWordsWhereverYouType",
          <SpellcheckSettingControl />,
        )}
        {row(
          "generalAutoLinkWhileTyping",
          "generalTurnTypedURLsIntoLinksAs",
          <NfmAutolinkTypingSettingControl />,
        )}
        {row(
          "generalRecognizeBareDomains",
          "generalLinkPlainDomainsLikeExampleCom",
          <NfmAutolinkBareDomainsSettingControl />,
        )}
      </SectionBlock>
      <SectionBlock id="pasting" title={intl.formatMessage(settingsMessages.editorPasting)}>
        {row(
          "generalAutoLinkOnPaste",
          "generalRecognizeLinksInPastedTextIncluding",
          <NfmAutolinkPasteSettingControl />,
        )}
        {row(
          "generalLargePasteTextThreshold",
          "generalPromptWhenPastedPlainTextReaches",
          <PasteResourceTextThresholdSettingControl />,
        )}
        {row(
          "generalLargePasteDescriptionSoftLimit",
          "generalPromptBeforePastedPlainTextPushes",
          <PasteResourceDescriptionSoftLimitSettingControl />,
        )}
      </SectionBlock>
      <SectionBlock id="pages" title={intl.formatMessage(settingsMessages.pageTitle)}>
        {row(
          "pageTaskShorthandLabel",
          "pageTaskShorthandDescription",
          <TaskShorthandPagePromotionSettingControl
            value={taskShorthandPagePromotionEnabled}
            onChange={onTaskShorthandPagePromotionEnabledChange}
          />,
        )}
      </SectionBlock>
      <SectionBlock
        id="files-and-links"
        title={intl.formatMessage(settingsMessages.generalFilesLinks)}
      >
        {row(
          "generalCopyFileReferencesAsLocalPaths",
          "generalUseAbsoluteLocalPathsInCopied",
          <CopyFileReferencesAsLocalPathsSettingControl />,
        )}
        {row(
          "generalMarkdownFileLinks",
          "generalChooseWhichDesktopAppHandlesAbsolute",
          <FileLinkOpenerSettingControl />,
        )}
      </SectionBlock>
    </SettingsPageSurface>
  );
}
