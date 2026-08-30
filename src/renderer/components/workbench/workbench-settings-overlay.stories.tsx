import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY } from "@/lib/codex-service-tier-settings";
import type {
  BackupRecord,
  CodexPermissionState,
  DiagnosticsSettings,
  Project,
  TelemetrySettings,
  ThreadNotificationSettings,
  UpdateWorktreeEnvironmentConfigInput,
  WorktreeEnvironmentSettingsSnapshot,
} from "@/lib/types";
import { SettingsRouteShell } from "./workbench-settings-route-shell";
import {
  buildBrowserSettingsPath,
  buildSettingsPath,
  buildSettingsAnchorPath,
  OPEN_SOURCE_LICENSES_SETTINGS_PATH,
} from "./workbench-settings-routes";
import { DEFAULT_BROWSER_USE_POLICY } from "../../../shared/browser-use-policy";
import {
  applyCommandKeybindingUpdate,
  createCommandKeymapState,
  type CommandKeybindingOverrides,
  type CommandKeybindingUpdate,
} from "../../../shared/command-keybindings";
import { DEFAULT_DICTATION_SETTINGS } from "../../../shared/dictation";

const PROJECTS: Project[] = [
  {
    id: "default",
    libraryId: "library:test",
    databaseId: "database:test:primary",
    defaultDatabaseViewId: "view:test:primary",
    lifecycle: "active",
    bindingRevision: 1,
    name: "Nodex",
    description: "",
    appearance: { color: "blue", marker: { kind: "icon", icon: "terminal" } },
    sources: [{ root: "/Users/asc/repo/nodex", order: 0 }],
    primaryWorkspaceRoot: "/Users/asc/repo/nodex",
    pinned: false,
    pinnedOrder: null,
    created: new Date("2026-03-01T00:00:00.000Z"),
    updated: new Date("2026-03-01T00:00:00.000Z"),
  },
];

const DEFAULT_NOTIFICATION_SETTINGS: ThreadNotificationSettings = {
  turnMode: "unfocused",
  permissionsEnabled: true,
  questionsEnabled: true,
};

function buildEnvironmentSnapshot(
  projectId: string,
  overrides?: Partial<WorktreeEnvironmentSettingsSnapshot>,
): WorktreeEnvironmentSettingsSnapshot {
  const project = PROJECTS.find((candidate) => candidate.id === projectId) ?? PROJECTS[0];

  return {
    projectId: project.id,
    projectName: project.name,
    workspacePath: project.primaryWorkspaceRoot ?? "",
    configPath: ".codex/environments/environment.toml",
    nextConfigPath: ".codex/environments/environment-2.toml",
    configExists: true,
    revision: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    configs: [
      {
        configPath: ".codex/environments/environment.toml",
        fileName: "environment.toml",
        state: "success",
        exists: true,
        name: `${project.name} env`,
        hasSetupScript: true,
        hasCleanupScript: true,
        actionCount: 1,
        parseErrorMessage: null,
        readErrorMessage: null,
        environment: {
          version: 1,
          name: `${project.name} env`,
          setup: {
            script: "bun install\nbun run build",
            platformScripts: {},
          },
          cleanup: {
            script: "git clean -fd",
            platformScripts: {},
          },
          actions: [
            {
              name: "Run tests",
              icon: "test",
              command: "bun test",
              platform: null,
            },
          ],
        },
      },
    ],
    environment: {
      version: 1,
      name: `${project.name} env`,
      setup: {
        script: "bun install\nbun run build",
        platformScripts: {},
      },
      cleanup: {
        script: "git clean -fd",
        platformScripts: {},
      },
      actions: [
        {
          name: "Run tests",
          icon: "test",
          command: "bun test",
          platform: null,
        },
      ],
    },
    parseErrorMessage: null,
    readErrorMessage: null,
    ...overrides,
  };
}

