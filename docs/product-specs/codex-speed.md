# Codex Speed

## Intent

This document is the source of truth for how Nodex chooses the speed a Codex chat runs at: the
global new-chat preference, the controls that change it, how a speed fits the model it lands on,
and how requests carry it.

Other product specs link here instead of restating speed behavior.

## Canonical Model

- A Codex speed is Standard, Fast or Ultrafast. Nodex names them `null`, `"fast"` and
  `"ultrafast"`; slowest to fastest, they form one ladder.
- A model offers Standard plus the faster tiers its catalog lists. Current catalogs name Fast
  `priority` (older ones `fast`); app-server `"default"` and legacy `"standard"` mean Standard.
  Nodex reads every alias by its Nodex name and writes the id the model's own catalog uses.
- Ultrafast exists only on models that list it, such as GPT-6.2 Sol.
- The new-chat preference is global, not per-project. Existing executions, including subagents,
  keep their own provider-observed speed.

## Fitting A Speed To A Model

- A speed carried to another model, such as the new-chat preference or the previous model's
  choice on a model switch, runs at that tier when the model offers it, otherwise at the fastest
  offered tier below it, otherwise Standard. Ultrafast on a model with only Fast runs Fast.
- A model the catalog has not described yet keeps the carried speed until it is described.
- Saved choices that must hold exactly, such as an Automation's speed or a Page's Agent config
  `speed`, are checked against the model's offered tiers and refused when it lacks them.
- A model switch that lands on Standard sends an explicit Standard reset, so a tier the previous
  model ran at never carries onto a model that lacks it.

## Source Of Truth

- The renderer owns the global preference in `localStorage` under one Nodex-scoped key; invalid
  values read as Standard and `storage` events keep windows in sync.
- All reads and writes go through the shared service-tier settings module and hook; surfaces do
  not keep parallel copies.

## UI Contract

### Settings

- Settings → Agents → Codex has a `Speed` row: the speed new Codex chats start with.
- It offers `Standard` and `Fast`, and `Ultrafast` when any Codex model offers it or it is the
  saved preference. Choosing a speed in an unstarted Codex chat also becomes the new default.

### Model Picker

- When the chat's model offers a faster tier, the picker's controls show one speed button. Its
  glyph is the tier in force: an outlined bolt for Standard, a bolt for Fast, a double bolt for
  Ultrafast.
- Hovering or pressing it opens a menu of Standard and each faster tier the model offers, each
  with its cost; the current tier is checked. A model with no faster tier shows no speed button.
- While a faster tier is on, the effort track streams, faster for Ultrafast, and the picker
  trigger shows the tier's glyph before the model label. Subagent detail headers show the
  subagent's own observed tier the same way and never borrow their parent's.

### Slash Commands

- `/fast` switches to Fast, or back to Standard when Fast is on. `/ultrafast` does the same for
  Ultrafast and appears only when the model offers it. A started chat changes its own speed; an
  unstarted chat changes the global preference.

## Request Resolution

- Requests distinguish an omitted speed, explicit Standard (`null`) and a named tier.
- An explicit speed wins; an omitted one falls back to the global preference, fitted to the
  request's model. With no override at all, the field is omitted so the thread keeps its setting.
- Explicit Standard is sent as Standard, clearing any inherited or configured acceleration.
- Covered paths: a new thread's first turn, follow-up turns, queued follow-ups and the
  replacement turn of an edited last message.
- Main forwards the speed the renderer resolved and never reads the preference itself.
- Queued follow-ups freeze the speed at enqueue time; changing the preference later does not
  rewrite them.
- Managed Codex accounts that cannot choose a tier omit the field.

## Reporting

- Usage, logs and summaries report `standard`, `fast` or `ultrafast`, never a raw `null`.
