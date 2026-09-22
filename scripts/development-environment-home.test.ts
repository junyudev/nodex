import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";

import {
  cleanupDevelopmentEnvironmentHome,
  markDevelopmentEnvironmentInitialized,
  openDevelopmentEnvironmentHome,
  parseDevelopmentHomeManifest,
  refreshDevelopmentEnvironmentHome,
  resolveDevelopmentHomeRoot,
  updateDevelopmentAgentFiles,
} from "./development-environment-home";

const roots: string[] = [];

const createRepository = async (): Promise<string> => {
  const root = await mkdtemp("/tmp/ndh-");
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("development environment home", () => {
  test("resolves the default and explicit environment roots from the repository", async () => {
    const repositoryRoot = await createRepository();
    expect(resolveDevelopmentHomeRoot(repositoryRoot)).toBe(
      path.join(repositoryRoot, "runs.local/default"),
    );
    expect(resolveDevelopmentHomeRoot(repositoryRoot, "runs.local/perf")).toBe(
      path.join(repositoryRoot, "runs.local/perf"),
    );
  });

  test("creates the owned layout and reopens the same identity", async () => {
    const repositoryRoot = await createRepository();
    const created = await openDevelopmentEnvironmentHome({ repositoryRoot });
    expect(created.wasCreated).toBe(true);
    await expect(
      Promise.all([
        stat(created.nodexHome),
        stat(created.codexHome),
        stat(created.workspace),
        stat(created.artifacts),
      ]),
    ).resolves.toHaveLength(4);

    const reopened = await openDevelopmentEnvironmentHome({ repositoryRoot });
    expect(reopened.wasCreated).toBe(false);
    expect(reopened.manifest.environmentId).toBe(created.manifest.environmentId);
  });

  test("records initialization and seed provenance atomically", async () => {
    const repositoryRoot = await createRepository();
    const home = await openDevelopmentEnvironmentHome({ repositoryRoot });
    await markDevelopmentEnvironmentInitialized(home, {
      kind: "seed",
      seed: {
        id: "board/dense",
        revision: 2,
      },
    });
    const refreshed = await refreshDevelopmentEnvironmentHome(home);
    expect(refreshed.manifest).toMatchObject({
      initializedAt: expect.any(String),
      seed: { id: "board/dense", revision: 2 },
    });
  });

  test("records immutable real Profile snapshot provenance", async () => {
    const repositoryRoot = await createRepository();
    const home = await openDevelopmentEnvironmentHome({ repositoryRoot });
    const profileSnapshot = {
      conversations: {
        version: 1,
        captureStartedAt: "2026-08-21T00:01:00.000Z",
        captureCompletedAt: "2026-08-21T00:01:00.000Z",
        requiredThreadCount: 2,
        capturedThreadCount: 2,
        externalThreadCount: 0,
        missingThreadIds: [],
        rolloutCount: 2,
        nativeStateSchema: "state_5",
        contentSha256: "b".repeat(64),
      },
      sourceProfileHome: "/tmp/source-profile",
      sourceProfileFingerprint: "a".repeat(64),
      backupIntegrityEvidenceVersion: 1,
      missingManagedAssetCount: 2,
      backupId: "core-backup",
      backupCreatedAt: "2026-08-21T00:00:00.000Z",
      clonedAt: "2026-08-21T00:01:00.000Z",
      storeSchemaVersion: 131,
      sourceStoreEpoch: "epoch:source",
      storeEpoch: "epoch:source",
      profileId: "profile:real",
      libraryId: "library:real",
    } as const;
    await markDevelopmentEnvironmentInitialized(home, {
      kind: "profileSnapshot",
      profileSnapshot,
    });
    await expect(refreshDevelopmentEnvironmentHome(home)).resolves.toMatchObject({
      manifest: { profileSnapshot },
    });
    await expect(
      markDevelopmentEnvironmentInitialized(home, {
        kind: "seed",
        seed: { id: "board/dense", revision: 2 },
      }),
    ).rejects.toThrow("data source is immutable");
    expect(() =>
      parseDevelopmentHomeManifest({
        ...home.manifest,
        profileSnapshot: { ...profileSnapshot, storeEpoch: "epoch:other" },
      }),
    ).toThrow("Profile snapshot provenance is invalid");
    expect(() =>
      parseDevelopmentHomeManifest({
        ...home.manifest,
        profileSnapshot: { ...profileSnapshot, conversations: undefined },
      }),
    ).toThrow("Create a new --home");
  });

  test("can defer Profile creation for atomic snapshot materialization", async () => {
    const repositoryRoot = await createRepository();
    const home = await openDevelopmentEnvironmentHome({
      repositoryRoot,
      initializeProfileHome: false,
    });
    await expect(stat(home.workspace)).resolves.toBeDefined();
    await expect(stat(home.artifacts)).resolves.toBeDefined();
    await expect(stat(home.nodexHome)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("copies explicit agent files privately and sanitizes config", async () => {
    const repositoryRoot = await createRepository();
    const home = await openDevelopmentEnvironmentHome({ repositoryRoot });
    const auth = path.join(repositoryRoot, "source-auth.json");
    const config = path.join(repositoryRoot, "source-config.toml");
    await writeFile(auth, '{"token":"test"}\n');
    await writeFile(
      config,
      ['model = "gpt-5"', "[mcp_servers.node_repl]", 'command = "node"', ""].join("\n"),
    );

    await updateDevelopmentAgentFiles(home, {
      authJson: auth,
      agentConfigToml: config,
    });

    const installedAuth = path.join(home.codexHome, "auth.json");
    const installedConfig = path.join(home.codexHome, "config.toml");
    expect((await stat(installedAuth)).mode & 0o777).toBe(0o600);
    expect((await stat(installedConfig)).mode & 0o777).toBe(0o600);
    expect(await readFile(installedAuth, "utf8")).toContain("test");
    expect(await readFile(installedConfig, "utf8")).not.toContain("node_repl");
  });

  test("deletes only the owned home without runtime evidence", async () => {
    const repositoryRoot = await createRepository();
    const home = await openDevelopmentEnvironmentHome({ repositoryRoot });
    await expect(cleanupDevelopmentEnvironmentHome(home)).resolves.toEqual({
      status: "deleted",
    });

    const unsafe = await openDevelopmentEnvironmentHome({
      repositoryRoot,
      home: "runs.local/unsafe",
    });
    const runtimeDirectory = path.join(unsafe.nodexHome, "run/core");
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(path.join(runtimeDirectory, "core.json"), "{}");
    await expect(cleanupDevelopmentEnvironmentHome(unsafe)).resolves.toMatchObject({
      status: "unsafe",
    });
    await expect(stat(unsafe.root)).resolves.toBeDefined();
  });
});
