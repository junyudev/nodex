import type { ShareCardView } from "@nodex/insights-cards";

import type { Locale } from "../locale";

export const MAX_NAME_LENGTH = 32;

export interface PreviewData {
  readonly view: ShareCardView;
  readonly locale: Locale;
  readonly name: string;
  readonly hasCost: boolean;
}

export const PREVIEW_DATA_SLOT = '<script id="preview-data" type="application/json"></script>';

export function embedPreviewData(template: string, data: PreviewData): string {
  // Script data is raw text in HTML. Escaping "<" also keeps user text from ending the element.
  const json = JSON.stringify(data).replaceAll("<", "\\u003c");
  return template.replace(
    PREVIEW_DATA_SLOT,
    () => `<script id="preview-data" type="application/json">${json}</script>`,
  );
}
