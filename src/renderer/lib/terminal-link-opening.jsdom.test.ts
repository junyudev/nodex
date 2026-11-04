import { expect, test, vi } from "vite-plus/test";
import type { Terminal, ITerminalAddon } from "@xterm/xterm";
import { installTerminalLinkOpening } from "./terminal-link-opening";
const addon = vi.hoisted(() => ({
  activate: null as null | ((event: MouseEvent, uri: string) => void),
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    constructor(handler: (event: MouseEvent, uri: string) => void) {
      addon.activate = handler;
    }
  },
}));

test("OSC 8 and web-link addon activation capture platform modifiers and the terminal's current host", () => {
  const openLink = vi.fn(async () => true);
  let hostId = "ssh:first";
  const terminal: Pick<Terminal, "options" | "loadAddon"> = {
    options: {},
    loadAddon: vi.fn<(addon: ITerminalAddon) => void>(),
  };
  installTerminalLinkOpening(terminal, () => ({ hostId, openLink }));
  const event = new MouseEvent("click", { button: 1, ctrlKey: true, shiftKey: true });
  terminal.options.linkHandler!.activate(event, "http://localhost:5173/", {
    start: { x: 1, y: 1 },
    end: { x: 20, y: 1 },
  });
  expect(openLink).toHaveBeenLastCalledWith(
    expect.objectContaining({
      url: "http://localhost:5173/",
      hostId: "ssh:first",
      initiator: "terminal_link_click",
      activation: expect.objectContaining({ button: 1, ctrlKey: true, shiftKey: true }),
    }),
  );
  hostId = "ssh:second";
  addon.activate!(new MouseEvent("click", { altKey: true }), "https://example.com/");
  expect(openLink).toHaveBeenLastCalledWith(
    expect.objectContaining({
      url: "https://example.com/",
      hostId: "ssh:second",
      initiator: "terminal_link_click",
      activation: expect.objectContaining({ altKey: true }),
    }),
  );
  expect(openLink).toHaveBeenCalledTimes(2);
});
