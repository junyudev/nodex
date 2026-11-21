import { describe, expect, test } from "vite-plus/test";
import { getIntl } from "@/lib/i18n";
import {
  antigravityInspection,
  antigravityOperation,
  managedAntigravityExecutable,
} from "../../../shared/antigravity-runtime.test-support";
import type {
  AntigravityRuntimeInspection,
  AntigravityRuntimeOperation,
} from "../../../shared/antigravity-runtime";
import {
  antigravityExecutableDescription,
  antigravityRuntimeView,
  formatAntigravityVersion,
} from "./antigravity-runtime-model";

const view = (
  inspection: AntigravityRuntimeInspection | null,
  operation: AntigravityRuntimeOperation | null = null,
) =>
  antigravityRuntimeView(
    { state: { revision: 1, inspection, operation }, pending: null, error: null },
    getIntl(),
  );

describe("Antigravity runtime status", () => {
  test("offers a passive-state recovery and permits installation only on supported platforms", () => {
    expect(
      antigravityRuntimeView({ state: null, pending: null, error: null }, getIntl()).text,
    ).toBe("Checking Antigravity runtime…");
    expect(view(null).primary).toEqual({ kind: "check", label: "Check runtime" });
    expect(view(antigravityInspection())).toMatchObject({
      text: "Not installed",
      primary: { kind: "install", label: "Install" },
    });
    const unsupported = view(
      antigravityInspection({
        platform: { os: "freebsd", arch: "x64", supported: false },
      }),
    );
    expect(unsupported.primary).toBeUndefined();
    expect(unsupported.text).toContain("Set an executable path.");
  });

  test("offers a manual release check for a managed version until an update is known", () => {
    const managed = { managed: managedAntigravityExecutable, canRemove: true };
    expect(view(antigravityInspection(managed))).toMatchObject({
      text: "Downloaded runtime · 1.5.13",
      primary: { kind: "install", label: "Check for updates" },
      canRemove: true,
    });
    expect(view(antigravityInspection({ ...managed, updateAvailable: true })).primary?.label).toBe(
      "Update",
    );
    expect(view(antigravityInspection({ ...managed, updateAvailable: false })).primary?.label).toBe(
      "Check for updates",
    );
    const path = { ...managedAntigravityExecutable, source: "path" as const };
    expect(view(antigravityInspection({ path })).text).toBe("agy on this computer · 1.5.13");
  });

  test("only versions strictly below the threshold give a compatibility warning or block", () => {
    const compatible = (version: string) =>
      view(
        antigravityInspection({
          managed: { ...managedAntigravityExecutable, version },
          recommendedVersion: "1.5.12",
        }),
      );
    expect(compatible("1.4.99")).toMatchObject({
      text: "Downloaded runtime · 1.4.99 · Requires 1.5.0 or newer to start chats",
      tone: "danger",
    });
    expect(compatible("1.5.0").tone).toBe("warning");
    expect(compatible("1.5.12").tone).toBeUndefined();
    expect(formatAntigravityVersion("agy_acp_server_20261120_RC00", getIntl())).toBe(
      "Nov 20, 2026",
    );
    expect(formatAntigravityVersion("agy_acp_server_20260230_RC00", getIntl())).toBe(
      "agy_acp_server_20260230_RC00",
    );
  });

  test("names the version needed by an older executable in settings", () => {
    const path = {
      executablePath: "/test/agy",
      managedVersionDirectory: null,
      source: "path",
      version: "1.4.9",
    } as const;
    const inspection = antigravityInspection({ path });
    expect(view(inspection)).toMatchObject({
      text: "agy on this computer · 1.4.9 · Requires 1.5.0 or newer to start chats",
      tone: "danger",
      primary: { kind: "install", optional: false },
    });
    const choice = {
      ...path,
      instanceId: "antigravity_work",
      configuredBinaryPath: null,
      issue: null,
    };
    expect(antigravityExecutableDescription(choice, inspection, undefined, getIntl())).toBe(
      "agy on this computer · /test/agy · 1.4.9 · Requires 1.5.0 or newer to start chats",
    );
  });

  test("uses byte progress, only offers cancellation when possible, and surfaces a failed operation", () => {
    const operation = antigravityOperation({
      progress: { phase: "downloading", downloadedBytes: 120_000_000, totalBytes: 512_000_000 },
    });
    expect(view(null, operation)).toMatchObject({
      text: "Downloading 120 of 512 MB",
      primary: { kind: "cancel", label: "Cancel" },
    });
    expect(view(null, { ...operation, cancellable: false }).primary).toBeUndefined();
    expect(
      view(
        null,
        antigravityOperation({
          phase: "failed",
          error: { reason: "download_failed", message: "The download timed out." },
        }),
      ),
    ).toMatchObject({
      text: "The download timed out.",
      primary: { kind: "install", label: "Retry" },
    });
  });

  test.each([
    ["installation_running", "during installation"],
    ["in_use", "while Antigravity is in use"],
    ["configured_path", "executable path points into the download"],
  ] as const)("explains why removal is blocked by %s", (reason, message) => {
    const blocked = view(
      antigravityInspection({
        managed: managedAntigravityExecutable,
        removalBlockedBy: [reason],
      }),
    );
    expect(blocked.text).toContain(message);
    expect(blocked.canRemove).toBe(false);
  });

  test("shows the runtime's saved selection and distinguishes an edited path", () => {
    const inspection = antigravityInspection();
    const choice = {
      instanceId: "instance",
      source: "managed",
      version: "1.5.13",
      configuredBinaryPath: null,
      executablePath: managedAntigravityExecutable.executablePath,
      issue: null,
    } as const;
    const description = (
      value: Parameters<typeof antigravityExecutableDescription>[0],
      path?: string,
    ) => antigravityExecutableDescription(value, inspection, path, getIntl());
    expect(description(choice)).toBe("Downloaded runtime · 1.5.13");
    expect(description(choice, "/test/agy")).toBe("Custom executable · /test/agy · Unchecked");
    expect(
      description({ ...choice, source: "path", executablePath: "/test/agy", version: null }),
    ).toBe("agy on this computer · /test/agy");
    expect(
      description({ ...choice, source: "unavailable", issue: "The executable is missing." }),
    ).toBe("The executable is missing.");
  });
});
