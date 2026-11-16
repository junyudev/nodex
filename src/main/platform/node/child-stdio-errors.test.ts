import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { execFile, observeChildStdioErrors } from "./child-stdio-errors";

it("reports a broken child input pipe to the owner even when the write has a callback", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "require('node:fs').closeSync(0); process.stdout.write('ready'); setInterval(() => {}, 1000)",
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = once(child, "close");
  try {
    const failure = new Promise<Error>((resolve) => observeChildStdioErrors(child, resolve));
    await once(child.stdout, "data");
    const writeError = new Promise<Error | null | undefined>((resolve) =>
      child.stdin.write("request\n", resolve),
    );
    const error = await writeError;
    expect(error).toBeInstanceOf(Error);
    expect(await failure).toBe(error);
  } finally {
    child.kill();
    await closed;
  }
});

it("fails an exec request when its captured output pipe errors", async () => {
  const failure = new Error("Read failed");
  const completed = new Promise<Error | null>((resolve) => {
    const child = execFile(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
      resolve,
    );
    child.stdout!.destroy(failure);
  });
  expect(await completed).toBe(failure);
});