function ensureStorybookElectronBridge({
  snapshots,
  onSaveSnapshot,
  backups,
  onDeleteBackup,
  onCreateBackup,
  initialCommandKeybindingOverrides = {},
  notificationSettings,
}: {
  snapshots: Record<string, WorktreeEnvironmentSettingsSnapshot>;
  onSaveSnapshot: (input: UpdateWorktreeEnvironmentConfigInput) => { type: "success" };
  backups: BackupRecord[];
  onDeleteBackup: (backupId: string) => void;
  onCreateBackup: (label: string | null) => BackupRecord;
  initialCommandKeybindingOverrides?: CommandKeybindingOverrides;
  notificationSettings: ThreadNotificationSettings;
}) {
  if (typeof window === "undefined") return;

  let diagnosticsSettings: DiagnosticsSettings = {
    enabled: false,
    dsn: "",
    environment: "production",
    release: null,
    tracesSampleRate: 0,
    replayEnabled: false,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1,
    envOverrides: {
      enabled: false,
      dsn: false,
      environment: false,
      release: false,
      tracesSampleRate: false,
      replayEnabled: false,
      replaysSessionSampleRate: false,
      replaysOnErrorSampleRate: false,
    },
  };
  let telemetrySettings: TelemetrySettings = {
    enabled: false,
    clientKey: "",
    environment: "production",
    autoCaptureEnabled: false,
    envOverrides: {
      enabled: false,
      clientKey: false,
      environment: false,
      autoCaptureEnabled: false,
    },
  };
  const permissionState: CodexPermissionState = {
    mode: "auto",
    effectivePreset: "auto",
    availableModes: ["auto", "guardian-approvals", "full-access", "custom"],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxMode: "workspace-write",
    sandbox: {
      type: "workspaceWrite",
      writableRoots: [PROJECTS[0].primaryWorkspaceRoot ?? ""],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    autoReviewAvailable: true,
    configTarget: {
      source: "user",
      filePath: "/Users/asc/.codex/config.toml",
    },
  };
  let commandKeybindingOverrides: CommandKeybindingOverrides = {
    ...initialCommandKeybindingOverrides,
  };
  let gitSettings = {
    branchPrefix: "codex/",
    commitInstructions: "Keep commits focused and use imperative subjects.",
    pullRequestInstructions: "Summarize validation and link the relevant issue.",
  };
  let dictationSettings = {
    ...DEFAULT_DICTATION_SETTINGS,
    dictionary: ["Nodex", "BlockNote", "useComposerDictation"],
  };

  window.api = {
    invoke: async (channel: string, ...args: unknown[]) => {
      switch (channel) {
        case "settings:git:get":
          return gitSettings;
        case "settings:third-party-notices:get":
          return {
            text: [
              "NODEX THIRD-PARTY NOTICES",
              "",
              "react@19.2.7 — MIT — https://react.dev",
              "",
              "Permission is hereby granted, free of charge, to any person obtaining a copy...",
            ].join("\n"),
          };
        case "settings:git:update":
          gitSettings = { ...gitSettings, ...(args[0] as Partial<typeof gitSettings>) };
          return gitSettings;
        case "settings:thread-notifications:get":
          return notificationSettings;
        case "codex-command-keymap-state":
          return createCommandKeymapState(commandKeybindingOverrides);
        case "set-codex-command-keybinding": {
          const [commandId, update] = args as [string, CommandKeybindingUpdate];
          commandKeybindingOverrides = applyCommandKeybindingUpdate(
            commandKeybindingOverrides,
            commandId,
            update,
          );
          return { type: "applied", state: createCommandKeymapState(commandKeybindingOverrides) };
        }
        case "reset-codex-command-keybindings":
          commandKeybindingOverrides = {};
          return { type: "applied", state: createCommandKeymapState(commandKeybindingOverrides) };
        case "global-dictation-capture-fn-hotkey":
          return null;
        case "codex:dictation:state:read":
          return {
            isEnabled: true,
            authMethod: "chatgpt",
            shortcutLabel: "Fn",
            capabilities: {
              composer: true,
              global: true,
              history: true,
              streaming: "available",
              semanticCleanup: true,
              microphoneOwner: "none",
              auth: "chatgpt",
            },
          };
        case "codex:dictation:microphone-access:read":
          return "granted";
        case "codex:dictation:settings:read":
          return dictationSettings;
        case "codex:dictation:settings:update":
          dictationSettings = { ...dictationSettings, ...(args[0] as object) };
          return dictationSettings;
        case "codex:dictation:global-permissions:read":
          return { available: true, inputMonitoring: true, accessibility: true };
        case "codex:dictation:history:list":
          return [
            {
              schemaVersion: 1,
              id: "storybook-dictation-1",
              createdAtMs: Date.parse("2026-08-25T08:15:00.000Z"),
              updatedAtMs: Date.parse("2026-08-25T08:15:08.000Z"),
              durationMs: 8_000,
              mimeType: "audio/webm;codecs=opus",
              sizeBytes: 48_000,
              chunkCount: 2,
              status: "completed",
              surface: "composer",
              transcript: "Add the dictation follow-up to my task list.",
            },
          ];
        case "codex:permission:state:get":
        case "codex:permission:mode:set":
        case "codex:permission:config-value:set":
          return permissionState;
        case "browser-profile-capabilities":
          return {
            contactInfo: { available: true, provider: "storybook" },
            credentialVault: { available: true, provider: "storybook" },
            extensions: { available: true, provider: "storybook" },
            history: { available: true, provider: "storybook" },
            profileImport: { available: true, provider: "storybook" },
            siteInfo: { available: true, provider: "storybook" },
          };
        case "browser-use-policy-get":
          return DEFAULT_BROWSER_USE_POLICY;
        case "browser-use-policy-update-modes":
        case "browser-use-policy-update-origin-rule":
          return { ...DEFAULT_BROWSER_USE_POLICY, ...(args[0] as object) };
        case "browser-browsing-data-clear":
        case "browser-credential-remove":
        case "browser-contact-info-remove":
        case "browser-extension-remove":
        case "browser-download-history-clear":
          return { ok: true };
        case "browser-credentials-list-all":
          return [];
        case "browser-contact-info-list":
          return [];
        case "browser-history-list":
          return { entries: [] };
        case "browser-extensions-list":
          return {
            capability: { available: true, provider: "storybook" },
            extensions: [],
          };
        case "browser-downloads-list":
          return { downloads: [] };
        case "browser-download-action":
          return { ok: true };
        case "settings:app-updates:get":
          return { automaticChecksEnabled: true };
        case "app:update:status":
          return {
            status: "idle",
            supported: true,
            currentVersion: "0.1.0",
            availableVersion: null,
            releaseName: null,
            releaseDate: null,
            releaseNotes: null,
            progressPercent: null,
            transferredBytes: null,
            totalBytes: null,
            checkedAt: null,
            message: null,
          };
        case "worktrees:managed:list":
          return [];
        case "backup:list":
          return backups;
        case "backup:capacity:get":
          return {
            availableBytes: 256 * 1024 * 1024 * 1024,
            estimatedNextBackupBytes: 1.2 * 1024 * 1024 * 1024,
            safetyMarginBytes: 512 * 1024 * 1024,
            totalReadyBytes: backups.reduce((total, backup) => total + backup.totalBytes, 0),
            manualReadyBytes: backups
              .filter((backup) => backup.trigger !== "auto")
              .reduce((total, backup) => total + backup.totalBytes, 0),
            automaticReadyBytes: backups
              .filter((backup) => backup.trigger === "auto")
              .reduce((total, backup) => total + backup.totalBytes, 0),
            canCreate: true,
          };
        case "backup:storage-optimization:get":
          return {
            optimizing: true,
            commitHead: 344_647,
            replayFloor: 82_000,
            pendingCommitMetadata: 12_400,
            pendingReceiptMetadata: 12_876,
            retainedCommitCount: 344_647,
            retainedDeliveryBytes: 2.7 * 1024 * 1024 * 1024,
            retainedReceiptCount: 345_123,
            retainedReceiptBytes: 360 * 1024 * 1024,
            receiptFloorAt: null,
            lastPrunedCommit: 81_999,
            freelistPages: 256,
            reclaimableBytes: 256 * 1024 * 1024,
          };
        case "backup:delete": {
          const backupId = typeof args[0] === "string" ? args[0] : "";
          onDeleteBackup(backupId);
          return {
            success: true,
            deletedBackupId: backupId,
          };
        }
        case "backup:create": {
          const operationId =
            typeof args[0] === "object" &&
            args[0] &&
            "operationId" in (args[0] as Record<string, unknown>) &&
            typeof (args[0] as { operationId?: unknown }).operationId === "string"
              ? (args[0] as { operationId: string }).operationId
              : "storybook-backup-operation";
          const created = onCreateBackup(
            typeof args[0] === "object" &&
              args[0] &&
              "label" in (args[0] as Record<string, unknown>)
              ? typeof (args[0] as { label?: unknown }).label === "string"
                ? ((args[0] as { label?: string }).label ?? null)
                : null
              : null,
          );
          return {
            kind: "submitted",
            operationId,
            job: {
              jobId: operationId,
              state: "completed",
              phase: "ready",
              completedUnits: 7,
              totalUnits: 7,
              startedAt: Date.now(),
              updatedAt: Date.now(),
              backup: created,
              error: null,
              progress: {
                databaseCopiedPages: 0,
                databaseTotalPages: 0,
                databaseBusyRetries: 0,
                assetBytesCopied: 0,
                databaseCopyMs: 0,
                assetCopyMs: 0,
                validationMs: 0,
                digestMs: 0,
                publishMs: 0,
                writerHeldMs: 0,
              },
            },
          };
        }
        case "backup:job:get":
          return null;
        case "settings:backup:get":
          return {
            autoEnabled: false,
            intervalHours: 24,
            retentionCount: 25,
            retentionGiB: 32,
            envOverrides: {
              autoEnabled: false,
              intervalHours: false,
              retentionCount: false,
              retentionGiB: false,
            },
          };
        case "settings:history:get":
          return {
            retentionCount: 1000,
            envOverrides: { retentionCount: false },
          };
        case "settings:diagnostics:get":
          return diagnosticsSettings;
        case "settings:diagnostics:update": {
          const input = args[0] as {
            enabled?: unknown;
            dsn?: unknown;
            environment?: unknown;
            release?: unknown;
            tracesSampleRate?: unknown;
            replayEnabled?: unknown;
            replaysSessionSampleRate?: unknown;
            replaysOnErrorSampleRate?: unknown;
          };
          diagnosticsSettings = {
            ...diagnosticsSettings,
            enabled:
              typeof input.enabled === "boolean" ? input.enabled : diagnosticsSettings.enabled,
            dsn: typeof input.dsn === "string" ? input.dsn : diagnosticsSettings.dsn,
            environment:
              typeof input.environment === "string"
                ? input.environment
                : diagnosticsSettings.environment,
            release: typeof input.release === "string" ? input.release : null,
            tracesSampleRate:
              typeof input.tracesSampleRate === "number"
                ? input.tracesSampleRate
                : diagnosticsSettings.tracesSampleRate,
            replayEnabled:
              typeof input.replayEnabled === "boolean"
                ? input.replayEnabled
                : diagnosticsSettings.replayEnabled,
            replaysSessionSampleRate:
              typeof input.replaysSessionSampleRate === "number"
                ? input.replaysSessionSampleRate
                : diagnosticsSettings.replaysSessionSampleRate,
            replaysOnErrorSampleRate:
              typeof input.replaysOnErrorSampleRate === "number"
                ? input.replaysOnErrorSampleRate
                : diagnosticsSettings.replaysOnErrorSampleRate,
          };
          return diagnosticsSettings;
        }
        case "settings:telemetry:get":
          return telemetrySettings;
        case "settings:telemetry:update": {
          const input = args[0] as {
            enabled?: unknown;
            clientKey?: unknown;
            environment?: unknown;
            autoCaptureEnabled?: unknown;
          };
          telemetrySettings = {
            ...telemetrySettings,
            enabled: typeof input.enabled === "boolean" ? input.enabled : telemetrySettings.enabled,
            clientKey:
              typeof input.clientKey === "string" ? input.clientKey : telemetrySettings.clientKey,
            environment:
              typeof input.environment === "string"
                ? input.environment
                : telemetrySettings.environment,
            autoCaptureEnabled:
              typeof input.autoCaptureEnabled === "boolean"
                ? input.autoCaptureEnabled
                : telemetrySettings.autoCaptureEnabled,
          };
          return telemetrySettings;
        }
        case "worktrees:environments:config:read": {
          const projectId = typeof args[0] === "string" ? args[0] : PROJECTS[0].id;
          const configPath = typeof args[1] === "string" ? args[1] : null;
          const baseSnapshot = snapshots[projectId] ?? buildEnvironmentSnapshot(projectId);
          if (configPath && configPath !== baseSnapshot.configPath) {
            return {
              ...baseSnapshot,
              configPath,
              configExists: false,
              environment: null,
            };
          }
          return baseSnapshot;
        }
        case "worktrees:environments:configs:list": {
          const projectId = typeof args[0] === "string" ? args[0] : PROJECTS[0].id;
          return (snapshots[projectId] ?? buildEnvironmentSnapshot(projectId)).configs;
        }
        case "worktrees:environments:config:save":
          return onSaveSnapshot(args[0] as UpdateWorktreeEnvironmentConfigInput);
        default:
          return null;
      }
    },
    on: () => () => {},
  } as typeof window.api;
}

function SettingsRouteShellStory({
  initialPath,
  initialServiceTier = "standard",
  initialCommandKeybindingOverrides,
  initialSettingsSearchQuery,
  initialSettingsSearchHighlightIndex,
  notificationSettings = DEFAULT_NOTIFICATION_SETTINGS,
}: {
  initialPath: string;
  initialServiceTier?: "standard" | "fast";
  initialCommandKeybindingOverrides?: CommandKeybindingOverrides;
  initialSettingsSearchQuery?: string;
  initialSettingsSearchHighlightIndex?: number;
  notificationSettings?: ThreadNotificationSettings;
}) {
  const [path, setPath] = useState(initialPath);
  const [environmentSnapshots, setEnvironmentSnapshots] = useState<
    Record<string, WorktreeEnvironmentSettingsSnapshot>
  >({
    default: buildEnvironmentSnapshot("default"),
  });
  const [backups, setBackups] = useState<BackupRecord[]>([
    {
      version: 1,
      id: "2026-04-15T09-00-00-000Z-story-a",
      createdAt: "2026-04-15T09:00:00.000Z",
      trigger: "manual",
      label: "Before schema cleanup",
      includesAssets: true,
      dbBytes: 2_400_000,
      assetsBytes: 320_000,
      totalBytes: 2_720_000,
    },
    {
      version: 1,
      id: "2026-04-14T18-15-00-000Z-story-b",
      createdAt: "2026-04-14T18:15:00.000Z",
      trigger: "pre-restore",
      label: null,
      includesAssets: true,
      dbBytes: 2_100_000,
      assetsBytes: 300_000,
      totalBytes: 2_400_000,
    },
  ]);
  ensureStorybookElectronBridge({
    snapshots: environmentSnapshots,
    onSaveSnapshot: (input) => {
      const nextSnapshot = buildEnvironmentSnapshot(input.projectId, {
        configPath: input.configPath,
        configExists: true,
        environment: input.environment,
        configs: [
          {
            configPath: input.configPath,
            fileName: input.configPath.split("/").at(-1) ?? "environment.toml",
            state: "success",
            exists: true,
            name: input.environment.name,
            hasSetupScript: Boolean(input.environment.setup.script),
            hasCleanupScript: Boolean(input.environment.cleanup.script),
            actionCount: input.environment.actions.length,
            parseErrorMessage: null,
            readErrorMessage: null,
            environment: input.environment,
          },
        ],
      });
      setEnvironmentSnapshots((current) => ({
        ...current,
        [input.projectId]: nextSnapshot,
      }));
      return { type: "success" };
    },
    backups,
    onDeleteBackup: (backupId) => {
      setBackups((current) => current.filter((backup) => backup.id !== backupId));
    },
    onCreateBackup: (label) => {
      const backup = {
        version: 1,
        id: `storybook-${backups.length + 1}`,
        createdAt: "2026-04-15T10:30:00.000Z",
        trigger: "manual" as const,
        label,
        includesAssets: true,
        dbBytes: 1024 * 1024,
        assetsBytes: 256 * 1024,
        totalBytes: 1280 * 1024,
      };
      setBackups((current) => [backup, ...current]);
      return backup;
    },
    initialCommandKeybindingOverrides,
    notificationSettings,
  });

  if (typeof localStorage !== "undefined") {
    if (initialServiceTier === "fast") {
      localStorage.setItem(CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY, "fast");
    } else {
      localStorage.removeItem(CODEX_DEFAULT_SERVICE_TIER_STORAGE_KEY);
    }
  }

  return (
    <div className="h-screen bg-(--background)">
      <SettingsRouteShell
        path={path}
        onPathChange={setPath}
        initialSettingsSearchQuery={initialSettingsSearchQuery}
        initialSettingsSearchHighlightIndex={initialSettingsSearchHighlightIndex}
        onBackToApp={() => {}}
        onRequestProjectPickerOpen={() => {}}
        projects={PROJECTS}
        activeProjectId="default"
        initialLocalEnvironmentProjectId={null}
        initialLocalEnvironmentConfigPath={null}
        threadQueueFollowUpsEnabled={true}
        onThreadQueueFollowUpsEnabledChange={() => {}}
        composerEnterBehavior="cmdIfMultiline"
        onComposerEnterBehaviorChange={() => {}}
        worktreeStartMode="autoBranch"
        onWorktreeStartModeChange={() => {}}
        worktreeAutoBranchPrefix="codex/"
        onWorktreeAutoBranchPrefixChange={() => {}}
        taskShorthandPagePromotionEnabled={true}
        onTaskShorthandPagePromotionEnabledChange={() => {}}
      />
    </div>
  );
}

const meta = {
  title: "Workbench/Settings/Route Shell",
  component: SettingsRouteShellStory,
  args: {
    initialPath: buildSettingsPath("general-settings"),
  },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Codex-style route-based settings shell for Nodex. The left rail selects a single section page while the main pane keeps the shared settings surface.",
      },
    },
  },
} satisfies Meta<typeof SettingsRouteShellStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const General: Story = {
  render: () => <SettingsRouteShellStory initialPath={buildSettingsPath("general-settings")} />,
};

