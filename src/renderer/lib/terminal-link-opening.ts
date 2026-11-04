import { WebLinksAddon } from "@xterm/addon-web-links";
import type { Terminal } from "@xterm/xterm";
import type { LinkOpenRequest } from "../../shared/link-opening";
import { snapshotLinkActivation } from "./link-activation";

/** OSC 8 and detected web links share the same activation and host snapshot. */
export function installTerminalLinkOpening(
  terminal: Pick<Terminal, "options" | "loadAddon">,
  readOwner: () => {
    readonly hostId: string;
    readonly openLink: (request: LinkOpenRequest) => Promise<boolean>;
  },
): void {
  const activate = (event: MouseEvent, url: string) => {
    event.preventDefault();
    const owner = readOwner();
    void owner.openLink({
      url,
      hostId: owner.hostId,
      initiator: "terminal_link_click",
      activation: snapshotLinkActivation(event),
    });
  };
  terminal.options.linkHandler = { activate };
  terminal.loadAddon(new WebLinksAddon(activate));
}
