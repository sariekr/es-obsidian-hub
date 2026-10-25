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

Source **1.4.0** is prepared on `feat/widget-refresh-lists`, based on main at `e4ee44e9badb6832c017b3cbf5810cbc3654eda3`. [PR #2](https://github.com/sariekr/es-obsidian-hub/pull/2) was merged at the user's explicit request; its icon/color source is now on main. The checkout was clean when this port began. The latest public download remains [v1.1.0](https://github.com/sariekr/es-obsidian-hub/releases/tag/v1.1.0).

Implemented: **Refresh all widgets** beside Customize replaces individual refresh buttons. Hide/Show widgets moves into Customize. Calendar and Mail refresh every ten minutes while their tab is visible; YouTrack reads its snapshot every six hours while visible; Slack remains five minutes. Manual refresh includes connected hidden modules/inactive tabs, waits for all sources and isolates failures. Public disconnected/profile-switch guards, Mail permission suppression, Slack cooldowns and default-off State sync remain. Reads never import notes or change issue State.

The user authorized sharing the selected personal 0.30.0 feature; only its scoped code/test changes were adapted. No personal settings, notes, snapshots, credentials or screenshots were copied. The shared source, personal hub and `.local/demo-vault` remain independent. This task does not redeploy to the personal hub.

The [interactive HTML proposal](prototypes/widget-lists.html) shows Notebook Navigator-inspired Mail/Slack date groups, stronger titles, quieter metadata, YouTrack State groups and an aligned Agenda. It has light/dark, density and narrow-panel controls with fictional data only. It is a browser demonstration, **not an implemented widget redesign**. The source links, rationale and remaining choices are in [UI research](UI-RESEARCH.md). No optional plugin was installed; existing published-vs-main version findings remain separate.

[Verification](VERIFICATION.md) owns the evidence: 208 Node / 21 Python tests; actual-runtime browser DOM checks in dark/light/narrow layouts; native disconnected Obsidian 1.11.7 interaction checks. Fake clocks cover intervals; no full six-hour real-time wait is claimed. All 23 demo Markdown files remained unchanged. Native demo remains Calendar/Month, widgets visible at 300px, Customize closed and board unfiltered.

Delivery is [PR #3](https://github.com/sariekr/es-obsidian-hub/pull/3), open from `feat/widget-refresh-lists` against `main`; implementation commit `1eca24a`. This follow-up records the verified PR receipt without embedding its own hash. Check the PR’s exact latest-head CI before merging. A new PR merge and a public release are separate decisions; the earlier PR #2 merge instruction is already fulfilled.

## Next steps

Review [PR #3](https://github.com/sariekr/es-obsidian-hub/pull/3) and the standalone HTML proposal. Choose whether to implement Mail/Slack date groups first; the list redesign is not yet in the runtime. Merge/release remains a separate decision.

Continue in this development checkout after reading AGENTS.md, this section, VERIFICATION.md and UI-RESEARCH.md. Use `docs/prototypes/widget-lists.html` directly in a browser; no server or install is required. The smallest proposed follow-up is date grouping and shared row spacing with existing filtering, limits, safe rendering, source-open actions and scroll retention preserved. Evaluate YouTrack State grouping and Calendar Agenda alignment afterward.

A Notebook Navigator sidebar trial is a different scope: pin its published version, respect the installed Obsidian minimum and check AnuPpuccin/leaf behavior. It cannot be assumed to restyle custom Hub cards or widgets. Never copy personal notes, credentials or settings into this repository.
