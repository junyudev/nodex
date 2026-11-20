import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createGzip } from "node:zlib";
import { verifyWorkspaceDependencyBundle } from "../src/main/platform/node/WorkspaceDependencyBundle";
import { sha256File } from "../src/main/platform/node/pinned-tar-archive";
import { WORKSPACE_RUNTIME_MANIFEST } from "../src/shared/workspace-dependency-runtime";
import { createNotarytoolClient, notarize, pauseBeforeRetry } from "./release/notarization";
import {
  readWorkspaceRuntimeLock,
  workspaceRuntimeAssetName,
  workspaceRuntimeSourceDigest,
} from "./workspace-runtime-release-lock";

const target = { platform: "darwin", arch: "arm64" };

const machOMagics = new Set([
  0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcafebabf, 0xcefaedfe, 0xcffaedfe, 0xbebafeca, 0xbfbafeca,
]);

function isMachO(file: string): boolean {
  const descriptor = openSync(file, "r");
  try {
    const header = Buffer.alloc(4);
    return readSync(descriptor, header, 0, 4, 0) === 4 && machOMagics.has(header.readUInt32BE());
  } finally {
    closeSync(descriptor);
  }
}

function signAndVerifyMacCode(identity: string, team: string, file: string): void {
  const codesign = "/usr/bin/codesign";
  execFileSync(
    codesign,
    ["--force", "--sign", identity, "--options", "runtime", "--timestamp", file],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const requirement = `anchor apple generic and certificate leaf[subject.OU] = "${team}" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`;
  execFileSync(codesign, ["--verify", "--strict", "-R", `=${requirement}`, file]);
  const display = spawnSync(codesign, ["-dv", "--verbose=4", file], { encoding: "utf8" });
  const entitlements = execFileSync(codesign, ["--display", "--entitlements", "-", file], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (
    display.status !== 0 ||
    !/^CodeDirectory .*flags=0x[0-9a-f]+\([^\n)]*\bruntime\b/imu.test(display.stderr) ||
    !/^Timestamp=\S/mu.test(display.stderr) ||
    entitlements.trim() !== ""
  )
    throw new Error(
      `Workspace code must have hardened runtime, a secure timestamp and no entitlements: ${file}`,
    );
}

export async function archiveWorkspaceRuntime(options: {
  readonly sourceRoot: string;
  readonly outputDirectory: string;
  readonly sourceLockSha256: string;
  readonly sign: (file: string) => void;
  readonly notarize?: (zip: string) => string;
}) {
  const sourceRoot = path.resolve(options.sourceRoot);
  const outputDirectory = path.resolve(options.outputDirectory);
  if (outputDirectory === sourceRoot || outputDirectory.startsWith(`${sourceRoot}${path.sep}`))
    throw new Error("Write the archive outside the workspace runtime source");
  const { manifest } = await verifyWorkspaceDependencyBundle({ root: sourceRoot, ...target });
  if (manifest.sourceLockSha256 !== options.sourceLockSha256)
    throw new Error("Stage the workspace runtime from the current lock before archiving");
  mkdirSync(outputDirectory, { recursive: true });
  const scratch = mkdtempSync(path.join(outputDirectory, ".workspace-release-"));
  try {
    const root = path.join(scratch, "workspace-runtime");
    cpSync(sourceRoot, root, { recursive: true, errorOnExist: true, force: false });
    if (!isMachO(path.join(root, manifest.pythonExecutable)))
      throw new Error("Workspace interpreter must be Mach-O");
    const artifacts = [];
    for (const artifact of manifest.artifacts) {
      const file = path.join(root, artifact.path);
      if (isMachO(file)) options.sign(file);
      artifacts.push({ ...artifact, size: lstatSync(file).size, sha256: await sha256File(file) });
    }
    const manifestPath = path.join(root, WORKSPACE_RUNTIME_MANIFEST);
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, artifacts }, null, 2)}\n`);
    const { unpackedBytes } = await verifyWorkspaceDependencyBundle({ root, ...target });
    const submissionId = options.notarize ? notarizeClosure(root, scratch, options.notarize) : null;
    const assetName = workspaceRuntimeAssetName(manifest.distributionId);
    const files = [
      WORKSPACE_RUNTIME_MANIFEST,
      ...artifacts.map((artifact) => artifact.path),
    ].sort();
    for (const file of files) {
      const absolute = path.join(root, file);
      chmodSync(absolute, (lstatSync(absolute).mode & 0o111) === 0 ? 0o644 : 0o755);
      utimesSync(absolute, 0, 0);
    }
    const { TAR_OPTIONS: _tarOptions, ...env } = process.env;
    const tar = path.join(scratch, "runtime.tar");
    execFileSync(
      "/usr/bin/tar",
      [
        "--format=ustar",
        "--uid",
        "0",
        "--gid",
        "0",
        "--uname",
        "root",
        "--gname",
        "root",
        "-cf",
        tar,
        "-C",
        root,
        "--null",
        "-T",
        "-",
      ],
      {
        env: { ...env, COPYFILE_DISABLE: "1", LC_ALL: "C" },
        input: `${files.join("\0")}\0`,
      },
    );
    const archive = path.join(scratch, assetName);
    await pipeline(createReadStream(tar), createGzip({ level: 9 }), createWriteStream(archive));
    const metadata = {
      assetName,
      url: null,
      archiveSize: lstatSync(archive).size,
      archiveSha256: await sha256File(archive),
      manifestSha256: await sha256File(manifestPath),
      unpackedBytes,
    };
    renameSync(archive, path.join(outputDirectory, assetName));
    return { ...metadata, submissionId };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function notarizeClosure(root: string, scratch: string, submit: (zip: string) => string): string {
  const zip = path.join(scratch, "workspace-runtime.zip");
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", root, zip]);
  return submit(zip);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    options: {
      source: { type: "string", default: ".generated/workspace-runtime/arm64" },
      out: { type: "string", default: ".generated/workspace-runtime-release" },
      lock: { type: "string", default: "resources/workspace-runtime/workspace-runtime.lock.json" },
      identity: { type: "string" },
      "notary-profile": { type: "string" },
    },
  });
  const identity = values.identity;
  const team = identity?.match(/^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/u)?.[1];
  if (process.platform !== "darwin" || process.arch !== "arm64" || !identity || !team)
    throw new Error(
      "Run on Apple silicon macOS with --identity 'Developer ID Application: Name (TEAMID)'",
    );
  const { APPLE_API_KEY, APPLE_API_KEY_B64, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  const credentialsRoot = mkdtempSync(path.join(tmpdir(), "nodex-workspace-notary-"));
  try {
    let submit: ((zip: string) => string) | undefined;
    const profile = values["notary-profile"];
    if (profile) {
      submit = (zip) => {
        const result = JSON.parse(
          execFileSync(
            "xcrun",
            [
              "notarytool",
              "submit",
              zip,
              "--keychain-profile",
              profile,
              "--wait",
              "--output-format",
              "json",
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
          ),
        );
        if (result.status !== "Accepted" || typeof result.id !== "string")
          throw new Error(`Apple did not accept the workspace runtime: ${JSON.stringify(result)}`);
        return result.id;
      };
    } else if (APPLE_API_KEY || APPLE_API_KEY_B64 || APPLE_API_KEY_ID || APPLE_API_ISSUER) {
      if ((!APPLE_API_KEY && !APPLE_API_KEY_B64) || !APPLE_API_KEY_ID || !APPLE_API_ISSUER)
        throw new Error("Incomplete App Store Connect notarization credentials");
      const key = APPLE_API_KEY ?? path.join(credentialsRoot, "AuthKey.p8");
      if (!APPLE_API_KEY && APPLE_API_KEY_B64)
        writeFileSync(key, Buffer.from(APPLE_API_KEY_B64, "base64"), { mode: 0o600 });
      const notary = createNotarytoolClient(process.cwd(), {
        key,
        keyId: APPLE_API_KEY_ID,
        issuer: APPLE_API_ISSUER,
      });
      submit = (zip) => notarize(notary, zip, { pause: pauseBeforeRetry, report: console.error });
    }
    console.log(
      JSON.stringify(
        await archiveWorkspaceRuntime({
          sourceRoot: values.source,
          outputDirectory: values.out,
          sourceLockSha256: workspaceRuntimeSourceDigest(readWorkspaceRuntimeLock(values.lock)),
          sign: (file) => signAndVerifyMacCode(identity, team, file),
          notarize: submit,
        }),
      ),
    );
  } finally {
    rmSync(credentialsRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
