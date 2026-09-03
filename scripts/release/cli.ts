import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  assembleReleaseBundle,
  parseReleaseBundleManifest,
  recordArchitectureBuild,
  type MacArchitecture,
} from "./bundle";
import { extractReleaseNotes } from "./changelog";
import { publishBrowserRuntime } from "./browser-runtime";
import { buildMacDistribution } from "./distribution";
import { generateHomebrewCaskFromBundle } from "./homebrew";
import {
  assertRemoteReleaseCandidate,
  ensureGitHubReleaseTag,
  inspectNightlyRemoteCandidate,
  publishGitHubRelease,
  releaseAssetPaths,
  verifyRemoteRelease,
} from "./github-release";
import {
  checkWorktreeReleaseTransition,
  detectReleaseTransition,
  inspectReleaseSourceAtRef,
  prepareReleaseSource,
} from "./source";
import { tagForVersion } from "./model";
import { parseReleaseIdentity } from "./model";
import {
  resolveNightlyCandidate,
  resolveReleaseIdentity,
  resolveStableReleaseIdentity,
  verifyReleaseIdentityAtRef,
} from "./candidate";
import { runSparkleFinalizeCli, runSparkleHistoryCli } from "./sparkle";
import { projectReleaseAppcasts, verifyPublishedAppcasts } from "./pages";
import { runNightlyRetention } from "./retention";

const projectRoot = resolve(import.meta.dirname, "../..");

const normalizedArgs = (): string[] => process.argv.slice(2).filter((value) => value !== "--");

