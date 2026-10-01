# NFM Editor Date Mention Behavior

Status: Active
Last Updated: 2026-10-01

## Summary

NFM supports an inline date mention:

```xml
<mention-date start="2026-06-28" format="relative" />
<mention-date start="2026-06-28T14:30:00+08:00" tz="Asia/Shanghai" format="relative" time-format="12h" reminder="minute:0" />
<mention-date start="2026-06-28" end="2026-06-30" format="ll" />
```

Date mentions are inline rich-editor tokens for planning text. They are stored inside card descriptions and do not create or update card schedule fields, SQLite reminder rows, or desktop notification jobs.

## Persistence

- The canonical inline NFM form is a self-closing `<mention-date ... />` tag.
- Attribute order is `start`, `end`, `tz`, `format`, `time-format`, `reminder`.
- `start` is required. `end` is optional. Date-only values use `YYYY-MM-DD`; datetime values use `YYYY-MM-DDTHH:mm:ssZ` or `YYYY-MM-DDTHH:mm:ss±HH:mm`.
- `type` is not serialized. It is derived from whether `start`/`end` are present and whether they are date-only or datetime values.
- `tz` is optional IANA timezone intent for datetime values. The offset in `start`/`end` is still the canonical serialized time offset; `Z` means UTC.
- `format` supports `relative`, `ll`, `MM/DD/YYYY`, `DD/MM/YYYY`, and `YYYY/MM/DD`.
- `time-format` supports unset, `12h`, and `24h`.
- `reminder` is an inline payload field, using readable values such as `minute:0`, `minute:10`, `minute:30`, `hour:1`, `day:0@09:00`, and `day:1@09:00`.
- Invalid or incomplete date mention tags remain plain text and must not create broken structured inline content.
- Reversed ranges are normalized during parse/serialize so `start` is earlier than `end`.

## Rendering

- Editable Card Stage, Toggle List, projected inline editors, read-only NFM previews, and static NFM renderers all understand `dateMention` inline content.
- The inline token is atomic and `contentEditable=false`.
- The chip is text-level, not a filled pill: it inherits body text color, renders a muted `@` prefix, the formatted label, and an optional reminder icon.
- Relative datetime labels omit `Today` when their date is the current local date, displaying `@4:53 PM` or `@16:53` according to the time format. Date-only labels keep `@Today`; other dates and explicit date formats retain their date labels. The same rule applies to each endpoint of a datetime range.
- Pending inline reminders use the blue chart token; overdue inline reminders use the red/error token.
- Relative date labels and inline reminder tones are renderer-time display state. Mounted editor, preview, and static renderer surfaces refresh them as local time crosses date/minute boundaries without changing the underlying NFM payload.
- Plain-text serialization emits deterministic labels such as `@Jun 28, 2026`, never time-dependent labels such as `@Today`.

## Editing Popover

- Clicking a date mention opens a top/start anchored popover on the shared Nodex popover facade.
- The popover contains a date input, a fixed-weeks DayPicker calendar with outside days, Today/previous/next controls, and rows for End date, Date format, Include time, Time format, Timezone, and Remind.
- End date toggles between single-date and range payload types while preserving date/time settings when possible.
- Include time toggles between date-only and datetime payload types and writes the current local timezone when time is enabled.
- Date format, time format, timezone, and reminder controls update only the inline NFM payload.
- Nodex-specific rows `Use as card due date`, `Create scheduled card`, and `Open project calendar` are visible but disabled until inline date mentions are intentionally wired to card scheduling.

## Insertion

- The NFM `@` suggestion menu includes date mention rows alongside current card and chat mention results.
- `@today`, `@tomorrow`, `@yesterday`, `@now`, parseable date strings, `@remind today`, and `@remind tomorrow` insert `dateMention` inline content followed by a trailing space.
- Date-like queries show date/reminder suggestions before current-project card/chat results.
- Empty `@` keeps current-project chats/cards first, then shows Today and Now, then other chats/cards.

## Prompt And Clipboard Behavior

- Date mentions serialize as deterministic plain text for clipboard, search, and prompt extraction.
- Date mentions do not attach calendar metadata, create reminders, or inject schedule state into prompts.
