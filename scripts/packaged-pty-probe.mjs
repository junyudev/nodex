// Node-only so release tools can probe the exact installed runtime without a loader.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sentinelExitCode = 73;
const receiptPrefix = "NODEX_PTY_RECEIPT ";
const program = String.raw`
const [addonPath, marker, sentinel, timeout] = process.argv.slice(1);
let terminal;
let exited = false;
let failed = false;
let output = "";
const stop = (message) => {
  if (failed) return;
  failed = true;
  process.stderr.write(message + "\n");
  if (terminal && !exited) {
    try { terminal.kill(process.platform === "win32" ? undefined : "SIGKILL"); }
    catch (error) { process.stderr.write(String(error) + "\n"); }
  }
  setTimeout(() => process.exit(1), 500);
};
const timer = setTimeout(() => stop("Packaged PTY timed out"), Number(timeout));
try {
  const pty = require(addonPath);
  process.stderr.write("Packaged PTY: spawning through " + addonPath + "\n");
  // Leave ConPTY options unset, exactly as production does on supported Windows.
  terminal = pty.spawn(process.execPath, ["-e", "process.stdout.write(" + JSON.stringify(marker) + ");process.exitCode=" + sentinel], {
    name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
  });
  terminal.onData((data) => {
    output += data;
    if (output.length > 32768) { clearTimeout(timer); stop("Packaged PTY output exceeded its bound"); }
  });
  terminal.onExit(({exitCode, signal}) => {
    exited = true;
    clearTimeout(timer);
    if (failed) return;
    if (exitCode !== Number(sentinel) || (signal !== undefined && signal !== 0))
      return stop("Packaged PTY wrong exit code: " + exitCode + ", signal: " + signal);
    if (!output.includes(marker)) return stop("Packaged PTY missing output marker");
    process.stdout.write("NODEX_PTY_RECEIPT " + JSON.stringify({
      schemaVersion: 1, nodeExecutable: process.execPath, addonPath,
      platform: process.platform, architecture: process.arch,
      marker, output, exitCode, ptyPid: terminal.pid,
    }) + "\n", () => process.exit(0));
  });
} catch (error) {
  clearTimeout(timer);
  stop(error.stack || String(error));
}
`;

/** Reject an absent or incomplete receipt before emitting a distribution bundle. */
export function assertPackagedPtyReceipt(receipt) {
  if (
    !receipt ||
    receipt.schemaVersion !== 1 ||
    typeof receipt.marker !== "string" ||
    !/^NODEX_PTY_[a-f0-9-]{36}$/u.test(receipt.marker) ||
    typeof receipt.output !== "string" ||
    !receipt.output.includes(receipt.marker) ||
    receipt.exitCode !== sentinelExitCode ||
    !Number.isSafeInteger(receipt.ptyPid) ||
    receipt.ptyPid <= 0 ||
    typeof receipt.nodeExecutable !== "string" ||
    !isAbsolute(receipt.nodeExecutable) ||
    typeof receipt.addonPath !== "string" ||
    !isAbsolute(receipt.addonPath) ||
    !["darwin", "win32", "linux"].includes(receipt.platform) ||
    !["arm64", "x64"].includes(receipt.architecture)
  )
    throw new Error("Packaged PTY probe receipt is missing or invalid");
  return receipt;
}

/** Load node-pty by absolute path under the packaged stock Node, then prove spawn/output/exit. */
export function runPackagedPtyProbe({ nodeExecutable, addonPath, timeoutMs = 10_000 }) {
  if (!isAbsolute(nodeExecutable) || !isAbsolute(addonPath))
    throw new Error("Packaged PTY probe requires absolute Node and addon paths");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error("Packaged PTY probe timeout must be between 1 and 60000ms");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE"].includes(key.toUpperCase()),
    ),
  );
  const marker = `NODEX_PTY_${randomUUID()}`;
  const result = spawnSync(
    nodeExecutable,
    ["-e", program, resolve(addonPath), marker, String(sentinelExitCode), String(timeoutMs)],
    {
      env,
      cwd: dirname(nodeExecutable),
      encoding: "utf8",
      timeout: timeoutMs + 2_000,
      killSignal: "SIGKILL",
      maxBuffer: 65536,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `Packaged PTY probe failed: ${result.error?.message ?? result.status}\n${result.stderr ?? ""}`,
    );
  const line = result.stdout.split(/\r?\n/u).find((value) => value.startsWith(receiptPrefix));
  const receipt = assertPackagedPtyReceipt(
    line ? JSON.parse(line.slice(receiptPrefix.length)) : null,
  );
  if (receipt.marker !== marker || resolve(receipt.addonPath) !== resolve(addonPath))
    throw new Error("Packaged PTY receipt belongs to another probe");
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [nodeExecutable, addonPath] = process.argv.slice(2);
  try {
    const receipt = runPackagedPtyProbe({
      nodeExecutable: nodeExecutable ?? "",
      addonPath: addonPath ?? "",
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
