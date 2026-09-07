import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { archiveConversation } from "./conversation";

test("archives exact native bytes and provenance independently of the source Profile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eval-conversation-"));
  try {
    const home = path.join(root, "agent");
    const sessions = path.join(home, "sessions/2026/09/07");
    const output = path.join(root, "report");
    await mkdir(sessions, { recursive: true });
    await mkdir(output);
    const contents = Buffer.from(
      '{"type":"session_meta","payload":{"id":"task-1"}}\n{"type":"response_item","payload":{"text":"你好","command":"cat data | jq ."}}\n{"partial":',
    );
    await writeFile(path.join(sessions, "rollout-date-task-1.jsonl"), contents);
    const metadata = await archiveConversation(home, "task-1", output);
    await rm(home, { recursive: true });
    expect(await readFile(path.join(output, "conversation.jsonl"))).toEqual(contents);
    expect(metadata).toMatchObject({
      threadId: "task-1",
      bytes: contents.length,
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
    expect(
      JSON.parse(await readFile(path.join(output, "conversation.metadata.json"), "utf8")),
    ).toEqual(metadata);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a matching filename whose session belongs to a different task", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eval-conversation-"));
  try {
    await mkdir(path.join(root, "sessions"));
    await writeFile(
      path.join(root, "sessions/rollout-date-task-1.jsonl"),
      '{"type":"session_meta","payload":{"id":"other-task"}}\n',
    );
    await expect(archiveConversation(root, "task-1", root)).rejects.toThrow(
      "No native conversation log",
    );
    await expect(readFile(path.join(root, "conversation.jsonl"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
