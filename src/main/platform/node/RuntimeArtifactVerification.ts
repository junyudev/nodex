import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

// Bound both open files and native inspectors. Every started operation settles before its
// caller completes, including cancellation, so startup owns no detached verification work.
export async function verifyRuntimeArtifacts<T, R>(
  artifacts: readonly T[],
  verify: (artifact: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(artifacts.length);
  let next = 0;
  let stopped = false;
  const workers = Array.from({ length: Math.min(8, artifacts.length) }, async () => {
    try {
      while (next < artifacts.length) {
        if (stopped) return;
        signal?.throwIfAborted();
        const index = next++;
        results[index] = await verify(artifacts[index]!);
      }
    } catch (error) {
      stopped = true;
      throw error;
    }
  });
  const settled = await Promise.allSettled(workers);
  signal?.throwIfAborted();
  const failed = settled.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return results;
}

export async function readRuntimeArtifactSha256(
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      signal?.throwIfAborted();
      if (bytesRead === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
}

/** Resolve only after close: an abort/error event alone does not mean the child has exited. */
export function readRuntimeInspectionCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal,
      killSignal: "SIGKILL",
      timeout: 30_000,
    });
    const output: string[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const collect = (chunk: string) => {
      if (failure) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8 * 1024 * 1024) {
        failure = new Error(`${command} exceeded the runtime inspection output limit`);
        child.kill("SIGKILL");
        return;
      }
      output.push(chunk);
    };
    child.stdout.setEncoding("utf8").on("data", collect);
    child.stderr.setEncoding("utf8").on("data", collect);
    child.on("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      if (signal?.aborted) return reject(signal.reason);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`${command} exited with ${String(code)}`));
      resolve(output.join("").trim());
    });
  });
}
