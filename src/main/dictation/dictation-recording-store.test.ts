import { dictationDiagnosticsFixture } from "../../../tests/fixtures/dictation-diagnostics";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  DICTATION_HISTORY_DIRECTORY_NAME,
  DICTATION_HISTORY_MAX_CHUNK_BYTES,
  DICTATION_HISTORY_MAX_RECORDINGS,
  type DictationRecordingMetadata,
} from "../../shared/dictation-history";
import {
  DictationRecordingStoreError,
  FileDictationRecordingStore,
} from "./dictation-recording-store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createProfileRoot(): string {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-dictation-history-"));
  roots.push(profileRoot);
  return profileRoot;
}

function recordingDirectory(profileRoot: string, id: string): string {
  return path.join(
    profileRoot,
    DICTATION_HISTORY_DIRECTORY_NAME,
    createHash("sha256").update(id).digest("hex"),
  );
}

function fileMode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

function createStore(options: { profileRoot?: string; now?: () => number } = {}) {
  const profileRoot = options.profileRoot ?? createProfileRoot();
  return {
    profileRoot,
    store: new FileDictationRecordingStore({
      profileRoot,
      now: options.now,
    }),
  };
}

async function createCompletedRecording(input: {
  store: FileDictationRecordingStore;
  id: string;
  transcript?: string;
}) {
  await input.store.create({
    id: input.id,
    mimeType: "audio/webm;codecs=opus",
    surface: "composer",
  });
  await input.store.append({ id: input.id, chunk: new Uint8Array([1]) });
  await input.store.finalize({ id: input.id, durationMs: 300, status: "completed" });
  if (input.transcript) {
    await input.store.setTranscript({ id: input.id, transcript: input.transcript });
  }
}

