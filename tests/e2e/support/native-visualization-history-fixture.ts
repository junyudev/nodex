import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { parseBundledAgentRuntimeMetadata } from "../../../src/shared/codex-runtime-metadata";
import { createNativeTranscriptFixtureClient } from "./native-transcript-benchmark-client";

const rowSchema = z
  .object({
    type: z.string(),
    ordinal: z.number().int().optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export async function resolveNativeVisualizationFixtureRuntime(repositoryRoot: string) {
  const root = path.join(
    repositoryRoot,
    process.arch === "x64"
      ? ".generated/codex-runtime-x64/agent-runtime"
      : ".generated/codex-runtime/agent-runtime",
  );
  const metadata = parseBundledAgentRuntimeMetadata(
    JSON.parse(await readFile(path.join(root, "agent-runtime.json"), "utf8")),
  );
  if (!metadata) throw new Error("Native visualization runtime metadata is invalid");
  const lock = z
    .object({ appServerRuntimeVersion: z.string(), upstream: z.object({ commit: z.string() }) })
    .parse(
      JSON.parse(
        await readFile(
          path.join(repositoryRoot, "resources/agent-runtime/codex-app-server.lock.json"),
          "utf8",
        ),
      ),
    );
  if (
    metadata.appServerRuntimeVersion !== lock.appServerRuntimeVersion ||
    metadata.sourceRevision.commit !== lock.upstream.commit
  )
    throw new Error("Native visualization runtime does not match the repository pin");
  const executable = path.join(root, metadata.entrypoint);
  const digest = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex");
  if (digest !== metadata.releaseAsset.entrypointSha256)
    throw new Error("Native visualization runtime bytes do not match the verified entrypoint");
  return { executable, version: metadata.appServerRuntimeVersion, sha256: digest };
}

/** Preserve native checkpoint offsets, then append historical lifecycle events; never execute a Turn. */
export async function seedNativeVisualizationHistory(input: {
  readonly executable: string;
  readonly codexHome: string;
  readonly cwd: string;
  readonly title: string;
  readonly answer: string;
  readonly turnId: string;
}) {
  const creator = await createNativeTranscriptFixtureClient(input);
  let nativeThread: Awaited<ReturnType<typeof creator.call<"thread/start">>>["thread"];
  try {
    nativeThread = (
      await creator.call(
        "thread/start",
        { cwd: input.cwd, ephemeral: false, approvalPolicy: "never", sandbox: "workspace-write" },
        "empty-thread-fixture",
      )
    ).thread;
    await creator.call(
      "thread/name/set",
      { threadId: nativeThread.id, name: input.title },
      "fixture-title",
    );
  } finally {
    await creator.close();
  }
  const sessionRoot = path.join(input.codexHome, "sessions");
  const candidates = nativeThread.path
    ? [nativeThread.path]
    : (await readdir(sessionRoot, { recursive: true }))
        .filter((name) => name.includes(nativeThread.id) && name.endsWith(".jsonl"))
        .map((name) => path.join(sessionRoot, name));
  if (candidates.length !== 1) throw new Error("The native Thread did not create one rollout");
  const rollout = path.resolve(candidates[0]!);
  if (!rollout.startsWith(`${path.resolve(sessionRoot)}${path.sep}`))
    throw new Error("Native fixture rollout escaped its disposable home");
  const prefix = await readFile(rollout);
  const lines = prefix
    .toString("utf8")
    .split(/(?<=\n)/u)
    .filter(Boolean);
  const records = lines.map((line) => rowSchema.parse(JSON.parse(line)));
  const metaIndex = records.findIndex((row) => row.type === "session_meta");
  if (metaIndex < 0) throw new Error("Native fixture has no session metadata");
  const changed = JSON.stringify({
    ...records[metaIndex],
    payload: { ...records[metaIndex]!.payload, source: "cli" },
  });
  const previous = lines[metaIndex]!.replace(/[\r\n]+$/u, "");
  const padding = Buffer.byteLength(previous) - Buffer.byteLength(changed);
  if (padding < 0) throw new Error("Native fixture source classification would move a checkpoint");
  lines[metaIndex] = changed + " ".repeat(padding) + lines[metaIndex]!.slice(previous.length);
  const preserved = Buffer.from(lines.join(""));
  if (preserved.byteLength !== prefix.byteLength)
    throw new Error("Native fixture moved a prefix checkpoint");
  await writeFile(rollout, preserved);
  let ordinal = Math.max(-1, ...records.map((row) => row.ordinal ?? -1)) + 1;
  const started = Math.floor(Date.now() / 1000);
  const event = (payload: object) =>
    JSON.stringify({
      timestamp: new Date(started * 1000).toISOString(),
      ordinal: ordinal++,
      type: "event_msg",
      payload,
    }) + "\n";
  await appendFile(
    rollout,
    [
      event({
        type: "turn_started",
        turn_id: input.turnId,
        root_turn_id: input.turnId,
        started_at: started,
        model_context_window: 100_000,
        collaboration_mode_kind: "default",
      }),
      event({
        type: "item_completed",
        thread_id: nativeThread.id,
        turn_id: input.turnId,
        started_at_ms: started * 1000,
        completed_at_ms: (started + 1) * 1000,
        item: {
          type: "UserMessage",
          id: `${input.turnId}-user`,
          content: [{ type: "text", text: input.title, text_elements: [] }],
        },
      }),
      event({
        type: "item_completed",
        thread_id: nativeThread.id,
        turn_id: input.turnId,
        started_at_ms: started * 1000,
        completed_at_ms: (started + 1) * 1000,
        item: {
          type: "AgentMessage",
          id: `${input.turnId}-answer`,
          content: [{ type: "Text", text: input.answer }],
          phase: "final_answer",
        },
      }),
      event({
        type: "turn_complete",
        turn_id: input.turnId,
        root_turn_id: input.turnId,
        last_agent_message: null,
        started_at: started,
        completed_at: started + 1,
        duration_ms: 1000,
      }),
    ].join(""),
  );
  const adopter = await createNativeTranscriptFixtureClient(input);
  try {
    await adopter.call(
      "thread/resume",
      { threadId: nativeThread.id, excludeTurns: true },
      "history-adoption",
    );
    const items = await adopter.call(
      "thread/items/list",
      { threadId: nativeThread.id, turnId: input.turnId, limit: 10, sortDirection: "asc" },
      "history-verification",
    );
    const answer = items.data.find((entry) => entry.item.type === "agentMessage")?.item;
    if (items.data.length !== 2 || answer?.type !== "agentMessage" || answer.text !== input.answer)
      throw new Error("Official native projection did not accept the HTML history fixture");
  } finally {
    await adopter.close();
  }
  return {
    threadId: nativeThread.id,
    title: input.title,
    rollout,
    nativePrefixBytes: prefix.byteLength,
    creatorPid: creator.pid,
    adopterPid: adopter.pid,
    requests: [...creator.samples, ...adopter.samples],
  };
}
