import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { WindowsStartupSettingsRow } from "./windows-startup-settings-row";

const state = vi.hoisted(() => ({ windows: true, query: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/settings-host-presentation", () => ({
  readSettingsHostPresentation: () => ({ launchAtLogin: state.windows }),
}));
vi.mock("@/lib/renderer-command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/renderer-command")>()),
  invokeRendererQuery: state.query,
  invokePlainCommand: state.open,
}));

beforeEach(() => {
  state.windows = true;
  state.query.mockReset().mockResolvedValue({ supported: true, enabled: true });
  state.open.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
});

test("refreshes Windows-owned enablement on return from Startup Apps", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <WindowsStartupSettingsRow open />
    </QueryClientProvider>,
  );
  try {
    await view.findByText("On");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Open Startup Apps" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(state.open).toHaveBeenCalledOnce());
    state.query.mockResolvedValue({ supported: true, enabled: false });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    await view.findByText("Off");
  } finally {
    view.unmount();
    client.clear();
  }
});

test("other hosts never query Windows startup registration", () => {
  state.windows = false;
  const view = render(<WindowsStartupSettingsRow open />);
  expect(view.queryByRole("button", { name: "Open Startup Apps" })).toBeNull();
  expect(state.query).not.toHaveBeenCalled();
});
