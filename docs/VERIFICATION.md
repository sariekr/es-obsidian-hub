# Verification record

## 1.3.0 source: 25 October 2026

Configurable Type icons and restrained priority colors were implemented in the development checkout on top of merged 1.2.0 (`794c826`). No candidate plugin, theme update, app upgrade or dependency installation was needed. This is PR source delivery; the published download remains 1.1.0.

- **200 Node tests and 21 Python tests passed.** Four new behavior tests first failed before implementation. They cover neutral defaults/no startup writes, explicit choice/reset, note and unrelated-setting preservation, reload persistence, serialization with widget settings, failed saves, invalid icons, missing/replaced folders, external conflicts and unload. Existing integration guards still pass with synthetic data.
- The actual-runtime `tests/board.preview.py` fixture showed **PASS** through computer use in desktop dark, 800px light with icon settings, and 480px dark with Preview. Existing filter/preview/redraw/cleanup checks remain. Added DOM checks cover immediate chip refresh, retained labels, shared Type-picker icons, visible save errors, long/arbitrary live folder names and reload persistence. A neutral priority variant was visually compared in desktop light/dark. The fixture's icon API intentionally renders a placeholder SVG; actual Lucide glyphs were verified natively, not inferred from these screenshots.
- The fixture measures composited text/icon colors against backgrounds and rejects faded ancestors, including Done cards. Selected samples include card chips, excerpts, Preview, count, search icon and placeholder. Minimum measured ratios were **5.97:1 text / 3.51:1 icons** in light, **9.36:1 / 6.74:1** in dark. The initial visual inspection found Done's inherited opacity fading controls; the scoped Hub override was applied and the browser/native checks repeated. These samples do not certify all app surfaces, hover/focus states or custom theme palettes. The browser log contained two unrelated Zotero-extension connection errors, with no fixture-origin error in the inspected log.
- Native Obsidian **1.11.7** (installer 1.6.7, explicitly distinguished in General settings) loaded the three updated runtime files in the disconnected `.local/demo-vault`. The Hub plugin was disabled through the UI before copying `main.js`, `styles.css`, `manifest.json`, then re-enabled. Copy hashes matched. No running settings file was edited by hand.
- Native dark/light visuals were inspected at approximately **1470×800**, plus light at **1053×800** with a 300px sidebar (roughly 750px content area). Type controls wrap, the settings grid adapts, and the existing widget horizontal scrolling remains. Real graduation-cap/person/sticky-note/briefcase/ticket glyphs, High/Medium/Urgent symbols, action/widget icons and a temporary Done card were visible. Done kept a struck title with readable controls.
- Native mouse and keyboard selection saved five explicit demo icon preferences. Reset to Folder and re-selection worked; the Type picker used the same icons. Search reduced six cards to two; combined Work filtering reduced them to one; Clear restored six. Preview opened with read-only content and Escape closed it. Calendar/Mail switched without connecting accounts. Preferences were independently read back from demo settings. Native app restart persistence was not retested; automated reload persistence passed.
- The temporary fictional Done/Urgent QA note was removed after inspection. All **13 original demo Markdown notes remained byte-identical**. The board was left open in dark mode, normal width, unfiltered, Calendar selected and Preview closed. The personal vault was not altered.
- **3 distribution tests passed**, along with the pristine checker and release builder. The 70-file allowlist is unchanged; only reviewed changed files received new hashes. ZIP members match that allowlist plus `distribution.json`. Generated calendar content was byte-compared with the merged base; vendor/theme hashes and integration adapters stayed unchanged. A bounded scan of added content found no credential patterns or private absolute paths; this was not a comprehensive secret audit.

Commands: the four suites listed in [AGENTS.md](../AGENTS.md), `python3 scripts/build-release.py`, and `python3 -B .obsidian/plugins/aimultiple-kanban-extras/tests/board.preview.py` served from its synthetic output directory on loopback. The browser preview and native demo are distinct evidence. No third-party candidate installation/compatibility test, live account operation, mobile/other-OS test or independent agent review is claimed. Research findings and optional next experiments are in [UI research](UI-RESEARCH.md).

## 1.2.0 source: 25 October 2026

Compact cards, combined search/Type filters and a click-to-open note preview were selectively ported into the shared checkout. The public fork's configurable accounts, account-bound imports, default-off YouTrack State sync and first-trust recovery remain intact. No additional plugin, theme update or dependency was installed. This is source delivery; no 1.2.0 GitHub release was published as part of it.

