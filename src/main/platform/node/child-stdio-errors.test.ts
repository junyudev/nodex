import { Writable } from "node:stream";
import { expect, it } from "vitest";
import { execFile, observeChildStdioErrors } from "./child-stdio-errors";

it("reports a broken child input pipe to the owner even when the write has a callback", async () => {
  const failure = Object.assign(new Error("Broken pipe"), { code: "EPIPE" });
  // Feed the stream an actual write failure. Closing fd 0 in a Windows child can
  // leave the inherited pipe handle open, so that fixture can accept writes.
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback(failure);
    },
  });
  const observed = new Promise<Error>((resolve) =>
    observeChildStdioErrors({ stdin, stdout: null, stderr: null }, resolve),
  );
  const writeError = await new Promise<Error | null | undefined>((resolve) =>
    stdin.write("request\n", resolve),
  );
  expect(writeError).toBe(failure);
  expect(await observed).toBe(failure);
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
