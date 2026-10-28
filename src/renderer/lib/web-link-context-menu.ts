import type { NativeContextMenuItem } from "../../shared/native-context-menu";
import { writeTextToClipboardStrict } from "./clipboard";
import { openExternalUrl } from "./file-system-operations";
import { showNativeContextMenu } from "./native-context-menu";
import { defineRendererCommand, invokePlainCommand } from "./renderer-command";
import { toast } from "@/components/ui/toast";

export interface WebLinkNavigation {
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
  const items: NativeContextMenuItem[] = [
    { id: "open-in-label", label: "Open in", enabled: false },
  ];
  if (navigation?.openTab)
    items.push({ id: "open-in-new-tab", label: "New tab", iconKey: "openIn" });
  if (navigation?.openTab && navigation.openWindow)
    items.push({ id: "open-in-new-window", label: "New window", iconKey: "window" });
  if (!navigation?.openTab || !navigation.isDefaultBrowser)
    items.push({ id: "open-in-external-browser", label: "Default browser", iconKey: "openIn" });
  items.push({ type: "separator" });
  if (selectedText) items.push({ id: "copy-selection", label: "Copy", iconKey: "copy" });
  items.push(
    { id: "copy-link", label: "Copy link", iconKey: "copy" },
    { id: "save-link-as", label: "Save link as…" },
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
    if (!started && input.isCurrent()) toast.danger("Unable to start download");
    return;
  }
  if (selected === "open-in-new-tab") {
    await input.navigation?.openTab?.(input.url);
    return;
  }
  if (selected === "open-in-new-window" && input.navigation?.openTab) {
    await input.navigation.openWindow?.(input.url);
    return;
  }
  if (
    selected === "open-in-external-browser" &&
    (!input.navigation?.openTab || !input.navigation.isDefaultBrowser)
  )
    await openExternalUrl(input.url);
}
