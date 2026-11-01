import { protocol } from "electron";
import { APP_PROTOCOL_SCHEME } from "../shared/app-protocol";
import { MCP_APP_SANDBOX_SCHEME } from "../shared/mcp-app/mcp-app-sandbox-contract";

import { PAGE_FILE_HTML_SCHEME } from "../shared/page-file-html";

type PrivilegedSchemeRegistrar = (schemes: Electron.CustomScheme[]) => void;

export function registerNodexPrivilegedSchemes(
  register: PrivilegedSchemeRegistrar = (schemes) => {
    protocol.registerSchemesAsPrivileged(schemes);
  },
): void {
  register([
    {
      scheme: PAGE_FILE_HTML_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
    {
      scheme: APP_PROTOCOL_SCHEME,
      privileges: {
        corsEnabled: true,
        secure: true,
        standard: true,
        stream: true,
        supportFetchAPI: true,
      },
    },
    {
      scheme: MCP_APP_SANDBOX_SCHEME,
      privileges: {
        allowServiceWorkers: true,
        corsEnabled: true,
        secure: true,
        standard: true,
        stream: true,
        supportFetchAPI: true,
      },
    },
  ]);
}
