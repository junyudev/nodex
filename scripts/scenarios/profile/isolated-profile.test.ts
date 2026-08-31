import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { acquireIsolatedRunLease } from "../../../src/main/core-client/isolated-run-ownership";

import {
  cleanupIsolatedProfile,
  createIsolatedProfile,
  resumeIsolatedProfile,
  type IsolatedProfile,
} from "./isolated-profile";

const retained: IsolatedProfile[] = [];

afterEach(async () => {
  for (const profile of retained.splice(0)) {
    await cleanupIsolatedProfile({ ...profile, retention: "dispose" });
    // A safety-gate test intentionally corrupts the ownership proof. Remove only
    // the exact test-created root after the production cleanup has refused it.
    await rm(profile.runRoot, { recursive: true, force: true });
  }
});

describe("isolated scenario Profile", () => {
  test("creates a short owned layout and removes it idempotently", async () => {
    const profile = await createIsolatedProfile({ label: "Board / Dense !!!" });
    const temporaryRoot = await import("node:fs/promises").then(({ realpath }) =>
      realpath(process.platform === "darwin" ? "/tmp" : os.tmpdir()),
    );
    expect(path.dirname(profile.runRoot)).toBe(temporaryRoot);
    expect(path.basename(profile.runRoot)).toMatch(/^ndx-scn-/u);
    expect(profile.nodexHome).toBe(path.join(profile.runRoot, ".nodex"));
    expect(profile.settingsPath).toBe(path.join(profile.nodexHome, "config.toml"));
    expect(profile.codexHome).not.toBe(process.env.CODEX_HOME);
    expect(JSON.parse(await readFile(profile.manifestPath, "utf8"))).toMatchObject({
      version: 1,
      runId: profile.runId,
      label: "board-dense",
    });
    await expect(cleanupIsolatedProfile(profile)).resolves.toEqual({ status: "deleted" });
    await expect(cleanupIsolatedProfile(profile)).resolves.toEqual({
      status: "already_missing",
    });
  });

  test("copies Codex credentials only under an explicit policy with private modes", async () => {
    const source = await mkdtemp(path.join(os.tmpdir(), "ndx-codex-source-"));
    await writeFile(path.join(source, "auth.json"), "top-secret", { mode: 0o644 });
    await writeFile(path.join(source, "config.toml"), 'model = "gpt-test"\n', {
      mode: 0o644,
    });
    const empty = await createIsolatedProfile({
      label: "empty",
      sourceCodexHome: source,
      retention: "keep",
    });
    retained.push(empty);
    await expect(readFile(path.join(empty.codexHome, "auth.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const copied = await createIsolatedProfile({
      label: "copied",
      codex: "copy-auth-and-config",
      sourceCodexHome: source,
      retention: "keep",
    });
    retained.push(copied);
    expect(await readFile(path.join(copied.codexHome, "auth.json"), "utf8")).toBe("top-secret");
    expect((await stat(path.join(copied.codexHome, "auth.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(copied.manifestPath, "utf8")).not.toContain("top-secret");

    const authOnly = await createIsolatedProfile({
      label: "auth-only",
      codex: "copy-auth",
      sourceCodexHome: source,
      retention: "keep",
    });
    retained.push(authOnly);
    expect(await readFile(path.join(authOnly.codexHome, "auth.json"), "utf8")).toBe("top-secret");
    await expect(
      readFile(path.join(authOnly.codexHome, "config.toml"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const configOnly = await createIsolatedProfile({
      label: "config-only",
      codex: "copy-config",
      sourceCodexHome: source,
      retention: "keep",
    });
    retained.push(configOnly);
    expect(await readFile(path.join(configOnly.codexHome, "config.toml"), "utf8")).toContain(
      "gpt-test",
    );
    expect((await stat(path.join(configOnly.codexHome, "config.toml"))).mode & 0o777).toBe(0o600);
    await expect(
      readFile(path.join(configOnly.codexHome, "auth.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("removes its owned root when credential materialization fails", async () => {
    const tempParent = process.platform === "darwin" ? "/tmp" : os.tmpdir();
    const source = await mkdtemp(path.join(os.tmpdir(), "ndx-codex-incomplete-"));
    await writeFile(path.join(source, "config.toml"), 'model = "gpt-test"\n');
    const before = new Set(
      (await readdir(tempParent)).filter((entry) => entry.startsWith("ndx-scn-")),
    );
    try {
      await expect(
        createIsolatedProfile({
          label: "missing-auth",
          codex: "copy-auth-and-config",
          sourceCodexHome: source,
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const leaked = (await readdir(tempParent)).filter(
        (entry) => entry.startsWith("ndx-scn-") && !before.has(entry),
      );
      expect(leaked).toEqual([]);
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

  test("copies a symlinked credential source into an owned regular file", async () => {
    const source = await mkdtemp(path.join(os.tmpdir(), "ndx-codex-symlink-"));
    const credential = path.join(source, "credential.json");
    await writeFile(credential, "top-secret");
    await symlink(credential, path.join(source, "auth.json"));

    const profile = await createIsolatedProfile({
      label: "symlink-auth",
      codex: "copy-auth",
      sourceCodexHome: source,
      retention: "keep",
    });
    retained.push(profile);
    expect(await readFile(path.join(profile.codexHome, "auth.json"), "utf8")).toBe("top-secret");
    expect((await stat(path.join(profile.codexHome, "auth.json"))).isFile()).toBe(true);
    await rm(source, { recursive: true, force: true });
  });

  test("refuses mismatched manifests, runtime evidence, and symlink roots", async () => {
    const mismatch = await createIsolatedProfile({ label: "mismatch", retention: "keep" });
    retained.push(mismatch);
    const raw = JSON.parse(await readFile(mismatch.manifestPath, "utf8")) as object;
    await writeFile(mismatch.manifestPath, JSON.stringify({ ...raw, runId: "other" }));
    await expect(
      cleanupIsolatedProfile({ ...mismatch, retention: "dispose" }),
    ).resolves.toMatchObject({ status: "unsafe" });

    const runtime = await createIsolatedProfile({ label: "runtime", retention: "keep" });
    retained.push(runtime);
    await mkdir(path.join(runtime.nodexHome, "run/core"), { recursive: true });
    await writeFile(path.join(runtime.nodexHome, "run/core/core.auth"), "capability");
    await expect(
      cleanupIsolatedProfile({ ...runtime, retention: "dispose" }),
    ).resolves.toMatchObject({ status: "unsafe" });

    const target = await createIsolatedProfile({ label: "target", retention: "keep" });
    retained.push(target);
    const link = path.join(path.dirname(target.runRoot), `ndx-scn-link-${Date.now()}`);
    await symlink(target.runRoot, link);
    await expect(resumeIsolatedProfile(link)).rejects.toThrow(/real directory|identity/u);

    await expect(resumeIsolatedProfile("relative-profile")).rejects.toThrow(/absolute/u);
    await expect(
      cleanupIsolatedProfile({
        ...target,
        retention: "dispose",
        runRoot: "relative-profile",
      }),
    ).resolves.toMatchObject({ status: "unsafe" });
  });

  test("refuses to resume a Profile while its isolated lease exists", async () => {
    const profile = await createIsolatedProfile({ label: "leased", retention: "keep" });
    retained.push(profile);
    const lease = acquireIsolatedRunLease({
      nodexHome: profile.nodexHome,
      runId: profile.runId,
      supervisorPid: process.pid,
    });
    try {
      await expect(resumeIsolatedProfile(profile.runRoot)).rejects.toThrow(/lease/u);
    } finally {
      lease.release();
    }
  });

  test("rejects unsupported retained manifest versions", async () => {
    const profile = await createIsolatedProfile({ label: "version", retention: "keep" });
    retained.push(profile);
    const raw = JSON.parse(await readFile(profile.manifestPath, "utf8")) as object;
    await writeFile(profile.manifestPath, JSON.stringify({ ...raw, version: 99 }));
    await expect(resumeIsolatedProfile(profile.runRoot)).rejects.toThrow(/unsupported/u);
  });
});
