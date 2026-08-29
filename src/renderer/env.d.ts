import type { AppInitializationStep } from "../shared/app-startup";
import type { CoreAuthorityStatus } from "../shared/core-authority-status";
import type {
  AppUpdateStatus,
  ClipboardPastePayload,
  ClipboardPasteInspectionItem,
  ClipboardPasteInspectionResult,
} from "../shared/types";
import type {
  NativeContextMenuItem,
  NativeContextMenuOptions,
} from "../shared/native-context-menu";
import type { CodexDesktopMessageFromView } from "../shared/remote-hosted-pip";
import type { WorkbenchCommandInvocation } from "../shared/workbench-commands";
import type {
  StructuralClipboardAwaitInput,
  StructuralClipboardBeginInput,
  StructuralClipboardLifecycleResult,
  StructuralClipboardResolution,
  StructuralClipboardSettleInput,
  StructuralClipboardWriteInput,
  StructuralClipboardWriteResult,
} from "../shared/clipboard-paste";
import type {
  GlobalDictationContextMenuAction,
  GlobalDictationRendererCommand,
  GlobalDictationRendererEvent,
} from "../shared/global-dictation";
import type { ContentAccessContext } from "../shared/content-access-context";
import type { PrepareDroppedPageFilesResult } from "../shared/page-files";

declare module "*.css";

declare global {
  interface ImportMetaEnv {
    readonly MODE: string;
    readonly DEV: boolean;
    readonly PROD: boolean;
    readonly SSR: boolean;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }

  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
    api?: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      on: (event: string, callback: (...args: unknown[]) => void) => () => void;
      onAppUpdateStatus?: (callback: (status: AppUpdateStatus) => void) => () => void;
      awaitInitialization?: () => Promise<void>;
      getCoreAuthorityStatus?: () => Promise<CoreAuthorityStatus>;
      onCoreAuthorityStatus?: (callback: (status: CoreAuthorityStatus) => void) => () => void;
      retryCoreAuthority?: () => Promise<void>;
      relaunchForCoreAuthority?: () => Promise<void>;
      restartApplication?: () => Promise<void>;
      onInitializationStep?: (callback: (step: AppInitializationStep) => void) => () => void;
      reportInitializationReady?: (input: {
        durationMs: number;
        outcome: "failed" | "ready";
      }) => void;
      onNavigateBack?: (callback: () => void) => () => void;
      onNavigateForward?: (callback: () => void) => () => void;
      onToggleSidebar?: (callback: () => void) => () => void;
      onRenameThread?: (callback: () => void) => () => void;
      onOpenContentSearch?: (callback: () => void) => () => void;
      onCyclePanelTabPrevious?: (callback: () => void) => () => void;
      onCyclePanelTabNext?: (callback: () => void) => () => void;
      onClosePanelTab?: (callback: () => void) => () => void;
      onRequestNewWindow?: (callback: () => void) => () => void;
      onWorkbenchCommand?: (
        callback: (invocation: WorkbenchCommandInvocation) => void,
      ) => () => void;
      resolveManagedAssetPath?: (source: string) => string | null;
      resolveManagedBlobPath?: (contentHash: string) => string | null;
      inspectPasteClipboard?: () => ClipboardPasteInspectionResult;
      readPasteClipboard?: () => Promise<ClipboardPastePayload>;
      beginStructuralClipboard?: (
        input: StructuralClipboardBeginInput,
      ) => Promise<StructuralClipboardLifecycleResult>;
      publishStructuralClipboard?: (
        input: StructuralClipboardWriteInput,
      ) => Promise<StructuralClipboardWriteResult>;
      settleStructuralClipboard?: (
        input: StructuralClipboardSettleInput,
      ) => Promise<StructuralClipboardLifecycleResult>;
      awaitStructuralClipboard?: (
        input: StructuralClipboardAwaitInput,
      ) => Promise<StructuralClipboardResolution>;
      getPathInfoForFile?: (file: File) => ClipboardPasteInspectionItem | null;
      getPathForFile?: (file: File) => string;
      prepareDroppedPageFiles?: (
        accessContext: ContentAccessContext,
        operationId: string,
        files: readonly File[],
      ) => Promise<PrepareDroppedPageFilesResult>;
      sendGitWorkerMessage?: (
        message: import("../shared/git-worker-protocol").GitWorkerMessageFromView,
      ) => Promise<void>;
      onGitWorkerMessage?: (
        callback: (
          message: import("../shared/git-worker-protocol").GitWorkerMessageForView,
        ) => void,
      ) => () => void;
    };
    electronBridge?: {
      sendMessageFromView?: (message: CodexDesktopMessageFromView) => Promise<void>;
      showContextMenu: (
        items: NativeContextMenuItem[],
        options?: NativeContextMenuOptions,
      ) => Promise<string | null>;
    };
    globalDictation?: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      onCommand: (callback: (command: GlobalDictationRendererCommand) => void) => () => void;
      sendEvent: (event: GlobalDictationRendererEvent) => Promise<boolean>;
      showContextMenu: () => Promise<GlobalDictationContextMenuAction>;
    };
  }
}

export {};
