# ES Obsidian Hub — agent installation and maintenance

This repository is a redistributable **starter Obsidian vault for macOS**, not the maintainer's personal vault. Read README.md, docs/CONNECTIONS.md and docs/VERIFICATION.md first. The primary user is new to Obsidian. Keep the UI in English and explain setup in the user's language.

## Install for a new user

1. Identify an explicit new destination, usually `~/Documents/ES Obsidian Hub`. Never overlay an existing vault, replace its `.obsidian`, or reset a user's notes. If a destination is already populated, choose a new empty folder with the user.
2. Prefer the release ZIP. With a clean source checkout and Python 3.9+, run `python3 scripts/install.py --dest "$HOME/Documents/ES Obsidian Hub"`. It copies the reviewed distribution file list, includes hidden `.obsidian`, excludes `.git`, refuses a nonempty destination and never launches an app or reads credentials. No npm/pip installation is needed. Shell quotes around the path are essential.
3. Open the destination through Obsidian **Open folder as vault**. Obsidian 1.11.4+ is required. The user owns Obsidian's first-run **Trust author and enable plugins** decision; do not edit global trust records to bypass it. Enable both **Kanban Bases View** and **ES Obsidian Hub** through the app UI.
4. The shipped `.obsidian/workspace.json` opens `Hub/Kanban Board.base` with the 300px left sidebar open. Files is selected, with Search and Bookmarks beside it at the top; the narrow vertical ribbon is hidden through `appearance.json`. After first trust, Extras repairs that one view if Obsidian still shows `Unknown view type: kanban-view`. Normal tabs and other Bases are left alone. If the board is absent, open that exact file; ensure Bases is enabled and the active view is **Board**.
5. Run `python3 scripts/check-setup.py --vault "<destination>"`. It performs read-only file/hash/configuration checks. A good result is not proof that an external account is connected. If a runtime hash differs, identify why; never regenerate hashes to hide an unexplained mismatch.
6. Verify native UI: Scratchpad above Calendar/YouTrack/Slack, three kanban columns, Backlog **Add note**, hidden native board toolbar, note **Add to board**, property controls, **Make a folder**, and separate **Delete note**. Test with new disposable notes only. Save creates exactly one ordinary Quick Note; typing alone creates none. Remove from board preserves body and location.
7. Ask which optional integrations the user wants, then follow docs/CONNECTIONS.md. Tokens/JSON are entered privately by the user in local Obsidian dialogs. Never request them in chat, read Keychain values, inspect global Codex/Claude credentials, create a shared token, or publish a connected vault. Calendar and Slack need no Python. YouTrack alone needs Python 3.11+ at the first existing `/opt/homebrew/bin/python3` or `/usr/local/bin/python3`.
8. Explain customizable folders and leave the actual board open. Report what was verified, what still needs the user's account action and any platform limitation. Do not claim Google/Slack/YouTrack live verification from mocks.

## Account boundaries

- Google OAuth reads the primary calendar only, using `calendar.events.owned.readonly`. The private-iCal fallback must use a Secret address, never require a public calendar. Each Mac connects separately.
- Slack derives team/user identity from the token. Notes channel and user-group handle are optional. Personal mentions and incoming one-to-one DMs remain enabled. Exact group matching requires the authenticated user's membership. Preserve bounds, rate limits, atomic whole-snapshot replacement and hidden-view scheduling.
- YouTrack host/login/project/state mapping and token are device-local Keychain data under `es-hub-youtrack`. The standard-library Python helper receives a bounded JSON payload on stdin and never reads Codex or Claude configuration. It sends HTTPS only to the configured hostname and rejects credential-bearing URLs/redirects.
- YouTrack uses the built-in MCP tool schema and projects with scalar `Assignee`, `State` and `Priority` fields. Custom multi-assignee or field schemas require explicit adapter work and behavioral tests; do not weaken identity/ownership checks. Current login/project/host syntax is documented in CONNECTIONS.md. Only one project/account per vault is supported.
- State sync is **off by default**. Enable it only at the user's request in the native setup dialog. Imports and moves then change only the mapped State after identity/ownership/schema checks and independent read-back. Startup never bulk-syncs, and uncertain writes never replay automatically. Do not use a real issue as a QA fixture.
- Imported files carry `youtrack_import: local-v1`, `youtrack_id`, `youtrack_url` and `youtrack_assignee`. Keep these fields. They bind the note to the configured account/host; duplicate or mismatched IDs fail visibly. Refresh never rewrites imported notes. Never add a background mirror/scheduler.
- Slack/Google tokens, YouTrack token/profile, Scratchpad recovery, saved-note receipt and widget-height preferences are device-local. YouTrack's snapshot and explicitly imported notes/attachments are files and may travel with a vault copy. Never assume Keychain transferred.

## Code map and behavior to preserve

