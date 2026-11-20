import { describe, expect, test } from "vite-plus/test";
import { APP_PROTOCOL_SCHEME } from "../shared/app-protocol";
import { MCP_APP_SANDBOX_SCHEME } from "../shared/mcp-app/mcp-app-sandbox-contract";
import { PAGE_FILE_HTML_SCHEME } from "../shared/page-file-html";
import { VISUAL_SCHEME } from "../shared/visual/bridge";
import { registerNodexPrivilegedSchemes } from "./privileged-schemes";

describe("privileged application schemes", () => {
  test("registers the exact renderer and guest privileges before readiness", () => {
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
    expect(registered.find((entry) => entry.scheme === PAGE_FILE_HTML_SCHEME)).toEqual({
      scheme: PAGE_FILE_HTML_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    });
    expect(registered.find((entry) => entry.scheme === VISUAL_SCHEME)).toEqual({
      scheme: VISUAL_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    });
    expect(registered.map((entry) => entry.scheme)).toEqual([
      VISUAL_SCHEME,
      PAGE_FILE_HTML_SCHEME,
      APP_PROTOCOL_SCHEME,
      MCP_APP_SANDBOX_SCHEME,
    ]);
  });
});
