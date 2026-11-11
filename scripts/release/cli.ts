import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  assembleReleaseBundle,
  parseReleaseBundleManifest,
  recordArchitectureBuild,
  type MacArchitecture,
} from "./bundle";
import { extractUnreleasedNotes, validateNextVersionChangelog } from "./changelog";
import { publishBrowserRuntime } from "./browser-runtime";
import { buildWindowsDistribution } from "./windows-distribution";
import { buildAndroidDistribution, buildIosDistribution } from "./mobile-distribution";
import { publishTestFlight } from "./testflight";
import { finalizeWindowsArchitectureUpdate } from "./windows-updates";
import { buildMacDistribution } from "./distribution";
import { generateHomebrewCaskFromBundle } from "./homebrew";
import {
  ensureGitHubReleaseTag,
  inspectNightlyRemoteCandidate,
  publishGitHubRelease,
  releaseAssetPaths,
  verifyRemoteRelease,
} from "./github-release";
import { inspectReleaseSource, inspectReleaseSourceAtRef, setSourceVersion } from "./source";
import { parseBuildIdentity, parseReleaseIdentity, publicationIdentity } from "./model";
import {
  assertSameBuildIdentity,
  resolveNightlyCandidate,
  resolveBuildIdentity,
  verifyBuildIdentityAtRef,
} from "./candidate";
import {
  advancePublishedRelease,
  preparePromotion,
  promoteFromLocal,
  verifyPromotedBundle,
} from "./promotion";
import { runSparkleFinalizeCli, runSparkleHistoryCli } from "./sparkle";
import { projectReleaseAppcasts, verifyPublishedAppcasts } from "./pages";
import { runNightlyRetention } from "./retention";
import { inspectNightlySourceCi } from "./source-ci";

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
  if (command === "version") {
    const [version] = positional;
    if (!version || positional.length !== 1)
      throw new Error("Usage: vp run release:version -- <x.y.z>.");
    setSourceVersion(projectRoot, version);
    return;
  }
  if (command === "check") {
    const snapshot = flags.has("head")
      ? inspectReleaseSourceAtRef(projectRoot, required(flags, "head"))
      : inspectReleaseSource(projectRoot);
    validateNextVersionChangelog(snapshot.changelog, snapshot.packageVersion);
    writeJson(flags.get("output"), { version: snapshot.packageVersion });
    return;
  }
  if (command === "resolve-source") {
    writeJson(
      required(flags, "output"),
      resolveBuildIdentity({
        cwd: projectRoot,
        ref: flags.get("head") ?? "HEAD",
      }),
    );
    return;
  }
  if (command === "resolve-promotion") {
    const result = preparePromotion(
      projectRoot,
      required(flags, "repo"),
      required(flags, "dir"),
      flags.get("tag"),
    );
    writeJson(required(flags, "output"), result);
    return;
  }
  if (command === "verify-promotion") {
    verifyPromotedBundle(required(flags, "nightly"), required(flags, "bundle"));
    return;
  }
  if (command === "promote") {
    if (positional.length > 1) throw new Error("Usage: vp run release:promote [-- <nightly-tag>].");
    promoteFromLocal(projectRoot, flags.get("repo") ?? "junyudev/nodex", positional[0]);
    return;
  }
  if (command === "advance") {
    const [tag] = positional;
    if (!tag || positional.length !== 1)
      throw new Error("Usage: vp run release:advance -- <stable-tag>.");
    advancePublishedRelease(projectRoot, flags.get("repo") ?? "junyudev/nodex", tag);
    return;
  }
  if (command === "certify") {
    const buildIdentity = resolveBuildIdentity({ cwd: projectRoot, ref: required(flags, "head") });
    writeJson(required(flags, "output"), {
      schemaVersion: 2,
      buildIdentity,
      repository: process.env.GITHUB_REPOSITORY,
      workflowRunId: process.env.GITHUB_RUN_ID,
      workflowRunAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      issuedAt: new Date().toISOString(),
    });
    return;
  }
  if (command === "verify-certificate") {
    const build = parseBuildIdentity(JSON.parse(readFileSync(required(flags, "identity"), "utf8")));
    const cert = JSON.parse(readFileSync(required(flags, "certificate"), "utf8"));
    if (
      cert.schemaVersion !== 2 ||
      cert.repository !== process.env.GITHUB_REPOSITORY ||
      cert.workflowRunId !== (flags.get("run-id") ?? process.env.GITHUB_RUN_ID)
    ) {
      throw new Error("Source certificate does not match the producing run.");
    }
    assertSameBuildIdentity(build, parseBuildIdentity(cert.buildIdentity));
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
  if (command === "check-nightly-ci") {
    writeJson(
      required(flags, "output"),
      inspectNightlySourceCi(required(flags, "repo"), required(flags, "head")),
    );
    return;
  }
  if (command === "verify-identity") {
    const identity = parseBuildIdentity(
      JSON.parse(readFileSync(resolve(required(flags, "identity")), "utf8")),
    );
    writeJson(
      flags.get("output"),
      verifyBuildIdentityAtRef({
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
    if (architecture !== "arm64") throw new Error("--arch must be arm64.");
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
    if (architecture !== "arm64") throw new Error("--arch must be arm64.");
    await buildMacDistribution({
      architecture,
      cwd: projectRoot,
      identityPath: required(flags, "identity"),
      outputDirectory: required(flags, "output"),
    });
    return;
  }
  if (command === "build-windows") {
    const architecture = required(flags, "arch");
    if (architecture !== "x64" && architecture !== "arm64")
      throw new Error("Windows --arch must be x64 or arm64.");
    buildWindowsDistribution({
      architecture,
      cwd: projectRoot,
      identityPath: required(flags, "identity"),
      outputDirectory: required(flags, "output"),
      release: flags.get("release") === "true",
    });
    return;
  }
  if (command === "build-android" || command === "build-ios") {
    const build = command === "build-android" ? buildAndroidDistribution : buildIosDistribution;
    build({
      cwd: projectRoot,
      identityPath: required(flags, "identity"),
      outputDirectory: required(flags, "output"),
    });
    return;
  }
  if (command === "publish-testflight") {
    const bundlePath = required(flags, "bundle");
    const channel = flags.get("channel");
    if (channel) {
      const bundle = parseReleaseBundleManifest(JSON.parse(readFileSync(bundlePath, "utf8")));
      if (bundle.releaseIdentity.channel !== channel)
        throw new Error("TestFlight bundle channel mismatch.");
    }
    const receipt = await publishTestFlight({ bundlePath });
    writeJson(flags.get("output"), receipt);
    return;
  }
  if (command === "finalize-windows") {
    const architecture = required(flags, "arch");
    const channel = required(flags, "channel");
    if (architecture !== "x64" && architecture !== "arm64")
      throw new Error("Windows --arch must be x64 or arm64.");
    if (channel !== "stable" && channel !== "nightly")
      throw new Error("Windows --channel must be stable or nightly.");
    await finalizeWindowsArchitectureUpdate({
      architecture,
      channel,
      architectureDirectory: required(flags, "architecture-dir"),
      outputDirectory: required(flags, "output"),
      privateKey: process.env.SPARKLE_ED25519_PRIVATE_KEY ?? "",
      publishedAt: required(flags, "published-at"),
      releaseNotesPath: required(flags, "notes"),
      sourceSha: required(flags, "source-sha"),
      version: required(flags, "version"),
    });
    return;
  }
  if (command === "assemble") {
    const channel = required(flags, "channel");
    if (channel !== "stable" && channel !== "nightly")
      throw new Error("Invalid publication channel.");
    const build = parseBuildIdentity(JSON.parse(readFileSync(required(flags, "identity"), "utf8")));
    assembleReleaseBundle({
      arm64Directory: required(flags, "arm64-dir"),
      arm64UpdateDirectory: required(flags, "arm64-update-dir"),
      windowsX64Directory: required(flags, "windows-x64-dir"),
      windowsArm64Directory: required(flags, "windows-arm64-dir"),
      windowsX64UpdateDirectory: required(flags, "windows-x64-update-dir"),
      windowsArm64UpdateDirectory: required(flags, "windows-arm64-update-dir"),
      androidDirectory: required(flags, "android-dir"),
      iosDirectory: required(flags, "ios-dir"),
      identity: publicationIdentity(build, channel),
      outputDirectory: required(flags, "output"),
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
    const notes = extractUnreleasedNotes(
      readFileSync(resolve(flags.get("changelog") ?? "CHANGELOG.md"), "utf8"),
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
    await verifyRemoteRelease({
      bundlePath: required(flags, "bundle"),
      repo: required(flags, "repo"),
    });
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
