import { getIntl } from "@/lib/i18n";
import type { NativeContextMenuItem } from "../../shared/native-context-menu";
import type { NodexDestination, NodexReferenceGesture } from "../../shared/nodex-reference";
import { writeTextToClipboardStrict } from "./clipboard";
import { canShowNativeContextMenu, showNativeContextMenu } from "./native-context-menu";

type NodexReferenceMenuAction = Extract<NodexReferenceGesture, { kind: "menu" }>["action"];

/** The same actions for every Page, View and chat reference, named for what they open. */
export function buildNodexReferenceContextMenu(input: {
  readonly destination: NodexDestination;
  readonly openable: boolean;
}): NativeContextMenuItem[] {
  const intl = getIntl();
  const chat = input.destination.kind === "session";
  const items: NativeContextMenuItem[] = [];
  if (input.openable) {
    items.push({
      id: "open",
      label: chat
        ? intl.formatMessage({ id: "lib.nodexReferenceMenu.openChat", defaultMessage: "Open chat" })
        : input.destination.kind === "view"
          ? intl.formatMessage({
              id: "lib.nodexReferenceMenu.openView",
              defaultMessage: "Open view",
            })
          : intl.formatMessage({
              id: "lib.nodexReferenceMenu.openPage",
              defaultMessage: "Open page",
            }),
      iconKey: "openIn",
    });
    if (!chat)
      items.push({
        id: "new-tab",
        label: intl.formatMessage({
          id: "lib.nodexReferenceMenu.openInNewTab",
          defaultMessage: "Open in new tab",
        }),
        iconKey: "newTab",
      });
    if (input.destination.kind !== "view")
      items.push({
        id: "new-window",
        label: intl.formatMessage({
          id: "lib.nodexReferenceMenu.openInNewWindow",
          defaultMessage: "Open in new window",
        }),
        iconKey: "window",
      });
    items.push({ type: "separator" });
  }
  items.push({
    id: "copy-link",
    label: intl.formatMessage({
      id: "lib.nodexReferenceMenu.copyLink",
      defaultMessage: "Copy link",
    }),
    iconKey: "copy",
  });
  return items;
}

/** The menu is native; its choice is applied only while the reference is still mounted. */
export async function openNodexReferenceContextMenu(input: {
  readonly destination: NodexDestination;
  readonly link: string;
  readonly openable: boolean;
  readonly x: number;
  readonly y: number;
  readonly isCurrent: () => boolean;
  readonly open: (action: NodexReferenceMenuAction) => void;
}): Promise<boolean> {
  if (!canShowNativeContextMenu()) return false;
  const selected = await showNativeContextMenu(buildNodexReferenceContextMenu(input), {
    x: input.x,
    y: input.y,
  });
  if (!selected || !input.isCurrent()) return true;
  if (selected === "copy-link") await writeTextToClipboardStrict(input.link);
  else if (selected === "open" || selected === "new-tab" || selected === "new-window")
    input.open(selected);
  return true;
}
