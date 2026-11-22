import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { render } from "@/test/dom";
import type { AntigravityAuthMethod } from "../../../shared/agents/antigravity";
import { providerSnapshot } from "../acp-agents/acp-agents.test-fixtures";
import { AntigravityAccountRow } from "./antigravity-account-row";
import { authState, fakeAccountRuntime, ok } from "./agent-account.test-fixtures";

const { runtime, readCatalog, subscribe, openExternalUrl } = vi.hoisted(() => ({
  runtime: { read: vi.fn(), start: vi.fn(), respond: vi.fn(), cancel: vi.fn(), logout: vi.fn() },
  readCatalog: vi.fn(),
  subscribe: vi.fn(),
  openExternalUrl: vi.fn(async () => true),
}));
vi.mock("../../lib/agent-accounts-runtime", () => ({
  agentAccountsRuntime: runtime,
  agentAccountCatalog: { read: readCatalog, subscribe },
}));
vi.mock("@/lib/file-system-operations", () => ({ openExternalUrl }));

const press = async (element: HTMLElement) =>
  act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });

function mount(authMethod: AntigravityAuthMethod, instanceConfigId: string) {
  const backend = { driver: "antigravity", instanceId: instanceConfigId } as const;
  const fake = fakeAccountRuntime();
  runtime.read.mockImplementation(fake.read);
  runtime.start.mockImplementation(fake.start);
  runtime.respond.mockImplementation(fake.respond);
  runtime.cancel.mockImplementation(fake.cancel);
  runtime.logout.mockImplementation(fake.logout);
  let changed: (() => void) | undefined;
  subscribe.mockImplementation((listener: () => void) => {
    changed = listener;
    return () => {
      changed = undefined;
    };
  });
  const setAuth = (auth: ReturnType<typeof providerSnapshot>["auth"]) => {
    readCatalog.mockResolvedValue([
      providerSnapshot({
        driver: "antigravity",
        instanceId: backend.instanceId!,
        auth,
      }),
    ]);
    return changed?.();
  };
  setAuth({ status: "unauthenticated" });
  const view = render(<AntigravityAccountRow backend={backend} authMethod={authMethod} />);
  const startButton = async (name: string) => {
    const button = await view.findByRole("button", { name });
    await waitFor(() => expect(button.getAttribute("aria-disabled")).not.toBe("true"));
    return button;
  };
  return { backend, fake, setAuth, view, startButton };
}

const googleUrl = "https://accounts.google.com/example";
const waiting = authState({
  phase: "waiting",
  flowId: "flow",
  authorizationUrl: googleUrl,
  interaction: {
    type: "credentials",
    id: "code",
    fields: [{ name: "code", secret: false, label: "Code from the Antigravity page" }],
  },
});

test("Google sign-in opens the link, sends the pasted URL, and displays the refreshed account", async () => {
  const { backend, view, fake, setAuth, startButton } = mount("oauth-personal", "browser");
  fake.start.mockResolvedValue(ok(waiting));
  fake.read.mockResolvedValue(ok(waiting));
  const response = authState({ phase: "succeeded", flowId: "flow", revision: 2 });
  fake.respond.mockImplementation(async () => {
    setAuth({ status: "authenticated", email: "person@example.test" });
    return ok(response);
  });
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  try {
    await press(await startButton("Sign in"));
    await press(await view.findByRole("button", { name: "Open browser" }));
    expect(openExternalUrl).toHaveBeenCalledWith(googleUrl);
    await press(view.getByRole("button", { name: "Copy sign-in link" }));
    expect(writeText).toHaveBeenCalledWith(googleUrl);

    const input = view.getByRole("textbox", { name: "Code from the Antigravity page" });
    const finalUrl = "https://antigravity.example.test/complete?code=fixture";
    await act(async () => {
      fireEvent.change(input, { target: { value: finalUrl } });
      await Promise.resolve();
    });
    await press(view.getByRole("button", { name: "Continue" }));
    expect(fake.respond).toHaveBeenCalledExactlyOnceWith({
      backend,
      flowId: "flow",
      interactionId: "code",
      response: { type: "credentials", values: { code: finalUrl } },
    });
    await view.findByText("Signed in as person@example.test");
  } finally {
    Reflect.deleteProperty(navigator, "clipboard");
  }
});

test("an API key connects directly, and sign-out requires confirmation", async () => {
  const { backend, view, fake, setAuth, startButton } = mount("gemini-api-key", "key");
  fake.start.mockImplementation(async () => {
    setAuth({ status: "authenticated" });
    return ok(authState({ phase: "succeeded", flowId: "key-flow" }));
  });
  fake.logout.mockImplementation(async () => {
    setAuth({ status: "unauthenticated" });
    return ok(authState());
  });
  await press(await startButton("Connect"));
  expect(fake.start).toHaveBeenCalledExactlyOnceWith({ backend });
  await view.findByText("Connected");
  expect(view.queryByRole("button", { name: "Open browser" })).toBeNull();
  await press(view.getByRole("button", { name: "Sign out" }));
  const dialog = await view.findByRole("dialog", { name: "Sign out of Antigravity?" });
  expect(fake.logout).not.toHaveBeenCalled();
  expect(
    within(dialog).getByText("Running chats on this profile will stop. Their history is kept."),
  ).toBeTruthy();
  await press(within(dialog).getByRole("button", { name: "Sign out" }));
  expect(fake.logout).toHaveBeenCalledExactlyOnceWith({ backend });
  await view.findByRole("button", { name: "Connect" });
});

test("unmounting the Antigravity row cancels its owned sign-in", async () => {
  const { backend, view, fake, startButton } = mount("oauth-business", "closing");
  fake.start.mockResolvedValue(ok(waiting));
  fake.read.mockResolvedValue(ok(waiting));
  await press(await startButton("Sign in"));
  await view.findByRole("button", { name: "Cancel" });
  view.unmount();
  expect(fake.cancel).toHaveBeenCalledExactlyOnceWith({ backend, flowId: "flow" });
});
