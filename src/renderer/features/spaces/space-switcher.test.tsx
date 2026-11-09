import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { SpaceSwitcher } from "./space-switcher";
import { SpaceAvailabilityNotice } from "./space-availability";

const runtime = vi.hoisted(() => ({
  switch: vi.fn(),
  openJoin: vi.fn(),
  spaces: [
    { spaceId: "personal", kind: "personal", name: "Personal", availability: "ready" },
    { spaceId: "team", kind: "team", name: "Team", availability: "access-revoked" },
  ],
}));
vi.mock("./spaces-runtime", () => ({
  currentSpace: () => runtime.spaces[1],
  useSpaceConnections: () => ({ data: runtime.spaces }),
  switchSpace: runtime.switch,
}));
vi.mock("./join-space-dialog", () => ({ useOpenJoinSpace: () => runtime.openJoin }));
beforeEach(() => {
  runtime.switch.mockReset().mockResolvedValue(undefined);
  runtime.openJoin.mockReset();
});

test("keeps personal navigation and enrollment available when a team loses access", async () => {
  const view = render(
    <>
      <SpaceSwitcher />
      <SpaceAvailabilityNotice />
    </>,
  );
  expect(view.getByRole("status").textContent).toBe("Access revoked");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Switch Space" }));
    await Promise.resolve();
  });
  const personal = await view.findByRole("menuitem", { name: /Personal/ });
  await act(async () => {
    fireEvent.click(personal);
    await Promise.resolve();
  });
  await waitFor(() => expect(runtime.switch).toHaveBeenCalledWith("personal"));
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Switch Space" }));
    await Promise.resolve();
  });
  const join = await view.findByRole("menuitem", { name: "Join a Space…" });
  await act(async () => {
    fireEvent.click(join);
    await Promise.resolve();
  });
  await waitFor(() => expect(runtime.openJoin).toHaveBeenCalledOnce());
});
