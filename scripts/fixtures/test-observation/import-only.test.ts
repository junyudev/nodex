import childProcess from "node:child_process";
import { expect, test } from "vite-plus/test";

test("has a subprocess capability without using it", () => {
  expect(typeof childProcess.spawn).toBe("function");
});
