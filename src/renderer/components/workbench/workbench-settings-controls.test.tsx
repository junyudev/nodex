import { act, fireEvent, render } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { WorktreeAutoBranchPrefixSettingControl } from "./workbench-settings-controls";

test("replaces an edited branch prefix when its committed value changes", async () => {
  const onChange = vi.fn();
  const view = render(
    <WorktreeAutoBranchPrefixSettingControl value="first/" onChange={onChange} />,
  );
  const input = view.getByRole("textbox");
  if (!(input instanceof HTMLInputElement)) throw new Error("Expected a branch prefix input");
  await act(async () => {
    fireEvent.change(input, { target: { value: "Uncommitted/" } });
    await Promise.resolve();
  });
  view.rerender(<WorktreeAutoBranchPrefixSettingControl value="second/" onChange={onChange} />);
  expect(input.value).toBe("second/");
  await act(async () => {
    fireEvent.blur(input);
    await Promise.resolve();
  });
  expect(onChange).toHaveBeenCalledExactlyOnceWith("second/");
});
