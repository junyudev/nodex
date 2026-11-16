import { WINDOWS_TERMINAL_SHELL_LABEL_MESSAGES } from "../../../shared/terminal-shell-settings";
import { defineMessages, getIntl, type IntlShape, type MessageDescriptor } from "@/lib/i18n";
import { readSettingsHostPresentation } from "@/lib/settings-host-presentation";
import { buildSettingsSearchResults } from "@/lib/settings-search";
import { scoreSettingsQueryMatch } from "@/lib/settings-search-score";
import { DEFAULT_WORKTREE_AUTO_BRANCH_PREFIX } from "../../lib/worktree-branch-prefix";
import {
  FILE_LINK_OPENER_LABEL_MESSAGES,
  FILE_LINK_OPENER_OPTIONS,
} from "../../../shared/file-link-openers";

type SearchMessage =
  | string
  | MessageDescriptor
  | {
      message: MessageDescriptor;
      values: Record<string, string>;
    };

interface SettingsSearchCatalogSection {
  messages: readonly SearchMessage[] | (() => readonly SearchMessage[]);
}

interface SettingsSearchCatalogPanel {
  title: SearchMessage;
  subtitle?: SearchMessage;
  groups: readonly SettingsSearchCatalogGroup[];
  messages?: readonly SearchMessage[];
}

interface SettingsSearchCatalogGroup {
  anchor?: string;
  title: SearchMessage;
  description?: SearchMessage;
  entries?: readonly SettingsSearchCatalogEntry[];
  messages?: readonly SearchMessage[];
}

interface SettingsSearchCatalogEntry {
  visibleWhen?: () => boolean;
  label: SearchMessage;
  description?: SearchMessage;
  terms?: readonly SearchMessage[];
}

function entry(
  label: SearchMessage,
  description?: SearchMessage,
  terms: readonly SearchMessage[] = [],
  visibleWhen?: () => boolean,
): SettingsSearchCatalogEntry {
  return { description, label, terms, visibleWhen };
}

function formatSearchMessage(value: SearchMessage, intl?: IntlShape): string {
  if (typeof value === "string") return value;
  if ("message" in value) {
    if (intl) return intl.formatMessage(value.message, value.values);
    return String(value.message.defaultMessage ?? "").replace(
      /\{(\w+)\}/g,
      (_, key: string) => value.values[key] ?? "",
    );
  }
  return intl ? intl.formatMessage(value) : String(value.defaultMessage ?? "");
}

function indexSearchMessages(messages: readonly SearchMessage[], intl: IntlShape) {
  const labels = new Map<string, string>();
  for (const message of messages) {
    const text = formatSearchMessage(message, intl);
    labels.set(text, text);
    labels.set(formatSearchMessage(message), text);
  }
  return labels;
}

function uniqueText(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const texts: string[] = [];

  const collect = (value: unknown) => {
    if (typeof value === "string") {
      const text = value.trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      texts.push(text);
      return;
    }

    if (!Array.isArray(value)) return;

    for (const entry of value) {
      collect(entry);
    }
  };

  for (const value of values) {
    collect(value);
  }

  return texts;
}

function materializePanelSearchMessages(
  panel: SettingsSearchCatalogPanel,
): readonly SearchMessage[] {
  return [
    panel.title,
    ...(panel.subtitle ? [panel.subtitle] : []),
    ...(panel.messages ?? []),
    ...panel.groups.flatMap((group) => [
      group.title,
      ...(group.description ? [group.description] : []),
      ...(group.messages ?? []),
      ...(group.entries ?? []).flatMap((setting) => {
        if (setting.visibleWhen?.() === false) return [];
        return [
          setting.label,
          ...(setting.description ? [setting.description] : []),
          ...(setting.terms ?? []),
        ];
      }),
    ]),
  ];
}

