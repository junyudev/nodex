import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { hasCompletePtyLine, probePtyResize } from "./pty-resize-probe";

const children = new Set<ChildProcess>();
const roots: string[] = [];
const deferred = <A = void>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  children.clear();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function terminalFixture(holdSize = false) {
  const root = await mkdtemp(join(tmpdir(), "nodex-pty-resize-"));
  roots.push(root);
  const driver = join(root, "driver.mjs");
  // Model Node's cached dimensions separately from an accepted native resize.
  // The actual terminal fixture observes the public resize event only on release.
  await writeFile(
    driver,
    `
    process.stdout.columns = 80;
    process.stdout.rows = 24;
    let requested;
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (...args) => {
      if (${holdSize} && String(args[0]).startsWith("SIZE:")) {
        process.send({ type: "query-held" });
        return true;
      }
      return write(...args);
    };
    process.on("message", (message) => {
      if (message.type === "resize") {
        requested = { cols: message.cols, rows: message.rows };
        process.send({ type: "requested", cols: process.stdout.columns, rows: process.stdout.rows });
        return;
      }
      if (message.type === "release") {
        process.stdout.columns = message.cols ?? requested.cols;
        process.stdout.rows = message.rows ?? requested.rows;
        process.stdout.emit("resize");
        process.send({ type: "released" });
      }
    });
    process.argv.push("login");
    await import(${JSON.stringify(pathToFileURL(resolve("scripts/testing/fixtures/acp-terminal-agent.mjs")).href)});
  `,
  );
  const child = fork(driver, [], {
    execArgv: [],
    env: { NODEX_PTY_FIXTURE_HOME: root },
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  const requested = deferred<{ cols: number; rows: number }>();
  const released = deferred();
  const queryHeld = deferred();
  child.on("message", (message) => {
    const frame = message as { type: string; cols: number; rows: number };
    if (frame.type === "requested") requested.resolve({ cols: frame.cols, rows: frame.rows });
    if (frame.type === "released") released.resolve();
    if (frame.type === "query-held") queryHeld.resolve();
  });
  let output = "";
  const observers = new Set<() => void>();
  const failures = new Set<(error: Error) => void>();
  child.stdout!.on("data", (data: Buffer) => {
    output += data.toString();
    for (const observe of observers) observe();
  });
  child.on("exit", () => {
    for (const fail of failures) fail(new Error(`Terminal fixture exited: ${output}`));
  });
  const waitForLine = (line: string, deadline: number) =>
    new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        observers.delete(check);
        failures.delete(fail);
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const check = () => {
        if (!hasCompletePtyLine(output, line)) return;
        cleanup();
        resolve();
      };
      const timer = setTimeout(
        () => fail(new Error(`Missing ${line}: ${output}`)),
        Math.max(0, deadline - Date.now()),
      );
      observers.add(check);
      failures.add(fail);
      check();
    });
  await waitForLine("READY", Date.now() + 10_000);
  let queries = 0;
  return {
    requested: requested.promise,
    queryHeld: queryHeld.promise,
    queries: () => queries,
    release: async (size?: { cols: number; rows: number }) => {
      child.send({ type: "release", ...size });
      await released.promise;
    },
    waitForLine,
    port: {
      resize: (cols: number, rows: number) => {
        child.send({ type: "resize", cols, rows });
      },
      query: () => {
        queries++;
        child.stdin!.write("size\n");
      },
      waitForLine,
    },
  };
}

test("waits for the real terminal fixture's delayed resize acknowledgement before querying", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const terminal = await terminalFixture();
  const done = probePtyResize(terminal.port, 109, 37);
  let state = "pending";
  void done.then(
    () => {
      state = "resolved";
    },
    () => {
      state = "rejected";
    },
  );
  await expect(terminal.requested).resolves.toEqual({ cols: 80, rows: 24 });
  expect(terminal.queries()).toBe(0);
  expect(state).toBe("pending");
  await terminal.release();
  await done;
  expect(terminal.queries()).toBe(1);
  expect(state).toBe("resolved");
});

test("keeps acknowledgement and readback within one existing ten-second deadline", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const terminal = await terminalFixture(true);
  const done = probePtyResize(terminal.port, 109, 37);
  const failed = done.then(
    () => undefined,
    (error: Error) => error,
  );
  await terminal.requested;
  await vi.advanceTimersByTimeAsync(9_000);
  await terminal.release();
  await terminal.queryHeld;
  await vi.advanceTimersByTimeAsync(1_000);
  expect((await failed)?.message).toContain("Missing SIZE:109:37");
});

test("accepts a resize acknowledgement buffered before request completion", async () => {
  const terminal = await terminalFixture();
  await probePtyResize(
    {
      ...terminal.port,
      resize: async (cols, rows) => {
        terminal.port.resize(cols, rows);
        await terminal.requested;
        await terminal.release();
        await terminal.waitForLine(`RESIZED:${cols}:${rows}`, Date.now() + 10_000);
      },
    },
    109,
    37,
  );
  expect(terminal.queries()).toBe(1);
});

test.each([
  { cols: 109, rows: 370 },
  { cols: 1090, rows: 37 },
])("rejects an acknowledgement for the wrong actual dimensions: %j", async (size) => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const terminal = await terminalFixture();
  const done = probePtyResize(terminal.port, 109, 37);
  const failed = done.then(
    () => undefined,
    (error: Error) => error,
  );
  await terminal.requested;
  await terminal.release(size);
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await failed)?.message).toContain("Missing RESIZED:109:37");
  expect(terminal.queries()).toBe(0);
});

test("rejects a resize accepted by the parent but never observed by the child", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const terminal = await terminalFixture();
  const done = probePtyResize(terminal.port, 109, 37);
  const failed = done.then(
    () => undefined,
    (error: Error) => error,
  );
  await terminal.requested;
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await failed)?.message).toContain("Missing RESIZED:109:37");
  expect(terminal.queries()).toBe(0);
});

test.each(["SIZE:109:37", "SIZE:109:370\n", "NOTSIZE:109:37\n", "SIZE:109:37\r"])(
  "rejects an incomplete or different size frame: %j",
  (output) => {
    expect(hasCompletePtyLine(output, "SIZE:109:37")).toBe(false);
  },
);

test.each(["\n", "\r\n"])("accepts exact completed frames with %j endings", (ending) => {
  expect(hasCompletePtyLine(`noise${ending}SIZE:109:37${ending}`, "SIZE:109:37")).toBe(true);
});

test("does not accept a size prefix while its frame is still arriving", () => {
  let output = "SIZE:109:3";
  expect(hasCompletePtyLine(output, "SIZE:109:37")).toBe(false);
  output += "7";
  expect(hasCompletePtyLine(output, "SIZE:109:37")).toBe(false);
  output += "0\r\nSIZE:109:37\r";
  expect(hasCompletePtyLine(output, "SIZE:109:37")).toBe(false);
  output += "\n";
  expect(hasCompletePtyLine(output, "SIZE:109:37")).toBe(true);
});
