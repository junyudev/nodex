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
    NODE_EXTRA_CA_CERTS: "company-ca.pem",
    HTTPS_PROXY: "proxy",
    USER_TOKEN: "credential",
  });
});