export const settingsMessages = defineMessages({
  pluginsSearchManage: {
    id: "settings.search.plugins.manage",
    defaultMessage: "Manage plugins, skills, and MCPs",
  },
  pluginsSearchBrowse: { id: "settings.search.plugins.browse", defaultMessage: "Browse directory" },
  pluginsSearchAddMarketplace: {
    id: "settings.search.plugins.addMarketplace",
    defaultMessage: "Add a marketplace",
  },
  pluginsSearchSkills: { id: "settings.search.plugins.skills", defaultMessage: "Skills" },
  browserSearchProfile: {
    id: "settings.search.browser.profile",
    defaultMessage: "Built-in Browser Profile",
  },
  browserSearchImportData: {
    id: "settings.search.browser.importData",
    defaultMessage: "Import browser data",
  },
  browserSearchCookies: { id: "settings.search.browser.cookies", defaultMessage: "Cookies" },
  browserSearchSiteData: { id: "settings.search.browser.siteData", defaultMessage: "Site data" },
  browserSearchCache: { id: "settings.search.browser.cache", defaultMessage: "Cache" },
  browserSearchDownloadHistory: {
    id: "settings.search.browser.downloadHistory",
    defaultMessage: "Download history",
  },
  browserSearchProviderAvailability: {
    id: "settings.search.browser.providerAvailability",
    defaultMessage: "Provider availability",
  },
  browserSearchAutofillAndPasswords: {
    id: "settings.search.browser.autofillAndPasswords",
    defaultMessage: "Autofill and passwords",
  },
  browserSearchSavedPasswords: {
    id: "settings.search.browser.savedPasswords",
    defaultMessage: "Saved passwords",
  },
  browserSearchPasswordManager: {
    id: "settings.search.browser.passwordManager",
    defaultMessage: "Password manager",
  },
  browserSearchCredentialStorage: {
    id: "settings.search.browser.credentialStorage",
    defaultMessage: "Credential storage",
  },
  browserSearchImportFromBrowser: {
    id: "settings.search.browser.importFromBrowser",
    defaultMessage: "Import from your browser",
  },
  browserSearchRemovePassword: {
    id: "settings.search.browser.removePassword",
    defaultMessage: "Remove password",
  },
  browserSearchContactInfo: {
    id: "settings.search.browser.contactInfo",
    defaultMessage: "Contact info",
  },
  browserSearchAutofill: { id: "settings.search.browser.autofill", defaultMessage: "Autofill" },
  browserSearchName: { id: "settings.search.browser.name", defaultMessage: "Name" },
  browserSearchEmail: { id: "settings.search.browser.email", defaultMessage: "Email" },
  browserSearchPhone: { id: "settings.search.browser.phone", defaultMessage: "Phone" },
  browserSearchAddress: { id: "settings.search.browser.address", defaultMessage: "Address" },
  browserSearchHistory: { id: "settings.search.browser.history", defaultMessage: "History" },
  browserSearchSearchHistory: {
    id: "settings.search.browser.searchHistory",
    defaultMessage: "Search history",
  },
  browserSearchClearHistory: {
    id: "settings.search.browser.clearHistory",
    defaultMessage: "Clear Browser history",
  },
  browserSearchVisitedPages: {
    id: "settings.search.browser.visitedPages",
    defaultMessage: "Visited pages",
  },
  browserSearchExtensions: {
    id: "settings.search.browser.extensions",
    defaultMessage: "Extensions",
  },
  browserSearchControlExistingBrowsers: {
    id: "settings.search.browser.controlExistingBrowsers",
    defaultMessage: "Control existing browsers",
  },
  browserSearchWaitingForExtension: {
    id: "settings.search.browser.waitingForExtension",
    defaultMessage: "Waiting for extension",
  },
  browserSearchControlProvider: {
    id: "settings.search.browser.controlProvider",
    defaultMessage: "Browser control provider",
  },
  browserSearchExtensionManager: {
    id: "settings.search.browser.extensionManager",
    defaultMessage: "Extension manager",
  },
  browserSearchLoadUnpacked: {
    id: "settings.search.browser.loadUnpacked",
    defaultMessage: "Load unpacked",
  },
  browserSearchRemoveExtension: {
    id: "settings.search.browser.removeExtension",
    defaultMessage: "Remove extension",
  },
  browserSearchSharedProfile: {
    id: "settings.search.browser.sharedProfile",
    defaultMessage: "Shared Browser Profile",
  },
  browserSearchDownloads: { id: "settings.search.browser.downloads", defaultMessage: "Downloads" },
  browserSearchPermissions: {
    id: "settings.search.browser.permissions",
    defaultMessage: "Permissions",
  },
  browserSearchWebsiteAccess: {
    id: "settings.search.browser.websiteAccess",
    defaultMessage: "Website access",
  },
  browserSearchBrowsingHistory: {
    id: "settings.search.browser.browsingHistory",
    defaultMessage: "Browsing history",
  },
  browserSearchUploads: { id: "settings.search.browser.uploads", defaultMessage: "Uploads" },
  browserSearchSitePermissions: {
    id: "settings.search.browser.sitePermissions",
    defaultMessage: "Site permissions",
  },
  browserSearchRememberedOrigins: {
    id: "settings.search.browser.rememberedOrigins",
    defaultMessage: "Remembered origins",
  },
  browserSearchDeveloperMode: {
    id: "settings.search.browser.developerMode",
    defaultMessage: "Developer mode",
  },
  browserSearchFullCdpAccess: {
    id: "settings.search.browser.fullCdpAccess",
    defaultMessage: "Full CDP access",
  },
  inboxSearchSubtitle: {
    id: "settings.search.inbox.subtitle",
    defaultMessage: "How messages you capture are suggested and dispatched.",
  },
  inboxSearchSuggestions: {
    id: "settings.search.inbox.suggestions",
    defaultMessage: "Suggestions",
  },
  inboxSearchSuggestDestination: {
    id: "settings.search.inbox.suggestDestination",
    defaultMessage: "Suggest where messages go",
  },
  inboxSearchSuggestDestinationDescription: {
    id: "settings.search.inbox.suggestDestinationDescription",
    defaultMessage: "An Agent reads new messages and proposes a chat, a Project, or keeping them.",
  },
  inboxSearchSuggestWith: {
    id: "settings.search.inbox.suggestWith",
    defaultMessage: "Suggest with",
  },
  inboxSearchSuggestWithDescription: {
    id: "settings.search.inbox.suggestWithDescription",
    defaultMessage: "The Agent and model that write suggestions.",
  },
  inboxSearchAutoStart: {
    id: "settings.search.inbox.autoStart",
    defaultMessage: "Let Nodex start chats for me",
  },
  inboxSearchAutoStartDescription: {
    id: "settings.search.inbox.autoStartDescription",
    defaultMessage: "What you clearly ask for starts without a click.",
  },
  inboxSearchRoutingPreferences: {
    id: "settings.search.inbox.routingPreferences",
    defaultMessage: "Routing preferences",
  },
  inboxSearchRoutingPreferencesDescription: {
    id: "settings.search.inbox.routingPreferencesDescription",
    defaultMessage: "Standing instructions suggestions follow over Nodex's own guidance.",
  },
  inboxSearchChats: { id: "settings.search.inbox.chats", defaultMessage: "Chats" },
  inboxSearchShowMessage: {
    id: "settings.search.inbox.showMessage",
    defaultMessage: "Show the message beside new chats",
  },
  inboxSearchShowMessageDescription: {
    id: "settings.search.inbox.showMessageDescription",
    defaultMessage: "A chat the Inbox starts opens with its message's Page in the right panel.",
  },
  inboxSearchNewChatsRunOn: {
    id: "settings.search.inbox.newChatsRunOn",
    defaultMessage: "New chats run on",
  },
  inboxSearchNewChatsRunOnDescription: {
    id: "settings.search.inbox.newChatsRunOnDescription",
    defaultMessage: "The Agent, model and effort for chats the Inbox starts.",
  },
  modelsSearchSubtitle: {
    id: "settings.search.models.subtitle",
    defaultMessage: "Off models leave every picker, and nothing in Nodex can start them.",
  },
  modelsSearchAllowChoice: {
    id: "settings.search.models.allowChoice",
    defaultMessage: "Let Agents choose Nodex models",
  },
  modelsSearchAllowChoiceDescription: {
    id: "settings.search.models.allowChoiceDescription",
    defaultMessage: "Whether an Agent can spend your credits.",
  },
  modelsSearchTurnOff: { id: "settings.search.models.turnOff", defaultMessage: "Turn models off" },
  modelsSearchTurnOffDescription: {
    id: "settings.search.models.turnOffDescription",
    defaultMessage: "Remove models you don't use from every picker.",
  },
  voiceSearchSubtitle: {
    id: "settings.search.voice.subtitle",
    defaultMessage: "Microphone, dictation behavior, and recoverable recordings.",
  },
  voiceSearchGeneral: { id: "settings.search.voice.general", defaultMessage: "General" },
  voiceSearchMicrophone: { id: "settings.search.voice.microphone", defaultMessage: "Microphone" },
  voiceSearchMicrophoneUse: {
    id: "settings.search.voice.microphoneUse",
    defaultMessage: "Used for voice chat and dictation",
  },
  voiceSearchSystemDefault: {
    id: "settings.search.voice.systemDefault",
    defaultMessage: "System default",
  },
  voiceSearchAllowAccess: {
    id: "settings.search.voice.allowAccess",
    defaultMessage: "Allow access",
  },
  voiceSearchOpenSettings: {
    id: "settings.search.voice.openSettings",
    defaultMessage: "Open settings",
  },
  voiceSearchDictation: { id: "settings.search.voice.dictation", defaultMessage: "Dictation" },
  voiceSearchHoldHotkey: {
    id: "settings.search.voice.holdHotkey",
    defaultMessage: "Hold-to-dictate hotkey",
  },
  voiceSearchToggleHotkey: {
    id: "settings.search.voice.toggleHotkey",
    defaultMessage: "Toggle dictation hotkey",
  },
  voiceSearchGlobalBar: {
    id: "settings.search.voice.globalBar",
    defaultMessage: "Keep global bar visible",
  },
  voiceSearchSounds: {
    id: "settings.search.voice.sounds",
    defaultMessage: "Play dictation sounds",
  },
  voiceSearchDictionary: {
    id: "settings.search.voice.dictionary",
    defaultMessage: "Dictation dictionary",
  },
  voiceSearchDictionaryDescription: {
    id: "settings.search.voice.dictionaryDescription",
    defaultMessage: "Words or phrases dictation should recognize",
  },
  voiceSearchAddEntry: { id: "settings.search.voice.addEntry", defaultMessage: "Add entry" },
  voiceSearchRecordings: {
    id: "settings.search.voice.recordings",
    defaultMessage: "Recent recordings",
  },
  voiceSearchCopyTranscript: {
    id: "settings.search.voice.copyTranscript",
    defaultMessage: "Copy transcript",
  },
  voiceSearchRetry: { id: "settings.search.voice.retry", defaultMessage: "Retry" },
  voiceSearchDownloadRecording: {
    id: "settings.search.voice.downloadRecording",
    defaultMessage: "Download recording",
  },
  voiceSearchDeleteRecording: {
    id: "settings.search.voice.deleteRecording",
    defaultMessage: "Delete recording",
  },
  accountSearchSubtitle: {
    id: "settings.search.account.subtitle",
    defaultMessage: "Optional. Everything local works without signing in.",
  },
  accountSearchAccount: { id: "settings.search.account.account", defaultMessage: "Nodex Account" },
  accountSearchSignIn: { id: "settings.search.account.signIn", defaultMessage: "Sign in" },
  accountSearchSignOut: { id: "settings.search.account.signOut", defaultMessage: "Sign out" },
  accountSearchCredits: { id: "settings.search.account.credits", defaultMessage: "Credits" },
  accountSearchTopUp: { id: "settings.search.account.topUp", defaultMessage: "Top up" },
  accountSearchBuyCredits: {
    id: "settings.search.account.buyCredits",
    defaultMessage: "Buy Nodex credits.",
  },
  accountSearchModelPrices: {
    id: "settings.search.account.modelPrices",
    defaultMessage: "Model prices",
  },
  accountSearchModelCost: {
    id: "settings.search.account.modelCost",
    defaultMessage: "What each model costs in credits.",
  },
  accountTitle: { id: "settings.account.title", defaultMessage: "Account" },
  generalGeneral: { id: "settings.general.title", defaultMessage: "General" },
  generalHowNodexStartsAndUpdatesHow: {
    id: "settings.general.subtitle",
    defaultMessage:
      "How Nodex starts and updates, how chats and writing behave, and what you share.",
  },
  generalApp: { id: "settings.general.app.title", defaultMessage: "App" },
  generalRestoreWindows: {
    id: "settings.general.restoreWindows.label",
    defaultMessage: "Restore windows",
  },
  generalChooseWhichWindowsReopenAfterQuitting: {
    id: "settings.general.restoreWindows.description",
    defaultMessage: "Choose which windows reopen after quitting Nodex.",
  },
  generalAll: { id: "settings.general.all", defaultMessage: "All" },
  generalLast: { id: "settings.general.last", defaultMessage: "Last" },
  generalNone: { id: "settings.general.none", defaultMessage: "None" },
  terminalShellTerminalShell: {
    id: "settings.terminalShell.terminalShell",
    defaultMessage: "Terminal shell",
  },
  terminalShellAppliesToNewTerminals: {
    id: "settings.terminalShell.appliesToNewTerminals",
    defaultMessage: "Applies to new terminals.",
  },
  terminalShellAutomatic: { id: "settings.terminalShell.automatic", defaultMessage: "Automatic" },
  generalNodexVersion: { id: "settings.general.nodexVersion", defaultMessage: "Nodex version" },
  generalCheckForUpdatesOrRestartTo: {
    id: "settings.general.checkForUpdatesOrRestartTo",
    defaultMessage: "Check for updates, or restart to install a downloaded one.",
  },
  appUpdatesCheckNow: { id: "settings.appUpdates.checkNow", defaultMessage: "Check now" },
  appUpdatesRestartToUpdate: {
    id: "settings.appUpdates.restartToUpdate",
    defaultMessage: "Restart to update",
  },
  appUpdatesCheckAutomatically: {
    id: "settings.appUpdates.checkAutomatically",
    defaultMessage: "Check automatically",
  },
  appUpdatesLookForUpdatesInTheBackground: {
    id: "settings.appUpdates.lookForUpdatesInTheBackground",
    defaultMessage: "Look for updates in the background and download them when they're ready.",
  },
  appUpdatesUpdateChannel: {
    id: "settings.appUpdates.updateChannel",
    defaultMessage: "Update channel",
  },
  appUpdatesNightlyGetsNewBuildsFirstSwitching: {
    id: "settings.appUpdates.nightlyGetsNewBuildsFirstSwitching",
    defaultMessage:
      "Nightly gets new builds first. Switching channels never installs an older build.",
  },
  appUpdatesStable: { id: "settings.appUpdates.stable", defaultMessage: "Stable" },
  appUpdatesNightly: { id: "settings.appUpdates.nightly", defaultMessage: "Nightly" },
  generalRunSetupAgain: {
    id: "settings.general.runSetup.label",
    defaultMessage: "Run setup again",
  },
  generalConnectAgentsAndAddProjects: {
    id: "settings.general.runSetup.description",
    defaultMessage: "Connect Agents and add projects.",
  },
  generalOpenSourceLicenses: {
    id: "settings.openSourceLicenses.rowLabel",
    defaultMessage: "Open source licenses",
  },
  generalThirdPartyNoticesForBundledDependencies: {
    id: "settings.openSourceLicenses.rowDescription",
    defaultMessage: "Third-party notices for bundled dependencies.",
  },
  usageMetersUsageMeters: {
    id: "settings.usageMeters.usageMeters",
    defaultMessage: "Usage meters",
  },
  generalShowClaudeUsageInTheRail: {
    id: "settings.general.showClaudeUsageInTheRail",
    defaultMessage: "Show Claude usage in the rail.",
  },
  generalShowCodexUsageInTheRail: {
    id: "settings.general.showCodexUsageInTheRail",
    defaultMessage: "Show Codex usage in the rail.",
  },
  usageMetersNodexCredits: {
    id: "settings.usageMeters.nodexCredits",
    defaultMessage: "Nodex credits",
  },
  generalShowNodexCreditsInTheRail: {
    id: "settings.general.showNodexCreditsInTheRail",
    defaultMessage: "Show Nodex credits in the rail.",
  },
  generalChats: { id: "settings.general.chats.title", defaultMessage: "Chats" },
  generalThreadDetail: {
    id: "settings.general.threadDetail.label",
    defaultMessage: "Thread detail",
  },
  generalChooseHowMuchCommandOutputTo: {
    id: "settings.general.threadDetail.description",
    defaultMessage: "Choose how much command output to show in threads.",
  },
  generalSteps: { id: "settings.general.steps", defaultMessage: "Steps" },
  generalStepsWithCodeCommands: {
    id: "settings.general.stepsWithCodeCommands",
    defaultMessage: "Steps with code commands",
  },
  generalStepsWithCodeOutput: {
    id: "settings.general.stepsWithCodeOutput",
    defaultMessage: "Steps with code output",
  },
  generalHideCommandsAndOutputs: {
    id: "settings.general.hideCommandsAndOutputs",
    defaultMessage: "Hide commands and outputs.",
  },
  generalShowCommandsCollapseOutput: {
    id: "settings.general.showCommandsCollapseOutput",
    defaultMessage: "Show commands, collapse output.",
  },
  generalShowCommandsAndExpandOutput: {
    id: "settings.general.showCommandsAndExpandOutput",
    defaultMessage: "Show commands and expand output.",
  },
  generalShowPredictions: {
    id: "settings.general.messagePredictions.label",
    defaultMessage: "Show predictions",
  },
  generalSuggestYourNextMessageAfterAn: {
    id: "settings.general.messagePredictions.description",
    defaultMessage: "Suggest your next message after an agent replies.",
  },
  generalEnterToSendLongPrompts: {
    id: "settings.general.enterBehavior.label",
    defaultMessage: "{modifier}+Enter to send long prompts",
  },
  generalSingleLinePromptsStillSendOn: {
    id: "settings.general.enterBehavior.description",
    defaultMessage:
      "Single-line prompts still send on Enter. Multiline prompts send with the modifier instead.",
  },
  generalQueueFollowUps: {
    id: "settings.general.queueFollowUps.label",
    defaultMessage: "Queue follow-ups",
  },
  generalWhileAThreadIsRunningQueue: {
    id: "settings.general.queueFollowUps.description",
    defaultMessage:
      "While a thread is running, queue new messages by default instead of steering it right away.",
  },
  chatTitleModelLabel: { id: "settings.chatTitle.model.label", defaultMessage: "Title chats with" },
  chatTitleModelDescription: {
    id: "settings.chatTitle.model.description",
    defaultMessage:
      "Each chat's own Agent titles it. A model chosen here receives every first message.",
  },
  generalWriting: { id: "settings.general.writing.title", defaultMessage: "Writing" },
  generalSpellcheck: { id: "settings.general.spellcheck.label", defaultMessage: "Spellcheck" },
  generalMarkMisspelledWordsWhereverYouType: {
    id: "settings.general.spellcheck.description",
    defaultMessage: "Mark misspelled words wherever you type.",
  },
  generalAutoLinkWhileTyping: {
    id: "settings.general.autolinkTyping.label",
    defaultMessage: "Auto-link while typing",
  },
  generalTurnTypedURLsIntoLinksAs: {
    id: "settings.general.autolinkTyping.description",
    defaultMessage: "Turn typed URLs into links as you finish the token.",
  },
  generalAutoLinkOnPaste: {
    id: "settings.general.autolinkPaste.label",
    defaultMessage: "Auto-link on paste",
  },
  generalRecognizeLinksInPastedTextIncluding: {
    id: "settings.general.autolinkPaste.description",
    defaultMessage:
      "Recognize links in pasted text, including inline URL spans inside longer content.",
  },
  generalRecognizeBareDomains: {
    id: "settings.general.autolinkBareDomains.label",
    defaultMessage: "Recognize bare domains",
  },
  generalLinkPlainDomainsLikeExampleCom: {
    id: "settings.general.autolinkBareDomains.description",
    defaultMessage:
      "Link plain domains like example.com. Leave off to avoid filename-like text such as .md paths.",
  },
  generalLargePasteTextThreshold: {
    id: "settings.general.pasteTextThreshold.label",
    defaultMessage: "Large paste text threshold",
  },
  generalPromptWhenPastedPlainTextReaches: {
    id: "settings.general.pasteTextThreshold.description",
    defaultMessage:
      "Prompt when pasted plain text reaches this many characters, so you can materialize it instead of inflating the note.",
  },
  generalPasteResourceTextThreshold: {
    id: "settings.general.pasteResourceTextThreshold",
    defaultMessage: "Paste resource text threshold",
  },
  generalLargePasteDescriptionSoftLimit: {
    id: "settings.general.pasteDescriptionLimit.label",
    defaultMessage: "Large paste description soft limit",
  },
  generalPromptBeforePastedPlainTextPushes: {
    id: "settings.general.pasteDescriptionLimit.description",
    defaultMessage:
      "Prompt before pasted plain text pushes the note near its description size ceiling.",
  },
  generalPasteResourceDescriptionSoftLimit: {
    id: "settings.general.pasteResourceDescriptionSoftLimit",
    defaultMessage: "Paste resource description soft limit",
  },
  generalFilesLinks: {
    id: "settings.general.filesAndLinks.title",
    defaultMessage: "Files & links",
  },
  generalCopyFileReferencesAsLocalPaths: {
    id: "settings.general.copyFileReferences.label",
    defaultMessage: "Copy file references as local paths",
  },
  generalUseAbsoluteLocalPathsInCopied: {
    id: "settings.general.copyFileReferences.description",
    defaultMessage:
      "Use absolute local paths in copied plain text; Library Files resolve to this Profile’s immutable .blob files.",
  },
  generalMarkdownFileLinks: {
    id: "settings.general.markdownFileLinks.label",
    defaultMessage: "Markdown file links",
  },
  generalChooseWhichDesktopAppHandlesAbsolute: {
    id: "settings.general.markdownFileLinks.description",
    defaultMessage:
      "Choose which desktop app handles absolute local file links in rendered markdown.",
  },
  generalNotifications: { id: "settings.general.notifications", defaultMessage: "Notifications" },
  generalTurnCompletionNotifications: {
    id: "settings.general.turnCompletionNotifications",
    defaultMessage: "Turn completion notifications",
  },
  generalSetWhenAgentAlertsYouThat: {
    id: "settings.general.setWhenAgentAlertsYouThat",
    defaultMessage: "Set when agent alerts you that it's finished",
  },
  generalEnableQuestionNotifications: {
    id: "settings.general.enableQuestionNotifications",
    defaultMessage: "Enable question notifications",
  },
  generalShowAlertsWhenInputIsNeeded: {
    id: "settings.general.showAlertsWhenInputIsNeeded",
    defaultMessage: "Show alerts when input is needed to continue",
  },
  generalNever: { id: "settings.general.never", defaultMessage: "Never" },
  generalWhenNodexIsInTheBackground: {
    id: "settings.general.whenNodexIsInTheBackground",
    defaultMessage: "When Nodex is in the background",
  },
  generalWhenTheChatIsntInView: {
    id: "settings.general.whenTheChatIsntInView",
    defaultMessage: "When the chat isn't in view",
  },
  generalAlways: { id: "settings.general.always", defaultMessage: "Always" },
  generalReadback: { id: "settings.general.readback", defaultMessage: "Readback" },
  generalShowWhatAnAgentPlansTo: {
    id: "settings.general.showWhatAnAgentPlansTo",
    defaultMessage: "Show what an agent plans to do after you send a message and move on",
  },
  generalPrivacy: { id: "settings.general.privacy.title", defaultMessage: "Privacy" },
  generalShareCrashReports: {
    id: "settings.general.shareCrashReports",
    defaultMessage: "Share crash reports",
  },
  generalSendCrashDiagnosticsToSentryPrompts: {
    id: "settings.general.sendCrashDiagnosticsToSentryPrompts",
    defaultMessage:
      "Send crash diagnostics to Sentry. Prompts, transcripts, card text and local payloads are scrubbed before upload.",
  },
  generalShareSessionReplays: {
    id: "settings.general.shareSessionReplays",
    defaultMessage: "Share session replays",
  },
  generalIncludeMaskedReplaysOfTheApp: {
    id: "settings.general.includeMaskedReplaysOfTheApp",
    defaultMessage: "Include masked replays of the app with crash reports.",
  },
  generalShareUsageAnalytics: {
    id: "settings.general.shareUsageAnalytics",
    defaultMessage: "Share usage analytics",
  },
  generalSendAnonymousCountsOfHowNodex: {
    id: "settings.general.sendAnonymousCountsOfHowNodex",
    defaultMessage:
      "Send anonymous counts of how Nodex is used, under a random ID. Prompts, code, titles and file paths are never sent.",
  },
  generalSeeWhatIsSent: {
    id: "settings.general.seeWhatIsSent",
    defaultMessage: "See what is sent",
  },
  generalTroubleshooting: {
    id: "settings.general.troubleshooting.title",
    defaultMessage: "Troubleshooting",
  },
  generalAppServerRequests: {
    id: "settings.general.appServerRequests",
    defaultMessage: "App server requests",
  },
  generalRecordRequestsWhileExpanded: {
    id: "settings.general.recordRequestsWhileExpanded",
    defaultMessage: "Record requests while expanded.",
  },
  appearanceTitle: { id: "settings.appearance.title", defaultMessage: "Appearance" },
  appearanceMode: { id: "settings.appearance.mode", defaultMessage: "Mode" },
  appearanceVisualStyle: { id: "settings.appearance.visualStyle", defaultMessage: "Visual style" },
  appearanceSystem: { id: "settings.appearance.system", defaultMessage: "System" },
  appearanceLight: { id: "settings.appearance.light", defaultMessage: "Light" },
  appearanceDark: { id: "settings.appearance.dark", defaultMessage: "Dark" },
  appearanceTheme2: { id: "settings.appearance.theme2", defaultMessage: "Theme" },
  appearanceAccentColor2: {
    id: "settings.appearance.accentColor2",
    defaultMessage: "Accent color",
  },
  appearanceCustom: { id: "settings.appearance.custom", defaultMessage: "Custom" },
  appearanceFont: { id: "settings.appearance.font", defaultMessage: "Font" },
  appearanceUIFont: { id: "settings.appearance.uIFont", defaultMessage: "UI font" },
  appearanceAdvanced: { id: "settings.appearance.advanced", defaultMessage: "Advanced" },
  appearanceReset: { id: "settings.appearance.reset", defaultMessage: "Reset" },
  appearanceResetAdvancedAppearance: {
    id: "settings.appearance.resetAdvancedAppearance",
    defaultMessage: "Reset advanced appearance",
  },
  appearanceUIFontSize: { id: "settings.appearance.uIFontSize", defaultMessage: "UI font size" },
  appearanceContentFontSize: {
    id: "settings.appearance.contentFontSize",
    defaultMessage: "Content font size",
  },
  appearancePages: { id: "settings.appearance.pages", defaultMessage: "Pages" },
  appearanceCodeFontSize: {
    id: "settings.appearance.codeFontSize",
    defaultMessage: "Code font size",
  },
  appearanceFontSmoothing: {
    id: "settings.appearance.fontSmoothing",
    defaultMessage: "Font smoothing",
  },
  appearanceReduceMotion: {
    id: "settings.appearance.reduceMotion",
    defaultMessage: "Reduce motion",
  },
  appearanceOn: { id: "settings.appearance.on", defaultMessage: "On" },
  appearanceOff: { id: "settings.appearance.off", defaultMessage: "Off" },
  appearanceSeparateLightDarkModes: {
    id: "settings.appearance.separateLightDarkModes",
    defaultMessage: "Separate light/dark modes",
  },
  appearanceContentFont: { id: "settings.appearance.contentFont", defaultMessage: "Content font" },
  appearanceSameAsUIFont: {
    id: "settings.appearance.sameAsUIFont",
    defaultMessage: "Same as UI font",
  },
  appearanceCodeFont: { id: "settings.appearance.codeFont", defaultMessage: "Code font" },
  voiceTitle: { id: "settings.voice.title", defaultMessage: "Voice" },
  modelsTitle: { id: "settings.models.title", defaultMessage: "Models" },
  agentsTitle: { id: "settings.agents.title", defaultMessage: "Agents" },
  agentsTheCodingAgentsNodexCanRun: {
    id: "settings.agents.theCodingAgentsNodexCanRun",
    defaultMessage:
      "The coding agents and models Nodex can run. Open one to change how it starts and signs in.",
  },
  agentsPermissions: { id: "settings.agents.permissions", defaultMessage: "Permissions" },
  agentsDefaultPermissions: {
    id: "settings.agents.defaultPermissions",
    defaultMessage: "Default permissions",
  },
  agentsWhatNewChatsCanDoOn: {
    id: "settings.agents.whatNewChatsCanDoOn",
    defaultMessage: "What new chats can do on this computer without asking.",
  },
  codexSpeed: { id: "settings.codex.speed", defaultMessage: "Speed" },
  codexTheSpeedNewCodexChatsStart: {
    id: "settings.codex.theSpeedNewCodexChatsStart",
    defaultMessage:
      "The speed new Codex chats start with. A speed you pick in a Codex chat becomes the new default.",
  },
  codexStandard: { id: "settings.codex.standard", defaultMessage: "Standard" },
  codexFast: { id: "settings.codex.fast", defaultMessage: "Fast" },
  codexCodexHome: { id: "settings.codex.codexHome", defaultMessage: "Codex home" },
  codexSettingsSkillsAndConversationHistory: {
    id: "settings.codex.settingsSkillsAndConversationHistory",
    defaultMessage: "Settings, skills and conversation history.",
  },
  codexAccountDirectory: {
    id: "settings.codex.accountDirectory",
    defaultMessage: "Account directory",
  },
  agentsASeparateFolderForAnotherCodex: {
    id: "settings.agents.aSeparateFolderForAnotherCodex",
    defaultMessage: "A separate folder for another Codex sign-in.",
  },
  agentsCopySetupFrom: { id: "settings.agents.copySetupFrom", defaultMessage: "Copy setup from" },
  agentsBringsInInstructionsSkillsMCPServers: {
    id: "settings.agents.bringsInInstructionsSkillsMCPServers",
    defaultMessage:
      "Brings in instructions, skills, MCP servers and more once you review them. Only what Codex is missing is added.",
  },
  agentsProfile: { id: "settings.agents.profile", defaultMessage: "Profile" },
  agentsUseAProfileForEachClaude: {
    id: "settings.agents.useAProfileForEachClaude",
    defaultMessage: "Use a profile for each Claude setup or account.",
  },
  agentProfilesAddProfile: {
    id: "settings.agentProfiles.addProfile",
    defaultMessage: "Add profile",
  },
  agentProfilesName: { id: "settings.agentProfiles.name", defaultMessage: "Name" },
  agentProfilesExecutable: {
    id: "settings.agentProfiles.executable",
    defaultMessage: "Executable",
  },
  claudeConfigDirectory: {
    id: "settings.claude.configDirectory",
    defaultMessage: "Config directory",
  },
  agentsWhereThisProfileKeepsItsSign: {
    id: "settings.agents.whereThisProfileKeepsItsSign",
    defaultMessage: "Where this profile keeps its sign-in and settings.",
  },
  agentsEnvironmentVariables: {
    id: "settings.agents.environmentVariables",
    defaultMessage: "Environment variables",
  },
  agentsPasteAEnvFileOrExport: {
    id: "settings.agents.pasteAEnvFileOrExport",
    defaultMessage: "Paste a .env file or export lines.",
  },
  agentsCustomModels: { id: "settings.agents.customModels", defaultMessage: "Custom models" },
  agentsModelsThisProfileCanChooseBesides: {
    id: "settings.agents.modelsThisProfileCanChooseBesides",
    defaultMessage: "Models this profile can choose besides Claude's own.",
  },
  agentsUseAProfileForEachOpenCode: {
    id: "settings.agents.useAProfileForEachOpenCode",
    defaultMessage: "Use a profile for each OpenCode setup.",
  },
  opencodeProfileDirectory: {
    id: "settings.opencode.profileDirectory",
    defaultMessage: "Profile directory",
  },
  agentsOpenCodesSettingsAndDataForThis: {
    id: "settings.agents.openCodesSettingsAndDataForThis",
    defaultMessage: "OpenCode's settings and data for this profile.",
  },
  opencodeServerURL: { id: "settings.opencode.serverURL", defaultMessage: "Server URL" },
  agentsConnectToAnOpenCodeServerThats: {
    id: "settings.agents.connectToAnOpenCodeServerThats",
    defaultMessage: "Connect to an OpenCode server that's already running.",
  },
  agentsProviderCredentialsForThisOpenCodeProfile: {
    id: "settings.agents.providerCredentialsForThisOpenCodeProfile",
    defaultMessage: "Provider credentials for this OpenCode profile.",
  },
  agentsApiKeys: { id: "settings.agents.apiKeys", defaultMessage: "API keys" },
  agentsUseDeepSeekKimiGlmMiniMax: {
    id: "settings.agents.useDeepSeekKimiGlmMiniMax",
    defaultMessage:
      "Use DeepSeek, Kimi, GLM, MiniMax or any Anthropic-compatible endpoint with your own key.",
  },
  agentsOtherAgents: { id: "settings.agents.otherAgents", defaultMessage: "Other agents" },
  agentsAgentClientProtocol: {
    id: "settings.agents.agentClientProtocol",
    defaultMessage: "Agent Client Protocol",
  },
  agentsInstallAgentsFromTheACPRegistry: {
    id: "settings.agents.installAgentsFromTheACPRegistry",
    defaultMessage: "Install agents from the ACP Registry or run your own command.",
  },
  conversationImportTitle: {
    id: "settings.conversationImport.title",
    defaultMessage: "Conversations",
  },
  conversationImportImport2: {
    id: "settings.conversationImport.import2",
    defaultMessage: "Import",
  },
  conversationImportImportConversations: {
    id: "settings.conversationImport.importConversations",
    defaultMessage: "Import conversations",
  },
  conversationImportCopyCodexAndClaudeCodeConversations: {
    id: "settings.conversationImport.copyCodexAndClaudeCodeConversations",
    defaultMessage: "Copy Codex and Claude Code conversations into new chats.",
  },
  conversationImportDestination: {
    id: "settings.conversationImport.destination",
    defaultMessage: "Destination",
  },
  conversationImportProjectless: {
    id: "settings.conversationImport.projectless",
    defaultMessage: "Projectless",
  },
  conversationImportFolderMissing: {
    id: "settings.conversationImport.folderMissing",
    defaultMessage: "Folder missing",
  },
  conversationImportChooseFolder: {
    id: "settings.conversationImport.chooseFolder",
    defaultMessage: "Choose folder",
  },
  conversationImportImportAndOpen: {
    id: "settings.conversationImport.importAndOpen",
    defaultMessage: "Import and open",
  },
  conversationImportNotImported: {
    id: "settings.conversationImport.notImported",
    defaultMessage: "Not imported",
  },
  inboxTitle: { id: "settings.inbox.title", defaultMessage: "Inbox" },
  keyboardShortcutsTitle: {
    id: "settings.keyboardShortcuts.title",
    defaultMessage: "Keyboard shortcuts",
  },
  linkOpeningOpenWebLinkInDefaultBrowser: {
    id: "settings.linkOpening.openWebLinkInDefaultBrowser",
    defaultMessage: "Open web link in default browser",
  },
  linkOpeningHoldTheAssignedKeysWhileClicking: {
    id: "settings.linkOpening.holdTheAssignedKeysWhileClicking",
    defaultMessage:
      "Hold the assigned keys while clicking a web link to open it in your default system browser",
  },
  keyboardShortcutsSearchLabel: {
    id: "settings.keyboardShortcuts.search.label",
    defaultMessage: "Search keyboard shortcuts",
  },
  keyboardShortcutsSearchPlaceholder: {
    id: "settings.keyboardShortcuts.search.placeholder",
    defaultMessage: "Search shortcuts",
  },
  keyboardShortcutsSearchByKeystrokes: {
    id: "settings.keyboardShortcuts.search.byKeystrokes",
    defaultMessage: "Search by keystrokes",
  },
  keyboardShortcutsSearchCapturePlaceholder: {
    id: "settings.keyboardShortcuts.search.capturePlaceholder",
    defaultMessage: "Press shortcut",
  },
  keyboardShortcutsLoadingShortcuts: {
    id: "settings.keyboardShortcuts.loadingShortcuts",
    defaultMessage: "Loading shortcuts...",
  },
  keyboardShortcutsCouldNotLoadShortcuts: {
    id: "settings.keyboardShortcuts.couldNotLoadShortcuts",
    defaultMessage: "Could not load shortcuts.",
  },
  keyboardShortcutsNoMatchingShortcuts: {
    id: "settings.keyboardShortcuts.noMatchingShortcuts",
    defaultMessage: "No matching shortcuts",
  },
  keyboardShortcutsCommand: { id: "settings.keyboardShortcuts.command", defaultMessage: "Command" },
  keyboardShortcutsKeybinding: {
    id: "settings.keyboardShortcuts.keybinding",
    defaultMessage: "Keybinding",
  },
  keyboardShortcutsActions: { id: "settings.keyboardShortcuts.actions", defaultMessage: "Actions" },
  keyboardShortcutsChangeShortcut: {
    id: "settings.keyboardShortcuts.changeShortcut",
    defaultMessage: "Change shortcut",
  },
  keyboardShortcutsSetShortcut: {
    id: "settings.keyboardShortcuts.setShortcut",
    defaultMessage: "Set shortcut",
  },
  keyboardShortcutsClearShortcut: {
    id: "settings.keyboardShortcuts.clearShortcut",
    defaultMessage: "Clear shortcut",
  },
  keyboardShortcutsResetShortcut: {
    id: "settings.keyboardShortcuts.resetShortcut",
    defaultMessage: "Reset shortcut",
  },
  keyboardShortcutsResetAllToDefaults: {
    id: "settings.keyboardShortcuts.resetAllToDefaults",
    defaultMessage: "Reset all to defaults",
  },
  keyboardShortcutsResetAllKeyboardShortcuts: {
    id: "settings.keyboardShortcuts.resetAllKeyboardShortcuts",
    defaultMessage: "Reset all keyboard shortcuts?",
  },
  keyboardShortcutsThisWillDiscardAllCustomShortcuts: {
    id: "settings.keyboardShortcuts.thisWillDiscardAllCustomShortcuts",
    defaultMessage:
      "This will discard all custom shortcuts and restore the default keyboard shortcuts.",
  },
  linkOpeningUnassigned: { id: "settings.linkOpening.unassigned", defaultMessage: "Unassigned" },
  keyboardShortcutsConflict: {
    id: "settings.keyboardShortcuts.conflict",
    defaultMessage: "Conflict",
  },
  keyboardShortcutsCommandKeybindings: {
    id: "settings.keyboardShortcuts.commandKeybindings",
    defaultMessage: "Command keybindings",
  },
  pageTitle: { id: "settings.page.title", defaultMessage: "Pages" },
  pagePageCreationAndImportBehavior: {
    id: "settings.page.pageCreationAndImportBehavior",
    defaultMessage: "Page creation and import behavior.",
  },
  pageBlockImport: { id: "settings.page.blockImport", defaultMessage: "Block import" },
  pageTaskShorthandLabel: {
    id: "settings.page.taskShorthand.label",
    defaultMessage: "Task shorthand on Block → Page",
  },
  pageTaskShorthandDescription: {
    id: "settings.page.taskShorthand.description",
    defaultMessage:
      "Interpret task metadata when a Block is promoted into a Page. 1XL(ui, unclear) Fix import → Fix import · P1 · XL · ui · unclear",
  },
  pageInterpretPriorityEstimateAndTagsSuch: {
    id: "settings.page.interpretPriorityEstimateAndTagsSuch",
    defaultMessage:
      "Interpret priority, estimate, and tags such as 1XL(ui, unclear) when a Block is promoted into a Page.",
  },
  gitTitle: { id: "settings.git.title", defaultMessage: "Git" },
  gitBranchNamingAndInstructionsUsedBy: {
    id: "settings.git.branchNamingAndInstructionsUsedBy",
    defaultMessage: "Branch naming and instructions used by Nodex for Git operations.",
  },
  gitBranches: { id: "settings.git.branches", defaultMessage: "Branches" },
  gitBranchPrefixLabel: { id: "settings.git.branchPrefix.label", defaultMessage: "Branch prefix" },
  gitBranchPrefixDescription: {
    id: "settings.git.branchPrefix.description",
    defaultMessage: "Prefix used when Nodex creates new branches.",
  },
  gitCommitInstructionsLabel: {
    id: "settings.git.commitInstructions.label",
    defaultMessage: "Commit instructions",
  },
  gitCommitInstructionsDescription: {
    id: "settings.git.commitInstructions.description",
    defaultMessage: "Added to commit message generation prompts.",
  },
  gitCommitInstructionsPlaceholder: {
    id: "settings.git.addCommitMessageGuidance",
    defaultMessage: "Add commit message guidance…",
  },
  gitSave: { id: "settings.git.save", defaultMessage: "Save" },
  gitPullRequestInstructionsLabel: {
    id: "settings.git.pullRequestInstructions.label",
    defaultMessage: "Pull request instructions",
  },
  gitPullRequestInstructionsDescription: {
    id: "settings.git.pullRequestInstructions.description",
    defaultMessage: "Added to PR title and description generation prompts.",
  },
  gitPullRequestInstructionsPlaceholder: {
    id: "settings.git.addPullRequestGuidance",
    defaultMessage: "Add pull request guidance…",
  },
  worktreesTitle: { id: "settings.worktrees.title", defaultMessage: "Worktrees" },
  worktreesManagedWorktreeCreationNamingAndCleanup: {
    id: "settings.worktrees.managedWorktreeCreationNamingAndCleanup",
    defaultMessage: "Managed worktree creation, naming, and cleanup.",
  },
  worktreesDefaults: { id: "settings.worktrees.defaults", defaultMessage: "Defaults" },
  worktreesWorktreeStartMode: {
    id: "settings.worktrees.worktreeStartMode",
    defaultMessage: "Worktree start mode",
  },
  worktreesChooseWhetherNewWorktreeThreadsAuto: {
    id: "settings.worktrees.chooseWhetherNewWorktreeThreadsAuto",
    defaultMessage: "Choose whether new worktree threads auto-create a branch or start detached.",
  },
  worktreesManagedWorktrees: {
    id: "settings.worktrees.managedWorktrees",
    defaultMessage: "Managed worktrees",
  },
  worktreesWorktreesCreatedByCardThreadsHover: {
    id: "settings.worktrees.worktreesCreatedByCardThreadsHover",
    defaultMessage: "Worktrees created by card threads. Hover a row to remove.",
  },
  worktreesBranch: { id: "settings.worktrees.branch", defaultMessage: "Branch" },
  worktreesManagedDirectory: {
    id: "settings.worktrees.managedDirectory",
    defaultMessage: "Managed directory",
  },
  worktreesCleanup: { id: "settings.worktrees.cleanup", defaultMessage: "Cleanup" },
  worktreesRemoveWorktreeRecord: {
    id: "settings.worktrees.removeWorktreeRecord",
    defaultMessage: "Remove worktree record",
  },
  environmentsLocalEnvironments: {
    id: "settings.environments.localEnvironments",
    defaultMessage: "Local environments",
  },
  environmentsLocalEnvironmentsTellNodexHowTo2: {
    id: "settings.environments.localEnvironmentsTellNodexHowTo2",
    defaultMessage:
      "Local environments tell Nodex how to set up worktrees for a project. Learn more.",
  },
  environmentsSelectAProject: {
    id: "settings.environments.selectAProject",
    defaultMessage: "Select a project",
  },
  environmentsAddProject: { id: "settings.environments.addProject", defaultMessage: "Add project" },
  environmentsNoProjectsYetAddOneTo: {
    id: "settings.environments.noProjectsYetAddOneTo",
    defaultMessage: "No projects yet. Add one to configure local environments.",
  },
  environmentsAvailableProjects: {
    id: "settings.environments.availableProjects",
    defaultMessage: "Available projects",
  },
  environmentsLoadingLocalEnvironments: {
    id: "settings.environments.loadingLocalEnvironments",
    defaultMessage: "Loading local environments",
  },
  environmentsFetchingYourProjectConfiguration: {
    id: "settings.environments.fetchingYourProjectConfiguration",
    defaultMessage: "Fetching your project configuration.",
  },
  environmentsSetup: { id: "settings.environments.setup", defaultMessage: "Setup" },
  environmentsThisScriptRunsOnWorktreeCreation: {
    id: "settings.environments.thisScriptRunsOnWorktreeCreation",
    defaultMessage: "This script runs on worktree creation",
  },
  environmentsName: { id: "settings.environments.name", defaultMessage: "Name" },
  environmentsSetupScriptEnvironmentVariables: {
    id: "settings.environments.setupScriptEnvironmentVariables",
    defaultMessage: "Setup script environment variables",
  },
  environmentsVariablesAvailableToTheSetupScript: {
    id: "settings.environments.variablesAvailableToTheSetupScript",
    defaultMessage: "Variables available to the setup script.",
  },
  environmentsDefault: { id: "settings.environments.default", defaultMessage: "Default" },
  environmentsNoScriptConfigured: {
    id: "settings.environments.noScriptConfigured",
    defaultMessage: "No script configured",
  },
  environmentsNoScriptConfiguredForThisPlatform: {
    id: "settings.environments.noScriptConfiguredForThisPlatform",
    defaultMessage: "No script configured for this platform",
  },
  environmentsNoPlatformOverrideUsingTheDefault: {
    id: "settings.environments.noPlatformOverrideUsingTheDefault",
    defaultMessage: "No platform override. Using the default script",
  },
  environmentsCleanup: { id: "settings.environments.cleanup", defaultMessage: "Cleanup" },
  environmentsRunsAtTheProjectRootBefore: {
    id: "settings.environments.runsAtTheProjectRootBefore",
    defaultMessage: "Runs at the project root before worktree cleanup",
  },
  environmentsActions: { id: "settings.environments.actions", defaultMessage: "Actions" },
  environmentsTheseActionsCanRunAnyCommand: {
    id: "settings.environments.theseActionsCanRunAnyCommand",
    defaultMessage: "These actions can run any command and will be displayed in the header.",
  },
  environmentsAddAction: { id: "settings.environments.addAction", defaultMessage: "Add action" },
  environmentsNoActionsConfigured: {
    id: "settings.environments.noActionsConfigured",
    defaultMessage: "No actions configured",
  },
  environmentsAllPlatforms: {
    id: "settings.environments.allPlatforms",
    defaultMessage: "All platforms",
  },
  environmentsEnterAnActionName: {
    id: "settings.environments.enterAnActionName",
    defaultMessage: "Enter an action name",
  },
  environmentsEnterAnActionCommand: {
    id: "settings.environments.enterAnActionCommand",
    defaultMessage: "Enter an action command",
  },
  environmentsEditLocalEnvironment: {
    id: "settings.environments.editLocalEnvironment",
    defaultMessage: "Edit local environment",
  },
  environmentsDiscardEdits: {
    id: "settings.environments.discardEdits",
    defaultMessage: "Discard edits",
  },
  environmentsRetrySave: { id: "settings.environments.retrySave", defaultMessage: "Retry save" },
  hooksTitle: { id: "settings.hooks.title", defaultMessage: "Hooks" },
  hooksManageLifecycleHooksFromConfigAnd: {
    id: "settings.hooks.manageLifecycleHooksFromConfigAnd",
    defaultMessage: "Manage lifecycle hooks from config and enabled plugins.",
  },
  hooksFromConfig: { id: "settings.hooks.fromConfig", defaultMessage: "From Config" },
  hooksUserConfig: { id: "settings.hooks.userConfig", defaultMessage: "User config" },
  hooksHooksConfiguredForTheCurrentUser: {
    id: "settings.hooks.hooksConfiguredForTheCurrentUser",
    defaultMessage: "Hooks configured for the current user.",
  },
  hooksAdminConfig: { id: "settings.hooks.adminConfig", defaultMessage: "Admin config" },
  hooksHooksManagedBySystemAndOrganization: {
    id: "settings.hooks.hooksManagedBySystemAndOrganization",
    defaultMessage: "Hooks managed by system and organization policy.",
  },
  hooksFromPlugins: { id: "settings.hooks.fromPlugins", defaultMessage: "From Plugins" },
  hooksUnknownPlugin: { id: "settings.hooks.unknownPlugin", defaultMessage: "Unknown plugin" },
  hooksTrust: { id: "settings.hooks.trust", defaultMessage: "Trust" },
  hooksManagedHooksAreAlwaysOn: {
    id: "settings.hooks.managedHooksAreAlwaysOn",
    defaultMessage: "Managed hooks are always on",
  },
  hooksFromProjects: { id: "settings.hooks.fromProjects", defaultMessage: "From Projects" },
  hooksProjectConfig: { id: "settings.hooks.projectConfig", defaultMessage: "Project config" },
  hooksReloadHooks: { id: "settings.hooks.reloadHooks", defaultMessage: "Reload hooks" },
  hooksNoHooksFound: { id: "settings.hooks.noHooksFound", defaultMessage: "No hooks found" },
  hooksCouldNotLoadHooks: {
    id: "settings.hooks.couldNotLoadHooks",
    defaultMessage: "Could not load hooks",
  },
  hooksOtherSources: { id: "settings.hooks.otherSources", defaultMessage: "Other sources" },
  hooksSessionFlags: { id: "settings.hooks.sessionFlags", defaultMessage: "Session flags" },
  hooksUnknownSource: { id: "settings.hooks.unknownSource", defaultMessage: "Unknown source" },
  hooksConfiguredHooksWillAppearHere: {
    id: "settings.hooks.configuredHooksWillAppearHere",
    defaultMessage: "Configured hooks will appear here",
  },
  archivedChatsTitle: { id: "settings.archivedChats.title", defaultMessage: "Data controls" },
  archivedChatsManageArchivedChatsAndPermanentLocal: {
    id: "settings.archivedChats.manageArchivedChatsAndPermanentLocal",
    defaultMessage: "Manage archived chats and permanent local deletion.",
  },
  archivedChatsArchivedChats: {
    id: "settings.archivedChats.archivedChats",
    defaultMessage: "Archived chats",
  },
  archivedChatsSearchArchivedChats: {
    id: "settings.archivedChats.searchArchivedChats",
    defaultMessage: "Search archived chats",
  },
  archivedChatsGroupArchivedChats: {
    id: "settings.archivedChats.groupArchivedChats",
    defaultMessage: "Group archived chats",
  },
  archivedChatsSortArchivedChats: {
    id: "settings.archivedChats.sortArchivedChats",
    defaultMessage: "Sort archived chats",
  },
  archivedChatsUnarchive: { id: "settings.archivedChats.unarchive", defaultMessage: "Unarchive" },
  archivedChatsDeleteArchivedChat3: {
    id: "settings.archivedChats.deleteArchivedChat3",
    defaultMessage: "Delete archived chat",
  },
  archivedChatsDeleteAllArchivedLocalChats2: {
    id: "settings.archivedChats.deleteAllArchivedLocalChats2",
    defaultMessage: "Delete all archived local chats",
  },
  backupsTitle: { id: "settings.backups.title", defaultMessage: "Backups" },
  backupsSnapshotCadenceRetentionAndRestoreOperations: {
    id: "settings.backups.snapshotCadenceRetentionAndRestoreOperations",
    defaultMessage: "Snapshot cadence, retention, and restore operations.",
  },
  backupsAutomaticSnapshots: {
    id: "settings.backups.automaticSnapshots",
    defaultMessage: "Automatic snapshots",
  },
  backupsAutoBackups: { id: "settings.backups.autoBackups", defaultMessage: "Auto backups" },
  backupsStorageBudget: { id: "settings.backups.storageBudget", defaultMessage: "Storage budget" },
  backupsSnapshotPagesDatabasesAndFilesIn: {
    id: "settings.backups.snapshotPagesDatabasesAndFilesIn",
    defaultMessage: "Snapshot Pages, Databases and Files in the background while you work.",
  },
  backupsScheduleBackgroundSnapshotsForTheLocal: {
    id: "settings.backups.scheduleBackgroundSnapshotsForTheLocal",
    defaultMessage: "Schedule background snapshots for the local store.",
  },
  backupsFrequency: { id: "settings.backups.frequency", defaultMessage: "Frequency" },
  backupsMinimumIsOneHour: {
    id: "settings.backups.minimumIsOneHour",
    defaultMessage: "Minimum is one hour.",
  },
  backupsHours: { id: "settings.backups.hours", defaultMessage: "hours" },
  backupsRetention: { id: "settings.backups.retention", defaultMessage: "Retention" },
  backupsSnapshotsKeptBeforePruning: {
    id: "settings.backups.snapshotsKeptBeforePruning",
    defaultMessage: "Snapshots kept before pruning.",
  },
  backupsMax: { id: "settings.backups.max", defaultMessage: "max" },
  backupsSomeValuesLockedByEnvVars: {
    id: "settings.backups.someValuesLockedByEnvVars",
    defaultMessage: "Some values locked by env vars.",
  },
  backupsRefresh: { id: "settings.backups.refresh", defaultMessage: "Refresh" },
  backupsSaveSchedule: { id: "settings.backups.saveSchedule", defaultMessage: "Save schedule" },
  backupsHistoryRetention: {
    id: "settings.backups.historyRetention",
    defaultMessage: "History retention",
  },
  backupsNewestDeletedBlockRecordsKeptPer: {
    id: "settings.backups.newestDeletedBlockRecordsKeptPer",
    defaultMessage:
      "Newest deleted Block records kept per Project before safe collection. Use 0 to collect every unreferenced tombstone.",
  },
  backupsRecords: { id: "settings.backups.records", defaultMessage: "records" },
  backupsValueLockedByEnvVar: {
    id: "settings.backups.valueLockedByEnvVar",
    defaultMessage: "Value locked by env var.",
  },
  backupsAppliedByBackgroundMaintenance: {
    id: "settings.backups.appliedByBackgroundMaintenance",
    defaultMessage: "Applied by background maintenance.",
  },
  backupsApply: { id: "settings.backups.apply", defaultMessage: "Apply" },
  backupsSnapshots: { id: "settings.backups.snapshots", defaultMessage: "Snapshots" },
  backupsSafetyBackup: { id: "settings.backups.safetyBackup", defaultMessage: "Safety backup" },
  backupsCreateAFreshSnapshotBeforeRestoring: {
    id: "settings.backups.createAFreshSnapshotBeforeRestoring",
    defaultMessage: "Create a fresh snapshot before restoring an older one.",
  },
  backupsOptionalSnapshotLabel: {
    id: "settings.backups.optionalSnapshotLabel",
    defaultMessage: "Optional snapshot label",
  },
  backupsCreateSnapshot: {
    id: "settings.backups.createSnapshot",
    defaultMessage: "Create snapshot",
  },
  backupsNoSnapshotsYet: {
    id: "settings.backups.noSnapshotsYet",
    defaultMessage: "No snapshots yet.",
  },
  backupsManual: { id: "settings.backups.manual", defaultMessage: "Manual" },
  backupsAuto: { id: "settings.backups.auto", defaultMessage: "Auto" },
  backupsSafety: { id: "settings.backups.safety", defaultMessage: "Safety" },
  backupsConfirmRestore: {
    id: "settings.backups.confirmRestore",
    defaultMessage: "Confirm restore",
  },
  backupsRestore: { id: "settings.backups.restore", defaultMessage: "Restore" },
  backupsConfirmDelete: { id: "settings.backups.confirmDelete", defaultMessage: "Confirm delete" },
  backupsCancel: { id: "settings.backups.cancel", defaultMessage: "Cancel" },
  backupsDeleteSnapshot: {
    id: "settings.backups.deleteSnapshot",
    defaultMessage: "Delete snapshot",
  },
  backupsSnapshotDeleted: {
    id: "settings.backups.snapshotDeleted",
    defaultMessage: "Snapshot deleted.",
  },
  backupsBackupRestored: {
    id: "settings.backups.backupRestored",
    defaultMessage: "Backup restored.",
  },
  browserTitle: { id: "settings.browser.title", defaultMessage: "Browser" },
  linkOpeningWebURLAndLinkOpenDestination: {
    id: "settings.linkOpening.webURLAndLinkOpenDestination",
    defaultMessage: "Web URL and link open destination",
  },
  linkOpeningLocalURLOpenDestination: {
    id: "settings.linkOpening.localURLOpenDestination",
    defaultMessage: "Local URL open destination",
  },
  linkOpeningWhereLocalDevelopmentSitesOpenBy: {
    id: "settings.linkOpening.whereLocalDevelopmentSitesOpenBy",
    defaultMessage: "Where local development sites open by default",
  },
  linkOpeningDefaultBrowser: {
    id: "settings.linkOpening.defaultBrowser",
    defaultMessage: "Default browser",
  },
  pluginsTitle: { id: "settings.plugins.title", defaultMessage: "Plugins" },
  computerUseTitle: { id: "settings.computerUse.title", defaultMessage: "Computer use" },
  computerUseAnyApp: { id: "settings.computerUse.anyApp", defaultMessage: "Any app" },
  computerUseAlwaysAllowedApps: {
    id: "settings.computerUse.alwaysAllowedApps",
    defaultMessage: "Always-allowed apps",
  },
  computerUseAlwaysAllowedToSend: {
    id: "settings.computerUse.alwaysAllowedToSend",
    defaultMessage: "Always allowed to send",
  },
  computerUseClickSounds: {
    id: "settings.computerUse.clickSounds",
    defaultMessage: "Click sounds",
  },
  computerUseLockedUse: { id: "settings.computerUse.lockedUse", defaultMessage: "Locked use" },
  computerUsePictureInPicture: {
    id: "settings.computerUse.pictureInPicture",
    defaultMessage: "Picture in picture",
  },
  computerUseAlwaysHidePictureInPicture: {
    id: "settings.computerUse.alwaysHidePictureInPicture",
    defaultMessage: "Always hide picture in picture",
  },
  spacesTitle: { id: "settings.spaces.title", defaultMessage: "Spaces" },
  githubTitle: { id: "settings.github.title", defaultMessage: "GitHub" },
  environmentsTitle: { id: "settings.environments.title", defaultMessage: "Environments" },
  generalLanguage: { id: "settings.ide.language.label", defaultMessage: "Language" },
  generalLanguageForTheAppUI: {
    id: "settings.ide.language.description",
    defaultMessage: "Language for the app UI",
  },
});

