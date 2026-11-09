import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { JoinSpaceDialog } from "./join-space-dialog";

const runtime = vi.hoisted(() => ({ join: vi.fn(), switch: vi.fn() }));
vi.mock("./spaces-runtime", () => ({ joinSpace: runtime.join, switchSpace: runtime.switch }));
beforeEach(() => {
  runtime.join.mockReset();
  runtime.switch.mockReset();
});

test("pins the invite's certificate and joins with the person's device identity", async () => {
  runtime.join.mockResolvedValue({ spaceId: "team" });
  runtime.switch.mockResolvedValue(undefined);
  const close = vi.fn();
  const view = render(<JoinSpaceDialog onClose={close} />);
  const fingerprint = "a".repeat(64);
  await act(async () => {
    fireEvent.change(view.getByLabelText("Invite URL"), {
      target: { value: `https://team.example?fingerprint=${fingerprint}` },
    });
    fireEvent.change(view.getByLabelText("One-time code"), { target: { value: "one-use-code" } });
    fireEvent.change(view.getByLabelText("Your name"), { target: { value: "Alice" } });
    await Promise.resolve();
  });
  expect(view.getByText("Certificate pinned")).toBeTruthy();
  expect(view.queryByLabelText("Certificate fingerprint")).toBeNull();
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: /^Join$/ }));
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(runtime.join).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Alice", deviceLabel: "Desktop", fingerprint }),
    ),
  );
  await waitFor(() => expect(runtime.switch).toHaveBeenCalledWith("team"));
  expect(close).toHaveBeenCalledOnce();
});

test("asks for the fingerprint when the invite carries none and never keeps a stale pin", async () => {
  const view = render(<JoinSpaceDialog onClose={vi.fn()} />);
  await act(async () => {
    fireEvent.change(view.getByLabelText("Invite URL"), {
      target: { value: `https://team.example?fingerprint=${"b".repeat(64)}` },
    });
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.change(view.getByLabelText("Invite URL"), {
      target: { value: "https://other.example" },
    });
    await Promise.resolve();
  });
  expect(view.queryByText("Certificate pinned")).toBeNull();
  expect((view.getByLabelText("Certificate fingerprint") as HTMLInputElement).value).toBe("");
});

test("refuses a name Core would refuse, with the reason beside the field", async () => {
  const view = render(<JoinSpaceDialog onClose={vi.fn()} />);
  await act(async () => {
    fireEvent.change(view.getByLabelText("Invite URL"), {
      target: { value: `https://team.example?fingerprint=${"c".repeat(64)}` },
    });
    fireEvent.change(view.getByLabelText("One-time code"), { target: { value: "one-use-code" } });
    fireEvent.change(view.getByLabelText("Your name"), { target: { value: " you " } });
    await Promise.resolve();
  });
  expect(view.getByRole("alert").textContent).toBe(
    "Choose a name others will recognize; Nodex shows each person their own actions as You",
  );
  expect(view.getByLabelText("Your name").getAttribute("aria-invalid")).toBe("true");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: /^Join$/ }));
    await Promise.resolve();
  });
  expect(runtime.join).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.change(view.getByLabelText("Your name"), { target: { value: "Alice" } });
    await Promise.resolve();
  });
  expect(view.queryByRole("alert")).toBeNull();
});
