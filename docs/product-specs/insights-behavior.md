# Insights Behavior

## Intent

Insights shows what a person's agents did and what came of it: tokens processed, models used,
messages sent, how many agents ran at once, tasks finished and Pages written. It reaches back before
Nodex was installed, so a new person sees their history the first time they open it, and it turns
those numbers into a picture worth sharing.

## Access

Insights is a rail destination between Scheduled and Plugins, a command (`Go to Insights`, `G I`) and
a page route beside the Home sidebar.

Reading Claude Code and Codex history needs one explicit grant per Profile. Before it, Insights reads
no provider history and asks with `Read my agent history`. `Stop reading history` withdraws the grant
and forgets everything read through it; asking again starts over.

## What is counted

Numbers come from two owners and are joined only for display.

**Provider transcripts** supply tokens, models, cost and messages. The Agent Runtime reads Claude Code
and Codex transcripts from each home a Profile knows about: the person's own homes, whether or not a
provider is configured for them, plus homes only Nodex writes to. It keeps counts and nothing else: no
prompts, paths in results, or content. A request counts once even when a resumed session copies it
into another file. A rollout counts once whether it is plain, compressed or archived. Compressed
history counts. Work a subagent did counts toward tokens but is not a message a person sent.

The ledger outlives its transcripts. A provider deleting old files never lowers a number, because
Nodex already recorded them. A rewritten transcript replaces its own earlier numbers.

**Tokens processed** is the total of input, cache reads, cache writes and output. Cache reads are
usually most of it, so the page states their share beside the total and the Receipt itemizes it.

**Cost** is always labelled `at API list price`. It says what the usage would cost at published
prices and never claims anyone spent it. Prices come from a public price table refreshed daily and
cached on disk; the request names no user, model or usage. A model without a known price adds nothing
and the page says how many there are. Without any price table the page shows no cost.

**Agents at once** and **agent hours** come from Nodex's own runs, so they only cover work Nodex ran.
A turn longer than six hours was waiting on someone, and is excluded from both. Nodex keeps its own
record of finished turns, so deleting a conversation does not lower a record.

**Content** comes from Core's public SQL relations. A task is a Page with a `status` value, and it
finished when its Status last moved to `Done`. Blocks are shown only as a Library total: their creation
times are not a reliable history.

## The page

The header holds Share and `Stop reading history`. Below it, a period (`7 days`, `30 days`, `90 days`,
`12 months`, `All time`) and a scope (`All agents`, `Nodex only`) apply to everything on the page. Days
follow the device's time zone, including zones a quarter hour off the hour.

From the top: tokens processed with cost and cache share; agents at once, tasks done, messages and
longest streak; three plain-language findings; an activity calendar switchable between tokens,
messages, tasks and pages; tokens over time by model family with the model table beside it; rhythm by
hour; agent totals; and Library totals. Library totals describe the Library now, whatever the period.

While history is being read the page stays usable. It reads the newest files first, says how many are
left, and the numbers grow as it goes. A file that cannot be read is retried on the next pass rather
than counted as empty. Without Core, content numbers show `—` and everything else still works.

## Sharing

Share opens a dialog with a large preview. It offers two 4:5 cards, a period, a `Show cost` switch and
an optional `Name on card`.

- **Skyline** draws activity as a city, one tower per day, with the tallest labelled. `7 days` draws
  hours instead of days. Empty weeks before the first activity are left out so a short history still
  fills the card.
- **Receipt** itemizes models, the cache discount and the total on a till receipt, with a barcode whose
  bars are days.

Both state the period, carry a QR code and `nodex.jyu.app`, and show the strongest non-zero numbers.
A fixed mark (`1B Club`, `10B Club`, `100B Club`, `1T Club`) and an archetype read from the numbers
give them something to wear; neither compares anyone with anyone.

A card contains no project names, Page titles, prompts, paths or account identity. A name appears only
if the person types one. Cost can be hidden.

The preview is the export: one image, drawn on the device at 2160×2700. `Copy image` puts it on the
clipboard, `Save PNG` asks where to put it, and `Post on X` copies it and opens a compose window with
the numbers as text, ready to paste. Nothing is uploaded unless the person posts it.
