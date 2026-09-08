import { useState } from "react";
import { BrowserUseIcon, ConnectorGlobeIcon } from "@/components/shared/icons";
import {
  WebsiteFigmaIcon,
  WebsiteGitHubIcon,
  WebsiteGmailIcon,
  WebsiteGoogleCalendarIcon,
  WebsiteGoogleDriveIcon,
  WebsiteLinearIcon,
  WebsiteNotionIcon,
  WebsiteSalesforceIcon,
  WebsiteSlackIcon,
} from "@/components/shared/icons/website-icons";
import { resolveBrowserWebsiteSourceIconId } from "../../../../../../shared/browser-website-source";
import { formatCodexMcpVisualSourceName } from "../../../../../../shared/codex-mcp-tool-call";
import type { CodexWebMcpCall } from "../../../../../../shared/codex-webmcp-tool-call";
import { ThreadActivityDisclosure } from "./tool-primitives";
import { ToolCallCodePanel } from "./tool-call-inspection";

const WEBSITE_SOURCE_ICONS = {
  figma: WebsiteFigmaIcon,
  github: WebsiteGitHubIcon,
  gmail: WebsiteGmailIcon,
  googleCalendar: WebsiteGoogleCalendarIcon,
  googleDrive: WebsiteGoogleDriveIcon,
  linear: WebsiteLinearIcon,
  notion: WebsiteNotionIcon,
  salesforce: WebsiteSalesforceIcon,
  slack: WebsiteSlackIcon,
};

function parseJsonOrText(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function formatJsonOrText(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function websiteFaviconUrl(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.origin)}&sz=32`;
  } catch {
    return null;
  }
}

function WebMcpSourceIcon({ href, loadRemote }: { href: string | null; loadRemote: boolean }) {
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const sourceId = href ? resolveBrowserWebsiteSourceIconId(href) : null;
  const SourceIcon = sourceId ? WEBSITE_SOURCE_ICONS[sourceId] : null;
  if (SourceIcon)
    return (
      <SourceIcon
        aria-hidden
        className="icon-xs shrink-0 rounded-2xs text-token-conversation-body"
      />
    );
  const faviconUrl = href && loadRemote ? websiteFaviconUrl(href) : null;
  const loaded = faviconUrl !== null && loadedUrl === faviconUrl;
  if (href === null)
    return <BrowserUseIcon aria-hidden className="icon-xs shrink-0 text-token-conversation-body" />;
  return (
    <span
      aria-hidden
      className="icon-xs relative inline-block shrink-0 text-token-conversation-body"
    >
      {!loaded ? <ConnectorGlobeIcon className="absolute inset-0 size-full" /> : null}
      {faviconUrl ? (
        <img
          key={faviconUrl}
          alt=""
          className="absolute inset-0 size-full rounded-2xs object-contain"
          style={{ opacity: loaded ? 1 : 0 }}
          decoding="async"
          draggable={false}
          onLoad={() => setLoadedUrl(faviconUrl)}
          referrerPolicy="no-referrer"
          src={faviconUrl}
        />
      ) : null}
    </span>
  );
}

export function WebMcpToolActivity({
  call,
  fallbackPageUrl,
  loadRemoteLogos = true,
}: {
  call: CodexWebMcpCall;
  fallbackPageUrl: string | null;
  loadRemoteLogos?: boolean;
}) {
  const sourceUrl =
    call.sourceHostname == null ? fallbackPageUrl : `https://${call.sourceHostname}`;
  const input = call.kind === "invokeTool" ? call.inputJson : undefined;
  const inputTruncated = call.kind === "invokeTool" && call.inputTruncated === true;
  const definition = JSON.stringify(
    {
      name: call.name,
      title: call.title,
      description: call.description,
      website: call.sourceHostname,
      readOnlyHint: call.readOnlyHint,
      input: input == null || inputTruncated ? input : parseJsonOrText(input),
      inputTruncated: inputTruncated ? true : undefined,
    },
    null,
    2,
  );
  const result =
    call.outputJson == null
      ? null
      : call.outputTruncated
        ? call.outputJson
        : formatJsonOrText(call.outputJson);
  const summary =
    call.kind === "listTools"
      ? "Listed website tools"
      : (call.title ?? formatCodexMcpVisualSourceName(call.name, { style: "sentence" }));
  return (
    <ThreadActivityDisclosure
      icon={<WebMcpSourceIcon href={sourceUrl} loadRemote={loadRemoteLogos} />}
      status="completed"
      summary={summary}
    >
      <ToolCallCodePanel
        title={inputTruncated ? "Tool (input truncated)" : "Tool"}
        preview={{ kind: "complete", text: definition }}
        previewCharacterLimit={null}
      />
      {result !== null ? (
        <ToolCallCodePanel
          title={call.outputTruncated ? "Result (truncated)" : "Result"}
          preview={{ kind: "complete", text: result }}
          previewCharacterLimit={null}
        />
      ) : null}
    </ThreadActivityDisclosure>
  );
}
