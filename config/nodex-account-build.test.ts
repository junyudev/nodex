import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "vite";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import electronConfig from "../electron.vite.config";
import type { resolveNodexAccountConfiguration } from "../src/main/nodex-account/configuration";
import { resolveNodexAccountBuildConfiguration } from "./nodex-account-build";

const production = { issuer: "https://clerk.example.test", clientId: "public-production-client" };

afterEach(() => vi.unstubAllEnvs());

const buildConfiguration = async () => {
  const main = electronConfig({ command: "build", mode: "production" }).main;
  const result = await build({
    configFile: false,
    logLevel: "silent",
    define: main?.define,
    build: {
      write: false,
      lib: {
        entry: resolve("src/main/nodex-account/configuration.ts"),
        formats: ["cjs"],
        fileName: "account.cjs",
      },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !("output" in output)) throw new Error("Expected one account build output");
  const entry = output.output.find((item) => item.type === "chunk" && item.isEntry);
  if (!entry || entry.type !== "chunk") throw new Error("Expected an account entry chunk");
  const fixture = {
    exports: {} as { resolveNodexAccountConfiguration: typeof resolveNodexAccountConfiguration },
  };
  runInNewContext(entry.code, { module: fixture, exports: fixture.exports, URL });
  return fixture.exports.resolveNodexAccountConfiguration;
};

describe("Nodex account deployment configuration", () => {
  test("builds use only their public deployment pair, never runtime development overrides", () => {
    expect(resolveNodexAccountBuildConfiguration({}, null)).toBeNull();
    expect(
      resolveNodexAccountBuildConfiguration(
        {
          NODEX_CLERK_ISSUER: "https://development.clerk.accounts.dev",
          NODEX_CLERK_CLIENT_ID: "development-client",
        },
        production,
      ),
    ).toEqual(production);
    expect(
      resolveNodexAccountBuildConfiguration(
        {
          NODEX_BUILD_CLERK_ISSUER: ` ${production.issuer}/ `,
          NODEX_BUILD_CLERK_CLIENT_ID: ` ${production.clientId} `,
        },
        null,
      ),
    ).toEqual(production);
  });

  test("refuses incomplete or development build overrides instead of falling back", () => {
    for (const issuer of [
      undefined,
      "http://127.0.0.1:4000",
      "https://test.clerk.accounts.dev",
      "https://clerk.example.test/path",
      "https://user:password@clerk.example.test",
    ]) {
      expect(() =>
        resolveNodexAccountBuildConfiguration(
          {
            NODEX_BUILD_CLERK_ISSUER: issuer,
            NODEX_BUILD_CLERK_CLIENT_ID: "client",
          },
          production,
        ),
      ).toThrow("production HTTPS issuer");
    }
    expect(() =>
      resolveNodexAccountBuildConfiguration(
        {
          NODEX_BUILD_CLERK_ISSUER: production.issuer,
        },
        production,
      ),
    ).toThrow("production HTTPS issuer");
    expect(() =>
      resolveNodexAccountBuildConfiguration(
        {},
        {
          ...production,
          secretKey: "not-a-public-setting",
        },
      ),
    ).toThrow();
  });

  test("bundled apps resolve their production account without a shell environment", async () => {
    vi.stubEnv("NODEX_BUILD_CLERK_ISSUER", production.issuer);
    vi.stubEnv("NODEX_BUILD_CLERK_CLIENT_ID", production.clientId);
    const resolveConfiguration = await buildConfiguration();
    expect(resolveConfiguration({ isPackaged: true, environment: {} })).toEqual({
      kind: "ready",
      ...production,
    });
    expect(resolveConfiguration({ isPackaged: false, environment: {} })).toEqual({
      kind: "absent",
    });

    const environment = {
      NODEX_CLERK_ISSUER: "https://development.clerk.accounts.dev",
      NODEX_CLERK_CLIENT_ID: "development-client",
    };
    expect(resolveConfiguration({ isPackaged: true, environment })).toEqual({
      kind: "ready",
      issuer: environment.NODEX_CLERK_ISSUER,
      clientId: environment.NODEX_CLERK_CLIENT_ID,
    });
    expect(
      resolveConfiguration({
        isPackaged: true,
        environment: { NODEX_CLERK_ISSUER: environment.NODEX_CLERK_ISSUER },
      }),
    ).toEqual({ kind: "invalid" });
    expect(
      resolveConfiguration({
        isPackaged: true,
        environment: { NODEX_CLERK_ISSUER: "", NODEX_CLERK_CLIENT_ID: "" },
      }),
    ).toEqual({ kind: "absent" });
  });

  test("an explicitly local build keeps account access absent after packaging", async () => {
    vi.stubEnv("NODEX_BUILD_CLERK_ISSUER", "");
    vi.stubEnv("NODEX_BUILD_CLERK_CLIENT_ID", "");
    const resolveConfiguration = await buildConfiguration();
    expect(resolveConfiguration({ isPackaged: true, environment: {} })).toEqual({ kind: "absent" });
  });

  test("ships the checked-in account deployment without build or runtime environment variables", async () => {
    vi.stubEnv("NODEX_BUILD_CLERK_ISSUER", undefined);
    vi.stubEnv("NODEX_BUILD_CLERK_CLIENT_ID", undefined);
    const configured = resolveNodexAccountBuildConfiguration({});
    const resolveConfiguration = await buildConfiguration();
    expect(resolveConfiguration({ isPackaged: true, environment: {} })).toEqual(
      configured ? { kind: "ready", ...configured } : { kind: "absent" },
    );
  });
});
