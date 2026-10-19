# Updating

This starter does not automatically replace files in your everyday vault.

1. **Save** any Scratchpad draft. If you use Sync, let it finish.
2. Back up the entire vault, then close Obsidian.
3. Extract the new release into a **separate folder**. Read its release notes and `docs/VERIFICATION.md`.
4. For a normal Extras update, limit replacements to the code, manifest, CSS and helper scripts under `.obsidian/plugins/aimultiple-kanban-extras/`. Preserve your **data.json** preferences and **youtrack-widget.json** snapshot. Do not delete and replace the entire folder.
5. Keep your `Hub`, `Templates`, `.obsidian/workspace.json`, `app.json`, `appearance.json`, board and taxonomy. If a release requires changes there, review and apply individual differences.
6. Update vendor plugins or the theme only when release notes call for it. Extras depends on some upstream DOM selectors.
7. Reopen Obsidian and check the board and note tools. Keep real YouTrack issues unchanged during testing. If needed, restore the changed code files from your backup.

`scripts/install.py` requires a new empty destination. Use the steps above to update an existing vault. Keep a separate source checkout and personal vault. Do not publish your personal vault to obtain updates.

`distribution.json` records starter-file hashes. When deliberately updating a version, also carry over its checker and manifest with the new runtime hashes. Do not restore edited sample notes to their original hashes: normal `check-setup.py` does not validate personal note contents.

## 1.1.0: Calendar / Mail

Copy the new `scripts/read-mail.applescript` together with `main.js`, `styles.css` and `manifest.json`. Mail cannot run from the three main plugin files alone. Run the updated checker after copying the reviewed code and `distribution.json`.

Mail starts disconnected on this device. Open its tab and choose **Connect Mail** to use your local Apple Mail accounts. Existing Google, Slack and YouTrack settings and Keychain entries remain compatible. Remote YouTrack State sync keeps its current setting and remains off for new users. Calendar and Mail now share one visibility control. The Calendar tab starts in Month after a reload. Date/view, Mail filters and scroll reset after the session ends.

## 1.0.1 layout defaults

New vaults start with a 300px left sidebar open, Files selected, Search and Bookmarks tabs beside it at the top, and the narrow vertical ribbon hidden. Existing vaults can use the sidebar toggle and **Settings → Appearance → Show ribbon** to match this arrangement. Do not replace an existing workspace merely to change these preferences.

Version 1.0.1 also adds an English README and guides, plus a demo screenshot. The screenshot contains additional fictional cards for illustration. The starter keeps its small set of editable example notes. Integration runtime behavior is unchanged.