export const Appearance: Story = {
  render: () => <SettingsRouteShellStory initialPath={buildSettingsPath("appearance")} />,
};

export const NotificationsNever: Story = {
  render: () => (
    <SettingsRouteShellStory
      initialPath={buildSettingsPath("general-settings")}
      notificationSettings={{
        turnMode: "off",
        permissionsEnabled: true,
        questionsEnabled: true,
      }}
    />
  ),
};

export const NotificationsAlways: Story = {
  render: () => (
    <SettingsRouteShellStory
      initialPath={buildSettingsPath("general-settings")}
      notificationSettings={{
        turnMode: "always",
        permissionsEnabled: true,
        questionsEnabled: true,
      }}
    />
  ),
};

export const NotificationApprovalsDisabled: Story = {
  render: () => (
    <SettingsRouteShellStory
      initialPath={buildSettingsPath("general-settings")}
      notificationSettings={{
        turnMode: "unfocused",
        permissionsEnabled: false,
        questionsEnabled: true,
      }}
    />
  ),
};

export const NotificationQuestionsDisabled: Story = {
  render: () => (
    <SettingsRouteShellStory
      initialPath={buildSettingsPath("general-settings")}
      notificationSettings={{
        turnMode: "unfocused",
        permissionsEnabled: true,
        questionsEnabled: false,
      }}
    />
  ),
};

