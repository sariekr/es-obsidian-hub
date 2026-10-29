# Hub design language

The Hub is a compact workspace inside Obsidian. Its visual priority is symmetry:
equal-weight sources share the same frame, typography and alignment. AnuPpuccin
provides the identity; Hub adds structure through its own scoped styles. Keep the
interface in English and keep Calendar / Mail, YouTrack and Slack in that order.

## Widget contract

Every widget has four regions. The Calendar / Mail panels remain mounted inside
one shared tile and use the same tracks as the two neighboring tiles.

| Region | Shared class | Default size | Responsibility |
| --- | --- | --- | --- |
| Header | `aim-widget-header` | 36 px | 16 px Lucide icon, title or Calendar / Mail tabs, optional quiet context |
| Controls | `aim-widget-controls` | 40 px | Filters or account/project scope; horizontal overflow, never wrapping |
| Body | `aim-widget-body` | Remaining height | Source content, empty state and bounded errors; lists own their scroll |
| Footer | `aim-widget-footer` | 52 px | 28 px action line, 16 px freshness line, 7 px top padding and 1 px border |

Tile padding is 12 px on all sides. Tiles are separated by 16 px. At equal tile
heights, header bottom, body top and footer top/bottom must align within 1 CSS px.
Do not add source-specific top margins to simulate alignment. Put calendar month
navigation inside its body. Keep YouTrack's source link beside its settings action.
Footer actions can scroll horizontally; the status stays on a separate line.
Long status text truncates with its complete meaning available in a tooltip.

The shared resizer still controls height, including the existing 300 px minimum.
Calendar days reserve a 24px date badge, a 4px gap and a dedicated 4px marker line inside a minimum 36px cell. Center the entire marker group below the badge; never anchor dots over its background. Short calendars scroll internally, including a five-week month at the 300px minimum. The exact meeting count remains in the date tooltip and accessible label. Narrow panels keep the
three sources in one horizontally scrollable row; they do not squeeze into
unreadable columns. Mail, Slack and YouTrack error banners use at most 40% of the body, with their
own scrolling. Calendar errors remain in its scrolling Agenda. Neither changes
footer geometry.

## Tokens and type

The canonical implementation is the **Widget design contract** block in
`styles.css`, scoped to `.aim-home`. New widgets must reuse these classes and
tokens. Keep vendor CSS and AnuPpuccin unchanged.

| Role | Token / rule | Default |
| --- | --- | --- |
| Spacing | `--aim-space-1` through `--aim-space-4` | 4 / 8 / 12 / 16 px |
| Typeface | `--font-interface` | Current Obsidian interface font |
| Widget title | `--aim-widget-title` → `--font-ui-medium` | 14 px, weight 600, line 20 px |
| Sender, issue title, body | `--aim-widget-body-size` → `--font-ui-small` | 13 px, line 20 px; titles 600, body 400 |
| Context, time, footer, controls | `--aim-widget-meta` → `--font-ui-smaller` | 12 px, line 16 px; controls line 20 px |
| Widget icon | Obsidian `setIcon`, Lucide | 16 px; never emoji |

Use 8 px vertical / 4 px horizontal row padding. Keep text excerpts to two lines.
Sender/title leads, excerpt follows, account/channel/issue ID and priority come
last. Dates group Mail and Slack into Today, Yesterday and older calendar dates;
the row shows time, with the full timestamp in its accessible label and tooltip.
Use local calendar arithmetic, including midnight, year and DST transitions.
YouTrack groups by actual State labels from the snapshot, preserving issue order
inside each group and group order by first occurrence. Its controls use the same
button geometry and selected accent as Slack: To do / In progress / Done, with
Other only when needed for unmatched open states. Keep actual State headings,
quiet visible-row counts and a scope tooltip. Filtering does not change the
board. Done must disclose its 20-result page limit; do not imply a full archive.

## Color means something

- Surfaces, borders, body text and secondary text inherit Obsidian variables.
- Accent identifies a selected control, keyboard focus or an actionable link.
- Mail alone has a real unread indicator. Do not invent Slack unread state.
- Priority remains text. Existing board High/Urgent emphasis stays distinct from
  selection and board State. Do not color every source or Type differently.
- Empty states use normal/secondary text. Errors use theme warning/error colors
  plus readable text; never communicate an error through color alone.

No external font, icon plugin, framework or theme fork is required. Folder names
and project/state labels come from live configuration, never personal defaults.

## Interaction and verification

One **Refresh all widgets** action serves the row. Each footer reports that
source's own freshness and interval. Settings and source links remain explicit.
Changing a filter, tab or density must not read accounts, write notes or alter
saved queries. Preserve keyboard focus, mounted panels, scroll restoration,
visible focus rings and reduced-motion behavior.

Before changing the contract, run the actual-runtime browser fixture in dark,
light and narrow modes. Measure all four regions for Calendar, Agenda and Mail;
include loaded/empty/disconnected data, long names, all Slack filters, errors,
busy states and the six-week month at minimum height. Check computed font roles
and contrast, then inspect native Obsidian in the independent demo vault.
Unit/DOM checks alone are not visual verification. Record evidence and limits in
[VERIFICATION.md](VERIFICATION.md). The fictional
[interactive HTML](prototypes/widget-lists.html) communicates the direction;
runtime CSS and this contract take precedence over its illustrative content.

## Research basis — 26 October 2026

[Obsidian styling guidance](https://docs.obsidian.md/Reference/CSS%20variables/About%20styling)
supports inheriting its CSS variables for native appearance and theme compatibility.
[Carbon spacing](https://carbondesignsystem.com/elements/spacing/overview/) supports
a small token scale and consistent grouping; its
[typography guidance](https://carbondesignsystem.com/elements/typography/overview/)
distinguishes compact application typography from expressive display typography.
These principles inform the contract; Carbon code, fonts and dependencies are
not adopted. The list hierarchy builds on the Notebook Navigator research in
[UI-RESEARCH.md](UI-RESEARCH.md), without installing it or assuming it can style
our custom widgets.
