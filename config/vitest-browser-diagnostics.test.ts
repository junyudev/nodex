import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { Page } from "playwright";
import { expect, test, vi } from "vite-plus/test";
import type { BrowserProvider } from "vite-plus/test/node";
import {
  observeBrowserPage,
  observeBrowserProvider,
  observeBrowserServer,
} from "./vitest-browser-diagnostics";

test("distinguishes outer-page navigation and teardown from normal tester iframe replacement", () => {
  const browser = Object.assign(new EventEmitter(), { isConnected: () => connected });
  const context = Object.assign(new EventEmitter(), { browser: () => browser });
  const mainFrame = {};
  let connected = true;
  let closed = false;
  let url = "http://localhost/__vitest_test__/?sessionId=session-1";
  const page = Object.assign(new EventEmitter(), {
    context: () => context,
    mainFrame: () => mainFrame,
    isClosed: () => closed,
    url: () => url,
  });
  const diagnostics: Readonly<Record<string, unknown>>[] = [];
  observeBrowserPage("session-1", page as unknown as Page, (entry) => diagnostics.push(entry));
  page.emit("framenavigated", {});
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toEqual({
    event: "page-observed",
    sessionId: "session-1",
    url,
    pageClosed: false,
    browserConnected: true,
  });

  url = "http://localhost/reloaded";
  page.emit("framenavigated", mainFrame);
  closed = true;
  page.emit("close");
  vi.spyOn(page, "url").mockImplementation(() => {
    throw new Error("Closed Page is no longer available");
  });
  vi.spyOn(page, "isClosed").mockImplementation(() => {
    throw new Error("Closed Page is no longer available");
  });
  vi.spyOn(page, "mainFrame").mockImplementation(() => {
    throw new Error("Closed Page is no longer available");
  });
  expect(() => page.emit("framenavigated", mainFrame)).not.toThrow();
  context.emit("close");
  connected = false;
  browser.emit("disconnected");
  expect(diagnostics.slice(1)).toEqual([
    {
      event: "main-frame-navigated",
      sessionId: "session-1",
      url,
      pageClosed: false,
      browserConnected: true,
    },
    { event: "page-closed", sessionId: "session-1", url, pageClosed: true, browserConnected: true },
    {
      event: "context-closed",
      sessionId: "session-1",
      url,
      pageClosed: true,
      browserConnected: true,
    },
    {
      event: "browser-disconnected",
      sessionId: "session-1",
      url,
      pageClosed: true,
      browserConnected: false,
    },
  ]);
});

test("retains the listening address when a server closes and records server errors without closing it", () => {
  const server = createServer();
  const address = { address: "127.0.0.1", family: "IPv4", port: 63315 };
  const getAddress = vi.spyOn(server, "address").mockReturnValue(address);
  const close = vi.spyOn(server, "close");
  const onError = vi.fn();
  server.on("error", onError);
  const diagnostics: Readonly<Record<string, unknown>>[] = [];
  observeBrowserServer(server, (entry) => diagnostics.push(entry));
  server.emit("listening");
  server.emit("error", new Error("connection reset"));
  getAddress.mockReturnValue(null);
  server.emit("close");
  expect(diagnostics).toEqual([
    { event: "http-listening", address },
    { event: "http-error", address, name: "Error", message: "connection reset" },
    { event: "http-closed", address },
  ]);
  expect(close).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledOnce();
  expect(server.listening).toBe(false);
});

test("monitoring a server error preserves its existing unhandled-error behavior", () => {
  const server = createServer();
  const diagnostics: Readonly<Record<string, unknown>>[] = [];
  observeBrowserServer(server, (entry) => diagnostics.push(entry));
  const error = new Error("unhandled server error");
  expect(() => server.emit("error", error)).toThrow(error);
  expect(diagnostics).toEqual([
    { event: "http-error", address: null, name: "Error", message: error.message },
  ]);
});

const providerFixture = (
  openPage: BrowserProvider["openPage"],
  getCommandsContext: BrowserProvider["getCommandsContext"],
): BrowserProvider => ({
  name: "playwright",
  supportsParallelism: true,
  openPage,
  getCommandsContext,
  close: vi.fn(async () => {}),
});

test("observes a Page after navigation fails while preserving the provider error and teardown", async () => {
  const context = Object.assign(new EventEmitter(), { browser: () => null });
  const page = Object.assign(new EventEmitter(), {
    context: () => context,
    mainFrame: () => ({}),
    isClosed: (): boolean => false,
    url: () => "http://localhost/failed-navigation",
  });
  const error = new Error("page.goto failed");
  const openPage = vi.fn(async () => {
    throw error;
  });
  const provider = providerFixture(openPage, () => ({ page }));
  const close = provider.close;
  const diagnostics: Readonly<Record<string, unknown>>[] = [];
  expect(observeBrowserProvider(provider, (entry) => diagnostics.push(entry))).toBe(provider);
  const options = { parallel: false };
  await expect(provider.openPage("failed-session", "http://localhost/", options)).rejects.toBe(
    error,
  );
  expect(openPage).toHaveBeenCalledExactlyOnceWith("failed-session", "http://localhost/", options);
  expect(diagnostics).toEqual([
    {
      event: "page-observed",
      sessionId: "failed-session",
      url: "http://localhost/failed-navigation",
      pageClosed: false,
      browserConnected: false,
    },
  ]);
  vi.spyOn(page, "isClosed").mockReturnValue(true);
  page.emit("close");
  expect(diagnostics[1]).toEqual(
    expect.objectContaining({ event: "page-closed", pageClosed: true }),
  );
  expect(provider.close).toBe(close);
  expect(close).not.toHaveBeenCalled();
});

test("a failure before Page creation retains the original error when command context is unavailable", async () => {
  const error = new Error("browser launch failed");
  const provider = providerFixture(
    async () => {
      throw error;
    },
    () => {
      throw new Error("Page not found");
    },
  );
  const diagnostics: Readonly<Record<string, unknown>>[] = [];
  observeBrowserProvider(provider, (entry) => diagnostics.push(entry));
  await expect(
    provider.openPage("missing-session", "http://localhost/", { parallel: false }),
  ).rejects.toBe(error);
  expect(diagnostics).toEqual([]);
  expect(provider.close).not.toHaveBeenCalled();
});
