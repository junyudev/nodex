import { beforeEach, describe, expect, test } from "vite-plus/test";
import {
  resetSafeSendWarningRateLimitForTests,
  safeBroadcastToWindows,
  safeBroadcastToPersonalWindows,
  safeSendToWebContents,
  safeSendToWindow,
  type SafeSendOptions,
} from "./ipc-safe-send";

class FakeWebContents {
  id: number;
  destroyed = false;
  sendCalls: Array<{ channel: string; args: unknown[] }> = [];
  throwOnSend: unknown = null;
  url = "http://localhost:3000";

  getURL() {
    return this.url;
  }

  constructor(id: number) {
    this.id = id;
  }

  isDestroyed() {
    return this.destroyed;
  }

  send(channel: string, ...args: unknown[]) {
    if (this.throwOnSend) throw this.throwOnSend;
    this.sendCalls.push({ channel, args });
  }
}

class FakeWindow {
  id: number;
  destroyed = false;
  webContents: FakeWebContents;

  constructor(id: number, webContents = new FakeWebContents(id * 10)) {
    this.id = id;
    this.webContents = webContents;
  }

  isDestroyed() {
    return this.destroyed;
  }
}

function createLogger() {
  const debugCalls: object[] = [];
  const warnCalls: object[] = [];
  return {
    debugCalls,
    warnCalls,
    logger: {
      debug: (_message: string, fields?: object) => {
        debugCalls.push(fields ?? {});
      },
      warn: (_message: string, fields?: object) => {
        warnCalls.push(fields ?? {});
      },
    },
  };
}

function createOptions(
  logger: ReturnType<typeof createLogger>["logger"],
  nowMs = 1_000,
): SafeSendOptions {
  return {
    logger,
    nowMs: () => nowMs,
    warnRateLimitMs: 100,
  };
}

describe("ipc-safe-send", () => {
  beforeEach(() => {
    resetSafeSendWarningRateLimitForTests();
  });

  test("delivers personal Automation changes only to personal windows", () => {
    const personal = new FakeWindow(1);
    const team = new FakeWindow(2);
    team.webContents.url = "http://localhost:3000?spaceId=team";
    for (const channel of ["automations:changed", "automations:runs:updated"]) {
      expect(
        safeBroadcastToPersonalWindows([personal, team], channel, [
          { automationId: "same-automation" },
        ]),
      ).toBe(1);
    }
    expect(personal.webContents.sendCalls.map(({ channel }) => channel)).toEqual([
      "automations:changed",
      "automations:runs:updated",
    ]);
    expect(team.webContents.sendCalls).toEqual([]);
  });

  test("does not send to destroyed webContents", () => {
    const contents = new FakeWebContents(1);
    contents.destroyed = true;
    const logger = createLogger();

    const sent = safeSendToWebContents(
      contents,
      "project-sessions-changed",
      [{ projectId: "p1" }],
      createOptions(logger.logger),
    );

    expect(sent).toBe(false);
    expect(contents.sendCalls.length).toBe(0);
    expect(logger.debugCalls.length).toBe(1);
    expect(logger.warnCalls.length).toBe(0);
  });

  test("does not send to destroyed windows or destroyed child webContents", () => {
    const destroyedWindow = new FakeWindow(1);
    destroyedWindow.destroyed = true;
    const destroyedContentsWindow = new FakeWindow(2);
    destroyedContentsWindow.webContents.destroyed = true;
    const liveWindow = new FakeWindow(3);
    const logger = createLogger();

    const count = safeBroadcastToWindows(
      [destroyedWindow, destroyedContentsWindow, liveWindow],
      "codex:host-message",
      [{ type: "noop" }],
      createOptions(logger.logger),
    );

    expect(count).toBe(1);
    expect(destroyedWindow.webContents.sendCalls.length).toBe(0);
    expect(destroyedContentsWindow.webContents.sendCalls.length).toBe(0);
    expect(liveWindow.webContents.sendCalls.length).toBe(1);
    expect(logger.warnCalls.length).toBe(0);
  });

  test("treats disposed renderer frame errors as lifecycle races", () => {
    const contents = new FakeWebContents(4);
    contents.throwOnSend = new Error(
      "Render frame was disposed before WebFrameMain could be accessed",
    );
    const logger = createLogger();

    const sent = safeSendToWindow(
      new FakeWindow(5, contents),
      "project-sessions-changed",
      [],
      createOptions(logger.logger),
    );

    expect(sent).toBe(false);
    expect(logger.debugCalls.length).toBe(1);
    expect(logger.warnCalls.length).toBe(0);
  });

  test("rate-limits non-lifecycle send failures", () => {
    const contents = new FakeWebContents(6);
    contents.throwOnSend = new Error("Unexpected send failure");
    const logger = createLogger();

    safeSendToWebContents(contents, "codex:event", [], createOptions(logger.logger, 1_000));
    safeSendToWebContents(contents, "codex:event", [], createOptions(logger.logger, 1_050));
    safeSendToWebContents(contents, "codex:event", [], createOptions(logger.logger, 1_101));

    expect(logger.warnCalls.length).toBe(2);
    expect(logger.debugCalls.length).toBe(0);
  });
});
