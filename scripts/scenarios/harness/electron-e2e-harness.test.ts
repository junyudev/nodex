import { afterEach, expect, test, vi } from "vitest";
import { launchNodexElectronApplication } from "./electron-e2e-harness";

const { launch } = vi.hoisted(() => ({
  launch: vi.fn((_input: { env: NodeJS.ProcessEnv }) => Promise.resolve(undefined)),
}));
vi.mock("playwright", () => ({ _electron: { launch } }));

afterEach(() => {
  vi.unstubAllEnvs();
  launch.mockClear();
});

const fixture = {
  executablePath: "/fixture/electron",
  initialProjectsDirectory: "/fixture/workspace",
  nodexHome: "/fixture/.nodex",
};

test("launches the scenario build independently of the parent development renderer", async () => {
  vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:45958");
  vi.stubEnv("CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "parent-client");
  await launchNodexElectronApplication(fixture);
  const environment = launch.mock.calls[0]?.[0].env;
  expect(environment).not.toHaveProperty("ELECTRON_RENDERER_URL");
  expect(environment).not.toHaveProperty("CODEX_INTERNAL_ORIGINATOR_OVERRIDE");
  expect(environment).toMatchObject({ NODEX_HOME: fixture.nodexHome, NODE_ENV: "test" });
});

test("preserves an explicitly requested development renderer for the scenario", async () => {
  vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:45958");
  await launchNodexElectronApplication({
    ...fixture,
    environment: { ELECTRON_RENDERER_URL: "http://localhost:5179" },
  });
  expect(launch.mock.calls[0]?.[0].env.ELECTRON_RENDERER_URL).toBe("http://localhost:5179");
});
