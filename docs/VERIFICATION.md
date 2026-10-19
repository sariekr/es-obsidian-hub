# Verification record

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
