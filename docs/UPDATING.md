# Updating

This starter does not automatically replace files in your everyday vault.

1. **Save** any Scratchpad draft. If you use Sync, let it finish.
2. Back up the entire vault, then close Obsidian.
3. Extract the new release into a **separate folder**. Read its release notes and `docs/VERIFICATION.md`.
4. For a normal Extras update, replace only the code, manifest, CSS and helper scripts under `.obsidian/plugins/aimultiple-kanban-extras/`. Preserve your **data.json** preferences and **youtrack-widget.json** snapshot. Do not delete and replace the entire folder.
5. Keep your `Hub`, `Templates`, `.obsidian/workspace.json`, `app.json`, `appearance.json`, board and taxonomy. If a release requires changes there, review and apply individual differences.
6. Update vendor plugins or the theme only when release notes call for it. Extras depends on some upstream DOM selectors.
7. Reopen Obsidian and check the board and note tools. Do not change a real YouTrack State just for testing. If needed, restore only the changed code from your backup.

`scripts/install.py` installs into new empty destinations only. It is not an updater. Keep a separate source checkout and personal vault; do not publish your personal vault to obtain updates.

`distribution.json` records starter-file hashes. When deliberately updating a version, also carry over its checker and manifest with the new runtime hashes. Do not restore edited sample notes to their original hashes: normal `check-setup.py` does not validate personal note contents.

## 1.0.1 layout defaults

New vaults start with a 300px left sidebar open, Files selected, Search and Bookmarks tabs beside it at the top, and the narrow vertical ribbon hidden. Existing vaults can use the sidebar toggle and **Settings → Appearance → Show ribbon** to match this arrangement. Do not replace an existing workspace merely to change these preferences.

Version 1.0.1 also adds an English README and guides, plus a demo screenshot. The screenshot contains additional fictional cards for illustration; the starter keeps its small set of editable example notes. Integration runtime behavior is unchanged.
