import fs from "node:fs";
import path from "node:path";
import type { RemoteHostedPipTaskVisibility } from "../shared/remote-hosted-pip";

export type { RemoteHostedPipTaskVisibility } from "../shared/remote-hosted-pip";

export interface RemoteHostedPipPreferenceSnapshot {
  readonly alwaysHide: boolean;
  readonly maxDisplaySize: number | null;
  readonly revision: number;
  readonly taskVisibilities: Readonly<Record<string, RemoteHostedPipTaskVisibility>>;
}

type RemoteHostedPipPreferencesV3 = RemoteHostedPipPreferenceSnapshot & {
  readonly schemaVersion: 3;
};

const MAX_PREFERENCE_FILE_BYTES = 256 * 1024;
const MAX_TASK_PREFERENCES = 512;
const MAX_TASK_ID_LENGTH = 1_024;

const emptyPreferences = (): RemoteHostedPipPreferencesV3 => ({
  alwaysHide: false,
  maxDisplaySize: null,
  revision: 0,
  schemaVersion: 3,
  taskVisibilities: {},
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseTaskVisibilities(
  value: unknown,
): Readonly<Record<string, RemoteHostedPipTaskVisibility>> | null {
  const record = asRecord(value);
  if (!record || Object.keys(record).length > MAX_TASK_PREFERENCES) return null;
  const parsed: Record<string, RemoteHostedPipTaskVisibility> = {};
  for (const [taskId, visibility] of Object.entries(record)) {
    const normalized = taskId.trim();
    if (
      normalized !== taskId ||
      normalized.length === 0 ||
      normalized.length > MAX_TASK_ID_LENGTH ||
      (visibility !== "hidden" && visibility !== "shown")
    ) {
      return null;
    }
    parsed[normalized] = visibility;
  }
  return parsed;
}

function parsePreferences(value: unknown): RemoteHostedPipPreferencesV3 | null {
  const candidate = asRecord(value);
  if (!candidate) return null;
  const maxDisplaySize = candidate.maxDisplaySize;
  const parsedMaxDisplaySize =
    typeof maxDisplaySize === "number" && Number.isFinite(maxDisplaySize) && maxDisplaySize > 0
      ? maxDisplaySize
      : null;
  if (candidate.schemaVersion === 2) {
    return {
      alwaysHide: candidate.alwaysHide === true,
      maxDisplaySize: parsedMaxDisplaySize,
      revision: 0,
      schemaVersion: 3,
      taskVisibilities: {},
    };
  }
  if (candidate.schemaVersion !== 3) return null;
  const taskVisibilities = parseTaskVisibilities(candidate.taskVisibilities);
  if (!taskVisibilities) return null;
  if (
    typeof candidate.alwaysHide !== "boolean" ||
    !Number.isSafeInteger(candidate.revision) ||
    (candidate.revision as number) < 0
  ) {
    return null;
  }
  return {
    alwaysHide: candidate.alwaysHide,
    maxDisplaySize: parsedMaxDisplaySize,
    revision: candidate.revision as number,
    schemaVersion: 3,
    taskVisibilities,
  };
}

export interface RemoteHostedPipPreferencesAdapter {
  readonly deleteTaskVisibility: (taskId: string) => boolean;
  readonly readAlwaysHide: () => boolean;
  readonly readMaxDisplaySize: () => number | null;
  readonly readSnapshot: () => RemoteHostedPipPreferenceSnapshot;
  readonly setTaskVisibilities: (
    taskIds: readonly string[],
    visibility: RemoteHostedPipTaskVisibility,
  ) => boolean;
  readonly setTaskVisibility: (
    taskId: string,
    visibility: RemoteHostedPipTaskVisibility,
  ) => boolean;
  readonly writeAlwaysHide: (alwaysHide: boolean) => boolean;
  readonly writeMaxDisplaySize: (maxDisplaySize: number) => boolean;
}

/**
 * Cached synchronous adapter for native callbacks. Mutations use file+directory fsync and atomic
 * rename; malformed input is quarantined before the safe default is installed in memory.
 */
export function makeRemoteHostedPipPreferences(
  filePath: string,
): RemoteHostedPipPreferencesAdapter {
  const fileSignature = (): string => {
    try {
      const stat = fs.statSync(filePath, { bigint: true });
      return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  };

  const readInitial = (): RemoteHostedPipPreferencesV3 => {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_PREFERENCE_FILE_BYTES)
        throw new Error("PiP preference file is oversized");
      const parsed = parsePreferences(JSON.parse(fs.readFileSync(filePath, "utf8")));
      if (!parsed) throw new Error("PiP preference file is invalid");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && fs.existsSync(filePath)) {
        try {
          fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
        } catch {
          // A failed quarantine must not make native visibility callbacks unsafe.
        }
      }
      return emptyPreferences();
    }
  };

  let current = readInitial();
  let currentFileSignature = fileSignature();

  const reloadIfChanged = (): void => {
    const nextSignature = fileSignature();
    if (nextSignature === currentFileSignature) return;
    current = readInitial();
    currentFileSignature = fileSignature();
  };

  const write = (next: RemoteHostedPipPreferencesV3): void => {
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.tmp`;
    fs.mkdirSync(directory, { recursive: true });
    const descriptor = fs.openSync(temporaryPath, "w", 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporaryPath, filePath);
    const directoryDescriptor = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
    current = next;
    currentFileSignature = fileSignature();
  };

  const update = (
    project: (snapshot: RemoteHostedPipPreferencesV3) => RemoteHostedPipPreferencesV3,
  ): boolean => {
    reloadIfChanged();
    const next = project(current);
    if (next === current) return false;
    write({ ...next, revision: current.revision + 1 });
    return true;
  };

  const setTaskVisibilities = (
    taskIds: readonly string[],
    visibility: RemoteHostedPipTaskVisibility,
  ): boolean => {
    const normalizedTaskIds = [...new Set(taskIds.map((taskId) => taskId.trim()))];
    if (
      normalizedTaskIds.length === 0 ||
      normalizedTaskIds.length > MAX_TASK_PREFERENCES ||
      normalizedTaskIds.some((taskId) => taskId.length === 0 || taskId.length > MAX_TASK_ID_LENGTH)
    ) {
      return false;
    }
    return update((snapshot) => {
      if (normalizedTaskIds.every((taskId) => snapshot.taskVisibilities[taskId] === visibility)) {
        return snapshot;
      }
      const requestedTaskIds = new Set(normalizedTaskIds);
      const entries = Object.entries(snapshot.taskVisibilities).filter(
        ([taskId]) => !requestedTaskIds.has(taskId),
      );
      for (const taskId of normalizedTaskIds) entries.push([taskId, visibility]);
      return {
        ...snapshot,
        taskVisibilities: Object.fromEntries(entries.slice(-MAX_TASK_PREFERENCES)),
      };
    });
  };

  return {
    deleteTaskVisibility: (taskId) =>
      update((snapshot) => {
        const normalized = taskId.trim();
        if (!(normalized in snapshot.taskVisibilities)) return snapshot;
        const taskVisibilities = { ...snapshot.taskVisibilities };
        delete taskVisibilities[normalized];
        return { ...snapshot, taskVisibilities };
      }),
    readAlwaysHide: () => {
      reloadIfChanged();
      return current.alwaysHide;
    },
    readMaxDisplaySize: () => {
      reloadIfChanged();
      return current.maxDisplaySize;
    },
    readSnapshot: () => {
      reloadIfChanged();
      return {
        alwaysHide: current.alwaysHide,
        maxDisplaySize: current.maxDisplaySize,
        revision: current.revision,
        taskVisibilities: { ...current.taskVisibilities },
      };
    },
    setTaskVisibilities,
    setTaskVisibility: (taskId, visibility) => setTaskVisibilities([taskId], visibility),
    writeAlwaysHide: (alwaysHide) =>
      update((snapshot) =>
        snapshot.alwaysHide === alwaysHide ? snapshot : { ...snapshot, alwaysHide },
      ),
    writeMaxDisplaySize: (maxDisplaySize) => {
      if (!Number.isFinite(maxDisplaySize) || maxDisplaySize <= 0) return false;
      return update((snapshot) =>
        snapshot.maxDisplaySize === maxDisplaySize ? snapshot : { ...snapshot, maxDisplaySize },
      );
    },
  };
}
