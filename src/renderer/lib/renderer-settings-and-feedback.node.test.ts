import {
  settingsSearchIndex,
  settingsSearchAnchor,
} from "../components/workbench/workbench-settings-search-catalog";
import { getIntl } from "./i18n";
import { describe, expect, test } from "vite-plus/test";
import { normalizeEnvironmentAwareAppResourceSource } from "./app-resource-source";
import type { BackupJobStatus } from "../../shared/types";
import { projectBackupJob } from "./backup-job-presentation";
import { formatCompactRelativeTime } from "./compact-relative-time";
import { formatElapsedSince, getNextElapsedTimeUpdateDelay } from "./elapsed-time";
import { readableIpcError } from "./ipc-error-message";
import { normalizeReducedMotionPreference, resolveReducedMotionPreference } from "./reduced-motion";
import { resolveSettingsHostPresentation } from "./settings-host-presentation";

describe("environment-aware generic app resources", () => {
  test("uses Vite /@fs only for HTTP(S) development surfaces", () => {
    expect(normalizeEnvironmentAwareAppResourceSource("/tmp/icon.png", "http:")).toBe(
      "/@fs/tmp/icon.png",
    );
    expect(normalizeEnvironmentAwareAppResourceSource("C:\\Apps\\icon.png", "https:")).toBe(
      "app://fs/@fs/C:/Apps/icon.png",
    );
    expect(normalizeEnvironmentAwareAppResourceSource("/tmp/icon.png", "app:")).toBe(
      "app://fs/@fs/tmp/icon.png",
    );
  });

  test.each([
    "app://fs/@fs/tmp/icon.png",
    "data:image/png;base64,YQ==",
    "https://example.test/icon.png",
    "http://localhost/icon.png",
    "/@fs/tmp/icon.png",
  ])("preserves an already-supported resource source: %s", (source) => {
    expect(normalizeEnvironmentAwareAppResourceSource(source, "http:")).toBe(source);
  });

  test.each(["file:///tmp/icon.png", "blob:https://example.test/id", "relative/icon.png", ""])(
    "rejects a source outside the generic icon contract: %s",
    (source) => {
      expect(normalizeEnvironmentAwareAppResourceSource(source, "app:")).toBe(null);
    },
  );
});

describe("backup job presentation", () => {
  const job = (overrides: Partial<BackupJobStatus> = {}): BackupJobStatus => ({
    jobId: "job-1",
    state: "running",
    phase: "database_snapshot",
    completedUnits: 1,
    totalUnits: 7,
    startedAt: 1,
    updatedAt: 2,
    backup: null,
    error: null,
    progress: {
      databaseCopiedPages: 25,
      databaseTotalPages: 100,
      databaseBusyRetries: 0,
      assetBytesCopied: 0,
      databaseCopyMs: 0,
      assetCopyMs: 0,
      validationMs: 0,
      digestMs: 0,
      publishMs: 0,
      writerHeldMs: 0,
    },
    ...overrides,
  });

  describe("projectBackupJob", () => {
    test("projects durable database progress into the bounded snapshot meter", () => {
      expect(projectBackupJob(job())).toMatchObject({
        active: true,
        cancellable: true,
        phaseLabel: "Copying database",
        progressTotal: 7,
        progressUnits: 1.25,
      });
    });

    test.each(["commit", "publishing"] as const)(
      "closes cancellation when the job reaches %s",
      (phase) => {
        expect(projectBackupJob(job({ phase })).cancellable).toBe(false);
      },
    );
  });
});

