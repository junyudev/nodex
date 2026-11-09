import { useState } from "react";
import { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

describe("event Automation filters", () => {
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
