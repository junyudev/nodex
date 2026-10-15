/* @effect-diagnostics asyncFunction:off -- SessionStore is the SDK's Promise-based persistence boundary. */
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const MAX_SESSION_BYTES = 128 * 1024 * 1024;
const MAX_RECORDS = 250_000;
const MAX_PROJECTS = 10_000;
const segment = /^[A-Za-z0-9_-]{1,256}$/;
const absent = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
const validateSegment = (value: string) => {
  if (!segment.test(value)) throw new Error("Invalid restored Claude history key.");
  return value;
};
const suffix = (key: SessionKey) => {
  validateSegment(key.projectKey);
  validateSegment(key.sessionId);
  if (key.subpath === undefined) return [`${key.sessionId}.jsonl`];
  const parts = key.subpath.split("/").map(validateSegment);
  if (parts.length > 32)
    throw new Error("Restored Claude subagent history exceeds its path bound.");
  return [key.sessionId, ...parts.slice(0, -1), `${parts.at(-1)!}.jsonl`];
};

async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function directory(
  root: string,
  parts: readonly string[],
  create = false,
): Promise<string | null> {
  let selected = root;
  for (const part of ["", ...parts]) {
    selected = path.join(selected, part);
    if (create) {
      const created = await fs
        .mkdir(selected, { mode: 0o700 })
        .then(() => true)
        .catch((cause: unknown) => {
          if (
            typeof cause !== "object" ||
            cause === null ||
            !("code" in cause) ||
            cause.code !== "EEXIST"
          )
            throw cause;
          return false;
        });
      if (created) await syncDirectory(path.dirname(selected));
    }
    const stat = await fs.lstat(selected).catch((cause: unknown) => {
      if (absent(cause)) return null;
      throw cause;
    });
    if (stat === null) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Restored Claude history must use real directories.");
  }
  return selected;
}

async function read(
  file: string,
): Promise<{ entries: SessionStoreEntry[]; bytes: number; stamp: string } | null> {
  const handle = await fs
    .open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch((cause: unknown) => {
      if (absent(cause)) return null;
      throw cause;
    });
  if (handle === null) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_SESSION_BYTES)
      throw new Error("Restored Claude transcript exceeds its safe native resume boundary.");
    const text = await handle.readFile({ encoding: "utf8" });
    const entries: SessionStoreEntry[] = [];
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      const entry: unknown = JSON.parse(line);
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("type" in entry) ||
        typeof entry.type !== "string" ||
        ("uuid" in entry && entry.uuid !== undefined && typeof entry.uuid !== "string")
      )
        throw new Error("Restored Claude transcript contains an invalid native entry.");
      entries.push(entry as SessionStoreEntry);
      if (entries.length > MAX_RECORDS)
        throw new Error("Restored Claude transcript exceeds its native record boundary.");
    }
    return {
      entries,
      bytes: stat.size,
      stamp: `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`,
    };
  } finally {
    await handle.close();
  }
}

