import { z } from "zod";
import { CHANGELOG_SECTION_KINDS, type ChangelogSectionKind } from "./changelog";

/**
 * The public Nodex changelog feed: the most recent published releases from CHANGELOG.md, published by
 * the website beside its changelog page and read by the desktop's What's new. The website builds
 * it; Main fetches and decodes it; the renderer only presents it.
 */

/** The website's changelog page, which lists every release. */
export const CHANGELOG_PAGE_URL = "https://nodex.jyu.app/changelog/";
/** Where the website publishes the feed. */
export const CHANGELOG_FEED_URL = "https://nodex.jyu.app/changelog.json";

/** One changelog bullet, split after its first sentence. Both parts keep inline Markdown. */
export interface ChangelogEntry {
  /** The entry's first sentence, or the clause before its first colon. */
  readonly lead: string;
  /** What follows the lead; empty when the entry is a single sentence. */
  readonly detail: string;
}

export interface ChangelogSection {
  readonly kind: ChangelogSectionKind;
  readonly entries: readonly ChangelogEntry[];
}

export interface ChangelogRelease {
  /** Semver without a `v`, such as `0.5.12`. */
  readonly version: string;
  /** Release day as `YYYY-MM-DD`, the same in every time zone. */
  readonly date: string;
  /** The release's anchor on the changelog page. */
  readonly url: string;
  /** What people will care about most in this release, as plain text. */
  readonly headline: string;
  /** Sections with entries, in CHANGELOG_SECTION_KINDS order. */
  readonly sections: readonly ChangelogSection[];
}

export interface ChangelogFeed {
  readonly schemaVersion: 1;
  /** The changelog page. */
  readonly url: string;
  /** Newest first, dated releases only. */
  readonly releases: readonly ChangelogRelease[];
}

const httpsUrl = z
  .url({ protocol: /^https$/u })
  .max(2048)
  .refine((value) => {
    const url = URL.parse(value);
    return !!url && !url.username && !url.password;
  });
const sectionKind = z.enum(CHANGELOG_SECTION_KINDS);
const sectionSchema = z.union([
  z.object({
    kind: sectionKind,
    entries: z
      .array(z.object({ lead: z.string().min(1).max(1024), detail: z.string().max(8192) }))
      .min(1)
      .max(100),
  }),
  z
    .object({
      kind: z
        .string()
        .min(1)
        .max(64)
        .refine((kind) => !sectionKind.safeParse(kind).success),
    })
    .transform(() => null),
]);
const feedSchema = z.object({
  schemaVersion: z.literal(1),
  url: httpsUrl,
  releases: z
    .array(
      z.object({
        version: z
          .string()
          .max(128)
          .regex(
            /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
          ),
        date: z.iso.date(),
        url: httpsUrl,
        headline: z.string().min(1).max(120),
        sections: z.array(sectionSchema).max(32),
      }),
    )
    .max(50),
});

/** Validates the published feed and skips future kinds of change this app cannot display. */
export function decodeChangelogFeed(value: unknown): ChangelogFeed {
  const feed = feedSchema.parse(value);
  return {
    ...feed,
    releases: feed.releases.flatMap((release) => {
      const sections = release.sections.filter((section) => section !== null);
      return sections.length ? [{ ...release, sections }] : [];
    }),
  };
}
