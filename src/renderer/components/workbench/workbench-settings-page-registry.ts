import type { ComponentType } from "react";
import type { ComposerEnterBehavior } from "../../lib/composer-enter-behavior";
import type { Project, WorktreeStartMode } from "../../lib/types";
import type {
  BrowserSettingsAnchor,
  BrowserSettingsDestination,
  BrowserSettingsDetail,
} from "./workbench-settings-routes";

export type SettingsPageKey =
  | "account"
  | "general"
  | "appearance"
  | "voice"
  | "agent"
  | "import"
  | "keyboard-shortcuts"
  | "inbox"
  | "browser"
  | "computer-use"
  | "page"
  | "git"
  | "worktrees"
  | "local-environments"
  | "hooks"
  | "data-controls"
  | "backups";

/** Opens a chat from Settings; an Agent chat may name its Session to skip a Thread lookup. */
export type SettingsOpenThread = (
  threadId: string,
  context?: { readonly runtimeSessionId: string },
) => void | Promise<void>;

export interface SettingsSectionPageProps {
  activeProjectId: string | null;
  browserAnchor: BrowserSettingsAnchor | null;
  browserDetail: BrowserSettingsDetail | null;
  composerEnterBehavior: ComposerEnterBehavior;
  initialLocalEnvironmentConfigPath?: string | null;
  initialLocalEnvironmentProjectId?: string | null;
  initialSearchQuery?: string;
  isMacPlatform: boolean;
  onComposerEnterBehaviorChange: (value: ComposerEnterBehavior) => void;
  onOpenBrowserDetail: (
    destination: BrowserSettingsDestination,
    anchor?: BrowserSettingsAnchor,
  ) => void;
  onOpenThread?: SettingsOpenThread;
  onPathChange: (path: string) => void;
  onRequestProjectPickerOpen: () => void;
  onTaskShorthandPagePromotionEnabledChange: (value: boolean) => void;
  onThreadQueueFollowUpsEnabledChange: (value: boolean) => void;
  onWorktreeAutoBranchPrefixChange: (value: string) => void;
  onWorktreeStartModeChange: (value: WorktreeStartMode) => void;
  open: boolean;
  path: string;
  projects: Project[];
  settingsAnchor?: string | null;
  taskShorthandPagePromotionEnabled: boolean;
  threadQueueFollowUpsEnabled: boolean;
  worktreeAutoBranchPrefix: string;
  worktreeStartMode: WorktreeStartMode;
}

export type SettingsPageComponent = ComponentType<SettingsSectionPageProps>;

export type SettingsPageComponentRegistry = Readonly<
  Record<SettingsPageKey, SettingsPageComponent>
>;
