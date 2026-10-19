# ES Obsidian Hub runtime

Version **1.1.0** adds Calendar / Mail from local dashboard runtime 0.27.0. This public fork began at 0.25.1 and keeps its configurable account setup. The historical plugin ID remains `aimultiple-kanban-extras`. The displayed name is ES Obsidian Hub.

Read the repository [README](../../../README.md), [AGENTS](../../../AGENTS.md) and [connection guide](../../../docs/CONNECTIONS.md). No personal notes, snapshots, tokens, local settings, global tool configuration or source-vault history is part of this package.

`main.js`, `manifest.json`, `styles.css` run directly in Obsidian. YouTrack uses `scripts/refresh-youtrack.py` and Python 3.11+. Calendar and Slack use Obsidian's runtime with no installed Node/Python dependencies. Mail requires the bundled `scripts/read-mail.applescript` and macOS `/usr/bin/osascript`. It uses no Python or additional installation. Keep the bundled ICAL license and source.

Each user connects YouTrack through local Keychain credentials and can opt into State sync with configurable state names. Imported notes retain their account identity. Slack's notes channel and user group are optional. The starter includes generic folders and recovers the board view after the initial plugin trust step. See [verification](../../../docs/VERIFICATION.md) for actual test scope.

The source below `// BEGIN LOCAL CALENDAR BUNDLE` is generated. Edit calendar adapter modules then run `node scripts/bundle-calendar.cjs` here. Keep other helpers above the marker.