export const APPEARANCE_ADVANCED_ANCHOR = "advanced";

export const SETTINGS_SEARCH_PANELS = {
  account: {
    title: settingsMessages.accountTitle,
    subtitle: settingsMessages.accountSearchSubtitle,
    groups: [
      {
        title: settingsMessages.accountSearchAccount,
        entries: [
          entry(settingsMessages.accountSearchSignIn),
          entry(settingsMessages.accountSearchSignOut),
        ],
      },
      {
        title: settingsMessages.accountSearchCredits,
        entries: [
          entry(settingsMessages.accountSearchTopUp, settingsMessages.accountSearchBuyCredits, [
            "credit",
            "credits",
            "balance",
            "payment",
          ]),
          entry(
            settingsMessages.accountSearchModelPrices,
            settingsMessages.accountSearchModelCost,
            ["price", "pricing", "cost", "API", "tokens"],
          ),
        ],
      },
    ],
  },
  "general-settings": {
    title: settingsMessages.generalGeneral,
    subtitle: settingsMessages.generalHowNodexStartsAndUpdatesHow,
    groups: [
      {
        anchor: "app",
        title: settingsMessages.generalApp,
        entries: [
          entry(settingsMessages.generalLanguage, settingsMessages.generalLanguageForTheAppUI, [
            "locale",
            "English",
            "中文",
            "简体中文",
          ]),
          entry(
            settingsMessages.generalRestoreWindows,
            settingsMessages.generalChooseWhichWindowsReopenAfterQuitting,
            [
              settingsMessages.generalAll,
              settingsMessages.generalLast,
              settingsMessages.generalNone,
              "quit",
              "reopen",
            ],
          ),
          entry(
            settingsMessages.terminalShellTerminalShell,
            settingsMessages.terminalShellAppliesToNewTerminals,
            [
              settingsMessages.terminalShellAutomatic,
              "PowerShell 7",
              "Windows PowerShell",
              WINDOWS_TERMINAL_SHELL_LABEL_MESSAGES["cmd"],
              "Git Bash",
            ],
            () => readSettingsHostPresentation().terminalShell,
          ),
          entry(
            settingsMessages.generalNodexVersion,
            settingsMessages.generalCheckForUpdatesOrRestartTo,
            [
              "App updates",
              settingsMessages.appUpdatesCheckNow,
              settingsMessages.appUpdatesRestartToUpdate,
              "download updates",
              "install updates",
            ],
          ),
          entry(
            settingsMessages.appUpdatesCheckAutomatically,
            settingsMessages.appUpdatesLookForUpdatesInTheBackground,
            ["automatic updates", "check updates"],
          ),
          entry(
            settingsMessages.appUpdatesUpdateChannel,
            settingsMessages.appUpdatesNightlyGetsNewBuildsFirstSwitching,
            [settingsMessages.appUpdatesStable, settingsMessages.appUpdatesNightly, "beta"],
          ),
          entry(
            settingsMessages.generalRunSetupAgain,
            settingsMessages.generalConnectAgentsAndAddProjects,
            ["setup", "welcome", "onboarding"],
          ),
          entry(
            settingsMessages.generalOpenSourceLicenses,
            settingsMessages.generalThirdPartyNoticesForBundledDependencies,
            ["open source", "licenses", "dependencies"],
          ),
        ],
      },
      {
        anchor: "usage-meters",
        title: settingsMessages.usageMetersUsageMeters,
        entries: [
          entry("Claude", settingsMessages.generalShowClaudeUsageInTheRail, [
            "usage",
            "limits",
            "rail",
            "meter",
          ]),
          entry("Codex", settingsMessages.generalShowCodexUsageInTheRail, [
            "usage",
            "rate limits",
            "rail",
            "meter",
          ]),
          entry(
            settingsMessages.usageMetersNodexCredits,
            settingsMessages.generalShowNodexCreditsInTheRail,
            ["credit", "credits", "balance", "rail", "meter"],
          ),
        ],
      },
      {
        anchor: "chats",
        title: settingsMessages.generalChats,
        entries: [
          entry(
            settingsMessages.generalThreadDetail,
            settingsMessages.generalChooseHowMuchCommandOutputTo,
            [
              settingsMessages.generalSteps,
              settingsMessages.generalStepsWithCodeCommands,
              settingsMessages.generalStepsWithCodeOutput,
              settingsMessages.generalHideCommandsAndOutputs,
              settingsMessages.generalShowCommandsCollapseOutput,
              settingsMessages.generalShowCommandsAndExpandOutput,
            ],
          ),
          entry(
            settingsMessages.generalShowPredictions,
            settingsMessages.generalSuggestYourNextMessageAfterAn,
            ["autocomplete", "suggestions"],
          ),
          entry(
            {
              message: settingsMessages.generalEnterToSendLongPrompts,
              values: { modifier: "Cmd" },
            },
            settingsMessages.generalSingleLinePromptsStillSendOn,
            ["Ctrl+Enter to send long prompts", "composer", "modifier chord"],
          ),
          entry(
            settingsMessages.generalQueueFollowUps,
            settingsMessages.generalWhileAThreadIsRunningQueue,
            ["steer", "composer"],
          ),
          entry(settingsMessages.chatTitleModelLabel, settingsMessages.chatTitleModelDescription, [
            "title",
            "name",
            "rename",
            "generate",
            "model",
            "utility",
          ]),
        ],
      },
      {
        anchor: "writing",
        title: settingsMessages.generalWriting,
        entries: [
          entry(
            settingsMessages.generalSpellcheck,
            settingsMessages.generalMarkMisspelledWordsWhereverYouType,
            ["spelling"],
          ),
          entry(
            settingsMessages.generalAutoLinkWhileTyping,
            settingsMessages.generalTurnTypedURLsIntoLinksAs,
          ),
          entry(
            settingsMessages.generalAutoLinkOnPaste,
            settingsMessages.generalRecognizeLinksInPastedTextIncluding,
          ),
          entry(
            settingsMessages.generalRecognizeBareDomains,
            settingsMessages.generalLinkPlainDomainsLikeExampleCom,
          ),
          entry(
            settingsMessages.generalLargePasteTextThreshold,
            settingsMessages.generalPromptWhenPastedPlainTextReaches,
            [settingsMessages.generalPasteResourceTextThreshold],
          ),
          entry(
            settingsMessages.generalLargePasteDescriptionSoftLimit,
            settingsMessages.generalPromptBeforePastedPlainTextPushes,
            [settingsMessages.generalPasteResourceDescriptionSoftLimit],
          ),
        ],
      },
      {
        anchor: "files-and-links",
        title: settingsMessages.generalFilesLinks,
        entries: [
          entry(
            settingsMessages.generalCopyFileReferencesAsLocalPaths,
            settingsMessages.generalUseAbsoluteLocalPathsInCopied,
            ["absolute path", "portable file reference", "NFM copy"],
          ),
          entry(
            settingsMessages.generalMarkdownFileLinks,
            settingsMessages.generalChooseWhichDesktopAppHandlesAbsolute,
            [
              "Open markdown file links in",
              ...FILE_LINK_OPENER_OPTIONS.map(
                (option) => FILE_LINK_OPENER_LABEL_MESSAGES[option.id] ?? option.label,
              ),
            ],
          ),
        ],
      },
      {
        anchor: "notifications",
        title: settingsMessages.generalNotifications,
        entries: [
          entry(
            settingsMessages.generalTurnCompletionNotifications,
            settingsMessages.generalSetWhenAgentAlertsYouThat,
            [
              settingsMessages.generalEnableQuestionNotifications,
              "Show alerts when notification permissions are required",
              settingsMessages.generalShowAlertsWhenInputIsNeeded,
              settingsMessages.generalNever,
              settingsMessages.generalWhenNodexIsInTheBackground,
              settingsMessages.generalWhenTheChatIsntInView,
              settingsMessages.generalAlways,
            ],
          ),
          entry(settingsMessages.generalReadback, settingsMessages.generalShowWhatAnAgentPlansTo, [
            "opening statement",
            "plan",
            "Stop",
            "Reply",
          ]),
        ],
      },
      {
        anchor: "privacy",
        title: settingsMessages.generalPrivacy,
        entries: [
          entry(
            settingsMessages.generalShareCrashReports,
            settingsMessages.generalSendCrashDiagnosticsToSentryPrompts,
            ["Diagnostics", "crash diagnostics", "Sentry", "scrubbed"],
          ),
          entry(
            settingsMessages.generalShareSessionReplays,
            settingsMessages.generalIncludeMaskedReplaysOfTheApp,
            ["masked session replays"],
          ),
          entry(
            settingsMessages.generalShareUsageAnalytics,
            settingsMessages.generalSendAnonymousCountsOfHowNodex,
            ["Telemetry", "anonymous usage", "Statsig", settingsMessages.generalSeeWhatIsSent],
          ),
        ],
      },
      {
        anchor: "app-server-diagnostics",
        title: settingsMessages.generalTroubleshooting,
        entries: [
          entry(
            settingsMessages.generalAppServerRequests,
            settingsMessages.generalRecordRequestsWhileExpanded,
            ["App server diagnostics", "request log", "failed requests"],
          ),
        ],
      },
    ],
  },
  appearance: {
    title: settingsMessages.appearanceTitle,
    groups: [
      {
        title: settingsMessages.appearanceMode,
        messages: [settingsMessages.appearanceVisualStyle],
        entries: [
          entry(settingsMessages.appearanceMode, "", [
            settingsMessages.appearanceSystem,
            settingsMessages.appearanceLight,
            settingsMessages.appearanceDark,
            settingsMessages.appearanceTheme2,
            "force fixed theme",
          ]),
        ],
      },
      {
        title: settingsMessages.appearanceTheme2,
        entries: [
          entry(settingsMessages.appearanceAccentColor2, "", [
            "Default",
            "Blue",
            "Green",
            "Yellow",
            "Pink",
            "Orange",
            "Purple",
            "Black",
            "White",
            settingsMessages.appearanceCustom,
            "hex color",
          ]),
          entry(settingsMessages.appearanceFont, "", [
            settingsMessages.appearanceUIFont,
            settingsMessages.appearanceSystem,
            "font family",
            "Light theme",
            "Dark theme",
          ]),
        ],
      },
      {
        title: settingsMessages.appearanceAdvanced,
        anchor: APPEARANCE_ADVANCED_ANCHOR,
        messages: [
          settingsMessages.appearanceReset,
          settingsMessages.appearanceResetAdvancedAppearance,
        ],
        entries: [
          entry(settingsMessages.appearanceUIFontSize, "", [
            "Default",
            "font size",
            "interface",
            "chat text",
          ]),
          entry(settingsMessages.appearanceContentFontSize, settingsMessages.appearancePages, [
            "Page font size",
            "document",
            "body",
            "headings",
          ]),
          entry(settingsMessages.appearanceCodeFontSize, "", [
            "Default",
            "editor font size",
            "chats",
            "diffs",
            "terminals",
          ]),
          entry(settingsMessages.appearanceFontSmoothing, "", [
            "macOS",
            "anti-aliasing",
            "antialiasing",
          ]),
          entry(settingsMessages.appearanceReduceMotion, "", [
            settingsMessages.appearanceSystem,
            settingsMessages.appearanceOn,
            settingsMessages.appearanceOff,
            "Reduced motion",
            "animation",
            "accessibility",
          ]),
          entry(settingsMessages.appearanceSeparateLightDarkModes, "", [
            "Light theme",
            "Dark theme",
            "font appearance",
          ]),
          entry(settingsMessages.appearanceContentFont, "", [
            settingsMessages.appearanceSameAsUIFont,
            settingsMessages.appearanceLight,
            settingsMessages.appearanceDark,
            "font family",
          ]),
          entry(settingsMessages.appearanceCodeFont, "", [
            settingsMessages.appearanceSystem,
            settingsMessages.appearanceLight,
            settingsMessages.appearanceDark,
            "monospace",
            "font family",
          ]),
        ],
      },
    ],
  },
  voice: {
    title: settingsMessages.voiceTitle,
    subtitle: settingsMessages.voiceSearchSubtitle,
    groups: [
      {
        title: settingsMessages.voiceSearchGeneral,
        messages: [
          settingsMessages.voiceSearchMicrophone,
          settingsMessages.voiceSearchMicrophoneUse,
          settingsMessages.voiceSearchSystemDefault,
          settingsMessages.voiceSearchAllowAccess,
          settingsMessages.voiceSearchOpenSettings,
        ],
      },
      {
        title: settingsMessages.voiceSearchDictation,
        messages: [
          settingsMessages.voiceSearchHoldHotkey,
          settingsMessages.voiceSearchToggleHotkey,
          settingsMessages.voiceSearchGlobalBar,
          settingsMessages.voiceSearchSounds,
          settingsMessages.voiceSearchDictionary,
          settingsMessages.voiceSearchDictionaryDescription,
          settingsMessages.voiceSearchAddEntry,
        ],
      },
      {
        title: settingsMessages.voiceSearchRecordings,
        messages: [
          settingsMessages.voiceSearchCopyTranscript,
          settingsMessages.voiceSearchRetry,
          settingsMessages.voiceSearchDownloadRecording,
          settingsMessages.voiceSearchDeleteRecording,
        ],
      },
    ],
  },
  models: {
    title: settingsMessages.modelsTitle,
    subtitle: settingsMessages.modelsSearchSubtitle,
    groups: [
      {
        anchor: "nodex",
        title: "Nodex",
        entries: [
          entry(
            settingsMessages.modelsSearchAllowChoice,
            settingsMessages.modelsSearchAllowChoiceDescription,
            ["subagent", "credit", "credits", "spend"],
          ),
        ],
      },
      {
        title: settingsMessages.modelsTitle,
        entries: [
          entry(
            settingsMessages.modelsSearchTurnOff,
            settingsMessages.modelsSearchTurnOffDescription,
            ["opt out", "hide", "disable", "model picker", "free models"],
          ),
        ],
      },
    ],
  },
  agent: {
    title: settingsMessages.agentsTitle,
    subtitle: settingsMessages.agentsTheCodingAgentsNodexCanRun,
    groups: [
      {
        anchor: "default-permissions",
        title: settingsMessages.agentsPermissions,
        entries: [
          entry(
            settingsMessages.agentsDefaultPermissions,
            settingsMessages.agentsWhatNewChatsCanDoOn,
            ["Ask for approval", "Approve for me", "Full access", "approvals", "sandbox"],
          ),
        ],
      },
      {
        anchor: "codex",
        title: "Codex",
        entries: [
          entry(settingsMessages.codexSpeed, settingsMessages.codexTheSpeedNewCodexChatsStart, [
            "Service tier",
            settingsMessages.codexStandard,
            settingsMessages.codexFast,
            "Fast mode",
          ]),
          entry(
            settingsMessages.codexCodexHome,
            settingsMessages.codexSettingsSkillsAndConversationHistory,
            ["CODEX_HOME", "~/.codex", "restart"],
          ),
          entry(
            settingsMessages.codexAccountDirectory,
            settingsMessages.agentsASeparateFolderForAnotherCodex,
            ["account", "sign-in"],
          ),
          entry(
            settingsMessages.agentsCopySetupFrom,
            settingsMessages.agentsBringsInInstructionsSkillsMCPServers,
            [
              "Claude Code",
              "Other Codex home",
              "migrate",
              "instructions",
              "AGENTS.md",
              "skills",
              "MCP servers",
              "hooks",
              "plugins",
              "subagents",
              "commands",
              "memory",
            ],
          ),
        ],
      },
      {
        anchor: "claude",
        title: "Claude Code",
        entries: [
          entry(settingsMessages.agentsProfile, settingsMessages.agentsUseAProfileForEachClaude, [
            settingsMessages.agentProfilesAddProfile,
            settingsMessages.agentProfilesName,
            settingsMessages.agentProfilesExecutable,
            "claude",
          ]),
          entry(
            settingsMessages.claudeConfigDirectory,
            settingsMessages.agentsWhereThisProfileKeepsItsSign,
            ["~/.claude", "CLAUDE_CONFIG_DIR", "account"],
          ),
          entry(
            settingsMessages.agentsEnvironmentVariables,
            settingsMessages.agentsPasteAEnvFileOrExport,
            [
              "ANTHROPIC_BASE_URL",
              "ANTHROPIC_AUTH_TOKEN",
              "ANTHROPIC_API_KEY",
              "export",
              "token",
              "proxy",
            ],
          ),
          entry(
            settingsMessages.agentsCustomModels,
            settingsMessages.agentsModelsThisProfileCanChooseBesides,
          ),
        ],
      },
      {
        anchor: "keys",
        title: settingsMessages.agentsApiKeys,
        entries: [
          entry(settingsMessages.agentsApiKeys, settingsMessages.agentsUseDeepSeekKimiGlmMiniMax, [
            "Add API key",
            "DeepSeek",
            "Kimi",
            "Moonshot",
            "GLM",
            "Zhipu",
            "Z.ai",
            "MiniMax",
            "Anthropic-compatible",
            "base URL",
            "endpoint",
            "gateway",
            "relay",
            "bring your own key",
            "BYOK",
            "token",
          ]),
        ],
      },
      {
        anchor: "opencode",
        title: "OpenCode",
        entries: [
          entry(settingsMessages.agentsProfile, settingsMessages.agentsUseAProfileForEachOpenCode, [
            settingsMessages.agentProfilesAddProfile,
            settingsMessages.agentProfilesName,
            settingsMessages.agentProfilesExecutable,
            "opencode",
          ]),
          entry(
            settingsMessages.opencodeProfileDirectory,
            settingsMessages.agentsOpenCodesSettingsAndDataForThis,
            ["account"],
          ),
          entry(
            settingsMessages.opencodeServerURL,
            settingsMessages.agentsConnectToAnOpenCodeServerThats,
            ["Local server", "OPENCODE_SERVER_PASSWORD"],
          ),
          entry(
            settingsMessages.agentsEnvironmentVariables,
            settingsMessages.agentsProviderCredentialsForThisOpenCodeProfile,
            ["API key", "Moonshot", "Kimi", "DeepSeek", "OpenRouter", "Secret", "export"],
          ),
        ],
      },
      {
        anchor: "acp",
        title: settingsMessages.agentsOtherAgents,
        entries: [
          entry(
            settingsMessages.agentsAgentClientProtocol,
            settingsMessages.agentsInstallAgentsFromTheACPRegistry,
            [
              "ACP",
              "Found on this computer",
              "Google Antigravity",
              "Antigravity",
              "agy",
              "Gemini",
              "Add agent",
              "ACP Registry",
              "Local command",
              "Install",
              "Update",
              "Uninstall",
              "Connect",
              "Sign in",
              "Sign out",
              "Account storage",
              "Arguments",
              "Distribution",
              "Executable override",
              "System proxy",
              "Custom models",
              "Model services",
              "Qoder",
              "Copilot",
              "Gemini",
            ],
          ),
        ],
      },
    ],
  },
  "agent-import": {
    title: settingsMessages.conversationImportTitle,
    groups: [
      {
        title: settingsMessages.conversationImportImport2,
        entries: [
          entry(
            settingsMessages.conversationImportImportConversations,
            settingsMessages.conversationImportCopyCodexAndClaudeCodeConversations,
            [
              "codex://threads",
              "Search conversations",
              "Conversation link or ID",
              "Claude Code",
              "Codex",
              "CODEX_HOME",
              "CLAUDE_CONFIG_DIR",
              "batch",
            ],
          ),
        ],
        messages: [
          settingsMessages.conversationImportDestination,
          settingsMessages.conversationImportProjectless,
          settingsMessages.conversationImportFolderMissing,
          settingsMessages.conversationImportChooseFolder,
          settingsMessages.conversationImportImportAndOpen,
          settingsMessages.conversationImportNotImported,
        ],
      },
    ],
  },
  "inbox-settings": {
    title: settingsMessages.inboxTitle,
    subtitle: settingsMessages.inboxSearchSubtitle,
    groups: [
      {
        title: settingsMessages.inboxSearchSuggestions,
        entries: [
          entry(
            settingsMessages.inboxSearchSuggestDestination,
            settingsMessages.inboxSearchSuggestDestinationDescription,
            ["inbox", "suggestions", "dispatch", "agent", "capture"],
          ),
          entry(
            settingsMessages.inboxSearchSuggestWith,
            settingsMessages.inboxSearchSuggestWithDescription,
            ["suggestion agent", "codex", "claude", "model"],
          ),
          entry(
            settingsMessages.inboxSearchAutoStart,
            settingsMessages.inboxSearchAutoStartDescription,
            ["start", "automatic", "requests"],
          ),
          entry(
            settingsMessages.inboxSearchRoutingPreferences,
            settingsMessages.inboxSearchRoutingPreferencesDescription,
            ["instructions", "routing"],
          ),
        ],
      },
      {
        title: settingsMessages.inboxSearchChats,
        entries: [
          entry(
            settingsMessages.inboxSearchShowMessage,
            settingsMessages.inboxSearchShowMessageDescription,
            ["page", "right panel", "side panel", "open"],
          ),
          entry(
            settingsMessages.inboxSearchNewChatsRunOn,
            settingsMessages.inboxSearchNewChatsRunOnDescription,
            ["dispatch", "runtime", "model", "effort", "speed"],
          ),
        ],
      },
    ],
  },
  "keyboard-shortcuts": {
    title: settingsMessages.keyboardShortcutsTitle,
    groups: [
      {
        title: settingsMessages.keyboardShortcutsTitle,
        messages: [
          settingsMessages.linkOpeningOpenWebLinkInDefaultBrowser,
          settingsMessages.linkOpeningHoldTheAssignedKeysWhileClicking,
          settingsMessages.keyboardShortcutsSearchLabel,
          settingsMessages.keyboardShortcutsSearchPlaceholder,
          settingsMessages.keyboardShortcutsSearchByKeystrokes,
          settingsMessages.keyboardShortcutsSearchCapturePlaceholder,
          settingsMessages.keyboardShortcutsLoadingShortcuts,
          settingsMessages.keyboardShortcutsCouldNotLoadShortcuts,
          settingsMessages.keyboardShortcutsNoMatchingShortcuts,
          settingsMessages.keyboardShortcutsCommand,
          settingsMessages.keyboardShortcutsKeybinding,
          settingsMessages.keyboardShortcutsActions,
          settingsMessages.keyboardShortcutsChangeShortcut,
          settingsMessages.keyboardShortcutsSetShortcut,
          settingsMessages.keyboardShortcutsClearShortcut,
          settingsMessages.keyboardShortcutsResetShortcut,
          settingsMessages.keyboardShortcutsResetAllToDefaults,
          settingsMessages.keyboardShortcutsResetAllKeyboardShortcuts,
          settingsMessages.keyboardShortcutsThisWillDiscardAllCustomShortcuts,
          settingsMessages.linkOpeningUnassigned,
          settingsMessages.keyboardShortcutsConflict,
          settingsMessages.keyboardShortcutsCommandKeybindings,
        ],
      },
    ],
  },
  page: {
    title: settingsMessages.pageTitle,
    subtitle: settingsMessages.pagePageCreationAndImportBehavior,
    groups: [
      {
        title: settingsMessages.pageBlockImport,
        entries: [
          entry(
            settingsMessages.pageTaskShorthandLabel,
            settingsMessages.pageTaskShorthandDescription,
            ["task shorthand", "block import", "priority", "estimate", "tags", "1XL"],
          ),
        ],
      },
    ],
  },
  git: {
    title: settingsMessages.gitTitle,
    subtitle: settingsMessages.gitBranchNamingAndInstructionsUsedBy,
    groups: [
      {
        title: settingsMessages.gitBranches,
        entries: [
          entry(
            settingsMessages.gitBranchPrefixLabel,
            settingsMessages.gitBranchPrefixDescription,
            [DEFAULT_WORKTREE_AUTO_BRANCH_PREFIX],
          ),
        ],
      },
      {
        title: settingsMessages.gitCommitInstructionsLabel,
        description: settingsMessages.gitCommitInstructionsDescription,
        messages: [settingsMessages.gitCommitInstructionsPlaceholder, settingsMessages.gitSave],
      },
      {
        title: settingsMessages.gitPullRequestInstructionsLabel,
        description: settingsMessages.gitPullRequestInstructionsDescription,
        messages: [
          settingsMessages.gitPullRequestInstructionsPlaceholder,
          settingsMessages.gitSave,
        ],
      },
    ],
  },
  worktrees: {
    title: settingsMessages.worktreesTitle,
    subtitle: settingsMessages.worktreesManagedWorktreeCreationNamingAndCleanup,
    groups: [
      {
        title: settingsMessages.worktreesDefaults,
        entries: [
          entry(
            settingsMessages.worktreesWorktreeStartMode,
            settingsMessages.worktreesChooseWhetherNewWorktreeThreadsAuto,
            ["Auto branch", "Detached HEAD"],
          ),
        ],
      },
      {
        title: settingsMessages.worktreesManagedWorktrees,
        description: settingsMessages.worktreesWorktreesCreatedByCardThreadsHover,
        messages: [
          "Git",
          settingsMessages.worktreesBranch,
          settingsMessages.worktreesManagedDirectory,
          settingsMessages.worktreesCleanup,
          settingsMessages.worktreesRemoveWorktreeRecord,
        ],
      },
    ],
  },
  "local-environments": {
    title: settingsMessages.environmentsLocalEnvironments,
    subtitle: settingsMessages.environmentsLocalEnvironmentsTellNodexHowTo2,
    groups: [
      {
        title: settingsMessages.environmentsSelectAProject,
        messages: [
          settingsMessages.environmentsAddProject,
          settingsMessages.environmentsNoProjectsYetAddOneTo,
          settingsMessages.environmentsAvailableProjects,
          settingsMessages.environmentsLoadingLocalEnvironments,
          settingsMessages.environmentsFetchingYourProjectConfiguration,
        ],
      },
      {
        title: settingsMessages.environmentsSetup,
        description: settingsMessages.environmentsThisScriptRunsOnWorktreeCreation,
        entries: [
          entry(settingsMessages.environmentsName),
          entry(
            settingsMessages.environmentsSetupScriptEnvironmentVariables,
            settingsMessages.environmentsVariablesAvailableToTheSetupScript,
            [
              "Source workspace path",
              "New worktree path",
              "CODEX_SOURCE_TREE_PATH",
              "CODEX_WORKTREE_PATH",
            ],
          ),
        ],
        messages: [
          settingsMessages.environmentsDefault,
          "macOS",
          "Linux",
          "Windows",
          settingsMessages.environmentsNoScriptConfigured,
          settingsMessages.environmentsNoScriptConfiguredForThisPlatform,
          settingsMessages.environmentsNoPlatformOverrideUsingTheDefault,
        ],
      },
      {
        title: settingsMessages.environmentsCleanup,
        description: settingsMessages.environmentsRunsAtTheProjectRootBefore,
        messages: [
          settingsMessages.environmentsDefault,
          "macOS",
          "Linux",
          "Windows",
          settingsMessages.environmentsNoScriptConfigured,
          settingsMessages.environmentsNoScriptConfiguredForThisPlatform,
        ],
      },
      {
        title: settingsMessages.environmentsActions,
        description: settingsMessages.environmentsTheseActionsCanRunAnyCommand,
        messages: [
          settingsMessages.environmentsAddAction,
          settingsMessages.environmentsNoActionsConfigured,
          settingsMessages.environmentsAllPlatforms,
          settingsMessages.environmentsEnterAnActionName,
          settingsMessages.environmentsEnterAnActionCommand,
          settingsMessages.environmentsEditLocalEnvironment,
          settingsMessages.environmentsDiscardEdits,
          settingsMessages.environmentsRetrySave,
        ],
      },
    ],
  },
  "hooks-settings": {
    title: settingsMessages.hooksTitle,
    subtitle: settingsMessages.hooksManageLifecycleHooksFromConfigAnd,
    groups: [
      {
        title: settingsMessages.hooksFromConfig,
        entries: [
          entry(
            settingsMessages.hooksUserConfig,
            settingsMessages.hooksHooksConfiguredForTheCurrentUser,
          ),
          entry(
            settingsMessages.hooksAdminConfig,
            settingsMessages.hooksHooksManagedBySystemAndOrganization,
          ),
        ],
      },
      {
        title: settingsMessages.hooksFromPlugins,
        messages: [
          settingsMessages.hooksUnknownPlugin,
          settingsMessages.hooksTrust,
          settingsMessages.hooksManagedHooksAreAlwaysOn,
        ],
      },
      {
        title: settingsMessages.hooksFromProjects,
        messages: [
          settingsMessages.hooksProjectConfig,
          settingsMessages.hooksReloadHooks,
          settingsMessages.hooksNoHooksFound,
          settingsMessages.hooksCouldNotLoadHooks,
        ],
      },
      {
        title: settingsMessages.hooksOtherSources,
        messages: [
          settingsMessages.hooksSessionFlags,
          settingsMessages.hooksUnknownSource,
          settingsMessages.hooksConfiguredHooksWillAppearHere,
        ],
      },
    ],
  },
  "data-controls": {
    title: settingsMessages.archivedChatsTitle,
    subtitle: settingsMessages.archivedChatsManageArchivedChatsAndPermanentLocal,
    groups: [
      {
        title: settingsMessages.archivedChatsArchivedChats,
        messages: [
          settingsMessages.archivedChatsSearchArchivedChats,
          settingsMessages.archivedChatsGroupArchivedChats,
          settingsMessages.archivedChatsSortArchivedChats,
          settingsMessages.archivedChatsUnarchive,
          settingsMessages.archivedChatsDeleteArchivedChat3,
          settingsMessages.archivedChatsDeleteAllArchivedLocalChats2,
        ],
      },
    ],
  },
  backups: {
    title: settingsMessages.backupsTitle,
    subtitle: settingsMessages.backupsSnapshotCadenceRetentionAndRestoreOperations,
    groups: [
      {
        title: settingsMessages.backupsAutomaticSnapshots,
        entries: [
          entry(
            settingsMessages.backupsAutoBackups,
            settingsMessages.backupsSnapshotPagesDatabasesAndFilesIn,
          ),
          entry(settingsMessages.backupsStorageBudget),
          entry(settingsMessages.backupsFrequency, settingsMessages.backupsMinimumIsOneHour, [
            settingsMessages.backupsHours,
          ]),
          entry(
            settingsMessages.backupsRetention,
            settingsMessages.backupsSnapshotsKeptBeforePruning,
            [settingsMessages.backupsMax],
          ),
        ],
        messages: [
          settingsMessages.backupsSomeValuesLockedByEnvVars,
          settingsMessages.backupsRefresh,
          settingsMessages.backupsSaveSchedule,
        ],
      },
      {
        title: settingsMessages.backupsHistoryRetention,
        entries: [
          entry(
            settingsMessages.backupsHistoryRetention,
            settingsMessages.backupsNewestDeletedBlockRecordsKeptPer,
            [settingsMessages.backupsRecords],
          ),
        ],
        messages: [
          settingsMessages.backupsValueLockedByEnvVar,
          settingsMessages.backupsAppliedByBackgroundMaintenance,
          settingsMessages.backupsApply,
        ],
      },
      {
        title: settingsMessages.backupsSnapshots,
        entries: [
          entry(
            settingsMessages.backupsSafetyBackup,
            settingsMessages.backupsCreateAFreshSnapshotBeforeRestoring,
          ),
        ],
        messages: [
          settingsMessages.backupsOptionalSnapshotLabel,
          settingsMessages.backupsCreateSnapshot,
          settingsMessages.backupsNoSnapshotsYet,
          settingsMessages.backupsManual,
          settingsMessages.backupsAuto,
          settingsMessages.backupsSafety,
          settingsMessages.backupsConfirmRestore,
          settingsMessages.backupsRestore,
          settingsMessages.backupsConfirmDelete,
          settingsMessages.backupsCancel,
          settingsMessages.backupsDeleteSnapshot,
          settingsMessages.backupsSnapshotDeleted,
          settingsMessages.backupsBackupRestored,
        ],
      },
    ],
  },
} satisfies Record<string, SettingsSearchCatalogPanel>;

