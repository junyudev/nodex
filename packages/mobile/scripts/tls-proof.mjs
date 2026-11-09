#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [platform, device, destination, flag] = process.argv.slice(2);
if (!destination || !["ios", "android"].includes(platform)) {
  throw new Error(
    "Usage: node scripts/tls-proof.mjs ios|android <simulator-uuid|emulator-serial> <artifact-dir> [--skip-build]",
  );
}
const output = resolve(destination);
mkdirSync(output, { recursive: true });
const env = {
  ...process.env,
  APP_VARIANT: "tls-proof",
  EXPO_NO_GIT_STATUS: "1",
  NODE_ENV: "production",
};
const run = (command, args, cwd = root) =>
  execFileSync(command, args, { cwd, env, stdio: "inherit" });
const adb = resolve(env.ANDROID_HOME ?? `${env.HOME}/Library/Android/sdk`, "platform-tools/adb");
if (flag !== "--skip-build") {
  run("vp", ["exec", "expo", "prebuild", "--clean", "--no-install", "--platform", platform]);
  if (platform === "ios") {
    run("pod", ["install"], resolve(root, "ios"));
    run("xcodebuild", [
      "-workspace",
      "ios/NodexTLSProof.xcworkspace",
      "-scheme",
      "NodexTLSProof",
      "-configuration",
      "Release",
      "-sdk",
      "iphonesimulator",
      "-destination",
      `id=${device}`,
      "-derivedDataPath",
      "ios/build/tls-proof",
      "CODE_SIGNING_ALLOWED=NO",
      "ONLY_ACTIVE_ARCH=YES",
      "ARCHS=arm64",
    ]);
  } else {
    run(
      "./gradlew",
      [":app:assembleRelease", "-PreactNativeArchitectures=arm64-v8a", "--max-workers=4"],
      resolve(root, "android"),
    );
  }
}
if (platform === "ios") {
  const plist = JSON.parse(
    execFileSync(
      "plutil",
      [
        "-extract",
        "NSAppTransportSecurity",
        "json",
        "-o",
        "-",
        resolve(
          root,
          "ios/build/tls-proof/Build/Products/Release-iphonesimulator/NodexTLSProof.app/Info.plist",
        ),
      ],
      { encoding: "utf8" },
    ),
  );
  if (plist.NSAllowsLocalNetworking !== true || Object.hasOwn(plist, "NSAllowsArbitraryLoads"))
    throw new Error("iOS proof requires local-only ATS policy with no arbitrary-loads key");
  writeFileSync(resolve(output, "ios-ats.json"), JSON.stringify(plist, null, 2));
}
const resultFile = resolve(output, `${platform}-result.json`);
rmSync(resultFile, { force: true });
const server = spawn(
  process.execPath,
  [resolve(root, "scripts/tls-proof-server.mjs"), platform, output],
  { cwd: root, stdio: "inherit" },
);
const pause = () => new Promise((done) => setTimeout(done, 500));
try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (server.exitCode !== null) throw new Error("Proof server exited");
    try {
      await fetch("http://127.0.0.1:19444/config");
      ready = true;
      break;
    } catch {
      await pause();
    }
  }
  if (!ready) throw new Error("Proof server did not become ready");
  if (platform === "ios") {
    run("xcrun", [
      "simctl",
      "install",
      device,
      "ios/build/tls-proof/Build/Products/Release-iphonesimulator/NodexTLSProof.app",
    ]);
    // Direct launch avoids iOS's first-open custom-scheme confirmation dialog.
    run("xcrun", [
      "simctl",
      "launch",
      "--terminate-running-process",
      device,
      "app.jyu.nodex.mobile.tlsproof",
    ]);
  } else {
    run(adb, [
      "-s",
      device,
      "install",
      "-r",
      "android/app/build/outputs/apk/release/app-release.apk",
    ]);
    run(adb, ["-s", device, "shell", "am", "force-stop", "app.jyu.nodex.mobile.tlsproof"]);
    run(adb, [
      "-s",
      device,
      "shell",
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      "nodex-mobile-tls-proof://run?control=http%3A%2F%2F10.0.2.2%3A19444",
      "app.jyu.nodex.mobile.tlsproof",
    ]);
  }
  for (let attempt = 0; attempt < 180 && !existsSync(resultFile); attempt++) await pause();
  if (!existsSync(resultFile)) throw new Error("Timed out waiting for native proof result");
  if (platform === "ios")
    run("xcrun", ["simctl", "io", device, "screenshot", resolve(output, "ios.png")]);
  else
    writeFileSync(
      resolve(output, "android.png"),
      execFileSync(adb, ["-s", device, "exec-out", "screencap", "-p"]),
    );
  const report = JSON.parse(readFileSync(resultFile, "utf8"));
  if (!report.passed) throw new Error(`Native proof failed: ${JSON.stringify(report)}`);
  console.log(`${platform}: all pinned TLS native checks passed`);
} finally {
  server.kill("SIGTERM");
}