const parseFlags = (
  args: readonly string[],
): { readonly flags: ReadonlyMap<string, string>; readonly positional: readonly string[] } => {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    if (argument === "--worktree") {
      flags.set("worktree", "true");
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}.`);
    flags.set(argument.slice(2), value);
    index += 1;
  }
  return { flags, positional };
};

const required = (flags: ReadonlyMap<string, string>, name: string): string => {
  const value = flags.get(name)?.trim();
  if (!value) throw new Error(`Missing required --${name}.`);
  return value;
};

const writeJson = (path: string | undefined, value: unknown): void => {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (!path) {
    process.stdout.write(content);
    return;
  }
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, content, "utf8");
};

const main = async (): Promise<void> => {
  const [command, ...rest] = normalizedArgs();
  const { flags, positional } = parseFlags(rest);
  if (command === "prepare") {
    const version = positional[0];
    if (!version || positional.length !== 1) throw new Error("Usage: release prepare <version>.");
    const result = prepareReleaseSource({
      cwd: projectRoot,
      date: flags.get("date") ?? new Date().toISOString().slice(0, 10),
      version,
    });
    process.stdout.write(
      `Prepared ${result.tag}; review and commit the four release metadata files.\n`,
    );
    return;
  }
  if (command === "check") {
    const base = flags.get("base");
    if (base && flags.get("worktree") === "true") {
      writeJson(flags.get("output"), checkWorktreeReleaseTransition(projectRoot, base));
      return;
    }
    const head = flags.get("head") ?? "HEAD";
    if (base) {
      writeJson(flags.get("output"), detectReleaseTransition(projectRoot, base, head));
      return;
    }
    const snapshot = inspectReleaseSourceAtRef(projectRoot, head);
    writeJson(flags.get("output"), {
      sourceSha: execFileSync("git", ["rev-parse", `${head}^{commit}`], {
        cwd: projectRoot,
        encoding: "utf8",
      }).trim(),
      sourceTree: execFileSync("git", ["rev-parse", `${head}^{tree}`], {
        cwd: projectRoot,
        encoding: "utf8",
      }).trim(),
      tag: tagForVersion(snapshot.packageVersion),
      version: snapshot.packageVersion,
    });
    return;
  }
  if (command === "detect") {
    writeJson(
      required(flags, "output"),
      detectReleaseTransition(projectRoot, required(flags, "base"), required(flags, "head")),
    );
    return;
  }
  if (command === "resolve-stable") {
    writeJson(
      required(flags, "output"),
      resolveStableReleaseIdentity({
        base: required(flags, "base"),
        cwd: projectRoot,
        head: required(flags, "head"),
      }),
    );
    return;
  }
  if (command === "resolve-source") {
    const channel = required(flags, "channel");
    if (channel !== "stable" && channel !== "nightly")
      throw new Error("--channel must be stable or nightly.");
    writeJson(
      required(flags, "output"),
      resolveReleaseIdentity({
        channel,
        cwd: projectRoot,
        ref: flags.get("head") ?? "HEAD",
      }),
    );
    return;
  }
  if (command === "resolve-nightly") {
    writeJson(
      required(flags, "output"),
      resolveNightlyCandidate({
        cwd: projectRoot,
        head: flags.get("head") ?? "HEAD",
      }),
    );
    return;
  }
  if (command === "verify-identity") {
    const identity = parseReleaseIdentity(
      JSON.parse(readFileSync(resolve(required(flags, "identity")), "utf8")),
    );
    writeJson(
      flags.get("output"),
      verifyReleaseIdentityAtRef({
        cwd: projectRoot,
        identity,
        ref: required(flags, "head"),
      }),
    );
    return;
  }
  if (command === "retain-nightlies") {
    writeJson(
      flags.get("output"),
      runNightlyRetention({
        destructive: flags.get("destructive") === "true",
        keepCount: Number(flags.get("keep") ?? "20"),
        minAgeDays: Number(flags.get("min-age-days") ?? "14"),
        repo: required(flags, "repo"),
      }),
    );
    return;
  }
  if (command === "record-architecture") {
    const architecture = required(flags, "arch");
    if (architecture !== "arm64" && architecture !== "x64")
      throw new Error("--arch must be arm64 or x64.");
    recordArchitectureBuild({
      appPath: required(flags, "app-path"),
      architecture: architecture as MacArchitecture,
      cwd: projectRoot,
      distDirectory: required(flags, "dist-dir"),
      identityPath: required(flags, "identity"),
      outputDirectory: required(flags, "output"),
    });
    return;
  }
  if (command === "build-mac") {
    const architecture = required(flags, "arch");
    if (architecture !== "arm64" && architecture !== "x64")
      throw new Error("--arch must be arm64 or x64.");
    await buildMacDistribution({
      architecture,
      cwd: projectRoot,
      identityPath: required(flags, "identity"),
      outputDirectory: required(flags, "output"),
    });
    return;
  }
  if (command === "assemble") {
    assembleReleaseBundle({
      arm64Directory: required(flags, "arm64-dir"),
      arm64UpdateDirectory: required(flags, "arm64-update-dir"),
      identityPath: required(flags, "identity"),
      outputDirectory: required(flags, "output"),
      x64Directory: required(flags, "x64-dir"),
      x64UpdateDirectory: required(flags, "x64-update-dir"),
    });
    return;
  }
  if (command === "finalize-sparkle") {
    await runSparkleFinalizeCli(flags);
    return;
  }
  if (command === "fetch-sparkle-history") {
    runSparkleHistoryCli(flags);
    return;
  }
  if (command === "project-pages") {
    writeJson(
      flags.get("output"),
      projectReleaseAppcasts({
        bundlePath: required(flags, "bundle"),
        existingSiteDirectory: flags.get("existing-site-dir"),
        siteDirectory: required(flags, "site-dir"),
      }),
    );
    return;
  }
  if (command === "verify-pages") {
    await verifyPublishedAppcasts({ bundlePath: required(flags, "bundle") });
    return;
  }
  if (command === "extract-notes") {
    const version = required(flags, "version");
    const notes = extractReleaseNotes(
      readFileSync(resolve(flags.get("changelog") ?? "CHANGELOG.md"), "utf8"),
      version,
    );
    const output = flags.get("output");
    if (output) writeFileSync(resolve(output), notes, "utf8");
    else process.stdout.write(notes);
    return;
  }
  if (command === "homebrew") {
    const bundlePath = resolve(required(flags, "bundle"));
    releaseAssetPaths(bundlePath);
    const bundle = parseReleaseBundleManifest(JSON.parse(readFileSync(bundlePath, "utf8")));
    writeFileSync(
      resolve(required(flags, "output")),
      generateHomebrewCaskFromBundle(bundle),
      "utf8",
    );
    return;
  }
  if (command === "publish-github") {
    publishGitHubRelease({
      bundlePath: required(flags, "bundle"),
      notesPath: required(flags, "notes"),
      repo: required(flags, "repo"),
    });
    return;
  }
  if (command === "check-remote-candidate") {
    writeJson(
      flags.get("output"),
      assertRemoteReleaseCandidate({
        repo: required(flags, "repo"),
        sourceSha: required(flags, "source-sha"),
        version: required(flags, "version"),
      }),
    );
    return;
  }
  if (command === "check-nightly-remote") {
    const identity = parseReleaseIdentity(
      JSON.parse(readFileSync(resolve(required(flags, "identity")), "utf8")),
    );
    writeJson(
      flags.get("output"),
      inspectNightlyRemoteCandidate(required(flags, "repo"), identity),
    );
    return;
  }
  if (command === "ensure-tag") {
    process.stdout.write(
      `${ensureGitHubReleaseTag({
        bundlePath: required(flags, "bundle"),
        repo: required(flags, "repo"),
      })}\n`,
    );
    return;
  }
  if (command === "verify-remote") {
    verifyRemoteRelease({ bundlePath: required(flags, "bundle"), repo: required(flags, "repo") });
    return;
  }
  if (command === "verify-bundle") {
    const bundlePath = required(flags, "bundle");
    const bundle = parseReleaseBundleManifest(
      JSON.parse(readFileSync(resolve(bundlePath), "utf8")),
    );
    releaseAssetPaths(bundlePath);
    writeJson(flags.get("output"), bundle);
    return;
  }
  if (command === "publish-browser-runtime") {
    await publishBrowserRuntime({
      arm64Path: required(flags, "arm64"),
      lockPath: required(flags, "lock"),
      repo: required(flags, "repo"),
      tag: required(flags, "tag"),
      x64Path: required(flags, "x64"),
    });
    return;
  }
  throw new Error("Unknown release command.");
};

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
