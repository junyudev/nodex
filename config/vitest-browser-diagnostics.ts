import type { Server } from "node:http";
import { errorMonitor, type EventEmitter } from "node:events";
import type { Browser, Frame, Page } from "playwright";
import type { Plugin } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";
import { createDebugger, type BrowserProvider } from "vite-plus/test/node";

type Diagnostic = Readonly<Record<string, unknown>>;
type Report = (diagnostic: Diagnostic) => void;

const debug = createDebugger("vitest:browser:lifecycle");
const report: Report = (diagnostic) => debug?.("%o", diagnostic);

interface PageSnapshot {
  readonly sessionId: string;
  url: string;
  pageClosed: boolean;
}

// A separate callback scope keeps longer-lived owners from retaining the Page.
const recordSnapshot =
  (event: string, snapshot: PageSnapshot, browser: Browser | null, log: Report) => () =>
    log({ event, ...snapshot, browserConnected: browser?.isConnected() ?? false });

/** Observe the outer runner page; normal per-file iframe replacement is not navigation. */
export function observeBrowserPage(sessionId: string, page: Page, log: Report = report): void {
  const context = page.context();
  const browser = context.browser();
  const snapshot: PageSnapshot = { sessionId, url: page.url(), pageClosed: page.isClosed() };
  const record = (event: string) => {
    snapshot.url = page.url();
    snapshot.pageClosed = page.isClosed();
    recordSnapshot(event, snapshot, browser, log)();
  };
  const onNavigate = (frame: Frame) => {
    if (frame === page.mainFrame()) record("main-frame-navigated");
  };
  page.on("framenavigated", onNavigate);
  page.once("close", () => {
    record("page-closed");
    page.off("framenavigated", onNavigate);
  });
  context.once("close", recordSnapshot("context-closed", snapshot, browser, log));
  browser?.once("disconnected", recordSnapshot("browser-disconnected", snapshot, browser, log));
  record("page-observed");
}

/** Keep server teardown visible even when all browser transports disappear together. */
export function observeBrowserServer(
  server: EventEmitter & Pick<Server, "address">,
  log: Report = report,
): void {
  let address = server.address();
  server.once("listening", () => {
    address = server.address();
    log({ event: "http-listening", address });
  });
  server.once("close", () => log({ event: "http-closed", address }));
  server.on(errorMonitor, (error: Error) =>
    log({ event: "http-error", address, name: error.name, message: error.message }),
  );
}

export function ciPlaywrightProvider(): ReturnType<typeof playwright> {
  // Keep browser contracts on the full Chromium implementation in headed and headless runs.
  const provider = playwright({ launchOptions: { channel: "chromium" } });
  if (!process.env.CI) return provider;
  return {
    ...provider,
    providerFactory(project) {
      return observeBrowserProvider(provider.providerFactory(project));
    },
  };
}

const openedPage = (provider: BrowserProvider, sessionId: string): Page | undefined => {
  try {
    return provider.getCommandsContext(sessionId).page as Page | undefined;
  } catch {
    // Browser creation can fail before a Page exists; preserve its original error.
    return undefined;
  }
};

export function observeBrowserProvider(
  provider: BrowserProvider,
  log: Report = report,
): BrowserProvider {
  const openPage = provider.openPage.bind(provider);
  provider.openPage = async (sessionId, url, options) => {
    try {
      await openPage(sessionId, url, options);
    } finally {
      const page = openedPage(provider, sessionId);
      if (page) observeBrowserPage(sessionId, page, log);
    }
  };
  return provider;
}

export function browserServerDiagnostics(): Plugin {
  return {
    name: "nodex:browser-server-diagnostics",
    configureServer(server) {
      if (process.env.CI && server.httpServer) observeBrowserServer(server.httpServer);
    },
  };
}
