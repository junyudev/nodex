import { StrictMode } from "react";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { render } from "../../test/dom";
import type { ImportableBrowserProfile } from "../../../shared/browser-profile";
import { BrowserProfileImportDialog } from "./browser-profile-import-dialog";

const runtime = vi.hoisted(() => ({ capabilities: vi.fn(), profiles: vi.fn(), import: vi.fn() }));
vi.mock("./browser-profile-runtime", () => ({
  readBrowserProfileCapabilities: runtime.capabilities,
  readImportableBrowserProfiles: runtime.profiles,
  importBrowserProfile: runtime.import,
}));

test("reopening clears the import error and applies the inspected Profile's available data", async () => {
  const profile: ImportableBrowserProfile = {
    source: "chrome",
    appName: "Chrome",
    profileName: "Default",
    profileDirectoryName: "Default",
    profilePath: "/chrome/Default",
    rootPath: "/chrome",
    hasCookies: true,
    hasPasswords: true,
    sourceBrowserOpen: false,
  };
  runtime.capabilities.mockResolvedValue({
    profileImport: { available: true },
    credentialVault: { available: true },
  });
  runtime.profiles.mockResolvedValue([profile]);
  runtime.import.mockRejectedValue(new Error("Import failed"));
  const onOpenChange = () => undefined;
  const dialog = (open: boolean) => (
    <StrictMode>
      <BrowserProfileImportDialog open={open} onOpenChange={onOpenChange} />
    </StrictMode>
  );
  const view = render(dialog(true));
  const importButton = await view.findByRole("button", { name: "Import" });
  await act(async () => {
    fireEvent.click(importButton);
  });
  expect(await view.findByText("Import failed")).toBeTruthy();
  await act(async () => {
    view.rerender(dialog(false));
  });
  runtime.profiles.mockResolvedValue([{ ...profile, hasPasswords: false }]);
  await act(async () => {
    view.rerender(dialog(true));
  });
  await waitFor(() => {
    const passwords = view.getByRole("checkbox", { name: /^Passwords/ }) as HTMLInputElement;
    expect(passwords.checked).toBe(false);
    expect(passwords.disabled).toBe(true);
    expect((view.getByRole("checkbox", { name: /^Cookies/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(view.queryByText("Import failed")).toBeNull();
  });
});
