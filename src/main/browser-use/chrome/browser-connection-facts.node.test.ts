import { describe, expect, test } from "vite-plus/test";
import { withMacChromiumFamilies } from "./ChromeBrowserFamilyRegistry";
import {
  preferredBrowserExtension,
  projectBrowserConnectionFacts,
} from "./browser-connection-facts";
import { TEST_CHROME_AUTHORITY, TEST_CHROME_EXTENSION_IDS } from "./chrome-test-fixture";

const { families } = withMacChromiumFamilies(TEST_CHROME_AUTHORITY);
const dia = { name: "Dia", applicationId: "company.thebrowser.dia" };
const instance = {
  family: "chrome",
  extensionId: TEST_CHROME_EXTENSION_IDS[0],
  extensionInstanceId: "dia-profile",
  application: { family: "dia", iconPath: "/private/path/to/Dia.app/icon.icns" },
};

describe("Browser connection facts", () => {
  test("joins the system default to the attributed app and supplies one unambiguous REPL hint", () => {
    const facts = projectBrowserConnectionFacts("darwin", dia, {
      families,
      instances: [instance],
      status: "ready",
    });
    expect(facts.defaultBrowser).toEqual({
      name: "Dia",
      family: "dia",
      supported: true,
      running: true,
      connection: "connected",
    });
    expect(facts.connectedBrowsers).toEqual([
      { family: "dia", name: "Dia", extensionInstanceId: "dia-profile" },
    ]);
    expect(preferredBrowserExtension(facts)).toBe("dia-profile");
    expect(
      preferredBrowserExtension(
        projectBrowserConnectionFacts("darwin", dia, {
          families,
          instances: [instance, { ...instance, extensionInstanceId: "second-profile" }],
          status: "ready",
        }),
      ),
    ).toBeUndefined();
  });

  test("distinguishes a disconnected app, an unsupported default, and an ambiguous wire report", () => {
    const disconnected = {
      families,
      instances: [],
      status: "extension-disconnected" as const,
      runningFamilies: new Map([
        ["dia", false],
        ["arc", true],
      ]),
    };
    expect(projectBrowserConnectionFacts("darwin", dia, disconnected).defaultBrowser).toMatchObject(
      {
        connection: "disconnected",
        supported: true,
      },
    );
    expect(
      projectBrowserConnectionFacts(
        "darwin",
        { name: "Safari", applicationId: "com.apple.Safari" },
        disconnected,
      ).defaultBrowser,
    ).toMatchObject({ connection: "unsupported", supported: false });
    const facts = projectBrowserConnectionFacts("darwin", dia, {
      ...disconnected,
      instances: [{ ...instance, application: undefined }],
    });
    expect(facts.defaultBrowser?.connection).toBe("unknown");
    expect(facts.connectedBrowsers[0]?.family).toBeNull();
    expect(preferredBrowserExtension(facts)).toBeUndefined();
  });
});
