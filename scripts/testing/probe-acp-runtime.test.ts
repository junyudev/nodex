import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { createAcpProbeEnvironment, parseAcpRuntimeProbeArguments } from "./probe-acp-runtime";

const roots: string[] = [];
const host = { platform: "darwin", architecture: "arm64" };
const target = ["--target-platform", "darwin", "--target-arch", "arm64"];
const temporaryRoot = () => {
  const root = realpathSync(
    mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "acp-gate-")),
  );
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("the release gate requires native macOS arm64 and the complete management smoke", () => {
  expect(parseAcpRuntimeProbeArguments(["--gate", ...target], host)).toMatchObject({
    gate: true,
    ptyOnly: false,
  });
  expect(() =>
    parseAcpRuntimeProbeArguments(["--gate", ...target], {
      platform: "linux",
      architecture: "arm64",
    }),
  ).toThrow("matching");
  expect(() =>
    parseAcpRuntimeProbeArguments(
      ["--gate", "--target-platform", "darwin", "--target-arch", "x64"],
      { platform: "darwin", architecture: "x64" },
    ),
  ).toThrow("macOS arm64");
  expect(() => parseAcpRuntimeProbeArguments(["--gate", ...target, "--pty-only"], host)).toThrow(
    "full management",
  );
  expect(() =>
    parseAcpRuntimeProbeArguments(["--gate", ...target, "--home", "/tmp/reused"], host),
  ).toThrow("fresh owned");
  expect(() =>
    parseAcpRuntimeProbeArguments(
      [...target, "--home", "relative", "--report", "/tmp/result.json"],
      host,
    ),
  ).toThrow("absolute");
});

test("manual probes refuse existing homes and preserve previous reports", async () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  const reportPath = join(root, "report.json");
  const options = parseAcpRuntimeProbeArguments(
    [...target, "--home", home, "--report", reportPath],
    host,
  );
  const environment = await createAcpProbeEnvironment(root, options);
  expect(environment.manifest.repositoryRealpath).toBe(root);
  expect(JSON.parse(readFileSync(reportPath, "utf8"))).toEqual({ status: "running", home });
  writeFileSync(reportPath, "preserved evidence");
  await expect(createAcpProbeEnvironment(root, options)).rejects.toThrow("report already exists");
  expect(readFileSync(reportPath, "utf8")).toBe("preserved evidence");
  await expect(
    createAcpProbeEnvironment(root, { ...options, reportPath: join(root, "other.json") }),
  ).rejects.toThrow();
  expect(existsSync(join(root, "other.json"))).toBe(false);
});

test("linked-worktree gates create separate owned homes and reports in the primary checkout", async () => {
  const root = temporaryRoot();
  const primary = join(root, "primary");
  const linked = join(root, "linked");
  execFileSync("git", ["init", "--quiet", primary]);
  execFileSync("git", [
    "-C",
    primary,
    "-c",
    "user.name=ACP test",
    "-c",
    "user.email=acp@example.test",
    "commit",
    "--quiet",
    "--allow-empty",
    "--no-gpg-sign",
    "-m",
    "initial",
  ]);
  execFileSync("git", ["-C", primary, "worktree", "add", "--quiet", "--detach", linked]);
  const options = parseAcpRuntimeProbeArguments(["--gate", ...target], host);
  const first = await createAcpProbeEnvironment(linked, options);
  const second = await createAcpProbeEnvironment(linked, options);
  expect(first.home.startsWith(join(primary, "runs.local/acp-runtime-"))).toBe(true);
  expect(first.reportPath.startsWith(join(primary, "notes.local/artifacts/acp-runtime-"))).toBe(
    true,
  );
  expect(first.manifest.repositoryRealpath).toBe(realpathSync(linked));
  expect(first.manifest.environmentId).not.toBe(second.manifest.environmentId);
  expect(first.home).not.toBe(second.home);
  expect(first.reportPath).not.toBe(second.reportPath);
  expect(JSON.parse(readFileSync(join(first.home, "dev-home.json"), "utf8"))).toEqual(
    first.manifest,
  );
});
