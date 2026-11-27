import { getIntl } from "@/lib/i18n";
import type { NativeContextMenuItem } from "../../shared/native-context-menu";
import { writeTextToClipboardStrict } from "./clipboard";
import { openLink, type LinkRouter } from "./link-opening";
import { showNativeContextMenu } from "./native-context-menu";
import { defineRendererCommand, invokePlainCommand } from "./renderer-command";
import { toast } from "@/components/ui/toast";

export interface WebLinkNavigation extends Partial<LinkRouter> {
  readonly openTab?: (url: string) => Promise<boolean>;
  readonly openWindow?: (url: string) => Promise<boolean>;
  readonly isDefaultBrowser?: boolean;
}

const saveWebLinkCommand = defineRendererCommand({
  key: "web_link.save",
  channel: "browser-link:save",
  authority: "external",
  owner: "BrowserDownloads",
  protocol: { kind: "returned_value" },
});

export function buildWebLinkContextMenu(input: {
  readonly navigation?: WebLinkNavigation;
  readonly selectedText?: string;
}): NativeContextMenuItem[] {
  const { navigation, selectedText } = input;
  const items: NativeContextMenuItem[] = [];
  if (navigation?.openTab)
    items.push({
      id: "open-in-new-tab",
      label: getIntl().formatMessage({
        id: "lib.webLinkContextMenu.newTab",
        defaultMessage: "Open in new tab",
      }),
      iconKey: "newTab",
    });
  if (navigation?.openWindow)
    items.push({
      id: "open-in-new-window",
      label: getIntl().formatMessage({
        id: "lib.webLinkContextMenu.newWindow",
        defaultMessage: "Open in new window",
      }),
      iconKey: "window",
    });
  if (!navigation?.openTab || !navigation.isDefaultBrowser)
    items.push({
      id: "open-in-external-browser",
      label: getIntl().formatMessage({
        id: "lib.webLinkContextMenu.defaultBrowser",
        defaultMessage: "Open in default browser",
      }),
      iconKey: "openIn",
    });
  items.push({ type: "separator" });
  if (selectedText)
    items.push({
      id: "copy-selection",
      label: getIntl().formatMessage({ id: "lib.webLinkContextMenu.copy", defaultMessage: "Copy" }),
      iconKey: "copy",
    });
  items.push(
    {
      id: "copy-link",
      label: getIntl().formatMessage({
        id: "lib.webLinkContextMenu.copyLink",
        defaultMessage: "Copy link",
      }),
      iconKey: "link",
    },
    {
      id: "save-link-as",
      label: getIntl().formatMessage({
        id: "lib.webLinkContextMenu.saveLinkAs",
        defaultMessage: "Download linked file",
      }),
      iconKey: "download",
    },
  );
  return items;
}

/** Link actions retain the captured selection and recheck their mounted source after the native menu. */
export async function openWebLinkContextMenu(input: {
  readonly url: string;
  readonly selectedText?: string;
  readonly navigation?: WebLinkNavigation;
  readonly x: number;
  readonly y: number;
  readonly isCurrent: () => boolean;
}): Promise<void> {
  if (!input.isCurrent() || !/^https?:\/\//iu.test(input.url)) return;
  const selected = await showNativeContextMenu(buildWebLinkContextMenu(input), {
    x: input.x,
    y: input.y,
  });
  if (!selected || !input.isCurrent()) return;
  if (selected === "copy-selection" && input.selectedText) {
    await writeTextToClipboardStrict(input.selectedText);
    return;
  }
  if (selected === "copy-link") {
    await writeTextToClipboardStrict(input.url);
    return;
  }
  if (selected === "save-link-as") {
    const started = await invokePlainCommand(saveWebLinkCommand, { url: input.url });
    if (!started && input.isCurrent())
      toast.danger(
        getIntl().formatMessage({
          id: "lib.webLinkContextMenu.downloadFailed",
          defaultMessage: "Unable to start download",
        }),
      );
    return;
  }
  if (selected === "open-in-new-tab") {
    await input.navigation?.openTab?.(input.url);
    return;
  }
  if (selected === "open-in-new-window") {
    await input.navigation?.openWindow?.(input.url);
    return;
  }
  if (
    selected === "open-in-external-browser" &&
    (!input.navigation?.openTab || !input.navigation.isDefaultBrowser)
  )
    await (input.navigation?.openLink ?? openLink)({
      url: input.url,
      initiator: "link_context_menu",
      openTarget: "external-browser",
    });
}
