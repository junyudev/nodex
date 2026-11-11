import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { DEFAULT_BROWSER_USE_POLICY } from "../../../shared/browser-use-policy";
import { DEFAULT_LINK_OPENING_SETTINGS } from "../../../shared/link-opening-settings";
import { render, settleAsyncRender } from "../../test/dom";
import { TestQueryProvider } from "../../test/query";
import { BrowserSettingsPage } from "./browser-settings-pages";

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
});

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@/lib/renderer-command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/renderer-command")>()),
  invokePlainCommand: (definition: { readonly channel: string }, ...args: readonly unknown[]) =>
    invokeMock(definition.channel, ...args),
  invokePlainCommandWithTrace: (
    definition: { readonly channel: string },
    _trace: unknown,
    ...args: readonly unknown[]
  ) => invokeMock(definition.channel, ...args),
  invokeRendererQuery: (...args: readonly unknown[]) => invokeMock(...args),
}));

const capabilities = {
  contactInfo: { available: true, provider: "test" },
  credentialVault: { available: true, provider: "test" },
  extensions: { available: true, provider: "test" },
  history: { available: true, provider: "test" },
  profileImport: { available: true, provider: "test" },
  siteInfo: { available: true, provider: "test" },
};

function configureInvokeMock(unregistered = false) {
  invokeMock.mockImplementation(async (channel: string) => {
    if (channel === "browser-profile-capabilities") return capabilities;
    if (channel === "settings:link-opening:get") return DEFAULT_LINK_OPENING_SETTINGS;
    if (channel === "browser-use-policy-get") return DEFAULT_BROWSER_USE_POLICY;
    if (channel === "browser-use-policy-update-modes") return DEFAULT_BROWSER_USE_POLICY;
    if (channel === "browser-use-policy-update-origin-rule") return DEFAULT_BROWSER_USE_POLICY;
    if (channel === "chrome-control-settings-get") {
      return {
        bundleSupported: true,
        extensionConnected: false,
        nativeHostInstalled: !unregistered,
        providerReady: false,
        reason: unregistered
          ? "To register with your browsers, launch with vp run dev --register-browser-host."
          : "Waiting for a supported browser extension",
        requested: true,
        revision: 1,
        status: unregistered ? "registration-disabled" : "extension-disconnected",
      };
    }
    if (channel === "browser-credentials-list-all") return [];
    if (channel === "browser-contact-info-list") return [];
    if (channel === "browser-history-list") return { entries: [] };
    if (channel === "browser-extensions-list") {
      return { capability: capabilities.extensions, extensions: [] };
    }
    if (channel === "browser-downloads-list") return { downloads: [] };
    return { ok: true };
  });
}

function renderBrowser({
  browserDetail = null,
  unregistered = false,
  onOpenBrowserDetail = () => undefined,
}: {
  unregistered?: boolean;
  browserDetail?: "passwords" | "contact-info" | "history" | "extensions" | "downloads" | null;
  onOpenBrowserDetail?: (destination: string, anchor?: string) => void;
} = {}) {
  configureInvokeMock(unregistered);
  return render(
    <TestQueryProvider>
      <BrowserSettingsPage
        browserAnchor={null}
        browserDetail={browserDetail}
        onOpenBrowserDetail={onOpenBrowserDetail}
        open
      />
    </TestQueryProvider>,
  );
}

describe("Browser settings information architecture", () => {
  test("explains how to register Chrome control from development", async () => {
    renderBrowser({ unregistered: true });
    expect(await screen.findByText("Not registered (development instance)")).toBeTruthy();
    expect(screen.getByText(/vp run dev --register-browser-host/u)).toBeTruthy();
    expect(screen.queryByText("Waiting for extension")).toBeNull();
  });

  test("keeps browser management actions inside one overview page", async () => {
    const onOpenBrowserDetail = vi.fn();
    renderBrowser({ onOpenBrowserDetail });
    await settleAsyncRender();

    expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
    expect(
      await screen.findByRole("button", {
        name: "Web URL and link open destination: Default browser",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Local URL open destination: Nodex" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Autofill and passwords" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Permissions" })).toBeTruthy();
    expect(screen.getByText("Control existing browsers")).toBeTruthy();
    expect(screen.getByText("Waiting for extension")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manage Password manager" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Passwords" })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Manage Password manager" }));
      await Promise.resolve();
    });

    expect(onOpenBrowserDetail).toHaveBeenCalledWith("passwords", "autofill-and-passwords");
  });

  test("renders browser detail with breadcrumb and keeps Browser as the owner", async () => {
    const onOpenBrowserDetail = vi.fn();
    renderBrowser({
      browserDetail: "passwords",
      onOpenBrowserDetail,
    });
    await settleAsyncRender();

    expect(screen.getByRole("heading", { name: "Password manager" })).toBeTruthy();
    expect(screen.getByText("Settings")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Browser" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Browser" }));
      await Promise.resolve();
    });

    expect(onOpenBrowserDetail).toHaveBeenCalledWith("browser", "autofill-and-passwords");
  });

  test("uses the shared menu for Browser Use policy choices", async () => {
    renderBrowser();
    await settleAsyncRender();

    expect(screen.queryByRole("combobox", { name: "Website access approval mode" })).toBeNull();

    await act(async () => {
      const trigger = screen.getByRole("button", { name: "Website access approval mode" });
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await Promise.resolve();
    });

    expect(screen.getByRole("menuitem", { name: "Never ask" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Never ask" }));
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledWith("browser-use-policy-update-modes", {
      approvalMode: "neverAsk",
    });
  });
});

test("Windows keeps built-in Browser settings while hiding unsupported host integrations", async () => {
  const root = document.documentElement;
  const previousOs = root.dataset.codexOs;
  root.dataset.codexOs = "win32";
  invokeMock.mockClear();
  try {
    const view = renderBrowser();
    await settleAsyncRender();
    expect(view.getByRole("heading", { name: "Browser", level: 1 })).toBeTruthy();
    expect(view.getByRole("button", { name: "Manage Browsing history" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Manage extensions" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Manage Download history" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Import" })).toBeNull();
    expect(view.queryByText("Profile import")).toBeNull();
    expect(view.queryByText("Control existing browsers")).toBeNull();
    expect(
      invokeMock.mock.calls.some(([channel]) => channel === "chrome-control-settings-get"),
    ).toBe(false);
    view.unmount();
  } finally {
    if (previousOs === undefined) delete root.dataset.codexOs;
    else root.dataset.codexOs = previousOs;
  }
});