| Path | Purpose |
| --- | --- |
| `.obsidian/plugins/aimultiple-kanban-extras/main.js` | ES Hub runtime: note tools, board menus, Scratchpad, sizing, account dialogs, Slack reader, YouTrack process bridge |
| same folder: `styles.css`, `manifest.json` | Theme-inheriting styles and runtime metadata; public display name ES Obsidian Hub, historical plugin ID retained |
| same folder: `scripts/refresh-youtrack.py` | Bounded MCP reads/imports; exactly one allowed State update plus read-back |
| `calendar.js`, `google-calendar.js`, `meeting-links.js`, `vendor/ical.cjs` | Calendar sources bundled into main.js |
| `scripts/bundle-calendar.cjs` in plugin | Rebuild generated calendar portion after those source files change; never hand-edit generated bundle |
| `.obsidian/plugins/kanban-bases-view/` | Unmodified upstream 0.9.5; do not patch vendor code |
| `.obsidian/themes/AnuPpuccin/` | Unmodified tagged v1.5.0 theme; preserve license and corresponding source archive |
| `Hub/_kanban/taxonomy.md` | Columns, priorities, WIP, body; Type choices come from live direct Hub folders |
| `Hub/Kanban Board.base` | Single board filter: Hub notes with kanban tag |
| `distribution.json` | Reviewed initial file allowlist and SHA-256 hashes; release builders must not harvest arbitrary vault content |
| `scripts/` | Read-only checker, fresh-destination installer and reproducible release builder |

Any Markdown note under Hub can join the board without moving. Removing membership preserves body and location. Explicit Type changes may move the note or wrapping folder; reject collisions and stale targets. Native deletion must target the current Markdown file, never its parent. Keep per-file concurrency guards and rollback reporting.

Keep three columns (`backlog`, `in-progress`, `done`), live Hub Type discovery and existing `processFrontMatter` writes. Rendering must not write default properties, move notes or alter settings. Do not hand-edit `data.json` while Obsidian is running. Settings changes use serialized `loadData`/`saveData`, preserving unrelated fields. Do not alter theme or vendor files to fix an Extras selector.

The menu integration depends on `.obk-card[data-entry-path]` and `.obk-column[data-column-value]`; upstream changes can break it. Backlog quick capture, board header hiding and layout use scoped selectors. Cleanup must remove observers, owned nodes, timers and listeners from main/pop-out windows.

Keep inherited AnuPpuccin fonts/colors, theme-aware controls, the horizontal Scratchpad and shared widget separator. Preserve narrow-panel scrolling, focus and reduced-motion behavior. New UI work should build on this surface, without adding unrelated product/design scaffolding to a user's vault.

## Development and publication

Keep three independent locations: the maintainer's personal vault, this development checkout, and a separate demo vault with fictional notes. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Work in this repository must never deploy to or alter the personal vault. Do not create shared symlinks, sync jobs, watchers or automatic copying between them.

The maintainer may first develop a feature in their personal hub. Port it here only after an explicit request to share that feature. Transfer the selected code changes, adapt personal assumptions into configurable defaults, and test in the demo vault. Never copy the personal vault, its notes, credentials, account snapshots or settings wholesale. A personal-hub change is not automatic authorization to update or publish this repository; repository changes are not automatic authorization to update the personal hub.

Use a **separate clean checkout** for development; a user's working vault is data, not a release staging directory. A release may contain only synthetic starter notes, code, tests, docs, licenses and reviewed defaults. Never copy an entire personal vault to prepare a release. The original personal installation is outside this repository's scope.

Keep public documentation, setup instructions and screenshot captions in English. Capture presentation images only from a disconnected demo vault with fictional notes. Use GitHub noreply commit metadata; never copy personal workspace history or account settings into a release.

For behavior changes, first add and run a focused failing test. Then run:

```sh
node --test .obsidian/plugins/aimultiple-kanban-extras/tests/*.test.cjs
python3 -B -m unittest discover -s .obsidian/plugins/aimultiple-kanban-extras/tests -p 'test_*.py' -v
python3 scripts/check-setup.py --pristine
python3 -B -m unittest discover -s scripts/tests -v
```

The Node/Python tests use synthetic data and no real service writes. To generate the actual-runtime browser preview:

```sh
python3 -B .obsidian/plugins/aimultiple-kanban-extras/tests/slack.preview.py
```

Open its printed file URL through an available browser tool. The page runs its own DOM checks. `?light=1`, `?narrow=1` and `?compact=1` cover appearance/panel variants. This is a browser fixture, not a native Obsidian test. Use a separate disposable vault for first-trust, startup and real Obsidian behavior. Never put real credentials into fixtures.

When intentional source changes are complete, review the diff and update only the corresponding hashes in `distribution.json`. A new distributable file requires an explicit allowlist entry. `python3 scripts/build-release.py` validates pristine hashes and builds `dist/es-obsidian-hub.zip` plus `dist/SHA256SUMS`. Compare ZIP members against the allowlist before publishing. Preserve MIT, GPL-3.0 and MPL-2.0 notices/source boundaries.

Publishing, GitHub writes, installs, global configuration changes and remote state changes require authorization from the current user task; this document does not grant them. Do not auto-create issues, send messages, push personal notes or change global skills as part of installation.
