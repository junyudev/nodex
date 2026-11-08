import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runVitePlus } from "../vite-plus-command";
import { assertSourceIdentity } from "./distribution";
import {
  ANDROID_SIGNING_CERTIFICATE_SHA256,
  APPLE_TEAM_IDENTIFIER,
  MOBILE_APP_ID,
  MOBILE_BUILD_MANIFEST,
  mobileAppFor,
  mobileArtifactName,
  mobileBuildEnvironment,
  parseMobileBuildManifest,
  readMobileBuildDirectory,
  type MobileBuildManifest,
  type MobilePlatform,
} from "./mobile";
import { parseReleaseIdentity, sha256File, type ReleaseIdentity } from "./model";

interface MobileBuildOptions {
  readonly cwd: string;
  readonly identityPath: string;
  readonly outputDirectory: string;
}

const output = (command: string, args: readonly string[], options: object = {}): string =>
  execFileSync(command, [...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });

const run = (command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => {
  execFileSync(command, [...args], { cwd, env, stdio: "inherit" });
};

const toolVersion = (command: string, args: readonly string[]): string => {
  try {
    return output(command, args, { stdio: ["ignore", "pipe", "pipe"] })
      .trim()
      .split("\n")[0];
  } catch {
    return "unavailable";
  }
};

const runner = (tools: Readonly<Record<string, string>>): Record<string, string> => ({
  image: process.env.ImageOS ?? process.env.RUNNER_OS ?? "local",
  imageVersion: process.env.ImageVersion ?? "unknown",
  node: process.version,
  ...tools,
});

const prepare = (options: MobileBuildOptions) => {
  const cwd = resolve(options.cwd);
  const identity = parseReleaseIdentity(
    JSON.parse(readFileSync(resolve(options.identityPath), "utf8")),
  );
  assertSourceIdentity(cwd, identity);
  const outputDirectory = resolve(options.outputDirectory);
  if (existsSync(outputDirectory) && readdirSync(outputDirectory).length > 0)
    throw new Error("Mobile distribution output must be empty.");
  const mobile = join(cwd, "packages/mobile");
  const env = { ...process.env, ...mobileBuildEnvironment(identity) };
  return { cwd, identity, outputDirectory, mobile, env };
};

/** Records the verified artifact beside its manifest, the only shape assembly accepts. */
const record = (
  platform: MobilePlatform,
  identity: ReleaseIdentity,
  builtPath: string,
  outputDirectory: string,
  signer: string,
  tools: Readonly<Record<string, string>>,
): MobileBuildManifest => {
  mkdirSync(outputDirectory, { recursive: true });
  const name = mobileArtifactName(platform, identity.version);
  const target = join(outputDirectory, name);
  copyFileSync(builtPath, target);
  const manifest = parseMobileBuildManifest({
    schemaVersion: 1,
    platform,
    releaseIdentity: identity,
    app: mobileAppFor(platform, identity),
    artifact: { name, bytes: statSync(target).size, sha256: sha256File(target) },
    signer,
    runner: runner(tools),
  });
  writeFileSync(
    join(outputDirectory, MOBILE_BUILD_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  readMobileBuildDirectory(outputDirectory, platform, identity);
  return manifest;
};

const androidSdk = (): string => {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), "Library/Android/sdk"),
  ];
  const sdk = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!sdk) throw new Error("Android distribution needs ANDROID_HOME to name an Android SDK.");
  return sdk;
};

/** The newest installed build-tools, which carry apksigner and aapt2. */
const androidBuildTools = (sdk: string): string => {
  const root = join(sdk, "build-tools");
  const versions = readdirSync(root)
    .filter((name) => /^\d+\.\d+\.\d+$/u.test(name) && existsSync(join(root, name, "apksigner")))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  const newest = versions.at(-1);
  if (!newest) throw new Error("Android distribution needs build-tools with apksigner.");
  return join(root, newest);
};

