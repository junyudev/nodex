import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("loads the headless codec and rejects invalid evaluation arguments before execution", async () => {
  const outcome = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", path.resolve("scripts/agent-eval/launch.ts"), "--case", "__invalid__"],
    { env: { ...process.env, CI: "" }, timeout: 15_000 },
  ).then(
    () => ({ code: 0, output: "" }),
    (error: unknown) => {
      const failure = error as { code: number; stderr: string; stdout: string };
      return { code: failure.code, output: failure.stderr + failure.stdout };
    },
  );
  expect(outcome.code).toBe(1);
  expect(outcome.output).toContain("Unknown case or invalid variant count");
});
