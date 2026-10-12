import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  canonicalBundledAgentRuntimeMetadataJson,
  parseBundledAgentRuntimeMetadata,
} from "../../../src/shared/codex-runtime-metadata";
import { buildTranscriptPerformanceCorpus } from "./transcript-performance-corpus";

const corpusSchema = z.object({
  corpus: z.enum(["short", "long"]),
  threadId: z.string().uuid(),
  rolloutPath: z.string(),
  workspace: z.string(),
  turnCount: z.number().int().positive(),
  itemCount: z.number().int().positive(),
  nativePrefixRecordCount: z.number().int().positive(),
  syntheticEventRecordCount: z.number().int().positive(),
  textSha256: z.string().length(64),
  textByteCount: z.number().int().positive(),
});
export type NativeBenchmarkCorpus = z.infer<typeof corpusSchema>;
const manifestSchema = z.object({
  binary: z.string(),
  nativeVersion: z.string(),
  corpora: z.array(corpusSchema).length(2),
});
const lockSchema = z.object({
  appServerRuntimeVersion: z.string(),
  upstream: z.object({
    commit: z.string(),
    tag: z.string(),
    repository: z.literal("openai/codex"),
  }),
  builds: z.record(
    z.string(),
    z.object({
      archiveSha256: z.string(),
      entrypointSha256: z.string(),
      runtimeMetadataSha256: z.string(),
      targetTriple: z.string(),
    }),
  ),
});

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
async function fileSha256(file: string, endExclusive?: number): Promise<string> {
  const hash = createHash("sha256");
  for await (const buffer of createReadStream(
    file,
    endExclusive === undefined ? {} : { end: endExclusive - 1 },
  ))
    hash.update(buffer);
  return hash.digest("hex");
}

async function codeSignatureBoundary(file: string) {
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(32);
    await handle.read(header, 0, header.byteLength, 0);
    if (header.readUInt32LE(0) !== 0xfeedfacf)
      throw new Error("Expected a thin 64-bit Mach-O executable");
    const commandCount = header.readUInt32LE(16);
    const commandBytes = header.readUInt32LE(20);
    if (commandBytes > 1_048_576 || commandCount > commandBytes / 8)
      throw new Error("Invalid Mach-O load commands");
    const commands = Buffer.alloc(commandBytes);
    await handle.read(commands, 0, commandBytes, 32);
    let offset = 0;
    for (let index = 0; index < commandCount; index++) {
      if (offset + 8 > commandBytes) throw new Error("Truncated Mach-O load command");
      const cmd = commands.readUInt32LE(offset);
      const size = commands.readUInt32LE(offset + 4);
      if (size < 8 || offset + size > commandBytes)
        throw new Error("Invalid Mach-O load command size");
      if (cmd === 0x1d && size >= 16)
        return {
          offset: commands.readUInt32LE(offset + 8),
          size: commands.readUInt32LE(offset + 12),
        };
      offset += size;
    }
    throw new Error("Native executable has no code signature command");
  } finally {
    await handle.close();
  }
}

async function referenceNativeExecutable(entrypoint: string) {
  const entry = await realpath(entrypoint);
  const size = (await stat(entry)).size;
  if (size > 4_096) return { entrypoint: entry, executable: entry, wrapperSha256: null };
  const bytes = await readFile(entry);
  requireEqual(
    sha256(bytes),
    "50ab38ba21d0d9f8346f32f41848382f15b556190f3c7a07e885a4fb73e379c8",
    "fixed reference filesystem forwarder",
  );
  if (!bytes.toString("utf8").includes('exec "$bin_dir/../CodexCLI.app/Contents/MacOS/codex" "$@"'))
    throw new Error("Unsupported reference native launcher");
  return {
    entrypoint: entry,
    executable: await realpath(
      path.resolve(path.dirname(entry), "../CodexCLI.app/Contents/MacOS/codex"),
    ),
    wrapperSha256: sha256(bytes),
  };
}
const requireEqual = (actual: unknown, expected: unknown, label: string) => {
  if (actual !== expected) throw new Error(`Native benchmark preflight mismatch: ${label}`);
};