/**
 * The anchored group a settings search result lands on inside its panel: the best-matching group
 * when it has an anchor, or none when the query names the panel itself.
 */
export function settingsSearchAnchor(
  sectionId: string,
  query: string | undefined,
  intl = getIntl(),
): string | null {
  const panel: SettingsSearchCatalogPanel | undefined =
    SETTINGS_SEARCH_PANELS[sectionId as keyof typeof SETTINGS_SEARCH_PANELS];
  if (!panel || !query?.trim()) return null;
  if (
    [formatSearchMessage(panel.title), formatSearchMessage(panel.title, intl)].some(
      (title) => scoreSettingsQueryMatch(title, query) > 0,
    )
  )
    return null;
  const targets = panel.groups.map((group, index) => ({
    sectionId: String(index),
    panelLabel: formatSearchMessage(group.title, intl),
    messageTexts: [
      ...indexSearchMessages(
        materializePanelSearchMessages({ title: group.title, groups: [group] }),
        intl,
      ).keys(),
    ],
    termTexts: [],
  }));
  const [best] = buildSettingsSearchResults({
    query,
    targets,
    visibleSectionIds: targets.map((target) => target.sectionId),
  });
  return best ? (panel.groups[Number(best.sectionId)]?.anchor ?? null) : null;
}

