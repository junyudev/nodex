import { act } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { resolveSubagentAvatarAsset, SubagentAvatar } from "./subagent-avatar";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.classList.remove("dark");
});

describe("subagent avatar appearance", () => {
  test("switches only the theme variant and restores the same identity after remount", async () => {
    const seed = "019f3c6a-2ebc-7b82-ab83-cb7edb449ada";
    const asset = resolveSubagentAvatarAsset(seed);
    // The document palette is authoritative, even if a legacy class disagrees.
    document.documentElement.dataset.theme = "light";
    document.documentElement.classList.add("dark");
    const view = render(<SubagentAvatar seed={seed} data-testid="identity" />);
    const avatar = view.getByTestId("identity");
    const index = avatar.getAttribute("data-subagent-avatar-index");
    expect(avatar.getAttribute("src")).toBe(asset.light);
    expect(avatar.getAttribute("alt")).toBe("");
    expect(avatar.getAttribute("draggable")).toBe("false");

    await act(async () => {
      document.documentElement.dataset.theme = "dark";
      await Promise.resolve();
    });
    await waitFor(() => expect(avatar.getAttribute("src")).toBe(asset.dark));
    expect(avatar.getAttribute("data-subagent-avatar-index")).toBe(index);
    view.unmount();

    const remounted = render(<SubagentAvatar seed={seed} data-testid="identity" />);
    expect(remounted.getByTestId("identity").getAttribute("src")).toBe(asset.dark);
    expect(remounted.getByTestId("identity").getAttribute("data-subagent-avatar-index")).toBe(
      index,
    );

    await act(async () => {
      document.documentElement.removeAttribute("data-theme");
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(remounted.getByTestId("identity").getAttribute("src")).toBe(asset.light),
    );
  });
});