/** Signer certificates and the package line, read back from the finished APK. */
export function inspectAndroidApk(
  apkPath: string,
  buildTools: string,
): {
  readonly certificates: readonly string[];
  readonly schemes: ReadonlySet<string>;
  readonly id: string;
  readonly versionCode: string;
  readonly versionName: string;
} {
  const signers = output(join(buildTools, "apksigner"), [
    "verify",
    "--verbose",
    "--print-certs",
    apkPath,
  ]);
  const badging = output(join(buildTools, "aapt2"), ["dump", "badging", apkPath]);
  const pkg = /^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/mu.exec(badging);
  if (!pkg) throw new Error("Android APK has no readable package identity.");
  return {
    certificates: [...signers.matchAll(/certificate SHA-256 digest: ([a-f0-9]{64})/gu)].map(
      (match) => match[1],
    ),
    schemes: new Set(
      [...signers.matchAll(/^Verified using (v\d(?:\.\d)?) scheme .*: true$/gmu)].map(
        (match) => match[1],
      ),
    ),
    id: pkg[1],
    versionCode: pkg[2],
    versionName: pkg[3],
  };
}

/**
 * Builds the signed production APK. Only the pinned release certificate can sign it: a
 * debug-signed or differently signed APK could never update an installed copy, so it never
 * reaches a bundle.
 */
export function buildAndroidDistribution(options: MobileBuildOptions): MobileBuildManifest {
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new Error("Android distribution builds on Linux or macOS.");
  const { cwd, identity, outputDirectory, mobile, env } = prepare(options);
  if (!env.NODEX_ANDROID_KEYSTORE || !env.NODEX_ANDROID_KEYSTORE_PASSWORD)
    throw new Error("Android distribution needs the release keystore and its password.");
  const sdk = androidSdk();
  const buildEnv = { ...env, ANDROID_HOME: sdk };
  runVitePlus(["exec", "expo", "prebuild", "--clean", "--no-install", "--platform", "android"], {
    cwd: mobile,
    env: buildEnv,
  });
  // Phones that run Nodex Mobile are 64-bit Arm; one ABI keeps the download and the build small.
  run(
    "./gradlew",
    [":app:assembleRelease", "--no-daemon", "-PreactNativeArchitectures=arm64-v8a"],
    join(mobile, "android"),
    buildEnv,
  );
  assertSourceIdentity(cwd, identity);
  const apk = join(mobile, "android/app/build/outputs/apk/release/app-release.apk");
  const buildTools = androidBuildTools(sdk);
  const inspected = inspectAndroidApk(apk, buildTools);
  const app = mobileAppFor("android", identity);
  if (
    inspected.certificates.length !== 1 ||
    inspected.certificates[0] !== ANDROID_SIGNING_CERTIFICATE_SHA256 ||
    !inspected.schemes.has("v2")
  )
    throw new Error("Android APK is not signed by the Nodex release certificate.");
  if (
    inspected.id !== MOBILE_APP_ID ||
    inspected.versionCode !== app.build ||
    inspected.versionName !== app.version
  )
    throw new Error("Android APK identity does not match its Release Identity.");
  return record("android", identity, apk, outputDirectory, ANDROID_SIGNING_CERTIFICATE_SHA256, {
    // Gradle builds with JAVA_HOME when it is set, whatever `java` the PATH finds first.
    java: toolVersion(env.JAVA_HOME ? join(env.JAVA_HOME, "bin/java") : "java", ["--version"]),
    buildTools: buildTools.split("/").at(-1) ?? "unknown",
  });
}