describe("compact relative time", () => {
  test("formats elapsed time compactly at each unit boundary", () => {
    expect(formatCompactRelativeTime(0, 59_999)).toBe("now");
    expect(formatCompactRelativeTime(0, 60_000)).toBe("1m");
    expect(formatCompactRelativeTime(0, 5 * 60_000)).toBe("5m");
    expect(formatCompactRelativeTime(0, 3 * 3_600_000)).toBe("3h");
    expect(formatCompactRelativeTime(0, 2 * 86_400_000)).toBe("2d");
    expect(formatCompactRelativeTime(0, 7 * 86_400_000)).toBe("1w");
    expect(formatCompactRelativeTime(0, 29 * 86_400_000)).toBe("4w");
    expect(formatCompactRelativeTime(10, 0)).toBe("now");
    expect(formatCompactRelativeTime(Number.NaN, 0)).toBe("");
  });

  test("falls back to a short date after thirty days", () => {
    const timestamp = Date.UTC(2026, 0, 15, 12);
    expect(formatCompactRelativeTime(timestamp, timestamp + 31 * 86_400_000)).toBe(
      new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
  });
});

describe("formatElapsedSince", () => {
  test("matches sidebar-style elapsed labels", () => {
    const now = 1_000_000;

    expect(formatElapsedSince(now, now)).toBe("now");
    expect(formatElapsedSince(now - 59_000, now)).toBe("now");
    expect(formatElapsedSince(now - 60_000, now)).toBe("1m");
    expect(formatElapsedSince(now - 3_600_000, now)).toBe("1h");
    expect(formatElapsedSince(now - 86_400_000, now)).toBe("1d");
    expect(formatElapsedSince(now - 7 * 86_400_000, now)).toBe("1w");
    expect(formatElapsedSince(now - 30 * 86_400_000, now)).toBe("1mo");
    expect(formatElapsedSince(now - 365 * 86_400_000, now)).toBe("1y");
  });

  test("schedules the next semantic label boundary", () => {
    const updatedAt = 1_000_000;

    expect(getNextElapsedTimeUpdateDelay(updatedAt, updatedAt)).toBe(60_000);
    expect(getNextElapsedTimeUpdateDelay(updatedAt, updatedAt + 59_999)).toBe(1);
    expect(getNextElapsedTimeUpdateDelay(updatedAt, updatedAt + 61_000)).toBe(59_000);
    expect(getNextElapsedTimeUpdateDelay(updatedAt, updatedAt + 29 * 86_400_000)).toBe(86_400_000);
  });
});

describe("readableIpcError", () => {
  test("keeps only the reason after Electron's channel prefix", () => {
    expect(
      readableIpcError(
        new Error(
          "Error invoking remote method 'automations:create': Error: This Agent is turned off. Turn it on in Settings.",
        ),
      ),
    ).toBe("This Agent is turned off. Turn it on in Settings.");
    expect(readableIpcError("Error invoking remote method 'inbox:send': Core refused it")).toBe(
      "Core refused it",
    );
  });

  test("falls back when a rejection carries no readable reason", () => {
    expect(
      readableIpcError(new Error("Error invoking remote method 'x': Error: "), "Not saved"),
    ).toBe("Not saved");
    expect(readableIpcError({ code: 1 }, "Not saved")).toBe("Not saved");
    expect(readableIpcError(undefined)).toBe("");
  });
});

describe("reduced motion preference", () => {
  test("normalizes persisted values", () => {
    expect(normalizeReducedMotionPreference("system")).toBe("system");
    expect(normalizeReducedMotionPreference("on")).toBe("on");
    expect(normalizeReducedMotionPreference("off")).toBe("off");
    expect(normalizeReducedMotionPreference("reduce")).toBe("system");
    expect(normalizeReducedMotionPreference(null)).toBe("system");
  });

  test.each([
    ["system", false, false],
    ["system", true, true],
    ["on", false, true],
    ["on", true, true],
    ["off", false, false],
    ["off", true, false],
  ] as const)("resolves %s against OS=%s", (preference, os, expected) => {
    expect(resolveReducedMotionPreference(preference, os)).toBe(expected);
  });
});

describe("settings host presentation", () => {
  test.each(["linux", "unknown"])("%s hides host integrations it cannot run", (platform) => {
    expect(resolveSettingsHostPresentation(platform)).toEqual({
      terminalShell: false,
      computerUse: false,
      browserProfileImport: false,
      browserControl: false,
      appUpdates: false,
      launchAtLogin: false,
      mini: false,
    });
  });

  test("macOS keeps its native integrations", () => {
    expect(resolveSettingsHostPresentation("darwin")).toEqual({
      terminalShell: false,
      computerUse: true,
      browserProfileImport: true,
      browserControl: true,
      appUpdates: true,
      launchAtLogin: true,
      mini: true,
    });
  });

  test("Windows exposes Browser control and app update settings", () => {
    expect(resolveSettingsHostPresentation("win32")).toEqual({
      terminalShell: true,
      computerUse: true,
      browserProfileImport: false,
      browserControl: true,
      appUpdates: true,
      launchAtLogin: true,
      mini: true,
    });
  });
});

test("Settings search uses the offered Components and their Add-ons anchor", () => {
  const intl = getIntl();
  const index = (offered?: Parameters<typeof settingsSearchIndex>[2]) =>
    settingsSearchIndex("general-settings", intl, offered);
  const windows = ["desktop-tools", "codex", "claude-code"] as const;
  expect(index().has("Add-ons")).toBe(false);
  expect(index(windows).has("Add-ons")).toBe(true);
  expect(index(windows).has("Claude Code")).toBe(true);
  expect(index(windows).has("Document Tools")).toBe(false);
  expect(index([...windows, "document-tools"]).has("Document Tools")).toBe(true);
  expect(settingsSearchAnchor("general-settings", "Desktop Tools", intl, windows)).toBe(
    "components",
  );
  expect(settingsSearchAnchor("general-settings", "Desktop Tools", intl)).toBeNull();
});
