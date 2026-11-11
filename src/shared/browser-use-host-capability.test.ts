import { describe, expect, test } from "vite-plus/test";
import {
  BROWSER_USE_PEER_AUTHORIZATION_ENV,
  resolveBrowserUseHostCapability,
} from "./browser-use-host-capability";

describe("resolveBrowserUseHostCapability", () => {
  test("enables the packaged macOS host with production peer authorization", () => {
    expect(
      resolveBrowserUseHostCapability({
        browserRuntimeStatus: "available",
        environment: {},
        isPackaged: true,
        platform: "darwin",
      }),
    ).toEqual({
      availableBackends: ["iab"],
      peerAuthorizationMode: "packaged",
      status: "available",
    });
  });

  test("keeps development peer verification separate from unpackaged host availability", () => {
    expect(
      resolveBrowserUseHostCapability({
        browserRuntimeStatus: "available",
        environment: {
          [BROWSER_USE_PEER_AUTHORIZATION_ENV]: "1",
        },
        isPackaged: false,
        platform: "darwin",
      }),
    ).toEqual({
      availableBackends: ["iab"],
      peerAuthorizationMode: "development",
      status: "available",
    });

    expect(
      resolveBrowserUseHostCapability({
        browserRuntimeStatus: "available",
        environment: {},
        isPackaged: false,
        platform: "darwin",
      }),
    ).toEqual({
      availableBackends: ["iab"],
      peerAuthorizationMode: "disabled",
      status: "available",
    });
  });

  test("fails closed when the runtime or platform is unsupported", () => {
    expect(
      resolveBrowserUseHostCapability({
        browserRuntimeStatus: "unavailable",
        environment: {
          [BROWSER_USE_PEER_AUTHORIZATION_ENV]: "1",
        },
        isPackaged: false,
        platform: "darwin",
      }),
    ).toMatchObject({
      reason: "runtime-unavailable",
      status: "unavailable",
    });
    expect(
      resolveBrowserUseHostCapability({
        browserRuntimeStatus: "available",
        environment: {
          [BROWSER_USE_PEER_AUTHORIZATION_ENV]: "1",
        },
        isPackaged: false,
        platform: "linux",
      }),
    ).toMatchObject({
      reason: "platform-unsupported",
      status: "unavailable",
    });
  });
});

test("Windows Browser availability depends on verified native transport and local execution", () => {
  const local = {
    browserRuntimeStatus: "available",
    environment: {},
    isPackaged: false,
    platform: "win32",
  } as const;
  expect(resolveBrowserUseHostCapability(local)).toMatchObject({ status: "unavailable" });
  expect(resolveBrowserUseHostCapability({ ...local, windowsTransportReady: true })).toMatchObject({
    status: "available",
    peerAuthorizationMode: "packaged",
    availableBackends: ["iab"],
  });
  const optIn = {
    ...local,
    environment: { [BROWSER_USE_PEER_AUTHORIZATION_ENV]: "1" },
    windowsTransportReady: true,
  };
  expect(resolveBrowserUseHostCapability(optIn)).toMatchObject({
    peerAuthorizationMode: "development",
  });
  expect(resolveBrowserUseHostCapability({ ...optIn, isPackaged: true })).toMatchObject({
    peerAuthorizationMode: "packaged",
  });
  for (const execution of ["remote", "wsl"] as const)
    expect(resolveBrowserUseHostCapability({ ...optIn, execution })).toMatchObject({
      status: "unavailable",
    });
});