/** Static-only pin/byte/identity verification. This never spawns a process or reads credentials. */
export async function verifyNativeTranscriptBenchmarkInputs(
  repositoryRoot: string,
  corpusDirectory: string,
) {
  const lockBytes = await readFile(
    path.join(repositoryRoot, "resources/agent-runtime/codex-app-server.lock.json"),
  );
  const lock = lockSchema.parse(JSON.parse(lockBytes.toString("utf8")));
  const target = `${process.platform}-${process.arch}`;
  const build = lock.builds[target];
  if (!build) throw new Error(`No official native runtime pin for ${target}`);
  const runtimeRoot = path.join(
    repositoryRoot,
    process.arch === "x64"
      ? ".generated/codex-runtime-x64/agent-runtime"
      : ".generated/codex-runtime/agent-runtime",
  );
  const metadataBytes = await readFile(path.join(runtimeRoot, "agent-runtime.json"));
  const metadata = parseBundledAgentRuntimeMetadata(JSON.parse(metadataBytes.toString("utf8")));
  if (!metadata) throw new Error("Invalid official runtime metadata");
  requireEqual(metadata.appServerRuntimeVersion, lock.appServerRuntimeVersion, "version");
  requireEqual(metadata.sourceRevision.commit, lock.upstream.commit, "upstream commit");
  requireEqual(metadata.sourceRevision.tag, lock.upstream.tag, "upstream tag");
  requireEqual(metadata.releaseAsset.archiveSha256, build.archiveSha256, "release archive");
  const canonicalMetadataSha256 = sha256(canonicalBundledAgentRuntimeMetadataJson(metadata));
  requireEqual(canonicalMetadataSha256, build.runtimeMetadataSha256, "canonical runtime metadata");
  const executable = path.join(runtimeRoot, metadata.entrypoint);
  const executableSha256 = await fileSha256(executable);
  requireEqual(executableSha256, build.entrypointSha256, "native binary");
  const manifestBytes = await readFile(path.join(corpusDirectory, "manifest.json"));
  const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  requireEqual(manifest.nativeVersion, lock.appServerRuntimeVersion, "reference native version");
  const reference = await referenceNativeExecutable(manifest.binary);
  const referenceBinarySha256 = await fileSha256(reference.executable);
  const signature = await codeSignatureBoundary(executable);
  const referenceSignature = await codeSignatureBoundary(reference.executable);
  const executableBytes = (await stat(executable)).size;
  const referenceBytes = (await stat(reference.executable)).size;
  requireEqual(
    signature.offset + signature.size,
    executableBytes,
    "official signature is the exact trailing region",
  );
  requireEqual(
    referenceSignature.offset + referenceSignature.size,
    referenceBytes,
    "reference signature is the exact trailing region",
  );
  requireEqual(referenceSignature.offset, signature.offset, "signature boundary");
  requireEqual(referenceBytes, executableBytes, "reference native byte count");
  const beforeSignatureSha256 = await fileSha256(executable, signature.offset);
  requireEqual(
    await fileSha256(reference.executable, referenceSignature.offset),
    beforeSignatureSha256,
    "all reference bytes before signature",
  );
  const verifiedCorpora = [];
  for (const corpus of manifest.corpora) {
    const expectedCount = corpus.corpus === "short" ? 10 : 10_000;
    requireEqual(corpus.turnCount, expectedCount, "corpus Turn count");
    requireEqual(corpus.itemCount, expectedCount * 2, "corpus item count");
    const bytes = await readFile(corpus.rolloutPath);
    const records = bytes
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    const eventSchema = z.object({ payload: z.record(z.string(), z.unknown()) });
    const events = records
      .slice(
        corpus.nativePrefixRecordCount,
        corpus.nativePrefixRecordCount + corpus.syntheticEventRecordCount,
      )
      .map((value) => eventSchema.parse(value).payload);
    const turns = buildTranscriptPerformanceCorpus(corpus.turnCount);
    requireEqual(events.length, turns.length * 4, "native event count");
    const textHash = createHash("sha256");
    let textByteCount = 0;
    for (const [index, turn] of turns.entries()) {
      const [start, user, answer, complete] = events.slice(index * 4, index * 4 + 4);
      if (!start || !user || !answer || !complete)
        throw new Error("Incomplete synthetic native Turn");
      requireEqual(start.type, "turn_started", "native Turn start");
      requireEqual(complete.type, "turn_complete", "native Turn completion");
      for (const event of [start, user, answer, complete])
        requireEqual(event.turn_id, turn.id, "native Turn ID");
      const itemSchema = z.object({
        id: z.string(),
        content: z.array(z.object({ text: z.string() })),
      });
      const nativeUser = itemSchema.parse(user.item);
      const nativeAnswer = itemSchema.parse(answer.item);
      const generatedUser = turn.items[0];
      const generatedAnswer = turn.items[1];
      if (
        generatedUser?.type !== "userMessage" ||
        generatedAnswer?.type !== "agentMessage" ||
        generatedUser.content[0]?.type !== "text"
      )
        throw new Error("Unexpected benchmark corpus shape");
      requireEqual(nativeUser.id, generatedUser.id, "native user item ID");
      requireEqual(nativeAnswer.id, generatedAnswer.id, "native assistant item ID");
      requireEqual(nativeUser.content[0]?.text, generatedUser.content[0].text, "native user text");
      requireEqual(nativeAnswer.content[0]?.text, generatedAnswer.text, "native assistant text");
      const userText = nativeUser.content[0]!.text;
      const answerText = nativeAnswer.content[0]!.text;
      textHash.update(`${JSON.stringify([index, userText, answerText])}\n`);
      textByteCount += Buffer.byteLength(userText) + Buffer.byteLength(answerText);
    }
    const textSha256 = textHash.digest("hex");
    requireEqual(textSha256, corpus.textSha256, "native text SHA");
    requireEqual(textByteCount, corpus.textByteCount, "native text bytes");
    if (!(await stat(corpus.workspace)).isDirectory())
      throw new Error("Native corpus workspace is unavailable");
    verifiedCorpora.push({
      ...corpus,
      rolloutSha256: sha256(bytes),
      rolloutBytes: bytes.byteLength,
      textSha256,
      byteCopyOnly: true,
    });
  }
  return {
    runtime: {
      executable,
      runtimeRoot,
      target,
      version: lock.appServerRuntimeVersion,
      upstreamCommit: lock.upstream.commit,
      executableSha256,
      referenceBinarySha256,
      referenceExecutable: reference.executable,
      referenceWrapperSha256: reference.wrapperSha256,
      fullFileBytesEqual: referenceBinarySha256 === executableSha256,
      signature,
      allBytesBeforeSignatureEqual: true,
      beforeSignatureSha256,
      canonicalMetadataSha256,
      metadataFileSha256: sha256(metadataBytes),
      lockSha256: sha256(lockBytes),
      releaseArchiveSha256: build.archiveSha256,
    },
    manifestSha256: sha256(manifestBytes),
    corpora: verifiedCorpora,
  };
}

/** Override inherited test/private configuration at launch without inspecting any values. */
export function nativeReadOnlyBenchmarkEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const denied = new Set([
    "CODEX_SQLITE_HOME",
    "NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT",
    "NODEX_NATIVE_TRANSCRIPT_AUTH_FILE",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CHATGPT_AUTH_TOKEN",
    "OPENAI_ORG_ID",
    "OPENAI_BASE_URL",
    "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
  ]);
  for (const key of Object.keys(environment))
    if (
      key.startsWith("NODEX_FAKE_CODEX_") ||
      /^(?:OPENAI|CODEX|CHATGPT)_.*(?:KEY|TOKEN|AUTH_FILE|BASE_URL|ORG_ID)$/.test(key)
    )
      denied.add(key);
  return Object.fromEntries([...denied].map((key) => [key, undefined]));
}
