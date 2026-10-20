import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "@effect/vitest";

// Hold real child-process I/O at its visibility boundary so the parent can inspect
// a partial write and a delivered frame without depending on scheduler timing.
const boundaryProbe = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const write = fs.writeFileSync;
const wait = (file) => {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(file)) Atomics.wait(cell, 0, 0, 10);
};
let writes = 0;
fs.writeFileSync = (file, data, options) => {
  if (++writes !== 2 || process.env.PROBE_BOUNDARY !== "write") {
    return write(file, data, options);
  }
  const bytes = Buffer.from(data);
  const middle = Math.floor(bytes.length / 2);
  const descriptor = fs.openSync(file, "w");
  try {
    fs.writeSync(descriptor, bytes.subarray(0, middle));
    write(process.env.PROBE_REACHED, "");
    wait(process.env.PROBE_RELEASE);
    fs.writeSync(descriptor, bytes.subarray(middle));
  } finally {
    fs.closeSync(descriptor);
  }
};
syncBuiltinESMExports();
const send = process.stdout.write.bind(process.stdout);
process.stdout.write = (...args) => {
  const result = send(...args);
  if (["output", "mismatch"].includes(process.env.PROBE_BOUNDARY)) wait(process.env.PROBE_RELEASE);
  return result;
};
`;

const completedTranscript = {
  scenario: "publication-boundary",
  entries: [
    { type: "expect_outbound", frame: { kind: "notification", method: "probe/start" } },
    { type: "emit_inbound", frame: { kind: "notification", method: "probe/done" } },
    { type: "runtime_exit", status: "success" },
  ],
};

async function withReplayAgent(
  boundary: "write" | "output" | "failure" | "mismatch",
  run: (agent: {
    start: () => void;
    readStatus: () => {
      cursor: number;
      total: number;
      failure?: { detail: string; cursor: number; expected: unknown };
    };
    reached: () => boolean;
    stdout: () => string;
    stderr: () => string;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "nodex-acp-publication-"));
  const statusPath = join(directory, "status.json");
  const reachedPath = join(directory, "reached");
  const releasePath = join(directory, "release");
  const probePath = join(directory, "probe.mjs");
  writeFileSync(probePath, boundaryProbe);
  const transcript = {
    ...completedTranscript,
    entries:
      boundary === "failure"
        ? [{ type: "emit_inbound", frame: { kind: "response", method: "unknown", result: {} } }]
        : boundary === "mismatch"
          ? []
          : completedTranscript.entries,
  };
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(probePath).href,
      "--experimental-strip-types",
      fileURLToPath(new URL("../../scripts/acp-replay-agent.ts", import.meta.url)),
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        T3_ACP_REPLAY_TRANSCRIPT: Buffer.from(JSON.stringify(transcript)).toString("base64"),
        T3_ACP_REPLAY_STATUS_PATH: statusPath,
        PROBE_BOUNDARY: boundary,
        PROBE_REACHED: reachedPath,
        PROBE_RELEASE: releasePath,
      },
    },
  );
  const exited = once(child, "exit");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    await expect.poll(() => existsSync(statusPath), { timeout: 5_000 }).toBe(true);
    await run({
      start: () => {
        child.stdin.write(
          boundary === "mismatch"
            ? '{"jsonrpc":"2.0","id":1,"method":"probe/extra"}\n'
            : '{"jsonrpc":"2.0","method":"probe/start"}\n',
        );
      },
      readStatus: () => JSON.parse(readFileSync(statusPath, "utf8")),
      reached: () => existsSync(reachedPath),
      stdout: () => stdout,
      stderr: () => stderr,
    });
  } finally {
    writeFileSync(releasePath, "");
    child.kill();
    await exited;
    rmSync(directory, { recursive: true, force: true });
  }
}

it("keeps the prior complete status readable while the next snapshot is being written", () =>
  withReplayAgent("write", async (agent) => {
    agent.start();
    await expect.poll(agent.reached, { timeout: 5_000 }).toBe(true);
    expect(agent.readStatus()).toMatchObject({ cursor: 0, total: 3 });
  }));

it("publishes the inbound segment and trailing runtime exit before delivering its last frame", () =>
  withReplayAgent("output", async (agent) => {
    agent.start();
    await expect.poll(agent.stdout, { timeout: 5_000 }).toContain('"method":"probe/done"');
    expect(agent.readStatus()).toMatchObject({ cursor: 3, total: 3 });
  }));

it("retains the offending frame when an inbound response has no pending request", () =>
  withReplayAgent("failure", async (agent) => {
    await expect.poll(agent.stderr, { timeout: 5_000 }).toContain("ACP replay mismatch");
    expect(agent.stdout()).toBe("");
    expect(agent.readStatus()).toMatchObject({
      cursor: 0,
      total: 1,
      failure: {
        detail: "No pending client request for unknown",
        cursor: 0,
        expected: {
          type: "emit_inbound",
          frame: { kind: "response", method: "unknown", result: {} },
        },
      },
    });
  }));

it("publishes a replay mismatch before returning its error response after completion", () =>
  withReplayAgent("mismatch", async (agent) => {
    agent.start();
    await expect.poll(agent.stdout, { timeout: 5_000 }).toContain('"code":-32603');
    expect(agent.readStatus()).toMatchObject({
      cursor: 0,
      total: 0,
      failure: {
        detail: "Unexpected outbound ACP frame",
        cursor: 0,
        actual: { kind: "request", method: "probe/extra" },
      },
    });
  }));
