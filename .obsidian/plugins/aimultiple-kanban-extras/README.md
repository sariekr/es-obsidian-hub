# ES Obsidian Hub runtime

Version **1.0.1**, forked from the local dashboard runtime 0.25.1 for distribution as a clean, configurable starter vault. The historical plugin ID remains `aimultiple-kanban-extras`; the displayed name is ES Obsidian Hub.

Read the repository [README](../../../README.md), [AGENTS](../../../AGENTS.md) and [connection guide](../../../docs/CONNECTIONS.md). No personal notes, snapshots, tokens, local settings, global tool configuration or source-vault history is part of this package.

`main.js`, `manifest.json`, `styles.css` run directly in Obsidian. YouTrack additionally uses `scripts/refresh-youtrack.py` and Python 3.11+. Calendar and Slack use Obsidian's runtime with no installed Node/Python dependencies. Keep the bundled ICAL license and source.

New in the public fork: per-user YouTrack setup with local Keychain credentials, explicit opt-in State sync and configurable state names; optional Slack notes channel/group; account-bound imported notes; first-trust board recovery; generic folders and starter workspace. See [verification](../../../docs/VERIFICATION.md) for actual test scope.

The source below `// BEGIN LOCAL CALENDAR BUNDLE` is generated. Edit calendar adapter modules then run `node scripts/bundle-calendar.cjs` here. Keep other helpers above the marker.
