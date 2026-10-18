# Verification record

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
