# ES Obsidian Hub runtime

Version **1.2.0** selectively ports compact cards, temporary search/Type filters and a read-only note preview from local runtime 0.28.0. Version 1.1.0 added Calendar / Mail from local runtime 0.27.0. This public fork began at 0.25.1 and keeps its configurable account setup. The historical plugin ID remains `aimultiple-kanban-extras`. The displayed name is ES Obsidian Hub.

Read the repository [README](../../../README.md), [AGENTS](../../../AGENTS.md) and [connection guide](../../../docs/CONNECTIONS.md). No personal notes, snapshots, tokens, local settings, global tool configuration or source-vault history is part of this package.

`main.js`, `manifest.json`, `styles.css` run directly in Obsidian. YouTrack uses `scripts/refresh-youtrack.py` and Python 3.11+. Calendar and Slack use Obsidian's runtime with no installed Node/Python dependencies. Mail requires the bundled `scripts/read-mail.applescript` and macOS `/usr/bin/osascript`. It uses no Python or additional installation. Keep the bundled ICAL license and source.

Each user connects YouTrack through local Keychain credentials and can opt into State sync with configurable state names. Imported notes retain their account identity. Slack's notes channel and user group are optional. The starter includes generic folders and recovers the board view after the initial plugin trust step. See [verification](../../../docs/VERIFICATION.md) for actual test scope.

The source below `// BEGIN LOCAL CALENDAR BUNDLE` is generated. Edit calendar adapter modules then run `node scripts/bundle-calendar.cjs` here. Keep other helpers above the marker.

The managed main board adds one filter row and compact Priority/Type buttons per card. Optional excerpts use the first nonempty text under Next step or Sonraki adım. Search matches rendered titles, paths, issue IDs and effective Types, with diacritic-insensitive matching; it combines with the Type selector. Filters stay in the rendered leaf and reset on reload. Column/WIP totals still describe the saved Base result.

Preview is a nonmodal, text-only Markdown subset: no YAML, HTML execution, embeds, remote images or plugin postprocessors. It reads at most a 2 MiB note and shows at most 50,000 characters; Open note opens or reuses a Markdown tab while preserving the board. Excerpts are bounded and cached in memory. Metadata/file events invalidate them, and redraw/unload cleans owned controls, listeners and panels. Card Priority/Type controls reuse existing guarded property actions; choosing Type can still move the note.

Generate the synthetic DOM check with `python3 -B tests/board.preview.py` from this folder. Serve its printed directory over localhost and open it in a browser. Use `?narrow=1&light=1` or `?compact=1&preview=1` for panel variants. The fixture uses fictional notes and mocked APIs. See the repository's [handoff](../../../docs/DEVELOPMENT.md#next-steps) and [verification record](../../../docs/VERIFICATION.md).
