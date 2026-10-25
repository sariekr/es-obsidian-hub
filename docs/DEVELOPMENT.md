# Developing the shared hub

Keep the personal hub, shared source and demo vault separate.

| Location | Purpose | Rules |
| --- | --- | --- |
| Personal vault | Everyday notes and personal experiments | Never changed by work on this repository. Never published as a release. |
| Development checkout | Git source for the shared starter | Contains reviewed code, generic examples, documentation and distribution files. Keep account connections off. |
| `.local/demo-vault/` | Native Obsidian testing and screenshots | Uses fictional notes only. The whole `.local/` tree is Git-ignored and never included in releases. |

The demo lives inside the project folder for convenience, while its notes, `.obsidian` settings and plugin files remain independent copies. For example:

```text
~/Developer/es-obsidian-hub/
├── .git/                   # Shared source repository
├── .local/
│   └── demo-vault/          # Local-only Obsidian test vault
├── .obsidian/              # Reviewed starter defaults and source runtime
├── Hub/                    # Public starter examples
└── docs/
```

Open `.local/demo-vault` with Obsidian's **Open folder as vault** for testing; use Finder's `Cmd+Shift+.` to reveal `.local`. It has its own notes and configuration but no `.git` directory of its own. Git commands run inside it would still discover the parent repository, so run Git from the project root and never force-add ignored demo files. Do not add `.local/` paths to the distribution manifest.

The ignored demo is local workspace data and will not appear in a clone or release ZIP. To recreate it, extract a clean release into a temporary folder and move that extracted vault to `.local/demo-vault`, only when the target is absent and closed in Obsidian. The normal installer intentionally refuses destinations inside its own source checkout. Do not copy an everyday vault into this location.

Use ordinary independent folders, not symlinks or folders automatically synchronized with the personal vault.

## Bring a personal feature into the shared version

1. Wait for an explicit request to port the selected feature. Trying something in the personal hub alone does not authorize sharing it.
2. Review the relevant code difference. Transfer only what the feature needs; never copy the personal vault or its full plugin configuration.
3. Replace personal account names, projects, channels and paths with optional settings or generic examples. Preserve this starter's account and privacy boundaries.
4. Make and test the change in the development checkout. For behavior changes, follow the failing-test workflow in [AGENTS.md](../AGENTS.md).
5. Test with fictional notes in the separate demo vault. Close that vault before replacing its runtime files, or disable/re-enable the plugin through Obsidian's UI. Never use personal notes or remote issues as test fixtures.
6. Review the diff, account-data exclusions, documentation and distribution hashes before committing. Publish a release when the user requests it or the active task already authorizes publication.

Changes in either direction are deliberate. There is no automatic synchronization, deployment, background watcher or shared plugin directory between these locations. A change to the shared repository does not update the personal hub.

Temporary browser previews and old QA folders are disposable output, not the canonical source. Keep the Git checkout and separate demo vault as the ongoing workspaces. Build releases only from `distribution.json` in the checkout, never from a demo or everyday vault.

## Current handoff — 26 October 2026

Source **1.5.0** was delivered in commit `af3bec2d9313ba99d3b57700a249ca1ae0e766a7` on `feat/youtrack-state-filters` through [PR #4](https://github.com/sariekr/es-obsidian-hub/pull/4), targeting `main`. At the handoff check on **26 October 2026, 01:20 Europe/Istanbul**, PR #4 was open, mergeable and both current-code CI runs had passed. The branch is based on main at `225851871cafdd50c201f7a6fa7b03e39feba916`. This handoff-only update follows that implementation commit; its final delivery and current-head checks are reported in the closing receipt. [PR #3](https://github.com/sariekr/es-obsidian-hub/pull/3), containing shared refresh, symmetric widget frames and the Calendar marker fix, was merged at the user's request. The published download remains [v1.1.0](https://github.com/sariekr/es-obsidian-hub/releases/tag/v1.1.0).

Implemented: **To do / In progress / Done** replace the YouTrack project/context row. They reuse Slack's controls and selection style. To do is the initial view. An **Other** filter appears only for loaded unmatched open states. Filters are temporary view state: they do not request data, save settings, import notes or change remote State. The header counts visible rows; its tooltip retains configured project/account scope. Actual State headings and within-group order remain.

Refresh retains the existing complete open-issue read (maximum 400) and adds one page of the latest 20 resolved issues, ordered by update time. Done includes all server-resolved states and current confirmed local completion results. Pagination is disclosed. A malformed/foreign/duplicate row rejects the entire new snapshot, preserving the old one. Legacy open-only snapshots stay usable and explain how to load Done. The six-hour interval, account isolation and default-off State sync are unchanged.

Verified: **212 Node + 24 Python tests**, actual-runtime browser fixtures in desktop dark and 800px light, and disconnected native Obsidian **1.11.7** in `.local/demo-vault`. The native demo showed all three controls, selected-state changes and aligned frames at 300px; it remains on To do / Calendar Month with no account connected. Browser checks include mapped states, conditional Other, resolved variants, legacy snapshot guidance, no filter-triggered writes/reads and the existing geometry regressions. See [VERIFICATION.md](VERIFICATION.md). The feature was also deliberately adapted to the separately authorized personal installation; its private data and adapter are excluded from this repository.

The separately authorized personal installation is complete at **0.32.0**. Its existing plugin README owns the private continuation and rollback record. The recorded native check was Obsidian 1.11.7, desktop dark, with the 408px preference retained; all three filters and a completed shared refresh were observed. Personal notes and plugin settings were unchanged. Its independent suites passed 198 Node / 24 Python tests. No further installation is pending, and this documentation handoff does not redeploy either vault.

Research: JetBrains' documented resolved/unresolved semantics informed the bounded Done read, via Bright Data. No new community plugin was needed. [UI-RESEARCH.md](UI-RESEARCH.md) records the source; [DESIGN.md](DESIGN.md) owns the visual contract and [CONNECTIONS.md](CONNECTIONS.md) explains the filter limits.

## Next steps

Implementation and personal installation are complete. [PR #4](https://github.com/sariekr/es-obsidian-hub/pull/4) is open for review; merge and a new public release remain separate decisions. No further feature work or vault deployment is queued.

The earlier request to merge the then-open PRs was fulfilled by merging PR #3. The public download is still 1.1.0; source 1.5.0 has not been published as a release. Recheck PR #4 and its exact head before acting, since the GitHub state can change after this handoff.

Continue after reading AGENTS.md, this section, DESIGN.md, VERIFICATION.md and UI-RESEARCH.md. Inspect Git and current PR state before editing. Keep the public source, fictional demo and personal installation independent. No real account writes or shared-demo live connection test were performed. Notebook Navigator sidebar installation, density switching and richer multi-day Agenda remain separate optional work; no extra plugin is required for these filters.
