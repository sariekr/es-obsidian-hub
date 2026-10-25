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

Source **1.2.0** is prepared on `feat/board-ui-preview`, based on the published 1.1.0 source. The selected three UI changes are now in this checkout and were tested in its independent `.local/demo-vault`. The personal experiment remains a separate installation; there is no synchronization or deployment link between them.

Implemented: compact Priority/Type controls and optional next-step excerpts; temporary title/path/issue-ID search combined with live Type filtering; a bounded read-only Preview panel with Open note. Public account defaults and State-sync opt-in are preserved. [Verification](VERIFICATION.md) owns the evidence. [UI research](UI-RESEARCH.md) records recommendations and version checks for icons/colors; those plugins were researched, not installed.

GitHub delivery of this branch and its PR is requested. This handoff is saved before that delivery; verify the remote branch, PR and checks for its actual head before resuming. No merge, tag or public release is included in the delivery request. The latest published download remains 1.1.0.

## Next steps

Review the PR for `feat/board-ui-preview` and its current-head checks before merging. Then decide whether to prototype theme color controls and built-in Lucide icons in the disconnected demo. Additional plugin installation and a public 1.2.0 release remain separate decisions.

Continue in this development checkout, reading AGENTS.md, this section, VERIFICATION.md and UI-RESEARCH.md. Use the existing demo for native checks. Do not re-copy the personal plugin wholesale or overwrite any personal notes/settings. Stable passing checks above need no repeat unless the relevant code changes.