- **196 Node tests and 21 Python tests passed.** Four new behavior tests first failed for the missing methods and then passed. They cover next-step extraction, frontmatter/fence/comment exclusion, diacritic-insensitive title/ID search combined with effective Type, shared bounded reads, invalidation, unload and stale/deleted preview targets. Existing public-profile tests also pass.
- The new actual-runtime `tests/board.preview.py` fixture showed **PASS** in desktop dark, 800px light and 480px dark panels. Checks cover combined filters and no-results feedback, Clear, redraw persistence, single mounts, excerpts after edits, safe preview rendering, Close/Escape focus, Open note in a new tab, other-Base isolation, unload/reload cleanup, no note/property/settings writes and viewport overflow. Screenshots were inspected through native Chrome. These are synthetic browser checks, not live account tests.
- Native Obsidian **1.11.7** loaded the source in the independent disconnected `.local/demo-vault`. At approximately 1470×800, three widgets, three board columns and the existing **300px** widget height remained. Search reduced six cards to two; combining Work reduced them to one. Preview showed the fictional note without leaving the board. Open note preserved the board in another tab. Escape closed the panel, and Clear restored all six cards. The main board was left open, unfiltered, with Preview closed. SHA-256 readback confirmed all **13 demo Markdown notes unchanged**.
- **3 distribution tests passed**, including repeatable ZIP builds in a temporary synthetic vault, exact allowlist members, fresh installation and rejection of nonempty/symlink destinations. The pristine checker passed for 70 reviewed files. Nine existing hashes changed deliberately, two source/documentation files were added to the allowlist, and 59 existing hashes stayed identical. The generated calendar bundle was independently byte-compared with the base commit. A bounded scan of added content found no token patterns or private source paths; it is not a comprehensive secret audit.
- Only `main.js`, `styles.css` and `manifest.json` were copied to the disabled demo plugin, which was then re-enabled through Obsidian. No demo settings file was hand-edited. The generated calendar bundle, vendor plugin, theme and integration adapters were not changed.

No new mobile, other operating system, second Mac, live integration, native light-theme, long-duration polling or measured contrast check is claimed. There was no independent agent review. The README's older demonstration image remains explicitly labeled. Optional icon/color integrations have source research only; see [UI research](UI-RESEARCH.md).

## 1.1.0: 19 October 2026

Mail and the shared Calendar / Mail tile were selectively ported from the maintainer's 0.27.0 runtime. The public fork's configurable accounts, account-bound YouTrack imports, default-off State sync, optional Slack sources and first-trust recovery remain intact. No personal notes, account snapshots or settings were copied.

- **192 Node tests and 21 Python tests passed.** Ten Mail/tab behavior tests failed before the port and passed afterward. Three additional mocked-process tests verify the fixed osascript executable, literal arguments without a shell, time/output limits, safe errors and exact-message opening. No real email is opened by these tests.
- The actual-runtime browser fixture passed in desktop dark, 800px light and 480px dark panels. Mail checks cover synthetic connection data, the 50-row limit, account/unread filters and subjects containing HTML-like text. They verify that errors retain the previous list and that settings contain no Mail metadata. Tab navigation, keyboard controls, filter/scroll preservation, fixed height and layout reload also passed. Existing Scratchpad and Slack checks also pass. The preview generator now escapes inline closing-script text and resets its synthetic Mail preference between runs. Other browser storage remains untouched.
- Native Obsidian **1.11.7** loaded 1.1.0 in the independent disconnected demo vault. A 1024×800 window showed the open sidebar, header Scratchpad, three board columns and the shared tile at its 300px minimum. Mail displayed Connect Mail with no account connection. Left Arrow restored Calendar → Month. No real accounts were connected or messages opened in this demo.
- **3 distribution tests passed.** The pristine checker and release builder passed. ZIP members exactly match the reviewed allowlist plus `distribution.json`, including the new AppleScript and bridge tests. Repeated builds produced the same SHA-256. Changed runtime hashes were updated deliberately. Unchanged source/vendor files retained their hashes.
- A bounded text scan of the reviewed package found no real-token patterns or private source paths/account identifiers. Private settings, account snapshots, `.local`, `.git`, personal notes and OAuth files are excluded from the release. One agent reviewed the source and package within this scope. A comprehensive secret audit and independent security certification were outside the review.

