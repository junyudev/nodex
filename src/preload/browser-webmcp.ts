import { contextBridge } from "electron";
import {
  createBrowserWebMcpModelContext,
  type BrowserWebMcpModelContext,
} from "../shared/browser-webmcp-model-context";

/** Install before page scripts register document-scoped tools. No host capability crosses this bridge. */
export function installBrowserWebMcp(): void {
  if (globalThis.isSecureContext !== true) return;
  const modelContext = createBrowserWebMcpModelContext({
    location,
    isSecureContext: () => globalThis.isSecureContext === true,
    isOriginAgentCluster: () => window.originAgentCluster === true,
  });
  const bridgeKey = "__nodexWebMcpModelContext";
  contextBridge.exposeInMainWorld(bridgeKey, modelContext);
  contextBridge.executeInMainWorld({
    args: [bridgeKey],
    func: (key: string) => {
      const exposed = (window as unknown as Record<string, BrowserWebMcpModelContext>)[key];
      const bridged = Object.freeze({
        ...exposed,
        async registerTool(
          tool: Parameters<BrowserWebMcpModelContext["registerTool"]>[0],
          options?: { signal?: AbortSignal },
        ) {
          const signal = options?.signal;
          const result = exposed.registerTool(
            tool,
            signal == null
              ? options
              : {
                  ...options,
                  signal: {
                    aborted: signal.aborted,
                    reason: signal.reason,
                    addEventListener: (...args: Parameters<AbortSignal["addEventListener"]>) => {
                      signal.addEventListener(...args);
                      if (signal.aborted) throw signal.reason;
                    },
                  },
                },
          );
          if (signal == null) return result;
          return new Promise<void>((resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            result.finally(() => signal.removeEventListener("abort", abort)).then(resolve, reject);
          });
        },
      });
      Object.defineProperty(document, "modelContext", {
        configurable: false,
        enumerable: false,
        value: bridged,
        writable: false,
      });
    },
  });
}
