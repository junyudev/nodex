import { describe, expect, test } from "vite-plus/test";
import { childProcessEnvironment, mergeProcessEnvironments } from "./child-process-environment";
import { Writable } from "node:stream";
import { it } from "vitest";
import { execFile, observeChildStdioErrors } from "./child-stdio-errors";

describe("child-process-environment", () => {
  test("Windows overlays replace case variants and remove variables without changing their inputs", () => {
    const inherited = Object.freeze({ Path: "old", PATH: "new", Token: "old", REMOVE: "yes" });
    expect(
      mergeProcessEnvironments("win32", inherited, {
        path: "configured",
        TOKEN: "new",
        remove: undefined,
      }),
    ).toEqual({
      PATH: "configured",
      TOKEN: "new",
    });
    expect(inherited.Path).toBe("old");
  });

  test("POSIX environment names remain case-sensitive", () => {
    expect(
      mergeProcessEnvironments("darwin", { PATH: "native", Path: "other" }, { path: "user" }),
    ).toEqual({ PATH: "native", Path: "other", path: "user" });
  });

  test("child tools retain user configuration without desktop runtime or crash-reporting state", () => {
    expect(
      childProcessEnvironment(
        {
          Path: "tools",
          electron_run_as_node: "1",
          NODE_OPTIONS: "--inspect --require host.js",
          VSCODE_INSPECTOR_OPTIONS: "inspector",
          CHROME_CRASHPAD_PIPE_NAME: "host-pipe",
          CRASHPAD_HANDLER_PID: "123",
          ELECTRON_NO_ASAR: "1",
          NODE_EXTRA_CA_CERTS: "company-ca.pem",
          HTTPS_PROXY: "proxy",
          USER_TOKEN: "credential",
        },
        "win32",
      ),
    ).toEqual({
      PATH: "tools",
      NODE_OPTIONS: "--require host.js",
      NODE_EXTRA_CA_CERTS: "company-ca.pem",
      HTTPS_PROXY: "proxy",
      USER_TOKEN: "credential",
    });
  });

  test("Node options keep the user's flags and drop only the desktop's debugger", () => {
    const options = (value: string) =>
      childProcessEnvironment({ NODE_OPTIONS: value }, "darwin").NODE_OPTIONS;
    expect(options("--max-old-space-size=8192 --inspect=9229")).toBe("--max-old-space-size=8192");
    expect(options("--inspect-brk --inspect-port=0")).toBeUndefined();
    expect(options("--openssl-legacy-provider")).toBe("--openssl-legacy-provider");
  });
});

describe("child-stdio-errors", () => {
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
});
