import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { renderWithQuery } from "@/test/query";
import { SpacesSettingsPage } from "./spaces-settings-page";

const team = {
  spaceId: "team",
  kind: "team" as const,
  name: "Platform",
  memberId: "member:jun",
  deviceId: "device:laptop",
  availability: "ready" as const,
};
const member = (id: string, displayName: string, role: "owner" | "member") => ({
  id,
  library_id: "team",
  display_name: displayName,
  lifecycle: "active" as const,
  role,
  revision: 1,
});
const me = member("member:jun", "Jun", "member");

const admin = vi.hoisted(() => ({ renameMember: vi.fn(), devices: vi.fn() }));
vi.mock("@/lib/space-administration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/space-administration")>()),
  devices: admin.devices,
  renameMember: admin.renameMember,
}));
vi.mock("@/lib/members-runtime", () => ({
  useLocalMember: () => ({ data: me }),
  useMembers: () => ({ data: [me, member("member:alice", "Alice", "owner")] }),
}));
vi.mock("./spaces-runtime", () => ({
  currentSpace: () => team,
  useSpaceConnections: () => ({ data: [team] }),
  leaveSpace: vi.fn(),
  switchSpace: vi.fn(),
}));
vi.mock("./join-space-dialog", () => ({ useOpenJoinSpace: () => vi.fn() }));
beforeEach(() => {
  admin.renameMember.mockReset();
  admin.devices.mockResolvedValue([]);
});

test("a Member renames themselves in People and is told why Core would refuse a name", async () => {
  admin.renameMember.mockResolvedValue(member("member:jun", "Jun Yu", "member"));
  renderWithQuery(<SpacesSettingsPage />);
  // Only an Owner renames the Space; everyone names themselves.
  expect(screen.queryByRole("button", { name: "Rename this Space" })).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Change your name" }));
    await Promise.resolve();
  });
  const field = screen.getByLabelText("Your name") as HTMLInputElement;
  expect(field.value).toBe("Jun");
  await act(async () => {
    fireEvent.change(field, { target: { value: "You" } });
    await Promise.resolve();
  });
  expect(screen.getByRole("alert").textContent).toBe(
    "Choose a name others will recognize; Nodex shows each person their own actions as You",
  );
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {
    fireEvent.change(field, { target: { value: "  Jun Yu " } });
    await Promise.resolve();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await Promise.resolve();
  });
  await waitFor(() => expect(admin.renameMember).toHaveBeenCalledWith({ name: "Jun Yu" }));
  await waitFor(() => expect(screen.queryByLabelText("Your name")).toBeNull());
});
