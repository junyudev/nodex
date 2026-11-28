# nodex-insights

## Intent

`npx nodex-insights` gives anyone who uses coding agents the [Insights share cards](insights-behavior.md#sharing)
without installing Nodex: one command reads their local agent history and opens their Skyline and
Receipt, ready to copy, save or post. The cards carry `nodex.jyu.app` and its QR code back to Nodex.

## Reading history

The CLI reads usage through the pinned ccusage, a separate program it runs as a dependency, which
detects every agent ccusage supports (Claude Code, Codex, OpenCode, Gemini CLI, Antigravity, Kimi,
Qwen, DeepSeek Harness and the rest). It always runs it offline, which also keeps ccusage from
reporting its own use, and the CLI itself makes no network requests.

- **Span.** The current calendar year through today by default, in the device's time zone. `--year`
  picks another year (a past year runs to December 31); `--since` and `--until` pick any range, both
  days included.
- **Tokens processed** is input, cache reads, cache writes and output, each counted once, the same
  definition Insights uses.
- **Cost** is ccusage's estimate from tokens at API list price and is always labelled so. `--no-cost`
  leaves it out entirely.
- **Conversations** are the sessions ccusage reports for the span.
- History cannot say how many messages a person sent, how many agents ran at once, tasks, Pages or
  the hour of day, so those numbers are not shown; a rule that needs them simply never applies.

## The terminal

While history is read, a spinner says so. Then the terminal shows the cards' own numbers in their
own words, sized to the window and plain when output is not a terminal or `NO_COLOR` is set:

- the span, the tokens processed and, unless left out, what they are worth at API list price;
- the activity over the span as one line of bars, a day or a week each, between its first active day
  and its last day;
- the card's strongest numbers, its club and its archetype;
- the Receipt's models with their tokens and cost;
- every agent counted;
- the preview's address and how to stop it.

With no history in the span it says so and opens nothing.

## The preview

The preview is one local page served on `127.0.0.1` until the person stops the command. It loads
nothing from anywhere: fonts, script and copy are inside it. It shows both cards side by side with
the same hover actions as Insights: `Copy image`, `Save PNG` and `Post on X`, which copies the image
and opens a compose window whose text carries the numbers, and the cost when the card shows it.
Below the cards are `Name on card` and `Show cost`. The page also switches between dark and light
cards, following the system at first, and between English and 中文, starting from the terminal's
language (`LC_ALL`, `LC_MESSAGES`, then `LANG`; a `C` or `POSIX` value defers to the system).

## The cards

The cards are Insights' cards and follow every rule in [Sharing](insights-behavior.md#sharing): no
project names, Page titles, prompts, paths or account identity, a name only when typed, cost
hideable and labelled at API list price, the same clubs and archetypes, the agents counted named on
both, and a Receipt headed by its total. The period reads as the year (`2026`) or the chosen range,
and the Skyline draws days, since the hour of day is not known. The Skyline lists the agents that
fit on one line and counts the rest; the Receipt lists them all.
