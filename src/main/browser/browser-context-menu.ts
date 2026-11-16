import type { MenuItemConstructorOptions } from "electron";
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
  return (
    params.mediaType === "image" &&
    params.hasImageContents &&
    params.linkURL.length === 0 &&
    params.srcURL.length > 0
  );
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

  if (canAnnotate) {
    template.push(
      {
        label: getMainIntl().formatMessage({
          id: "main.contextMenu.quickAnnotate",
          defaultMessage: "Quick annotate",
        }),
        click: () => actions.annotate("quick-annotate"),
      },
      {
        label: getMainIntl().formatMessage({
          id: "main.contextMenu.annotate",
          defaultMessage: "Annotate",
        }),
        click: () => actions.annotate("annotate"),
      },
    );
    pushSeparator(template);
  }

  if (canAttachImage(params)) {
    template.push({
      label: getMainIntl().formatMessage({
        id: "main.contextMenu.attachImage",
        defaultMessage: "Attach image to chat",
      }),
      click: () => actions.attachImage(params.srcURL),
    });
    pushSeparator(template);
  }

  const hasLink = params.linkURL.length > 0;
  if (hasLink) {
    const itemCountBeforeLinkActions = template.length;
    if (isHttpUrl(params.linkURL)) {
      template.push(
        {
          label: getMainIntl().formatMessage({
            id: "main.contextMenu.openInTab",
            defaultMessage: "Open in new tab",
          }),
          click: () => actions.openLink(params.linkURL),
        },
        {
          label: getMainIntl().formatMessage({
            id: "main.contextMenu.openInWindow",
            defaultMessage: "Open in new window",
          }),
          click: () => actions.openWindow(params.linkURL),
        },
      );
    }
    if (isExternallyOpenableUrl(params.linkURL)) {
      template.push({
        label: getMainIntl().formatMessage({
          id: "main.contextMenu.openExternal",
          defaultMessage: "Open in external browser",
        }),
        click: () => actions.openExternal(params.linkURL),
      });
    }
    if (template.length > itemCountBeforeLinkActions) pushSeparator(template);
  }

  const hasSelection = hasCopyableSelection(params);
  if (hasLink || params.isEditable || hasSelection) {
    if (hasLink) {
      template.push({
        label: getMainIntl().formatMessage({
          id: "main.contextMenu.copyLink",
          defaultMessage: "Copy link address",
        }),
        click: () => actions.copyLink(params.linkURL),
      });
    }
    if (params.isEditable) {
      template.push(
        {
          role: "cut",
          enabled: params.editFlags.canCut,
        },
        {
          role: "copy",
          enabled: params.editFlags.canCopy,
        },
        {
          role: "paste",
          enabled: params.editFlags.canPaste,
        },
      );
    } else if (hasSelection) {
      template.push({
        role: "copy",
        enabled: params.editFlags.canCopy,
      });
    }
    pushSeparator(template);
  }

  if (isPlainPageContext(params)) {
    template.push(
      {
        label: getMainIntl().formatMessage({ id: "main.contextMenu.back", defaultMessage: "Back" }),
        enabled: canGoBack,
        click: actions.back,
      },
      {
        label: getMainIntl().formatMessage({
          id: "main.contextMenu.forward",
          defaultMessage: "Forward",
        }),
        enabled: canGoForward,
        click: actions.forward,
      },
      {
        label: getMainIntl().formatMessage({
          id: "main.contextMenu.reload",
          defaultMessage: "Reload",
        }),
        enabled: canReload,
        click: actions.reload,
      },
    );
    pushSeparator(template);
  }

  template.push({
    label: getMainIntl().formatMessage({
      id: "main.contextMenu.inspect",
      defaultMessage: "Inspect",
    }),
    click: () => actions.inspect({ x: params.x, y: params.y }),
  });
  return template;
}
