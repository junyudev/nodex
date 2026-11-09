# Product Analytics Behavior

Nodex reports anonymous facts about how it is used so we can tell how many people use it and which
parts work. This document is the contract for what is sent, when, and how a person controls it. The
decision is recorded in [ADR 0077](../adr/0077-anonymous-product-analytics.md).

## What a person sees

The first launch shows a notice at the bottom corner of the window: Nodex shares anonymous usage and
crash data, never prompts, code or files. **Got it** dismisses it. **Manage** dismisses it and opens
Settings → General → Privacy. It appears once per Profile, and not at all when nothing is being
shared.

Settings → General → Privacy has three switches:

| Setting               | Default | Applies                                   |
| --------------------- | ------- | ----------------------------------------- |
| Share crash reports   | On      | After restart                             |
| Share session replays | Off     | After restart; requires crash reports     |
| Share usage analytics | On      | Immediately; off discards anything unsent |

**See what is sent** lists the random ID, the fields every event carries, and each event waiting or
sent since launch. A switch that cannot take effect says why: an environment variable manages it,
`DO_NOT_TRACK` is set, the computer is running CI, or this is a development build.

## When events leave the computer

- Nothing is sent until the notice has been acknowledged or has been on screen for one minute, so a
  person who turns analytics off first sends nothing at all.
- Events wait in a bounded local outbox: at most 1,000 events and 14 days. They are delivered after
  two minutes or 25 events, and once more on quit.
- A network failure or transient service error keeps the events and retries with growing delays. A
  rejected batch is dropped. Analytics failures are never shown and never affect the app.
- While usage analytics is off nothing is sent, and waiting events are discarded. That includes
  events an earlier launch left behind when analytics is off by the next launch, for example
  because `DO_NOT_TRACK` was set in between.
- Development builds, CI and `DO_NOT_TRACK` send nothing and create no analytics state.
  `NODEX_TELEMETRY_ENABLED` overrides all of these, in either direction.

## What is sent

Every event carries a random installation ID, the app version, release channel, operating system,
processor architecture and language. The ID is created on this computer, belongs to one Profile, and
is not connected to a Nodex account.

| Event                                                                                                               | Meaning                                                                  | Fields                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `installation_created`                                                                                              | First active launch on a Profile                                         | `profile`: `new` or `existing`                                                                             |
| `app_launched`                                                                                                      | Each launch                                                              | `launch`: `first`, `updated` or `returning`                                                                |
| `app_active`                                                                                                        | First window focus of a UTC day                                          |                                                                                                            |
| `thread_started`                                                                                                    | A new conversation, on any Agent. Imported history is excluded           | `provider`, `model`, `source`, `actor`, `host`                                                             |
| `thread_branched`                                                                                                   | A subagent, fork or side chat                                            | `kind`, plus the fields of `thread_started`                                                                |
| `turn_completed`                                                                                                    | A provider turn ended. Value: duration in ms                             | `provider`, `model`, `status`, `effort`, `runtime_mode`, `interaction_mode`, `has_subagents`, token counts |
| `turn_first_response`                                                                                               | Remote hosts: sending a message to the first visible response. Value: ms | `outcome`, `reason`, `submission_kind`, `response_runtime`, `thread_kind`                                  |
| `thread_opened`                                                                                                     | Remote hosts: opening a Thread. Value: ms                                | `outcome`, `reason`, `thread_kind`, `thread_state`                                                         |
| `feature_used`                                                                                                      | A surface a person looked at in a window session, once each              | `feature`                                                                                                  |
| `composer_prediction_interaction`, `composer_prediction_submitted`                                                  | Use of composer predictions                                              | `action`, `accepted`, `edited`, `trigger`, `model`                                                         |
| `thread_message_navigation`                                                                                         | Jumping to a message                                                     | `ordinal`, `item_count`                                                                                    |
| `readback`                                                                                                          | A Readback appearing, being stopped from or leaving its window           | `action`                                                                                                   |
| `image_view`, `image_edit_entered`, `image_edit_submitted`, `image_edit_submit_outcome`, `image_editor_pin_outcome` | Use of the image editor                                                  | Counts and closed labels                                                                                   |

`src/shared/product-analytics/catalog.ts` is the executable source of truth; anything it does not
describe is discarded in Main. Prompts, responses, code, titles, file names and paths have no field.
`model` is a public model name, and any other value is reported as `other`.

## Website and distribution

The website counts `landing_viewed` and `landing_download_clicked` with no cookies or stored identity,
using an ID that lasts one page load. It sends nothing when the browser signals Do Not Track or Global
Privacy Control.

The daily `Distribution Metrics` workflow reports `distribution_downloads` (change in GitHub release
downloads by channel, platform and kind) and `update_feed_requests` (appcast requests from
Cloudflare). Downloads include CI and repeat fetches, so they bound installs from above.
`installation_created` with `profile=new` is the install count. Website and distribution events use a
stable ID, not a user ID, so they never count as active installations.

## Reading the numbers

The **Nodex Product Health** Statsig dashboard is defined in `scripts/analytics/product-dashboard.ts`.

| Question                       | Where                                                                  |
| ------------------------------ | ---------------------------------------------------------------------- |
| How many installs?             | New installations                                                      |
| Daily, weekly, monthly active? | Active installations                                                   |
| Conversations per day?         | Conversations started (`thread_started`), by Agent                     |
| Do new installs get going?     | Activation: `installation_created`, `thread_started`, `turn_completed` |
| Do they come back?             | Statsig's built-in Product Growth dashboard                            |

    python3 notes.local/secrets/use.py run statsig.console -- vp run analytics:provision
    python3 notes.local/secrets/use.py run statsig.console -- vp run analytics:report --out /tmp/report.txt

Changing what is reported means changing the catalog, this table and the website privacy page together.