The AppleScript bridge is byte-identical to the local 0.27.0 implementation, where real inbox metadata reads were previously verified. The public release was tested with mocked processes, synthetic browser data and a disconnected native demo. New live Mail reads, permission-denial prompts, opening real messages, the full five-minute interval, a second Mac, Intel Macs and other operating systems remain unverified. The README image remains the labeled 1.0.1 demo capture.

## 1.0.1 — 18 October 2026

This update changes starter appearance/workspace defaults, English documentation and presentation assets. Integration runtime behavior is unchanged; the unused legacy daily-note fallback headings are now English.

The separate demo vault opened with the **300px left sidebar visible**, **Files / Search / Bookmarks** tabs at the top, Files selected, and the narrow ribbon hidden. The board remained open with Scratchpad, all three widgets and the three kanban columns. The expanded Hub folder and additional example cards in the screenshot are demonstration content.

`docs/assets/hub-preview.jpg` is an actual Obsidian window capture from that demo vault. It contains only fictional sample notes; Calendar, YouTrack and Slack were disconnected. No personal-vault screenshot or account data was used. The image was visually inspected before publication.

Repository and release review covers the explicit distribution allowlist, credential-shaped strings, personal source paths/identifiers, Markdown links and screenshot contents. This is a bounded review, not a guarantee from a comprehensive secret-scanning service. Commits use GitHub noreply author metadata.

## 1.0.0 baseline — 18 October 2026

### Code and package checks

- **179 Node tests and 21 Python tests passed.** Tests use synthetic data for membership, note preservation/moves, Scratchpad, Calendar, Slack and YouTrack reads/imports/State changes.
- Portable-profile tests cover other servers/accounts/projects/State names, disconnected behavior, default-off State sync, optional Slack sources and changed Keychain profiles. New import/State operations are blocked while connection validation is pending.
- A focused test reproduced `Unknown view type: kanban-view` after first trust. The repair reopens only the affected main dashboard leaf.
- Distribution files are individually listed and SHA-256 checked in `distribution.json`. The release builder does not collect arbitrary notes or snapshots from a working vault.
- **3 distribution tests passed:** fresh installation, rejection of nonempty/symlink destinations, changed-runtime detection, and exclusion of unlisted files. Two ZIP builds produced the same SHA-256.
- Kanban Bases View 0.9.5 matches official release files. AnuPpuccin CSS matches the v1.5.0 source tag. Licenses and the corresponding theme source archive are included.
- The macOS GitHub Actions workflow passed all suites, the pristine checker and release build.

### Native Obsidian

Tested on a Mac with Obsidian **1.11.7**, a separate clean vault and synthetic notes. No personal vault or real service account was used as a fixture.

- Opening the folder selected the Board tab. Plugins were enabled after the user explicitly approved Obsidian’s trust prompt.
- The initial unknown-view problem was reproduced. Re-enabling the plugins through the UI recovered the dashboard without manually reopening its file.
- `Try Add to board` joined and left the board. Its body and location were preserved and read back from disk.
- Typing two Scratchpad lines created no file. Save created one ordinary Quick Note with the exact text, while the board stayed open.
- Status/Priority/Type/Tags/Other properties, Make a folder and separate Delete controls were present.
- The native YouTrack modal showed connection fields and default-off State sync.

### Synthetic browser preview

The fixture uses the actual runtime, vendor and theme CSS with mocked Obsidian/Slack APIs. Its DOM checks completed with **PASS**: Scratchpad Save/error/retry/double-click/exact-body/recovery/hidden-widget behavior; Slack source/filter/limit/automatic-refresh behavior. Desktop dark, an 800px light panel and the YouTrack setup form were visually inspected.

### Limits

No new live Google/Slack/YouTrack login, real YouTrack State write, friend’s Mac, Intel Mac, mobile or Windows/Linux test is claimed. Each user must finish their own account connection. Organization permissions and YouTrack MCP/field-schema compatibility still apply; mocks do not establish live service compatibility.

Final profile concurrency guards were tested in Node, and the checkbox layout in the actual-runtime browser fixture. The complete native behavioral sequence was not repeated for those final small changes. Upstream Obsidian/kanban DOM changes may affect selectors.
