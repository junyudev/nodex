import { expect, test } from "vite-plus/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { load as parse } from "js-yaml";

import {
  isEligibleSparkleHistoryRelease,
  selectLatestSparkleHistoryAppcast,
  readSparkleHistoryManifest,
  writeSparkleHistoryManifest,
} from "./sparkle";

test("round-trips empty and delimiter-containing history paths through a manifest", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sparkle-history-manifest-"));
  try {
    const manifest = path.join(root, "history.json");
    for (const directories of [
      [],
      [path.join(root, "first release"), path.join(root, "second:release\nwith newline")],
    ]) {
      writeSparkleHistoryManifest(manifest, directories);
      expect(readSparkleHistoryManifest(manifest)).toEqual(directories);
    }
    for (const invalid of [
      "task log\n[]",
      JSON.stringify(["relative/path"]),
      JSON.stringify([42]),
      "{}",
    ]) {
      writeFileSync(manifest, invalid);
      expect(() => readSparkleHistoryManifest(manifest)).toThrow();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Sparkle action carries history independently of task-runner stdout", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sparkle-action-"));
  try {
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    mkdirSync(path.join(root, "architecture"));
    writeFileSync(
      path.join(root, "architecture", "architecture-build.json"),
      JSON.stringify({
        releaseIdentity: { buildVersion: "1.0.1" },
      }),
    );
    const directories = [path.join(root, "first release"), path.join(root, "second:release")];
    writeFileSync(path.join(root, "expected.json"), JSON.stringify(directories));
    writeFileSync(
      path.join(bin, "vp"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
if (args.includes("release:fetch:sparkle-history")) {
  fs.copyFileSync(process.env.EXPECTED_HISTORY, flag("--manifest"));
  console.log("Task preparation log\\nTask timing summary");
} else if (args.includes("release:finalize:sparkle")) {
  fs.copyFileSync(flag("--history-manifest"), process.env.OBSERVED_HISTORY);
} else {
  throw new Error("Unexpected task: " + args.join(" "));
}
`,
      { mode: 0o755 },
    );
    const action = parse(
      readFileSync(
        path.resolve(import.meta.dirname, "../../.github/actions/finalize-sparkle/action.yml"),
        "utf8",
      ),
    ) as {
      runs: { steps: Array<{ name?: string; run?: string }> };
    };
    const env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      RUNNER_TEMP: root,
      GITHUB_REPOSITORY: "fixture/repository",
      RELEASE_ARCH: "arm64",
      RELEASE_VERSION: "0.2.3-nightly.20260909.100",
      RELEASE_SOURCE_SHA: "HEAD",
      SPARKLE_ED25519_PRIVATE_KEY: "fixture-key",
      SPARKLE_OUTPUT: path.join(root, "output"),
      EXPECTED_HISTORY: path.join(root, "expected.json"),
      OBSERVED_HISTORY: path.join(root, "observed.json"),
    };
    for (const name of [
      "Fetch verified compatible update history",
      "Finalize signed appcast and deltas",
    ]) {
      const script = action.runs.steps.find((step) => step.name === name)?.run;
      if (!script) throw new Error(`Missing Sparkle step: ${name}`);
      execFileSync("bash", ["-e", "-c", script.replaceAll("${{ inputs.channel }}", "nightly")], {
        env,
      });
    }
    expect(readSparkleHistoryManifest(env.OBSERVED_HISTORY)).toEqual(directories);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selects Sparkle history by semantic version rather than filename order", () => {
  expect(
    selectLatestSparkleHistoryAppcast([
      "/history/Nodex-0.2.9-appcast-arm64.xml",
      "/history/Nodex-0.2.10-appcast-arm64.xml",
      "/history/unrelated.xml",
    ]),
  ).toBe("/history/Nodex-0.2.10-appcast-arm64.xml");
});

test("accepts only immutable published releases as delta history", () => {
  expect(
    isEligibleSparkleHistoryRelease({
      draft: false,
      immutable: true,
      prerelease: false,
    }),
  ).toBe(true);
  expect(
    isEligibleSparkleHistoryRelease({
      draft: false,
      immutable: false,
      prerelease: false,
    }),
  ).toBe(false);
  expect(
    isEligibleSparkleHistoryRelease({
      draft: false,
      prerelease: false,
    }),
  ).toBe(false);
});
