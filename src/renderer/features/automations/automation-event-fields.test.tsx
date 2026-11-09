import { useState } from "react";
import { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  DEFAULT_AUTOMATION_SOURCE_FILTER,
  AutomationEventFields,
  AutomationSourceFields,
} from "./automation-event-fields";
import { TestQueryProvider } from "@/test/query";
import { installWindowApi } from "@/test/browser-globals";

describe("event Automation filters", () => {
  test("personal event editing reads Source options through its query adapter", async () => {
    const invoke = vi.fn().mockResolvedValue([{ id: "github", label: "Alice" }]);
    installWindowApi({ invoke });
    render(
      <TestQueryProvider>
        <AutomationSourceFields
          value={{ ...DEFAULT_AUTOMATION_SOURCE_FILTER, source_id: "github" }}
          disabled={false}
          onChange={vi.fn()}
        />
      </TestQueryProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Source" }).textContent).toBe("Alice"),
    );
    expect(invoke).toHaveBeenCalledWith("sources:automation-options");
  });
  test("commits repository and label lists while retaining typed separators, and toggles event kinds", async () => {
    const changed = vi.fn();
    function Editor() {
      const [value, setValue] = useState(DEFAULT_AUTOMATION_SOURCE_FILTER);
      return (
        <AutomationEventFields
          value={value}
          disabled={false}
          onChange={(next) => {
            changed(next);
            setValue(next);
          }}
        />
      );
    }
    render(<Editor />);
    const repositories = screen.getByRole("textbox", { name: "Repositories" });
    await act(async () => {
      fireEvent.change(repositories, { target: { value: "team/first, team/second" } });
      fireEvent.blur(repositories);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(changed).toHaveBeenLastCalledWith(
        expect.objectContaining({ repositories: ["team/first", "team/second"] }),
      ),
    );
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox", { name: "Labels" }), {
        target: { value: "bug, typo" },
      });
      fireEvent.blur(screen.getByRole("textbox", { name: "Labels" }));

      await Promise.resolve();
    });
    await waitFor(() =>
      expect(changed).toHaveBeenLastCalledWith(
        expect.objectContaining({ labels: ["bug", "typo"] }),
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Check passed" }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(changed).toHaveBeenLastCalledWith(
        expect.objectContaining({
          labels: ["bug", "typo"],
          kinds: ["check_failed", "check_passed"],
        }),
      ),
    );
  });
});
