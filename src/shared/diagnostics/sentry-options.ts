import type { BrowserOptions } from "@sentry/react";
import { scrubSentryBreadcrumb, scrubSentryEvent } from "./sentry-scrub";

/** Apply the same content boundary to errors and independently streamed spans in every process. */
export function createSentryPrivacyOptions() {
  return {
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      graphQL: { document: false, variables: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    } satisfies Required<NonNullable<BrowserOptions["dataCollection"]>>,
    integrations: [
      {
        name: "NodexEnvelopePrivacy",
        setup(client) {
          client.on("beforeEnvelope", ([headers]) => {
            if (headers.trace) headers.trace = scrubSentryEvent(headers.trace);
          });
        },
      },
    ],
    beforeSend: (event) => scrubSentryEvent(event),
    beforeSendSpan: (span) => scrubSentryEvent(span),
    beforeBreadcrumb: (breadcrumb) => {
      if (breadcrumb.category === "console") return null;
      return scrubSentryBreadcrumb(breadcrumb);
    },
    // Diagnostics use filtered warning/error breadcrumbs, never broad remote log shipping.
    beforeSendLog: () => null,
  } satisfies Pick<
    BrowserOptions,
    | "dataCollection"
    | "integrations"
    | "beforeSend"
    | "beforeSendSpan"
    | "beforeBreadcrumb"
    | "beforeSendLog"
  >;
}
