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

## Current handoff — 25 October 2026

Source **1.3.0** is prepared on `feat/type-icons-colors`, based on merged PR #1 at `794c8262a5ee9d4fb18a1595afc36e5b3a8f274f`. The checkout was clean when this task started. This pass implements the requested icon/color work rather than reopening the completed 1.2.0 port. The latest public download remains [v1.1.0](https://github.com/sariekr/es-obsidian-hub/releases/tag/v1.1.0).

Implemented: **Customize → Type icons** with twelve built-in choices and neutral defaults; matching card/Type-picker icons with retained text; small action/widget icons; distinct priority shapes with color only for High/Urgent; larger card controls and readable Done controls. Explicit preferences serialize with existing settings, preserve unrelated fields and reject stale changes. No folder-name assumptions, extra plugin, theme/vendor edit or personal-vault deployment is included.

[UI research](UI-RESEARCH.md) records fresh official Community, release-manifest and compatibility findings. Style Settings 1.0.9 remains an optional palette experiment. Iconic 1.1.11 requires Obsidian 1.13.0 and was not installed on the verified 1.11.7 runtime. Notebook Navigator 3.4.3's published minimum is 1.11.0, distinct from main's 1.13.0. Iconize's maintenance notice still argues against adding it. None of these candidates was installed or integration-tested.

[Verification](VERIFICATION.md) owns the detailed evidence: 200 Node / 21 Python tests, browser DOM/contrast checks and real native dark/light/narrow interaction checks in the disconnected `.local/demo-vault`. Five demo-only icon choices were saved via the UI. All 13 original demo notes stayed unchanged; the temporary QA card was removed. The demo runtime was copied only while disabled, and its board was left open. The source has no default Type mapping. Demo files/settings remain ignored and excluded from the distribution.

The user requested a new GitHub PR for these verified changes. Delivery uses `feat/type-icons-colors` against `main`; check the [branch's PR](https://github.com/sariekr/es-obsidian-hub/pulls?q=is%3Apr+head%3Afeat%2Ftype-icons-colors) and its latest-head checks for live status. This task does not authorize merging that new PR or publishing a release. Do not reuse the previous session's PR #1 merge instruction for this PR.

## Next steps

Review the icon/color PR and its latest-head checks. The built-in implementation is ready for review; decide separately whether to merge/release it or try Style Settings 1.0.9 for broader palette controls in the disconnected demo.

Optional navigation plugins require their own pinned-version native demo and package/license review. Keep the current Obsidian version boundary; do not upgrade the app or assume custom kanban integration from a plugin's explorer support. No need to repeat stable passing checks unless relevant code changes.

Continue in this development checkout after reading AGENTS.md, this section, VERIFICATION.md and UI-RESEARCH.md. The personal hub, source checkout and demo remain independent; never copy personal notes, credentials or settings into this repository.
