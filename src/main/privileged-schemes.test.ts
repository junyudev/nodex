import { describe, expect, test } from "vite-plus/test";
import { APP_PROTOCOL_SCHEME } from "../shared/app-protocol";
import { MCP_APP_SANDBOX_SCHEME } from "../shared/mcp-app/mcp-app-sandbox-contract";
import { registerNodexPrivilegedSchemes } from "./privileged-schemes";

describe("privileged application schemes", () => {
  test("registers app with the exact renderer and media privileges before readiness", () => {
    let registered: Electron.CustomScheme[] = [];
    registerNodexPrivilegedSchemes((schemes) => {
      registered = schemes;
    });

    expect(registered.find((entry) => entry.scheme === APP_PROTOCOL_SCHEME)).toEqual({
      scheme: "app",
      privileges: {
        corsEnabled: true,
        secure: true,
        standard: true,
        stream: true,
        supportFetchAPI: true,
      },
    });
    expect(registered.map((entry) => entry.scheme)).toEqual([
      APP_PROTOCOL_SCHEME,
      MCP_APP_SANDBOX_SCHEME,
    ]);
  });
});
