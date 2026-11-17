import { afterEach, describe, expect, test } from "vite-plus/test";
import { activateAppLocale, resetAppLocaleForTests } from "../lib/app-locale";
import { formatStartupMessage } from "./startup-copy";
import { fallbackStartupFormat, startupShellText } from "./startup-messages";

const visible = (step: Parameters<typeof startupShellText>[0]) => {
  const text = startupShellText(step, formatStartupMessage);
  return text.phase === "opening" ? text.visibleStatus : text.title;
};

describe("startup shell copy", () => {
  afterEach(resetAppLocaleForTests);

  test("keeps ordinary opening phases quiet", () => {
    expect(visible({ phase: "opening" })).toBeNull();
    expect(visible({ phase: "opening_workspace" })).toBeNull();
    expect(visible({ phase: "done" })).toBeNull();
    expect(startupShellText({ phase: "opening" }, formatStartupMessage).status).toBe(
      "Opening Nodex…",
    );
  });

  test("shows migration copy, with progress only when the total is trustworthy", () => {
    expect(visible({ phase: "migrating", fromVersion: 86, toVersion: 88 })).toBe(
      "Updating local data…",
    );
    expect(
      visible({ phase: "migrating", fromVersion: 104, toVersion: 107, completed: 67, total: 100 }),
    ).toBe("Updating local data… 67%");
    expect(
      visible({ phase: "migrating", fromVersion: 104, toVersion: 107, completed: 0, total: 0 }),
    ).toBe("Updating local data…");
  });

  test("follows the display language", async () => {
    await activateAppLocale("zh-CN");
    expect(visible({ phase: "failed" })).toBe("无法启动 Nodex");
    expect(
      visible({ phase: "migrating", fromVersion: 1, toVersion: 2, completed: 1, total: 2 }),
    ).toBe("正在更新本地数据… 50%");
  });

  test("still names the way out when the formatter could not load", () => {
    expect(startupShellText({ phase: "failed" }, fallbackStartupFormat)).toMatchObject({
      restart: "Restart Nodex",
    });
    expect(
      startupShellText(
        { phase: "migrating", fromVersion: 1, toVersion: 2, completed: 1, total: 2 },
        fallbackStartupFormat,
      ),
    ).toMatchObject({ visibleStatus: "Updating local data…" });
  });
});
