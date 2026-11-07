import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { InsightsOrigin } from "../../../shared/insights";
import { writeImageToClipboard } from "@/lib/clipboard";
import { openExternalUrl } from "@/lib/file-system-operations";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererQuery,
} from "@/lib/renderer-command";

const SCANNING_REFETCH_MS = 1_500;
const SETTLED_REFETCH_MS = 60_000;

const accessCommand = defineRendererCommand({
  key: "insights.access",
  channel: "insights:access",
  authority: "main",
  owner: "Insights",
  protocol: { kind: "returned_value" },
});

const saveCardCommand = defineRendererCommand({
  key: "insights.card.save",
  channel: "insights:card:save",
  authority: "external",
  owner: "Insights",
  protocol: { kind: "returned_value" },
});

export const insightsTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Numbers fill in while a scan runs, then only move when new work happens. */
export function useInsightsUsage(origin: InsightsOrigin) {
  const timeZone = insightsTimeZone();
  return useQuery({
    queryKey: ["insights", "usage", timeZone, origin],
    queryFn: () => invokeRendererQuery("insights:usage", { timeZone, origin }),
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      query.state.data?.scan.state === "scanning" ? SCANNING_REFETCH_MS : SETTLED_REFETCH_MS,
  });
}

export function useInsightsContent() {
  const timeZone = insightsTimeZone();
  return useQuery({
    queryKey: ["insights", "content", timeZone],
    queryFn: () => invokeRendererQuery("insights:content", { timeZone }),
    staleTime: SETTLED_REFETCH_MS,
  });
}

export function useInsightsAccess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (granted: boolean) => invokePlainCommand(accessCommand, { granted }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["insights"] }),
  });
}

export const copyCardImage = (pngDataUrl: string) => writeImageToClipboard(pngDataUrl);

export const saveCardImage = (pngDataUrl: string, suggestedName: string) =>
  invokePlainCommand(saveCardCommand, { pngDataUrl, suggestedName });

/** Compose windows take text only, so the image travels by clipboard. */
export const openPostComposer = (text: string) =>
  openExternalUrl(`https://x.com/intent/post?text=${encodeURIComponent(text)}`);

const NAME_KEY = "nodex.insights.card-name";

export function readCardName(): string {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeCardName(name: string) {
  try {
    if (name.trim()) window.localStorage.setItem(NAME_KEY, name);
    else window.localStorage.removeItem(NAME_KEY);
  } catch {
    // The name is a convenience; a card still works without remembering it.
  }
}