describe("FileDictationRecordingStore", () => {
  test("durably creates, appends, finalizes, lists, reads, and updates a recording", async () => {
    let nowMs = 1_000;
    const { profileRoot, store } = createStore({ now: () => nowMs });
    const id = "session:primary";

    await store.create({
      id,
      mimeType: "audio/webm;codecs=opus",
      surface: "composer",
    });
    await Promise.all([
      store.append({ id, chunk: new Uint8Array([1, 2]) }),
      store.append({ id, chunk: new Uint8Array([3]) }),
    ]);
    nowMs = 2_000;
    await store.finalize({ id, durationMs: 750, status: "completed" });
    const updated = await store.setTranscript({ id, transcript: "Hello world" });

    expect(updated).toMatchObject({
      id,
      chunkCount: 2,
      durationMs: 750,
      sizeBytes: 3,
      status: "completed",
      transcript: "Hello world",
    });
    expect(await store.list()).toEqual([updated]);
    expect(await store.readAudio(id)).toEqual({
      recording: updated,
      bytes: new Uint8Array([1, 2, 3]),
    });

    const historyRoot = path.join(profileRoot, DICTATION_HISTORY_DIRECTORY_NAME);
    const recordRoot = recordingDirectory(profileRoot, id);
    expect(fs.readdirSync(recordRoot).sort()).toEqual([
      "0000000000.chunk",
      "0000000001.chunk",
      "metadata.json",
    ]);
    expect(fileMode(historyRoot)).toBe(0o700);
    expect(fileMode(recordRoot)).toBe(0o700);
    expect(fileMode(path.join(recordRoot, "metadata.json"))).toBe(0o600);
    expect(fileMode(path.join(recordRoot, "0000000000.chunk"))).toBe(0o600);
  });

  test("recovers durable orphan chunks, removes temporary files, and interrupts a crashed session", async () => {
    let nowMs = 1_000;
    const first = createStore({ now: () => nowMs });
    const id = "session:recover";
    await first.store.create({ id, mimeType: "audio/webm", surface: "global" });
    await first.store.append({ id, chunk: new Uint8Array([1, 2]) });

    const recordRoot = recordingDirectory(first.profileRoot, id);
    fs.writeFileSync(path.join(recordRoot, "0000000001.chunk"), new Uint8Array([3, 4]), {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(recordRoot, ".0000000002.chunk.123.partial.tmp"), "partial", {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(recordRoot, ".metadata.json.123.partial.tmp"), "partial", {
      mode: 0o600,
    });
    const abandonedDirectory = path.join(
      first.profileRoot,
      DICTATION_HISTORY_DIRECTORY_NAME,
      "a".repeat(64),
    );
    fs.mkdirSync(abandonedDirectory, { mode: 0o700 });
    fs.writeFileSync(path.join(abandonedDirectory, ".metadata.json.123.abandoned.tmp"), "partial", {
      mode: 0o600,
    });

    nowMs = 5_000;
    const restarted = createStore({ profileRoot: first.profileRoot, now: () => nowMs });
    const [recovered] = await restarted.store.list();

    expect(recovered).toMatchObject({
      id,
      chunkCount: 2,
      sizeBytes: 4,
      status: "interrupted",
      updatedAtMs: 5_000,
    });
    expect(await restarted.store.readAudio(id)).toMatchObject({
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    expect(fs.readdirSync(recordRoot).some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(fs.existsSync(abandonedDirectory)).toBe(false);
  });

  test("rejects deleting an active recording and permits deletion after finalization", async () => {
    const { profileRoot, store } = createStore();
    const id = "session:active";
    await store.create({ id, mimeType: "audio/webm", surface: "composer" });

    await expect(store.delete(id)).rejects.toMatchObject({
      code: "active_recording_conflict",
    });
    expect(fs.existsSync(recordingDirectory(profileRoot, id))).toBe(true);

    await store.finalize({ id, durationMs: 0, status: "cancelled" });
    await store.delete(id);
    expect(await store.list()).toEqual([]);
    expect(fs.existsSync(recordingDirectory(profileRoot, id))).toBe(false);
  });

  test("retains the newest twenty inactive recordings without deleting active sessions", async () => {
    let nowMs = 0;
    const { profileRoot, store } = createStore({ now: () => nowMs });
    const activeId = "session:still-active";
    await store.create({ id: activeId, mimeType: "audio/webm", surface: "composer" });

    for (let index = 0; index <= DICTATION_HISTORY_MAX_RECORDINGS; index += 1) {
      nowMs = index + 1;
      await createCompletedRecording({ store, id: `session:completed-${index}` });
    }

    const recordings = await store.list();
    const inactive = recordings.filter((recording) => recording.status !== "recording");
    expect(inactive).toHaveLength(DICTATION_HISTORY_MAX_RECORDINGS);
    expect(recordings.some((recording) => recording.id === activeId)).toBe(true);
    expect(recordings.some((recording) => recording.id === "session:completed-0")).toBe(false);
    expect(fs.existsSync(recordingDirectory(profileRoot, activeId))).toBe(true);
    expect(fs.existsSync(recordingDirectory(profileRoot, "session:completed-0"))).toBe(false);
  });

  test("enforces chunk and identity bounds before writing", async () => {
    const { profileRoot, store } = createStore();
    await expect(
      store.create({ id: "../../escape", mimeType: "audio/webm", surface: "composer" }),
    ).rejects.toBeInstanceOf(DictationRecordingStoreError);
    expect(fs.existsSync(path.join(profileRoot, "escape"))).toBe(false);

    const id = "session:bounded";
    await store.create({ id, mimeType: "audio/webm", surface: "composer" });
    await expect(store.append({ id, chunk: new Uint8Array() })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(
      store.append({ id, chunk: new Uint8Array(DICTATION_HISTORY_MAX_CHUNK_BYTES + 1) }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(fs.readdirSync(recordingDirectory(profileRoot, id))).toEqual(["metadata.json"]);
  });

  test("fails closed for symlinked history roots and recording directories", async () => {
    const profileRoot = createProfileRoot();
    const outsideRoot = createProfileRoot();
    fs.symlinkSync(outsideRoot, path.join(profileRoot, DICTATION_HISTORY_DIRECTORY_NAME), "dir");

    await expect(new FileDictationRecordingStore({ profileRoot }).list()).rejects.toMatchObject({
      code: "unsafe_path",
    });

    fs.unlinkSync(path.join(profileRoot, DICTATION_HISTORY_DIRECTORY_NAME));
    fs.mkdirSync(path.join(profileRoot, DICTATION_HISTORY_DIRECTORY_NAME), { mode: 0o700 });
    const id = "session:symlink";
    const outsideRecord = path.join(outsideRoot, "outside-record");
    fs.mkdirSync(outsideRecord, { mode: 0o700 });
    fs.writeFileSync(path.join(outsideRecord, "sentinel"), "do not read");
    fs.symlinkSync(outsideRecord, recordingDirectory(profileRoot, id), "dir");

    await expect(new FileDictationRecordingStore({ profileRoot }).list()).rejects.toMatchObject({
      code: "unsafe_path",
    });
    expect(fs.readFileSync(path.join(outsideRecord, "sentinel"), "utf8")).toBe("do not read");
  });

  test("fails closed when finalized chunk numbering is no longer continuous", async () => {
    const first = createStore();
    const id = "session:gap";
    await createCompletedRecording({ store: first.store, id });
    const recordRoot = recordingDirectory(first.profileRoot, id);
    fs.renameSync(
      path.join(recordRoot, "0000000000.chunk"),
      path.join(recordRoot, "0000000001.chunk"),
    );

    const restarted = createStore({ profileRoot: first.profileRoot });
    await expect(restarted.store.list()).rejects.toMatchObject({
      code: "invalid_recording",
    });
  });

  test("rejects strict metadata corruption instead of exposing private paths", async () => {
    const first = createStore();
    const id = "session:metadata";
    await createCompletedRecording({ store: first.store, id });
    const metadataPath = path.join(recordingDirectory(first.profileRoot, id), "metadata.json");
    const metadata = JSON.parse(
      fs.readFileSync(metadataPath, "utf8"),
    ) as DictationRecordingMetadata;
    fs.writeFileSync(
      metadataPath,
      JSON.stringify({ ...metadata, sourcePath: "/private/audio.webm" }),
      { mode: 0o600 },
    );

    await expect(
      createStore({ profileRoot: first.profileRoot }).store.list(),
    ).rejects.toMatchObject({ code: "invalid_recording" });
  });
});

test("persists isolated diagnostics, rejects extra fields, and ignores a late older attempt", async () => {
  const { store, profileRoot } = createStore();
  await createCompletedRecording({ store, id: "diagnostics", transcript: "private transcript" });
  const diagnostics = dictationDiagnosticsFixture();
  await store.setDiagnostics({ id: "diagnostics", diagnostics });
  const [first] = await store.list();
  first!.diagnostics!.phases[0]!.durationMs = 999;
  expect((await store.list())[0]?.diagnostics).toEqual(diagnostics);
  await expect(
    store.setDiagnostics({
      id: "diagnostics",
      diagnostics: { ...diagnostics, token: "secret" } as typeof diagnostics,
    }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await store.setDiagnostics({ id: "diagnostics", diagnostics: { ...diagnostics, attempt: 2 } });
  await store.setDiagnostics({ id: "diagnostics", diagnostics });
  const reopened = new FileDictationRecordingStore({ profileRoot });
  expect((await reopened.list())[0]?.diagnostics?.attempt).toBe(2);
});
