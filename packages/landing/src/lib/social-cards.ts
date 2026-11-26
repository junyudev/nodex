/**
 * The social previews the site publishes, shared by the pages that declare them and the recorder
 * that draws them. Plain data so the Node recorder can read it without loading Astro.
 */
export const SOCIAL_CARD_VIEWPORT = { width: 1200, height: 630 } as const;
export const SOCIAL_CARD_SCALE = 2;

export const SOCIAL_CARDS = {
  home: {
    file: "og.png",
    alt: "Nodex: One inbox. Every agent. All local. Aerial view shows two chats at work with their subagents: a Claude Code lead handing its routes to Codex, its tests to Antigravity and its docs to OpenCode, and an Antigravity lead whose Codex subagent passes its screenshots to DeepSeek. Works with Claude Code, Codex, Antigravity, DeepSeek and OpenCode.",
  },
  download: {
    file: "og-download.png",
    alt: "Download Nodex, free and open source, for macOS on Apple silicon and Windows 11 on x64, or with Homebrew.",
  },
  changelog: {
    file: "og-changelog.png",
    alt: "The Nodex changelog: every change, release by release, grouped into Added, Changed and Fixed.",
  },
} as const;

export type SocialCardId = keyof typeof SOCIAL_CARDS;