export const OpenSourceLicenses: Story = {
  render: () => <SettingsRouteShellStory initialPath={OPEN_SOURCE_LICENSES_SETTINGS_PATH} />,
};

export const DefaultGroupedSidebar: Story = {
  render: () => <SettingsRouteShellStory initialPath={buildSettingsPath("general-settings")} />,
};

export const SearchMultipleResults: Story = {
  render: () => (
    <SettingsRouteShellStory
      initialPath={buildSettingsPath("general-settings")}
      initialSettingsSearchQuery="settings"
    />
  ),
};

export const SearchNoResults: Story = {
  render: () => (
    <SettingsRouteShellStory
      initialPath={buildSettingsPath("general-settings")}
      initialSettingsSearchQuery="zzzzzz-unknown"
    />
  ),
};

export const SearchLongResultLabel: Story = {
  render: () => (
    <SettingsRouteShellStory
      initialPath={buildSettingsAnchorPath("general-settings", "composer")}
      initialSettingsSearchQuery="large paste description soft limit"
    />
  ),
};

export const SearchKeyboardHighlightedResult: Story = {
  render: () => (
    <SettingsRouteShellStory
      initialPath={buildSettingsPath("general-settings")}
      initialSettingsSearchQuery="settings"
      initialSettingsSearchHighlightIndex={0}
    />
  ),
};

