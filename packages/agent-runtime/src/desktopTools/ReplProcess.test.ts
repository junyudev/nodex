// @effect-diagnostics nodeBuiltinImport:off -- exercises real process and lease lifetime
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vite-plus/test";
import { reapDesktopReplProcesses } from "./ReplProcess.ts";

const posix = process.platform === "darwin" || process.platform === "linux";
const groups = () =>
  execFileSync("/bin/ps", ["-ax", "-o", "pid=,pgid=,stat="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((row) => row.trim().split(/\s+/u))
    .filter(([, , status]) => !status?.startsWith("Z"))
    .map(([pid, group]) => ({ pid: Number(pid), group: Number(group) }));

const fixture = fileURLToPath(new URL("./fixtures/repl-owner.ts", import.meta.url));
const startOwner = (home: string, mode: string) =>
  spawn(process.execPath, ["--import", "tsx", fixture, home, mode], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });

it.skipIf(!posix).each(["idle", "in-flight"])(
  "reaps the %s REPL group after SIGKILL and recovers the writer lease",
  async (mode) => {
    const home = await mkdtemp(join(tmpdir(), "nodex-repl-lifetime-"));
    const owner = startOwner(home, mode);
    const exited = once(owner, "exit");
    let group: number | undefined;
    try {
      const [ready] = (await once(owner, "message", {
        signal: AbortSignal.timeout(5_000),
      })) as [{ nodeReplPid: number; kernelPid: number }];
      const directory = join(home, "desktop-repl");
      const [record] = await readdir(directory);
      group = (JSON.parse(await readFile(join(directory, record!), "utf8")) as { group: number })
        .group;
      expect(
        new Set(
          groups()
            .filter((row) => row.group === group)
            .map(({ pid }) => pid),
        ),
      ).toEqual(new Set([group, ready.nodeReplPid, ready.kernelPid]));
      expect(owner.kill("SIGKILL")).toBe(true);
      expect(await exited).toEqual([null, "SIGKILL"]);
      const expectGroupGone = () =>
        expect(groups().filter((row) => row.group === group)).toEqual([]);
      if (mode === "idle") await vi.waitFor(expectGroupGone);
      // For the in-flight case, start a new writer even if the watchdog hasn't finished yet.
      const replacement = startOwner(home, "replacement");
      try {
        expect(await once(replacement, "exit", { signal: AbortSignal.timeout(5_000) })).toEqual([
          0,
          null,
        ]);
      } finally {
        if (replacement.exitCode === null && replacement.signalCode === null)
          replacement.kill("SIGKILL");
      }
      expectGroupGone();
      expect(await readdir(directory)).toEqual([]);
      if (mode === "in-flight")
        expect(await readdir(join(home, "codex", "node_repl", "active_execs"))).toEqual([]);
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
      await exited;
      await rm(home, { recursive: true, force: true });
    }
  },
);

it.skipIf(!posix).each(["exited", "reused", "draining", "leader gone", "leader without argv"])(
  "reaps stale execution records when the watchdog is %s",
  async (state) => {
    const home = await mkdtemp(join(tmpdir(), "nodex-repl-record-"));
    try {
      const directory = join(home, "desktop-repl");
      const codexHome = join(home, "codex");
      const active = join(codexHome, "node_repl", "active_execs");
      const token = randomUUID();
      const sessionId = "a".repeat(64);
      const started = "Wed Nov 11 18:02:42 2026";
      await mkdir(directory);
      await mkdir(active, { recursive: true });
      await writeFile(
        join(directory, token + ".json"),
        JSON.stringify({ token, group: 123, started, sessionId, codexHome }),
      );
      await writeFile(join(directory, token + ".json.tmp"), "incomplete");
      await writeFile(join(active, "stale.json"), JSON.stringify({ sessionId, nodeReplPid: 234 }));
      await writeFile(join(active, "live.json"), JSON.stringify({ sessionId, nodeReplPid: 345 }));
      await writeFile(
        join(active, "other.json"),
        JSON.stringify({ sessionId: "other", nodeReplPid: 234 }),
      );
      const live = [{ pid: 345, group: 345, started, args: "live REPL" }];
      const snapshot = vi.fn(async () => live);
      if (state === "reused")
        snapshot.mockResolvedValue([
          ...live,
          { pid: 123, group: 123, started: "Wed Nov 11 18:03:42 2026", args: "unrelated" },
        ]);
      const draining = state !== "exited" && state !== "reused";
      const members = [...live, { pid: 234, group: 123, started, args: "old REPL" }];
      if (state === "draining")
        members.push({
          pid: 123,
          group: 123,
          started,
          args: "node -- nodex-desktop-repl:" + token,
        });
      if (state === "leader without argv")
        members.push({ pid: 123, group: 123, started, args: "" });
      if (draining) snapshot.mockResolvedValueOnce(members);
      await reapDesktopReplProcesses(home, snapshot);
      expect(snapshot).toHaveBeenCalledTimes(draining ? 2 : 1);
      expect(await readdir(directory)).toEqual([]);
      expect((await readdir(active)).sort()).toEqual(["live.json", "other.json"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
