import type {
  AppInitializationStep,
  DatabaseMigrationProgress,
} from "../shared/app-startup";
import type { ClipboardPasteInspectionItem, ClipboardPasteInspectionResult } from "../shared/types";

declare global {
  interface Window {
    api?: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      on: (event: string, callback: (...args: unknown[]) => void) => () => void;
      awaitInitialization?: () => Promise<void>;
      onInitializationStep?: (
        callback: (step: AppInitializationStep) => void,
      ) => () => void;
      onDatabaseMigrationProgress?: (
        callback: (progress: DatabaseMigrationProgress) => void,
      ) => () => void;
      serverUrl?: string;
      assetPathPrefix?: string;
      inspectPasteClipboard?: () => ClipboardPasteInspectionResult;
      getPathInfoForFile?: (file: File) => ClipboardPasteInspectionItem | null;
      getPathForFile?: (file: File) => string;
    };
  }
}

export {};
