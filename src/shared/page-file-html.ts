import type { ContentRoutingContext } from "./content-routing-context";

export const PAGE_FILE_HTML_SCHEME = "nodex-page-file";
export const PAGE_FILE_HTML_PARTITION_PREFIX = "nodex-page-file:";

export interface PageFileHtmlAdmissionInput {
  readonly routingContext: ContentRoutingContext;
  readonly pageId: string;
  readonly fileId: string;
  readonly logicalPath: string | null;
  /** The app's resolved theme, answered to the report's `prefers-color-scheme`. */
  readonly colorScheme: "light" | "dark";
}

/** Ephemeral owner capability; never persist it in a Scene or File record. */
export interface PageFileHtmlAdmission {
  readonly grant: string;
  readonly url: string;
  readonly partition: string;
}

export type PageFileHtmlAdmissionResult =
  | { readonly status: "admitted"; readonly admission: PageFileHtmlAdmission }
  | { readonly status: "refused"; readonly message: string };
