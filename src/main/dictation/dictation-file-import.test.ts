import { mkdtemp, mkdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { DICTATION_HISTORY_MAX_AUDIO_BYTES } from "../../shared/dictation-history";
import { readDictationWebmFile, validateDictationWebm } from "./dictation-file-import";

const roots: string[] = [];
const webm = new Uint8Array([
  0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, 0x18, 0x53, 0x80, 0x67,
  0xff, 0xe7, 0x81, 0,
]);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function selectedFile(name: string, bytes = webm) {
  const root = await mkdtemp(join(tmpdir(), "nodex-dictation-file-"));
  roots.push(root);
  const filePath = join(root, name);
  await writeFile(filePath, bytes);
  return filePath;
}

describe("WebM file import", () => {
  test("reads the exact bytes and basename of a native selection", async () => {
    const selected = await readDictationWebmFile(await selectedFile("Interview.WEBM"));
    expect(selected).toEqual({ fileName: "Interview.WEBM", bytes: webm });
    expect(Object.keys(selected)).toEqual(["fileName", "bytes"]);
  });

  test("accepts finite and unknown Segment lengths", () => {
    expect(() => validateDictationWebm(webm)).not.toThrow();
    const finite = Uint8Array.from(webm);
    finite[16] = 0x83;
    expect(() => validateDictationWebm(finite)).not.toThrow();
  });

  test("rejects other containers, truncated elements, duplicate DocTypes and missing audio bytes", () => {
    const otherDocType = Uint8Array.from(webm);
    otherDocType[11] = 0x76;
    const oversizedSegment = Uint8Array.from(webm);
    oversizedSegment[16] = 0x84;
    const duplicateDocType = new Uint8Array([
      ...webm.subarray(0, 4),
      0x8e,
      ...webm.subarray(5, 12),
      ...webm.subarray(5, 12),
      ...webm.subarray(12),
    ]);
    for (const malformed of [
      new Uint8Array([1, 2, 3]),
      otherDocType,
      webm.subarray(0, 10),
      webm.subarray(0, 17),
      oversizedSegment,
      duplicateDocType,
    ]) {
      expect(() => validateDictationWebm(malformed)).toThrow();
    }
  });

  test("rejects empty, mislabeled, non-regular and oversized selections before reading audio", async () => {
    await expect(
      readDictationWebmFile(await selectedFile("empty.webm", new Uint8Array())),
    ).rejects.toThrow("empty");
    await expect(readDictationWebmFile(await selectedFile("audio.wav"))).rejects.toThrow("WebM");
    await expect(
      readDictationWebmFile(await selectedFile("fake.webm", new Uint8Array([1, 2, 3]))),
    ).rejects.toThrow();
    const oversized = await selectedFile("oversized.webm");
    await truncate(oversized, DICTATION_HISTORY_MAX_AUDIO_BYTES + 1);
    await expect(readDictationWebmFile(oversized)).rejects.toThrow("64 MiB");
    const directory = join(roots[0]!, "directory.webm");
    await mkdir(directory);
    await expect(readDictationWebmFile(directory)).rejects.toThrow("regular");
  });

  test("honors cancellation before opening the file", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      readDictationWebmFile(await selectedFile("cancelled.webm"), controller.signal),
    ).rejects.toThrow("cancelled");
  });
});