const plistValue = (plist: string, key: string): string =>
  output("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist]).trim();

/**
 * Builds the App Store-signed IPA that TestFlight receives. Signing uses Apple's cloud-managed
 * certificates through the App Store Connect key, so no signing identity lives in CI.
 */
export function buildIosDistribution(options: MobileBuildOptions): MobileBuildManifest {
  if (process.platform !== "darwin") throw new Error("iOS distribution builds on macOS.");
  const { cwd, identity, outputDirectory, mobile, env } = prepare(options);
  const { APPLE_API_KEY_B64, APPLE_API_KEY_ID, APPLE_API_ISSUER } = env;
  if (!APPLE_API_KEY_B64 || !APPLE_API_KEY_ID || !APPLE_API_ISSUER)
    throw new Error("iOS distribution needs the App Store Connect key.");
  const work = mkdtempSync(join(tmpdir(), "nodex-ios-distribution-"));
  try {
    const key = join(work, "AuthKey.p8");
    writeFileSync(key, Buffer.from(APPLE_API_KEY_B64, "base64"), { mode: 0o600 });
    const signing = [
      "-allowProvisioningUpdates",
      "-authenticationKeyPath",
      key,
      "-authenticationKeyID",
      APPLE_API_KEY_ID,
      "-authenticationKeyIssuerID",
      APPLE_API_ISSUER,
    ];
    const buildEnv = { ...env, APPLE_TEAM_ID: APPLE_TEAM_IDENTIFIER };
    runVitePlus(["exec", "expo", "prebuild", "--clean", "--no-install", "--platform", "ios"], {
      cwd: mobile,
      env: buildEnv,
    });
    run("pod", ["install"], join(mobile, "ios"), buildEnv);
    const archive = join(work, "Nodex.xcarchive");
    run(
      "xcodebuild",
      [
        "archive",
        "-workspace",
        "ios/Nodex.xcworkspace",
        "-scheme",
        "Nodex",
        "-configuration",
        "Release",
        "-destination",
        "generic/platform=iOS",
        "-archivePath",
        archive,
        ...signing,
        `DEVELOPMENT_TEAM=${APPLE_TEAM_IDENTIFIER}`,
        "CODE_SIGN_STYLE=Automatic",
      ],
      mobile,
      buildEnv,
    );
    const exportOptions = join(work, "export.plist");
    writeFileSync(
      exportOptions,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>${APPLE_TEAM_IDENTIFIER}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>uploadSymbols</key><true/>
</dict></plist>
`,
    );
    const exported = join(work, "export");
    run(
      "xcodebuild",
      [
        "-exportArchive",
        "-archivePath",
        archive,
        "-exportOptionsPlist",
        exportOptions,
        "-exportPath",
        exported,
        ...signing,
      ],
      mobile,
      buildEnv,
    );
    assertSourceIdentity(cwd, identity);
    const ipas = readdirSync(exported).filter((name) => name.endsWith(".ipa"));
    if (ipas.length !== 1) throw new Error("iOS export did not produce exactly one IPA.");
    const ipa = join(exported, ipas[0]);
    verifyIpa(ipa, identity, work);
    return record("ios", identity, ipa, outputDirectory, APPLE_TEAM_IDENTIFIER, {
      xcode: toolVersion("xcodebuild", ["-version"]),
      cocoapods: toolVersion("pod", ["--version"]),
    });
  } finally {
    rmSync(work, { force: true, recursive: true });
  }
}

/** The app and its notification extension carry the release's identity and the Nodex team. */
function verifyIpa(ipa: string, identity: ReleaseIdentity, work: string): void {
  const payload = join(work, "payload");
  run("/usr/bin/ditto", ["-x", "-k", ipa, payload], work, process.env);
  const app = join(payload, "Payload/Nodex.app");
  const extension = join(app, "PlugIns/NotificationService.appex");
  const expected = mobileAppFor("ios", identity);
  for (const [bundle, id] of [
    [app, MOBILE_APP_ID],
    [extension, `${MOBILE_APP_ID}.NotificationService`],
  ] as const) {
    const plist = join(bundle, "Info.plist");
    if (
      plistValue(plist, "CFBundleIdentifier") !== id ||
      plistValue(plist, "CFBundleShortVersionString") !== expected.version ||
      plistValue(plist, "CFBundleVersion") !== expected.build
    )
      throw new Error(`${id} does not carry the Release Identity's versions.`);
  }
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], work, process.env);
  // codesign describes a signature on stderr.
  const signature = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=2", app], {
    encoding: "utf8",
  });
  if (
    signature.status !== 0 ||
    !signature.stderr.split("\n").includes(`TeamIdentifier=${APPLE_TEAM_IDENTIFIER}`)
  )
    throw new Error("iOS app is not signed by the Nodex team.");
}
