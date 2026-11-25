import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { launchTestElectron } from "./launch-electron";
import { isolatedElectronArguments } from "../isolated-run/electron-arguments";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("playwright", () => ({ _electron: { launch } }));

beforeEach(() => vi.stubEnv("NODEX_E2E_WINDOWS", undefined));
afterEach(() => {
  vi.unstubAllEnvs();
  launch.mockClear();
});

test("installs the background policy and strips Node mode from the supplied environment", async () => {
  const options = {
    args: ["/fixture/main.cjs", "--home", "/fixture/home"],
    cwd: "/fixture",
    env: { FIXTURE: "yes", ELECTRON_RUN_AS_NODE: "1" },
    executablePath: "/fixture/electron",
  };
  await launchTestElectron(options);
  expect(launch).toHaveBeenCalledWith({
    ...options,
    env: { FIXTURE: "yes" },
    args: [
      "-r",
      path.resolve("scripts/testing/electron-background-windows.cjs"),
      ...options.args,
      ...isolatedElectronArguments(),
    ],
  });
});

test.each(["explicit", "environment"])(
  "allows a deliberate foreground run (%s)",
  async (source) => {
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
    vi.stubEnv("FIXTURE", "inherited");
    if (source === "environment") vi.stubEnv("NODEX_E2E_WINDOWS", "foreground");
    await launchTestElectron({
      args: ["/fixture/main.cjs"],
      ...(source === "explicit" ? { windows: "foreground" } : {}),
    });
    const options = launch.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      args: ["/fixture/main.cjs", ...isolatedElectronArguments()],
      env: { FIXTURE: "inherited" },
    });
    expect(options).not.toHaveProperty("env.ELECTRON_RUN_AS_NODE");
  },
);
