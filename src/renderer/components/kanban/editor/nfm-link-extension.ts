import type { PasteRuleMatch } from "@tiptap/core";
import { markPasteRule } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { find } from "linkifyjs";
import { Link, isAllowedUri, type LinkOptions } from "@tiptap/extension-link";
import {
  readNfmAutolinkSettings,
  shouldAutoLinkMatchInText,
  shouldAutoLinkValue,
} from "@/lib/nfm-autolink-settings";

const DEFAULT_PROTOCOL = "https";

function shouldAutoLinkWhileTyping(url: string): boolean {
  const settings = readNfmAutolinkSettings();
  if (!settings.autoLinkWhileTyping) return false;
  return shouldAutoLinkValue(url, settings);
}

function shouldAutoLinkPasteMatch(
  fullText: string,
  startIndex: number,
  value: string,
): boolean {
  const settings = readNfmAutolinkSettings();
  if (!settings.autoLinkOnPaste) return false;
  return shouldAutoLinkMatchInText(fullText, startIndex, value, settings);
}

export function createNfmLinkExtension() {
  return Link.extend({
    addOptions() {
      const parentOptions = this.parent?.();
      const defaultOptions: LinkOptions = {
        autolink: true,
        defaultProtocol: DEFAULT_PROTOCOL,
        enableClickSelection: false,
        HTMLAttributes: {
          target: "_blank",
          rel: "noopener noreferrer nofollow",
          class: null,
        },
        isAllowedUri: (url, ctx) => !!isAllowedUri(url, ctx.protocols),
        linkOnPaste: false,
        openOnClick: true,
        protocols: [],
        shouldAutoLink: shouldAutoLinkWhileTyping,
        validate: (url) => !!url,
      };

      return {
        ...defaultOptions,
        ...(parentOptions ?? {}),
        autolink: true,
        defaultProtocol: DEFAULT_PROTOCOL,
        enableClickSelection: false,
        HTMLAttributes: parentOptions?.HTMLAttributes ?? defaultOptions.HTMLAttributes,
        isAllowedUri: parentOptions?.isAllowedUri ?? defaultOptions.isAllowedUri,
        openOnClick: true,
        linkOnPaste: false,
        protocols: [],
        shouldAutoLink: shouldAutoLinkWhileTyping,
        validate: parentOptions?.validate ?? defaultOptions.validate,
      };
    },

    addPasteRules() {
      return [
        markPasteRule({
          find: (text) => {
            const foundLinks: PasteRuleMatch[] = [];
            if (!text) return foundLinks;

            const links = find(text, {
              defaultProtocol: this.options.defaultProtocol,
            }).filter((item) => item.isLink);

            for (const link of links) {
              if (!shouldAutoLinkPasteMatch(text, link.start, link.value)) continue;
              foundLinks.push({
                text: link.value,
                data: { href: link.href },
                index: link.start,
              });
            }

            return foundLinks;
          },
          type: this.type,
          getAttributes: (match) => ({
            href: match.data?.href,
          }),
        }),
      ];
    },

    addProseMirrorPlugins() {
      const parentPlugins = this.parent?.() ?? [];

      return [
        ...parentPlugins,
        new Plugin({
          key: new PluginKey("handlePasteLinkNfm"),
          props: {
            handlePaste: (view, _event, slice) => {
              if (view.state.selection.empty) return false;

              let textContent = "";
              slice.content.forEach((node) => {
                textContent += node.textContent;
              });

              const link = find(textContent, {
                defaultProtocol: this.options.defaultProtocol,
              }).find((item) => item.isLink && item.value === textContent);

              if (
                !textContent ||
                !link ||
                !shouldAutoLinkPasteMatch(textContent, link.start, link.value)
              ) {
                return false;
              }

              return this.editor.commands.setMark(this.type, {
                href: link.href,
              });
            },
          },
        }),
      ];
    },
  }).configure({
    autolink: true,
    enableClickSelection: false,
    openOnClick: true,
  });
}
