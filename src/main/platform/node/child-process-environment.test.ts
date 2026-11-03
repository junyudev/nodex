import { expect, test } from "vite-plus/test";
import { childProcessEnvironment, mergeProcessEnvironments } from "./child-process-environment";

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