export const GeneralFastTier: Story = {
  render: () => (
    <SettingsRouteShellStory
      initialPath={buildSettingsPath("general-settings")}
      initialServiceTier="fast"
    />
  ),
};

export const Agent: Story = {
  render: () => <SettingsRouteShellStory initialPath={buildSettingsPath("agent")} />,
};

export const Browser: Story = {
  render: () => <SettingsRouteShellStory initialPath={buildBrowserSettingsPath()} />,
};

export const BrowserPasswordManager: Story = {
  render: () => <SettingsRouteShellStory initialPath={buildBrowserSettingsPath("passwords")} />,
};

export const BrowserContactInfo: Story = {
  render: () => <SettingsRouteShellStory initialPath={buildBrowserSettingsPath("contact-info")} />,
};

export const BrowserHistory: Story = {
  render: () => <SettingsRouteShellStory initialPath={buildBrowserSettingsPath("history")} />,
};

export const BrowserExtensions: Story = {
  render: () => <SettingsRouteShellStory initialPath={buildBrowserSettingsPath("extensions")} />,
};

export const BrowserDownloads: Story = {
  render: () => <SettingsRouteShellStory initialPath={buildBrowserSettingsPath("downloads")} />,
};

export const LocalEnvironments: Story = {
  render: () => <SettingsRouteShellStory initialPath={buildSettingsPath("local-environments")} />,
};

