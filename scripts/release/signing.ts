import { spawnSync } from "node:child_process";
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

export const runWithPrivateKey = (
  executable: string,
  args: readonly string[],
  privateKey: string,
  cwd?: string,
): string => {
  const result = spawnSync(executable, [...args], {
    cwd,
    encoding: "utf8",
    input: privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Sparkle tool ${path.basename(executable)} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`,
    );
  }
  return result.stdout.trim();
};

export const readConfiguredPublicKey = (): string => {
  const publicKey = readFileSync(
    path.join(repositoryRoot, "resources/sparkle/public-key.txt"),
    "utf8",
  ).trim();
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(publicKey) || Buffer.from(publicKey, "base64").length !== 32) {
    throw new Error("Configured Sparkle public key is invalid.");
  }
  return publicKey;
};

export const signFile = (signUpdate: string, filePath: string, privateKey: string): string => {
  // Sparkle treats .xml specially even with -p: it mutates the feed and prints no signature.
  // A binary copy requests a detached signature of the final, already sealed XML bytes.
  const temporary =
    path.extname(filePath).toLowerCase() === ".xml"
      ? mkdtempSync(path.join(tmpdir(), "nodex-sparkle-detached-"))
      : null;
  const signingPath = temporary ? path.join(temporary, "appcast.bin") : filePath;
  try {
    if (temporary) copyFileSync(filePath, signingPath);
    const signature = runWithPrivateKey(
      signUpdate,
      ["--ed-key-file", "-", "-p", signingPath],
      privateKey,
    );
    if (!/^[A-Za-z0-9+/]{86}==$/u.test(signature)) {
      throw new Error(
        `Sparkle returned an invalid Ed25519 signature for ${path.basename(filePath)}.`,
      );
    }
    return signature;
  } finally {
    if (temporary) rmSync(temporary, { force: true, recursive: true });
  }
};

export const assertPrivateKeyMatchesPublicKey = (
  signUpdate: string,
  privateKey: string,
  publicKey: string,
): void => {
  const verificationRoot = mkdtempSync(path.join(tmpdir(), "nodex-sparkle-key-verify-"));
  try {
    const sentinelPath = path.join(verificationRoot, "sentinel.txt");
    writeFileSync(sentinelPath, "Nodex Sparkle signing-key verification\n", "utf8");
    const signature = Buffer.from(signFile(signUpdate, sentinelPath, privateKey), "base64");
    const rawPublicKey = Buffer.from(publicKey, "base64");
    const key = createPublicKey({
      format: "der",
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawPublicKey]),
      type: "spki",
    });
    if (!verifySignature(null, readFileSync(sentinelPath), key, signature)) {
      throw new Error("Sparkle private key does not match the configured public key.");
    }
  } finally {
    rmSync(verificationRoot, { force: true, recursive: true });
  }
};

/** Verify exact bytes with the reviewed raw Ed25519 public key, independently of sign_update. */
export const verifyFileSignature = (
  filePath: string,
  signature: string,
  publicKey: string,
): void => {
  const rawPublicKey = Buffer.from(publicKey, "base64");
  if (rawPublicKey.length !== 32 || Buffer.from(signature, "base64").length !== 64) {
    throw new Error("Invalid Ed25519 public key or signature.");
  }
  const key = createPublicKey({
    format: "der",
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawPublicKey]),
    type: "spki",
  });
  if (!verifySignature(null, readFileSync(filePath), key, Buffer.from(signature, "base64"))) {
    throw new Error(`Invalid Ed25519 signature for ${path.basename(filePath)}.`);
  }
};
