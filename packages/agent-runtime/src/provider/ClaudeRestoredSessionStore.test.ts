import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { createClaudeRestoredSessionStores } from "./ClaudeRestoredSessionStore.ts";

const id = "11111111-1111-7111-8111-111111111111";
const key = { projectKey: "old-project", sessionId: id };
const roots: string[] = [];
const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nodex-claude-store-"));
  roots.push(root);
  await mkdir(path.join(root, "projects", key.projectKey), { recursive: true });
  return { root, store: createClaudeRestoredSessionStores()(root) };
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("retains complete native entries and subagent metadata after a workspace moves", async () => {
  const { root, store } = await fixture();
  const entry = {
    type: "assistant",
    uuid: "message:first",
    sessionId: id,
    message: { content: "complete history ".repeat(100_000) },
  };
  await store.append(key, [entry]);
  const children = path.join(root, "projects", key.projectKey, id, "subagents");
  await mkdir(children, { recursive: true });
  await writeFile(
    path.join(children, "agent-child.jsonl"),
    JSON.stringify({
      type: "assistant",
      uuid: "child:message",
      message: { role: "assistant", content: [{ type: "text", text: "native child report" }] },
    }) + "\n",
  );
  await writeFile(
    path.join(children, "agent-child.meta.json"),
    JSON.stringify({ toolUseId: "tool:launch", parentAgentId: null }),
  );
  const moved = { ...key, projectKey: "new-workspace" };
  expect(await store.load(moved)).toEqual([entry]);
  expect(await store.listSubkeys?.(moved)).toEqual(["subagents/agent-child"]);
  expect((await store.load({ ...moved, subpath: "subagents/agent-child" }))?.at(-1)).toEqual({
    type: "agent_metadata",
    toolUseId: "tool:launch",
    parentAgentId: null,
  });
  await store.append(moved, [{ type: "user", uuid: "message:next", sessionId: id }]);
  expect((await store.load(moved))?.map((entry) => entry.uuid)).toEqual([
    "message:first",
    "message:next",
  ]);
  expect(
    await ClaudeSdk.getSubagentMessages(id, "child", {
      dir: "/new/workspace",
      sessionStore: store,
    }),
  ).toMatchObject([
    { parent_tool_use_id: "tool:launch", message: { content: [{ text: "native child report" }] } },
  ]);
});

it("serializes concurrent mirrors, deduplicates retries, and supports the real SDK fork", async () => {
  const { store } = await fixture();
  const first = {
    type: "user",
    uuid: "message:first",
    sessionId: id,
    parentUuid: null,
    message: { role: "user", content: "original" },
  };
  const second = {
    type: "assistant",
    uuid: "message:second",
    sessionId: id,
    parentUuid: first.uuid,
    message: { role: "assistant", content: [{ type: "text", text: "reply" }] },
  };
  await Promise.all([
    store.append(key, [first]),
    store.append(key, [first, second]),
    store.append(key, [second]),
  ]);
  expect(await store.load(key)).toEqual([first, second]);
  const forked = await ClaudeSdk.forkSession(id, { dir: "/old/project", sessionStore: store });
  expect(forked.sessionId).not.toBe(id);
  const fork = await store.load({ ...key, sessionId: forked.sessionId });
  expect(
    fork
      ?.filter((entry) => entry.type === "user" || entry.type === "assistant")
      .map((entry) => entry.message),
  ).toEqual([first.message, second.message]);
});

it("requires captured history for managed resume and counts entries without UUIDs toward admission", async () => {
  const { root, store } = await fixture();
  const required = createClaudeRestoredSessionStores()(root, id);
  await expect(required.load(key)).rejects.toThrow("history is unavailable");
  await store.append(key, [{ type: "user", message: { content: "captured" } }]);
  expect(await required.load(key)).toEqual([{ type: "user", message: { content: "captured" } }]);
  await expect(
    store.append(
      key,
      Array.from({ length: 250_000 }, () => ({ type: "system" })),
    ),
  ).rejects.toThrow("native persistence boundary");
  expect(await required.load(key)).toHaveLength(1);
});

it("rejects traversal and file or directory aliases instead of reading outside managed history", async () => {
  const { root, store } = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "nodex-claude-outside-"));
  roots.push(outside);
  await writeFile(
    path.join(outside, "secret.jsonl"),
    JSON.stringify({ type: "user", text: "outside" }),
  );
  await symlink(
    path.join(outside, "secret.jsonl"),
    path.join(root, "projects", key.projectKey, `${id}.jsonl`),
  );
  await expect(store.load(key)).rejects.toBeDefined();
  await expect(store.load({ ...key, projectKey: "../outside" })).rejects.toBeDefined();
  await expect(
    store.append({ ...key, subpath: "../outside" }, [{ type: "user" }]),
  ).rejects.toBeDefined();
  await symlink(outside, path.join(root, "projects", "foreign-project"), "dir");
  await expect(store.load({ ...key, projectKey: "foreign-project" })).rejects.toBeDefined();
});
