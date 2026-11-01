import { fireEvent, screen, waitFor } from "@testing-library/react";
import { act, createRef } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
import { render, settleAsyncRender } from "@/test/dom";
import type { BrowserPermissionPrompt } from "../../../shared/browser/browser-permissions";
import {
  BrowserPermissionPromptPopover,
  permissionActionLabel,
  permissionDescriptorLabel,
} from "./browser-permission-prompt";

function prompt(overrides: Partial<BrowserPermissionPrompt> = {}): BrowserPermissionPrompt {
  return {
    id: "prompt-1",
    origin: "https://meet.example.com",
    permissions: [{ name: "camera" }, { name: "microphone" }],
    actions: ["allow", "allow-this-time", "deny", "dismiss"],
    variant: "permission",
    mountGeneration: 3,
    ...overrides,
  };
}

function renderPrompt(
  value: BrowserPermissionPrompt | null,
  handlers: {
    onRespond?: (prompt: BrowserPermissionPrompt, action: string) => Promise<boolean>;
    onOpenSystemSettings?: (prompt: BrowserPermissionPrompt) => Promise<boolean>;
  } = {},
) {
  const anchor = createRef<HTMLDivElement>();
  const onRespond = vi.fn(handlers.onRespond ?? (async () => true));
  const onOpenSystemSettings = vi.fn(handlers.onOpenSystemSettings ?? (async () => true));
  const view = render(
    <div>
      <div ref={anchor}>address</div>
      <BrowserPermissionPromptPopover
        prompt={value}
        anchor={anchor}
        onRespond={onRespond}
        onOpenSystemSettings={onOpenSystemSettings}
      />
    </div>,
  );
  return { view, onRespond, onOpenSystemSettings };
}

describe("permission wording", () => {
  test("offers while-visiting, this-time and never when a temporary grant exists", () => {
    const value = prompt();
    expect(permissionActionLabel(value, "allow")).toBe("Allow while visiting the site");
    expect(permissionActionLabel(value, "allow-this-time")).toBe("Allow this time");
    expect(permissionActionLabel(value, "deny")).toBe("Never allow");
    const permanentOnly = prompt({ actions: ["allow", "deny", "dismiss"] });
    expect(permissionActionLabel(permanentOnly, "allow")).toBe("Allow");
    expect(permissionActionLabel(permanentOnly, "deny")).toBe("Block");
  });

  test("names the protocol an external app link would open", () => {
    expect(
      permissionDescriptorLabel({ name: "open-external", externalUrl: "zoommtg://join?id=1" }),
    ).toBe("Open zoommtg: links with another app");
    expect(permissionDescriptorLabel({ name: "geolocation" })).toBe("Know your location");
  });
});

describe("permission prompt", () => {
  test("asks for every requested permission and sends the chosen answer", async () => {
    const { onRespond } = renderPrompt(prompt());
    const dialog = await screen.findByRole("dialog", {
      name: "Website permission request from meet.example.com",
    });
    expect(dialog.textContent).toContain("meet.example.com wants to");
    expect(screen.getByText("Use your cameras")).toBeTruthy();
    expect(screen.getByText("Use your microphones")).toBeTruthy();
    expect(
      screen
        .getAllByRole("button")
        .map((button) => button.textContent || button.getAttribute("aria-label")),
    ).toEqual([
      "Close permission request",
      "Allow while visiting the site",
      "Allow this time",
      "Never allow",
    ]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Allow this time" }));
      await settleAsyncRender();
    });
    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ id: "prompt-1" }),
      "allow-this-time",
    );
  });

  test("the close button sets the request aside", async () => {
    const { onRespond } = renderPrompt(prompt());
    const close = await screen.findByRole("button", { name: "Close permission request" });
    await act(async () => {
      fireEvent.click(close);
      await settleAsyncRender();
    });
    expect(onRespond).toHaveBeenCalledWith(expect.objectContaining({ id: "prompt-1" }), "dismiss");
  });

  test("says when an answer could not be sent and lets the user try again", async () => {
    const { onRespond } = renderPrompt(prompt(), { onRespond: async () => false });
    const never = await screen.findByRole("button", { name: "Never allow" });
    await act(async () => {
      fireEvent.click(never);
      await settleAsyncRender();
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn’t send your choice. Try again",
    );
    expect(screen.getByRole("button", { name: "Never allow" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(onRespond).toHaveBeenCalledTimes(1);
  });

  test("points to system settings when the system blocks the permission", async () => {
    const value = prompt({ variant: "os-system-settings", actions: ["dismiss"] });
    const { onOpenSystemSettings } = renderPrompt(value);
    expect((await screen.findByRole("dialog")).textContent).toContain(
      "Your system settings block these permissions for meet.example.com",
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open system settings" }));
      await settleAsyncRender();
    });
    expect(onOpenSystemSettings).toHaveBeenCalledWith(expect.objectContaining({ id: "prompt-1" }));
  });

  test("shows nothing without a pending request", async () => {
    renderPrompt(null);
    await settleAsyncRender();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
