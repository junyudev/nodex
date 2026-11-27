import type { MenuItemConstructorOptions } from "electron";
import { getNativeMenuIcon } from "../native-menu-icons";
import { getMainIntl } from "../i18n/main-intl";
import { isExternallyOpenableUrl, isHttpUrl } from "../../shared/browser-url-policy";

export interface BrowserContextMenuParams {
  x: number;
  y: number;
  linkURL: string;
  srcURL: string;
  mediaType: "none" | "image" | "audio" | "video" | "canvas" | "file" | "plugin";
  hasImageContents: boolean;
  isEditable: boolean;
  selectionText: string;
  formControlType: string;
  editFlags: {
    canCopy: boolean;
    canCut: boolean;
    canPaste: boolean;
  };
}

interface BrowserContextMenuActions {
  annotate(mode: "annotate" | "quick-annotate"): void;
  attachImage(sourceUrl: string): void;
  back(): void;
  copyLink(url: string): void;
  forward(): void;
  inspect(point: { x: number; y: number }): void;
  openExternal(url: string): void;
  openLink(url: string): void;
  openWindow(url: string): void;
  reload(): void;
}

interface BuildBrowserContextMenuInput {
  actions: BrowserContextMenuActions;
  canAnnotate: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  canReload: boolean;
  params: BrowserContextMenuParams;
}

function isPlainPageContext(params: BrowserContextMenuParams): boolean {
  return (
    !params.isEditable &&
    params.formControlType === "none" &&
    params.mediaType === "none" &&
    params.linkURL.length === 0 &&
    params.srcURL.length === 0 &&
    params.selectionText.length === 0
  );
}

function canAttachImage(params: BrowserContextMenuParams): boolean {
  return params.mediaType === "image" && params.hasImageContents && params.srcURL.length > 0;
}

function hasCopyableSelection(params: BrowserContextMenuParams): boolean {
  return !params.formControlType.endsWith("password") && params.selectionText.trim().length > 0;
}

function pushSeparator(template: MenuItemConstructorOptions[]): void {
  if (template.length === 0 || template.at(-1)?.type === "separator") return;
  template.push({ type: "separator" });
}

export function buildBrowserContextMenuTemplate({
  actions,
  canAnnotate,
  canGoBack,
  canGoForward,
  canReload,
  params,
}: BuildBrowserContextMenuInput): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];

  const hasLink = params.linkURL.length > 0;
  if (hasLink) {
    if (isHttpUrl(params.linkURL)) {
      template.push(
        {
          label: getMainIntl().formatMessage({
            id: "main.contextMenu.openInTab",
            defaultMessage: "Open in new tab",
          }),
          icon: getNativeMenuIcon("newTab"),
          click: () => actions.openLink(params.linkURL),
        },
        {
          label: getMainIntl().formatMessage({
            id: "main.contextMenu.openInWindow",
            defaultMessage: "Open in new window",
          }),
          icon: getNativeMenuIcon("window"),
          click: () => actions.openWindow(params.linkURL),
        },
      );
    }
    if (isExternallyOpenableUrl(params.linkURL)) {
      template.push({
        label: getMainIntl().formatMessage({
          id: "main.contextMenu.openExternal",
          defaultMessage: "Open in default browser",
        }),
        icon: getNativeMenuIcon("openIn"),
        click: () => actions.openExternal(params.linkURL),
      });
    }
  }

  const edits: MenuItemConstructorOptions[] = [];
  if (hasLink) {
    edits.push({
      label: getMainIntl().formatMessage({
        id: "main.contextMenu.copyLink",
        defaultMessage: "Copy link",
      }),
      icon: getNativeMenuIcon("link"),
      click: () => actions.copyLink(params.linkURL),
    });
  }
  if (params.isEditable && params.editFlags.canCut) {
    edits.push({ role: "cut", icon: getNativeMenuIcon("cut") });
  }
  if ((params.isEditable || hasCopyableSelection(params)) && params.editFlags.canCopy) {
    edits.push({ role: "copy", icon: getNativeMenuIcon("copy") });
  }
  if (params.isEditable && params.editFlags.canPaste) {
    edits.push({ role: "paste", icon: getNativeMenuIcon("paste") });
  }
  if (edits.length > 0) {
    pushSeparator(template);
    template.push(...edits);
  }

  if (isPlainPageContext(params)) {
    if (canGoBack)
      template.push({
        label: getMainIntl().formatMessage({ id: "main.contextMenu.back", defaultMessage: "Back" }),
        icon: getNativeMenuIcon("back"),
        click: actions.back,
      });
    if (canGoForward)
      template.push({
        label: getMainIntl().formatMessage({
          id: "main.contextMenu.forward",
          defaultMessage: "Forward",
        }),
        icon: getNativeMenuIcon("forward"),
        click: actions.forward,
      });
    if (canReload)
      template.push({
        label: getMainIntl().formatMessage({
          id: "main.contextMenu.reload",
          defaultMessage: "Reload",
        }),
        icon: getNativeMenuIcon("reload"),
        click: actions.reload,
      });
  }

  if (canAnnotate) {
    pushSeparator(template);
    template.push(
      {
        label: getMainIntl().formatMessage({
          id: "main.contextMenu.quickAnnotate",
          defaultMessage: "Quick annotate",
        }),
        icon: getNativeMenuIcon("annotate"),
        click: () => actions.annotate("quick-annotate"),
      },
      {
        label: getMainIntl().formatMessage({
          id: "main.contextMenu.annotate",
          defaultMessage: "Annotate",
        }),
        icon: getNativeMenuIcon("annotate"),
        click: () => actions.annotate("annotate"),
      },
    );
  }

  if (canAttachImage(params)) {
    pushSeparator(template);
    template.push({
      label: getMainIntl().formatMessage({
        id: "main.contextMenu.attachImage",
        defaultMessage: "Add to chat",
      }),
      icon: getNativeMenuIcon("attach"),
      click: () => actions.attachImage(params.srcURL),
    });
  }

  pushSeparator(template);
  template.push({
    label: getMainIntl().formatMessage({
      id: "main.contextMenu.inspect",
      defaultMessage: "Inspect",
    }),
    icon: getNativeMenuIcon("inspect"),
    click: () => actions.inspect({ x: params.x, y: params.y }),
  });
  return template;
}