/** Use the canonical Advanced group when a settings search opens Appearance. */
export function shouldExpandAppearanceAdvanced(query: string | undefined): boolean {
  return settingsSearchAnchor("appearance", query) === APPEARANCE_ADVANCED_ANCHOR;
}

const SETTINGS_SEARCH_CATALOG = {
  account: {
    messages: () => materializePanelSearchMessages(SETTINGS_SEARCH_PANELS.account),
  },
  "general-settings": {
    messages: () => materializePanelSearchMessages(SETTINGS_SEARCH_PANELS["general-settings"]),
  },
  appearance: {
    messages: () => materializePanelSearchMessages(SETTINGS_SEARCH_PANELS.appearance),
  },
  voice: {
    messages: () => materializePanelSearchMessages(SETTINGS_SEARCH_PANELS.voice),
  },
  browser: {
    messages: [
      settingsMessages.browserTitle,
      settingsMessages.linkOpeningWebURLAndLinkOpenDestination,
      settingsMessages.linkOpeningLocalURLOpenDestination,
      settingsMessages.linkOpeningWhereLocalDevelopmentSitesOpenBy,
      settingsMessages.linkOpeningDefaultBrowser,
      settingsMessages.browserSearchProfile,
      settingsMessages.browserSearchImportData,
      settingsMessages.browserSearchCookies,
      settingsMessages.browserSearchSiteData,
      settingsMessages.browserSearchCache,
      settingsMessages.browserSearchDownloadHistory,
      settingsMessages.browserSearchProviderAvailability,
      settingsMessages.generalGeneral,
      settingsMessages.browserSearchAutofillAndPasswords,
      settingsMessages.browserSearchSavedPasswords,
      settingsMessages.browserSearchPasswordManager,
      settingsMessages.browserSearchCredentialStorage,
      settingsMessages.browserSearchImportFromBrowser,
      settingsMessages.browserSearchRemovePassword,
      settingsMessages.browserSearchContactInfo,
      settingsMessages.browserSearchAutofill,
      settingsMessages.browserSearchName,
      settingsMessages.browserSearchEmail,
      settingsMessages.browserSearchPhone,
      settingsMessages.browserSearchAddress,
      settingsMessages.browserSearchHistory,
      settingsMessages.browserSearchSearchHistory,
      settingsMessages.browserSearchClearHistory,
      settingsMessages.browserSearchVisitedPages,
      settingsMessages.browserSearchExtensions,
      settingsMessages.browserSearchControlExistingBrowsers,
      settingsMessages.browserSearchWaitingForExtension,
      settingsMessages.browserSearchControlProvider,
      settingsMessages.browserSearchExtensionManager,
      settingsMessages.browserSearchLoadUnpacked,
      settingsMessages.browserSearchRemoveExtension,
      settingsMessages.browserSearchSharedProfile,
      settingsMessages.browserSearchDownloads,
      settingsMessages.browserSearchPermissions,
      settingsMessages.browserSearchWebsiteAccess,
      settingsMessages.browserSearchBrowsingHistory,
      settingsMessages.browserSearchUploads,
      settingsMessages.browserSearchSitePermissions,
      settingsMessages.browserSearchRememberedOrigins,
      settingsMessages.browserSearchDeveloperMode,
      settingsMessages.browserSearchFullCdpAccess,
    ],
  },
  "plugins-settings": {
    messages: [
      settingsMessages.pluginsTitle,
      settingsMessages.pluginsSearchManage,
      settingsMessages.pluginsSearchBrowse,
      settingsMessages.pluginsSearchAddMarketplace,
      settingsMessages.pluginsSearchSkills,
    ],
  },
  "computer-use": {
    messages: [
      settingsMessages.computerUseTitle,
      settingsMessages.computerUseAnyApp,
      settingsMessages.computerUseAlwaysAllowedApps,
      settingsMessages.computerUseAlwaysAllowedToSend,
      settingsMessages.computerUseClickSounds,
      settingsMessages.computerUseLockedUse,
      settingsMessages.computerUsePictureInPicture,
      settingsMessages.computerUseAlwaysHidePictureInPicture,
    ],
  },
  models: {
    messages: () => materializePanelSearchMessages(SETTINGS_SEARCH_PANELS.models),
  },
  agent: {
    messages: () => materializePanelSearchMessages(SETTINGS_SEARCH_PANELS.agent),
  },
  "agent-import": {
    messages: () => materializePanelSearchMessages(SETTINGS_SEARCH_PANELS["agent-import"]),
  },
  "keyboard-shortcuts": {
    messages: () => materializePanelSearchMessages(SETTINGS_SEARCH_PANELS["keyboard-shortcuts"]),
  },
  "inbox-settings": {
    messages: () => materializePanelSearchMessages(SETTINGS_SEARCH_PANELS["inbox-settings"]),
  },
  page: {
    messages: () => materializePanelSearchMessages(SETTINGS_SEARCH_PANELS.page),
  },
  git: {
    messages: () => materializePanelSearchMessages(SETTINGS_SEARCH_PANELS.git),
  },
  worktrees: {
    messages: () => materializePanelSearchMessages(SETTINGS_SEARCH_PANELS.worktrees),
  },
  "local-environments": {
    messages: () => materializePanelSearchMessages(SETTINGS_SEARCH_PANELS["local-environments"]),
  },
  "hooks-settings": {
    messages: () => materializePanelSearchMessages(SETTINGS_SEARCH_PANELS["hooks-settings"]),
  },
  "data-controls": {
    messages: () => materializePanelSearchMessages(SETTINGS_SEARCH_PANELS["data-controls"]),
  },
  backups: {
    messages: () => materializePanelSearchMessages(SETTINGS_SEARCH_PANELS.backups),
  },
} satisfies Record<string, SettingsSearchCatalogSection>;

function sectionSearchMessages(sectionId: string): readonly SearchMessage[] {
  const section: SettingsSearchCatalogSection | undefined =
    SETTINGS_SEARCH_CATALOG[sectionId as keyof typeof SETTINGS_SEARCH_CATALOG];
  return typeof section?.messages === "function" ? section.messages() : (section?.messages ?? []);
}

/** The command palette also uses these source strings as search keywords. */
export function settingsSearchSourceMessages(sectionId: string): readonly string[] {
  return uniqueText(
    sectionSearchMessages(sectionId).map((message) => formatSearchMessage(message)),
  );
}

/** Pair each matching text with the label to display, in the active app language. */
export function settingsSearchIndex(sectionId: string, intl: IntlShape) {
  return indexSearchMessages(sectionSearchMessages(sectionId), intl);
}
