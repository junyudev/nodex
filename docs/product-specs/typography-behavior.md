# Typography behavior

Typography preferences coordinate readable content and compact controls across
the workspace. A font family role and a size role are separate choices: content
can use a different family while sharing the chat's UI size, and Pages can use
that same content family with an independently selected body size.

## Preferences and initialization

UI size defaults to 14px and accepts 11–16px. Code size defaults to 12px and
accepts 8–24px. Page content size defaults to 14px and accepts 12–24px. Controls
step by 1px; valid fractional values retain their configured size. Non-finite or
invalid stored values resolve to the relevant default, and finite out-of-range
values are constrained to that role's range.

UI, content, and code font families are selected separately for light and dark
appearances. UI defaults to the system sans stack; code defaults to the system
mono stack. Content defaults to the selected UI family. A selected family
retains the role's fallback chain for missing fonts or unsupported glyphs.

One Profile presentation preference envelope persists in renderer browser
storage and synchronizes across windows sharing that storage. Changing one
size or font role preserves the others and the inactive appearance. Window
zoom remains an independent setting.

Appearance places UI, Content and Code sizes in its collapsed Advanced options
and groups each appearance's font choices with its theme controls. The independent
Page size is `Content font size`, marked `Pages`. Showing separate
light and dark editors changes only the settings presentation; it never copies
font choices or switches the active appearance.

Parser-time initialization and the mounted renderer use the same preference
normalizer and CSS-variable projector. Effective family, size, and scale tokens
are applied to root and body before content paints. Reopening a window restores
the selected values; theme changes select the active appearance's families.
Stored-setting changes update open content without remounting its editor or
message merely to refresh typography.

## Font and size roles

| Surface                                                        | Family  | Size owner                              |
| -------------------------------------------------------------- | ------- | --------------------------------------- |
| Sidebar, menus, buttons, settings and ordinary activity labels | UI      | UI scale                                |
| Chat prose and Markdown headings, lists and tables             | Content | UI/chat size and derived Markdown rules |
| Composer prompt                                                | UI      | UI/chat size                            |
| Page body and headings                                         | Content | Page content size                       |
| Page title                                                     | Content | UI heading-app scale                    |
| Inline code                                                    | Code    | Surrounding prose size                  |
| Code blocks, diff, source editor and terminal                  | Code    | Code size                               |

The default UI scale is xs 12px, sm 13px, base 14px, lg 16px, xl 28px, 2xl 36px,
3xl 48px and 4xl 72px. Heading-sm/md/lg/app are 18/20/24/28px. Each scaled token
is `round(base × selected UI size / 14)`. Direct UI/chat size retains the
configured value; Page and code sizes do not participate in this ratio.

## Conversations

Normal prose uses the chat size with 1.625 line height, producing 14px/22.75px
at the default. H1/H2/H3 sizes are 1.5/1.25/1.125 times prose, with line heights
2/1.75/1.75 times prose and 600 weight. H4 uses the prose size and 1.5 line
height; H5/H6 retain prose size and relaxed line height. Strong text uses 600.

Tables use `max(code size, prose size × 0.875)`, producing 12.25px at defaults.
Inline code uses the code family at 0.92em of its surrounding text. Final code
blocks use code size and `max(1.5em, 20px)` line height. Their action controls
use UI typography rather than inheriting the code family.

Desktop composer text uses chat size and 20px line height. Main running status
uses chat size plus 8px line height. Activity and request surfaces select their
actual UI/chat/code role; their size utility alone does not define a universal
family or row line height. User-message metadata remains on the UI small scale.

## Pages and file surfaces

Page prose uses its independent size, content family, normal 400 weight and
1.625 line height. Body heading multipliers match the conversation hierarchy.
The Page title uses content family and UI heading-app size with 1.2 line height;
adjusting Page content size changes the body and its headings while preserving
the title size. Page inline code follows surrounding text; code blocks continue
to use the independent code size.

Diff line height is code size × 1.8. The editable source editor rounds that line
height to an integer so code rows and edit overlays share one measurement.
Terminal uses code size and family with an xterm line-height factor of 1.2;
its rendered cell height also depends on glyph metrics and device-pixel rounding.
File previews use their own UI/chat/code role instead of the Page-size preference.

## Shell hierarchy

The ordinary desktop UI weight is 430. Explicit normal, medium and semibold
roles are 400, 500 and 600. Font matching and actual glyph interpolation remain
the responsibility of the selected font and browser.

Primary sidebar labels and thread titles use 14px at default; thread rows use
20px line height. Section labels use medium weight, and topbar titles use medium
weight with 24px line height. Ordinary menus, buttons and tooltips use the 13px
small scale; shortcut and metadata labels use the 12px extra-small scale.
Default tooltip line height is 18px. Dialog titles use UI heading-md 20px,
28px line height and 600 weight; dialog content follows the shared UI scale.

## Verification

Pure tests cover normalization, independent preference updates and scale
rounding. Browser tests exercise the production stylesheet and real component
consumers with applied preferences, checking resolved family, size and line
height. Parser-time tests pause application modules and prove saved typography
is already effective. Electron evidence uses synthetic Pages and native
conversation fixtures to verify settings interaction, cross-window propagation
and restoration after reopening.
