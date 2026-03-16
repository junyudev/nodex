import { describe, expect, test } from "bun:test";
import { AppStartupScreen } from "./app-startup-screen";
import { render } from "../test/dom";

describe("AppStartupScreen", () => {
  test("renders migration messaging and the current progress label", () => {
    const { getByRole, getByText } = render(
      <AppStartupScreen
        step={{ phase: "sqlite_waiting" }}
        migrationProgress={{ type: "InProgress", value: 67 }}
      />,
    );

    expect(getByText("Applying local data updates").textContent).toBe("Applying local data updates");
    expect(getByRole("progressbar", { name: "Database migration progress" }).getAttribute("aria-label")).toBe("Database migration progress");
    expect(getByText("67%").textContent).toBe("67%");
  });
});
