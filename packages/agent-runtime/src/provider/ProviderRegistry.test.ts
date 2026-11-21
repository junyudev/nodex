import { describe, it, assert } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@nodex/runtime-contracts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

describe("Antigravity model inventories", () => {
  const previousProvider = {
    instanceId: ProviderInstanceId.make("antigravity-personal"),
    driver: ProviderDriverKind.make("antigravity"),
    status: "ready",
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    checkedAt: "2026-09-02T00:00:00.000Z",
    version: "0.1.3",
    models: [
      {
        slug: "gemini-3.1-pro-high",
        name: "Gemini 3.1 Pro High",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "gemini-3-flash",
        name: "Gemini 3 Flash",
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
  } as const satisfies ServerProvider;

  it("clears models after sign-out, disable, uninstall, or an empty successful refresh", () => {
    const emptyProvider = {
      ...previousProvider,
      checkedAt: "2026-09-02T00:01:00.000Z",
      models: [],
    } satisfies ServerProvider;
    const clearedProviders = [
      { ...emptyProvider, status: "warning", auth: { status: "unauthenticated" } },
      { ...emptyProvider, status: "error", auth: { status: "unauthenticated" } },
      { ...emptyProvider, status: "disabled", enabled: false },
      { ...emptyProvider, status: "error", enabled: false },
      { ...emptyProvider, status: "error", installed: false, auth: { status: "unknown" } },
      emptyProvider,
    ] satisfies ReadonlyArray<ServerProvider>;

    for (const provider of clearedProviders) {
      const afterRemoval = ProviderRegistry.mergeProviderSnapshot(previousProvider, provider);
      assert.deepStrictEqual(afterRemoval.models, []);

      const afterFailure = ProviderRegistry.mergeProviderSnapshot(afterRemoval, {
        ...emptyProvider,
        status: "error",
        auth: { status: "unknown" },
      });
      assert.deepStrictEqual(afterFailure.models, []);
    }
  });
});

describe("Antigravity saved account", () => {
  const signedIn = {
    instanceId: ProviderInstanceId.make("antigravity-personal"),
    driver: ProviderDriverKind.make("antigravity"),
    status: "ready",
    enabled: true,
    installed: true,
    auth: { status: "authenticated", type: "oauth-personal", label: "Google account" },
    checkedAt: "2026-09-05T00:00:00.000Z",
    version: "1.5.12",
    models: [
      {
        slug: "gemini-3.7-flash-high",
        name: "Gemini 3.7 Flash",
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [{ name: "plan" }],
    skills: [],
  } as const satisfies ServerProvider;
  const uncheckedMessage = "Antigravity is installed. Google account access is not checked yet.";
  const restartProbe = {
    ...signedIn,
    status: "warning",
    auth: { status: "unknown" },
    checkedAt: "2026-09-05T00:01:00.000Z",
    message: uncheckedMessage,
    models: [],
  } as const satisfies ServerProvider;

  it("keeps the saved Google account through restart health checks", () => {
    const merged = ProviderRegistry.mergeProviderSnapshot(signedIn, restartProbe);
    const { message: _uncheckedMessage, ...probeWithoutMessage } = restartProbe;
    assert.deepStrictEqual(merged, {
      ...probeWithoutMessage,
      status: "ready",
      auth: signedIn.auth,
      models: signedIn.models,
    });
    assert.equal("message" in merged, false);
    assert.deepStrictEqual(ProviderRegistry.mergeProviderSnapshot(merged, restartProbe), merged);
  });

  it("does not invent an account after sign-out, disable, uninstall, or for other providers", () => {
    const untouched = [
      { ...restartProbe, auth: { status: "unauthenticated" } },
      { ...restartProbe, status: "disabled", enabled: false },
      { ...restartProbe, status: "error", installed: false },
      { ...restartProbe, driver: ProviderDriverKind.make("codex") },
      { ...restartProbe, auth: { status: "unknown", type: "gemini-api-key" } },
    ] satisfies ReadonlyArray<ServerProvider>;
    for (const next of untouched) {
      const merged = ProviderRegistry.mergeProviderSnapshot(signedIn, next);
      assert.deepStrictEqual(merged.auth, next.auth);
      assert.equal(merged.status, next.status);
      assert.equal(merged.message, next.message);
    }
    assert.deepStrictEqual(
      ProviderRegistry.mergeProviderSnapshot(
        { ...signedIn, auth: { status: "unknown" } },
        restartProbe,
      ).auth,
      { status: "unknown" },
    );
    assert.equal(
      ProviderRegistry.mergeProviderSnapshot(
        { ...signedIn, driver: ProviderDriverKind.make("codex") },
        restartProbe,
      ).auth.status,
      "unknown",
    );
    assert.deepStrictEqual(
      ProviderRegistry.mergeProviderSnapshot(signedIn, {
        ...restartProbe,
        auth: { status: "unknown", type: "oauth-personal" },
      }).auth,
      signedIn.auth,
    );
  });

  it("keeps scanned folders through health checks until Antigravity cannot run", () => {
    const scanned = ["/project", "/plain"].reduce<ServerProvider>(
      (provider, cwd) =>
        ProviderRegistry.upsertProviderWorkspaceSnapshot(provider, cwd, {
          ...signedIn,
          skills: [{ name: "review", path: `${cwd}/SKILL.md`, enabled: true }],
        }),
      signedIn,
    );
    const healthCheck = { ...signedIn, checkedAt: "2026-09-05T00:01:00.000Z" };
    const sessionFolder = {
      cwd: "/project",
      checkedAt: healthCheck.checkedAt,
      slashCommands: [{ name: "swarm" }],
      skills: [],
    };
    const kept = [
      healthCheck,
      restartProbe,
      { ...restartProbe, installed: false, version: null },
    ] satisfies ReadonlyArray<ServerProvider>;
    for (const next of kept) {
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(scanned, { ...next, workspaceSnapshots: [] })
          .workspaceSnapshots,
        scanned.workspaceSnapshots,
      );
    }
    assert.deepStrictEqual(
      ProviderRegistry.mergeProviderSnapshot(scanned, {
        ...healthCheck,
        workspaceSnapshots: [sessionFolder],
      }).workspaceSnapshots,
      [...scanned.workspaceSnapshots!.slice(1), sessionFolder],
    );
    const cleared = [
      { ...healthCheck, auth: { status: "unauthenticated" } },
      { ...healthCheck, status: "disabled", enabled: false },
      { ...healthCheck, status: "error", installed: false },
    ] satisfies ReadonlyArray<ServerProvider>;
    for (const next of cleared) {
      assert.deepStrictEqual(
        ProviderRegistry.mergeProviderSnapshot(scanned, { ...next, workspaceSnapshots: [] })
          .workspaceSnapshots,
        [],
      );
    }
  });
});