/** SDK-local mirror and temporary resume materialization; the configured account remains the auth owner. */
export function createClaudeRestoredSessionStores() {
  const stores = new Map<string, SessionStore>();
  const lanes = new Map<string, Promise<void>>();
  const indices = new Map<string, { stamp: string; records: number; uuids: Map<string, string> }>();
  const hash = (entry: SessionStoreEntry) =>
    createHash("sha256").update(JSON.stringify(entry)).digest("hex");
  const requireSession = (store: SessionStore, sessionId: string | undefined): SessionStore => {
    if (sessionId === undefined) return store;
    validateSegment(sessionId);
    return {
      ...store,
      load: async (key) => {
        const entries = await store.load(key);
        // The SDK otherwise falls back to the auth home's history before spawning the CLI.
        if (key.subpath === undefined && key.sessionId === sessionId && !entries?.length)
          throw new Error("Restored Claude session history is unavailable.");
        return entries;
      },
    };
  };
  return (home: string, requiredSessionId?: string): SessionStore => {
    if (!path.isAbsolute(home) || path.normalize(home) !== home)
      throw new Error("Restored Claude history requires an absolute managed path.");
    const cached = stores.get(home);
    if (cached !== undefined) return requireSession(cached, requiredSessionId);
    if (stores.size >= 256)
      throw new Error("Restored Claude history configuration exceeds its instance boundary.");
    const locate = async (key: SessionKey, create = false) => {
      const tail = suffix(key);
      const project = await directory(home, ["projects", key.projectKey], create);
      const direct = project === null ? null : path.join(project, ...tail);
      if (create) {
        await directory(home, ["projects", key.projectKey, ...tail.slice(0, -1)], true);
        return direct;
      }
      if (
        direct !== null &&
        (await fs.lstat(direct).then(
          () => true,
          (cause: unknown) => {
            if (absent(cause)) return false;
            throw cause;
          },
        ))
      ) {
        await directory(home, ["projects", key.projectKey, ...tail.slice(0, -1)]);
        return direct;
      }
      // A managed workspace can move between Profiles. UUID identity selects one captured project.
      const projects = await directory(home, ["projects"]);
      if (projects === null) return null;
      let selected: string | null = null;
      let count = 0;
      const listed = await fs.opendir(projects);
      for await (const entry of listed) {
        if (++count > MAX_PROJECTS)
          throw new Error("Restored Claude project lookup exceeds its metadata boundary.");
        if (!entry.isDirectory()) continue;
        validateSegment(entry.name);
        const folder = await directory(home, ["projects", entry.name, ...tail.slice(0, -1)]);
        if (folder === null) continue;
        const candidate = path.join(folder, tail.at(-1)!);
        const exists = await fs.lstat(candidate).then(
          () => true,
          (cause: unknown) => {
            if (absent(cause)) return false;
            throw cause;
          },
        );
        if (!exists) continue;
        if (selected !== null)
          throw new Error("Restored Claude session has ambiguous project ownership.");
        selected = candidate;
      }
      return selected;
    };
    const store: SessionStore = {
      load: async (key) => {
        const file = await locate(key);
        if (file === null) return null;
        const result = await read(file);
        if (result === null) return null;
        if (
          key.subpath === undefined ||
          result.entries.some((entry) => entry.type === "agent_metadata")
        )
          return result.entries;
        const metadataFile = file.slice(0, -".jsonl".length) + ".meta.json";
        const metadata = await fs
          .open(metadataFile, constants.O_RDONLY | constants.O_NOFOLLOW)
          .catch((cause: unknown) => {
            if (absent(cause)) return null;
            throw cause;
          });
        if (metadata === null) return result.entries;
        try {
          const stat = await metadata.stat();
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024)
            throw new Error("Restored Claude subagent metadata is invalid.");
          const value: unknown = JSON.parse(await metadata.readFile({ encoding: "utf8" }));
          if (typeof value !== "object" || value === null || Array.isArray(value))
            throw new Error("Restored Claude subagent metadata is invalid.");
          return [...result.entries, { ...value, type: "agent_metadata" }];
        } finally {
          await metadata.close();
        }
      },
      listSubkeys: async (key) => {
        const primary = await locate(key);
        if (primary === null) return [];
        const relative = path.relative(home, primary).split(path.sep).slice(0, -1);
        const session = await directory(home, [...relative, validateSegment(key.sessionId)]);
        if (session === null) return [];
        const pending = [session];
        const keys: string[] = [];
        let inspected = 0;
        while (pending.length > 0) {
          const current = pending.pop()!;
          const listed = await fs.opendir(current);
          for await (const entry of listed) {
            if (++inspected > MAX_RECORDS)
              throw new Error("Restored Claude subagent roster exceeds its metadata boundary.");
            if (entry.isSymbolicLink())
              throw new Error("Restored Claude subagent history must not contain symbolic links.");
            const file = path.join(current, entry.name);
            if (entry.isDirectory()) {
              pending.push(file);
              continue;
            }
            if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
            const subpath = path
              .relative(session, file)
              .slice(0, -".jsonl".length)
              .split(path.sep)
              .join("/");
            suffix({ ...key, subpath });
            keys.push(subpath);
          }
        }
        return keys;
      },
      append: (key, entries) => {
        // One lane covers retries, root messages and native child mirrors for each exact file.
        const laneKey = JSON.stringify([home, key.sessionId, key.subpath]);
        const previous = lanes.get(laneKey) ?? Promise.resolve();
        const next = previous
          .catch(() => undefined)
          .then(async () => {
            const file = (await locate(key)) ?? (await locate(key, true));
            if (file === null)
              throw new Error("Restored Claude history could not create its project directory.");
            const stat = await fs.lstat(file).catch((cause: unknown) => {
              if (absent(cause)) return null;
              throw cause;
            });
            const stamp =
              stat === null ? "" : `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
            let index = indices.get(file);
            if (index?.stamp !== stamp) {
              const existing = await read(file);
              index = {
                stamp,
                records: existing?.entries.length ?? 0,
                uuids: new Map(
                  existing?.entries.flatMap((entry) =>
                    entry.uuid === undefined ? [] : [[entry.uuid, hash(entry)]],
                  ),
                ),
              };
            }
            // Failed persistence cannot poison the retry dedupe evidence.
            index = { ...index, uuids: new Map(index.uuids) };
            const accepted: string[] = [];
            for (const entry of entries) {
              if (
                typeof entry.type !== "string" ||
                (entry.uuid !== undefined && typeof entry.uuid !== "string")
              )
                throw new Error("Claude mirror supplied an invalid transcript entry.");
              const digest = hash(entry);
              if (entry.uuid !== undefined && index.uuids.get(entry.uuid) === digest) continue;
              accepted.push(JSON.stringify(entry) + "\n");
              if (entry.uuid !== undefined) index.uuids.set(entry.uuid, digest);
            }
            if (accepted.length === 0) return;
            const handle = await fs.open(
              file,
              constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
              0o600,
            );
            try {
              const opened = await handle.stat();
              const bytes = accepted.reduce((total, value) => total + Buffer.byteLength(value), 0);
              if (
                !opened.isFile() ||
                opened.nlink !== 1 ||
                opened.size + bytes > MAX_SESSION_BYTES ||
                index.records + accepted.length > MAX_RECORDS
              )
                throw new Error("Claude mirrored history exceeds its native persistence boundary.");
              try {
                for (const text of accepted) await handle.writeFile(text);
                await handle.sync();
                if (stat === null) await syncDirectory(path.dirname(file));
              } catch (cause) {
                await handle.truncate(opened.size);
                await handle.sync();
                throw cause;
              }
              const saved = await handle.stat();
              index.stamp = `${saved.dev}:${saved.ino}:${saved.mtimeMs}:${saved.size}`;
              index.records += accepted.length;
              indices.delete(file);
              if (indices.size >= 4) indices.delete(indices.keys().next().value!);
              indices.set(file, index);
            } finally {
              await handle.close();
            }
          });
        lanes.set(laneKey, next);
        return next.finally(() => {
          if (lanes.get(laneKey) === next) lanes.delete(laneKey);
        });
      },
    };
    stores.set(home, store);
    return requireSession(store, requiredSessionId);
  };
}
