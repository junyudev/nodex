import { expect, it, vi } from "vite-plus/test";
import { createLinkRouter } from "./link-opening";
import { DEFAULT_LINK_OPENING_SETTINGS } from "../../shared/link-opening-settings";

it("executes the resolved owner capability and captures it before asynchronous settings reads", async () => {
  const first = vi.fn(async () => true);
  const second = vi.fn(async () => true);
  let open = first;
  const external = vi.fn(async () => true);
  const router = createLinkRouter({
    browserAvailable: true,
    browser: () => ({ available: true, open }),
    readSettings: async () => {
      open = second;
      return DEFAULT_LINK_OPENING_SETTINGS;
    },
    openExternal: external,
  });
  await router.openLink({ url: "http://localhost:3000", initiator: "test" });
  expect(first).toHaveBeenCalledOnce();
  expect(second).not.toHaveBeenCalled();
  expect(external).not.toHaveBeenCalled();
  await router.openLink({
    url: "https://example.com",
    initiator: "test",
    openTarget: "external-browser",
  });
  expect(external).toHaveBeenCalledWith("https://example.com");
});
it("keeps unavailable contexts external, rejects invalid URLs and delegates Alt-only downloads", async () => {
  const open = vi.fn(async () => true);
  const external = vi.fn(async () => true);
  const saveLink = vi.fn(async () => true);
  const router = createLinkRouter({
    browserAvailable: false,
    browser: () => ({ available: false, open }),
    readSettings: async () => DEFAULT_LINK_OPENING_SETTINGS,
    openExternal: external,
    saveLink,
  });
  await router.openLink({
    url: "http://localhost:3000",
    initiator: "test",
    openTarget: "in-app-browser",
  });
  expect(external).toHaveBeenCalledWith("http://localhost:3000");
  expect(open).not.toHaveBeenCalled();
  expect(await router.openLink({ url: "javascript:alert(1)", initiator: "test" })).toBe(false);
  expect(external).toHaveBeenCalledOnce();
  await router.openLink({
    url: "https://example.com/file",
    initiator: "test",
    activation: { platform: "darwin", altKey: true },
  });
  expect(saveLink).toHaveBeenCalledWith("https://example.com/file");
  expect(external).toHaveBeenCalledOnce();
});
