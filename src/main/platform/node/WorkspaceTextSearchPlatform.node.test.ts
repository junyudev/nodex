import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { decodePinnedRipgrepArchive } from "./WorkspaceTextSearchPlatform";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture(type: number = 48, duplicate = false) {
  const binary = Buffer.from("verified-executable");
  const header = Buffer.alloc(512);
  header.write("ripgrep-15.2.0-test-target/rg");
  header.write(binary.length.toString(8).padStart(11, "0"), 124);
  header[156] = type;
  const entry = Buffer.concat([header, binary, Buffer.alloc(512 - binary.length)]);
  const archive = gzipSync(
    Buffer.concat([entry, ...(duplicate ? [entry] : []), Buffer.alloc(1024)]),
  );
  return {
    archive,
    binary,
    pin: {
      archiveSha256: sha256(archive),
      archiveSize: archive.length,
      binarySha256: sha256(binary),
      binarySize: binary.length,
      target: "test-target",
    },
  };
}

it("extracts only the pinned executable and verifies both the archive and extracted bytes", async () => {
  const { archive, binary, pin } = fixture();
  expect(await decodePinnedRipgrepArchive(archive, pin)).toEqual(binary);
  await expect(
    decodePinnedRipgrepArchive(archive, { ...pin, archiveSize: archive.length + 1 }),
  ).rejects.toThrow("archive verification");
  await expect(
    decodePinnedRipgrepArchive(archive, { ...pin, archiveSha256: "bad" }),
  ).rejects.toThrow("archive verification");
  await expect(
    decodePinnedRipgrepArchive(archive, { ...pin, binarySha256: "bad" }),
  ).rejects.toThrow("executable verification");
  await expect(
    decodePinnedRipgrepArchive(archive, { ...pin, binarySize: binary.length + 1 }),
  ).rejects.toThrow("executable verification");
});

it("rejects archive links and duplicate executable entries", async () => {
  for (const { archive, pin } of [fixture(49), fixture(50), fixture(48, true)])
    await expect(decodePinnedRipgrepArchive(archive, pin)).rejects.toThrow("not a regular file");
});
