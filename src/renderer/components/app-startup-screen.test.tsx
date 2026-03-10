import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppStartupScreen } from "./app-startup-screen";

describe("AppStartupScreen", () => {
  test("renders migration messaging and the current progress label", () => {
    const markup = renderToStaticMarkup(
      createElement(AppStartupScreen, {
        step: { phase: "sqlite_waiting" },
        migrationProgress: { type: "InProgress", value: 67 },
      }),
    );

    expect(markup.includes("Applying local data updates")).toBeTrue();
    expect(markup.includes("Database migration progress")).toBeTrue();
    expect(markup.includes(">67%</span>")).toBeTrue();
  });
});