export const KeyboardShortcuts: Story = {
  render: () => <SettingsRouteShellStory initialPath={buildSettingsPath("keyboard-shortcuts")} />,
};

export const Voice: Story = {
  render: () => <SettingsRouteShellStory initialPath={buildSettingsPath("voice")} />,
};

export const KeyboardShortcutsCustomState: Story = {
  render: () => (
    <SettingsRouteShellStory
      initialPath={buildSettingsPath("keyboard-shortcuts")}
      initialCommandKeybindingOverrides={{
        openThreadInNewWindow: ["CmdOrCtrl+Alt+W"],
        toggleThreadPin: [],
      }}
    />
  ),
};

export const Backups: Story = {
  render: () => <SettingsRouteShellStory initialPath={buildSettingsPath("backups")} />,
};

export const Git: Story = {
  render: () => <SettingsRouteShellStory initialPath={buildSettingsPath("git")} />,
};

export const InvalidSectionFallback: Story = {
  render: () => <SettingsRouteShellStory initialPath="/settings/not-real" />,
};

export const NarrowViewport: Story = {
  render: () => (
    <div className="h-screen w-[390px] overflow-hidden border-r border-token-border">
      <SettingsRouteShellStory initialPath={buildSettingsPath("keyboard-shortcuts")} />
    </div>
  ),
};
