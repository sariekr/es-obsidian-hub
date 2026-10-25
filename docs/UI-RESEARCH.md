# Icons and colors for ES Obsidian Hub

Research checked on 25 October 2026 using Obsidian Community, maintainer documentation and release manifests. Public pages were fetched through Bright Data; the download-sorted Community page was also visible in native Chrome. The Iconic picker and AnuPpuccin palette examples were visually inspected. No candidate plugin was installed or compatibility-tested in the demo.

## Recommendation

Start with the existing AnuPpuccin palette and Obsidian's bundled Lucide icons. Use icons to identify Type and actions, and small color accents for priority/selection. Preserve the text labels, three columns and existing light/dark adaptation. The current runtime already uses Obsidian's `setIcon` and theme color variables, so adding a small number of icons to our own controls needs no icon-pack dependency.

**Style Settings is the first optional plugin to try.** It exposes existing theme controls instead of replacing the workspace. **Iconic is the next candidate for the native file explorer, tabs and properties**, after selecting a compatible release. Our custom kanban cards need their own implementation or an explicitly tested integration; Iconic's documented supported surfaces do not establish automatic support for those cards.

| Candidate | Useful part | Fit and limit |
| --- | --- | --- |
| [Style Settings](https://community.obsidian.md/plugins/obsidian-style-settings) | A settings UI for CSS variables/classes defined by themes, snippets and plugins; themed color controls | Best first experiment with the already bundled theme. It exposes settings that CSS declares; it does not invent settings for our controls. New Hub-specific color controls would need a small declared settings block and refresh integration. |
| [Iconic](https://community.obsidian.md/plugins/iconic) | Searchable Lucide/emoji picker, theme-following colors and rules based on folders, tags and properties | Good for distinct Work/Learning/Personal navigation icons. Keep icon plus text, use color sparingly, and test interactions with our note property toolbar. Do not assume it decorates vendor kanban cards. |
| [Notebook Navigator](https://community.obsidian.md/plugins/notebook-navigator) | Folder/tag/property navigation, note excerpts, compact lists and configurable icons/colors | Worth a separate sidebar prototype when browsing becomes the problem. It is a replacement navigation surface with a larger scope than an icon/color pass. Its note-preview hierarchy informed the card treatment; no source code was copied. |
| [Iconize](https://community.obsidian.md/plugins/obsidian-icon-folder) | SVG/icon packs and file/folder rules | Do not add as the default. Its maintainer announced end of maintenance effective 1 March 2025. Iconic's documentation also notes visual conflicts when both are enabled. |

## Version checks that change the decision

- **Iconic 1.1.11** is the latest release returned during this check; its [tagged manifest](https://github.com/gfxholo/iconic/blob/1.1.11/manifest.json) requires **Obsidian 1.13.0**. The native test app is 1.11.7, so this release is not a drop-in recommendation for that app. The upstream [version map](https://github.com/gfxholo/iconic/blob/main/versions.json) lists 1.1.4 for Obsidian 1.6.0; this is an older compatibility candidate, not a tested recommendation. Do not bypass the minimum-version check.
- **Notebook Navigator 3.4.3** has a [tagged manifest](https://github.com/johansan/notebook-navigator/blob/3.4.3/manifest.json) requiring **1.11.0**, so its declared minimum includes the test app. The main-branch manifest/Community page showed 1.13.0 during research. The release tag is the relevant source for a pinned release; neither declaration substitutes for a native integration test.
- **Style Settings 1.0.9** declares **0.11.5** in its [manifest](https://github.com/mgmeyers/obsidian-style-settings/blob/main/manifest.json). Its [documentation](https://github.com/mgmeyers/obsidian-style-settings) describes `variable-themed-color` and the `parse-style-settings` event for plugin-defined settings.

AnuPpuccin's [maintainer guide](https://github.com/AnubisNekhet/AnuPpuccin) documents palette selection, optional rainbow folders and Style Settings support. Rainbow folders use filesystem order, so they are not a stable semantic Type-to-color mapping. Our recommendation is consistent named Type icons with restrained theme-derived accents, rather than assigning meaning to that ordering.

## A concrete next prototype

In the demo only, try `briefcase` for Work, `graduation-cap` for Learning, `user` for Personal and `sticky-note` for Quick Notes. Keep unfamiliar/new Types on a neutral folder icon. For a shared release, folder names are user-customizable: any mapping must be optional and configurable, never inferred from personal folder names.

Keep priority text and its small dot together. Use the existing accent for focus, selection and primary actions; retain the vendor's column colors. A Type color should be a subtle icon or chip accent, not a full-card fill competing with status and priority. Compare one neutral scheme and one restrained accent scheme in both light and dark mode before deciding.

No installation, palette replacement or additional UI feature is approved merely by this research record. A future bundled plugin requires native demo verification and the repository's ordinary package/license review. Iconic's [README](https://github.com/gfxholo/iconic) describes its MIT-0 code license and separate third-party resource licenses; Notebook Navigator is GPL-3.0. Inspiration does not require copying their code or assets.

The maintenance finding for Iconize comes from the author's [deprecation notice](https://github.com/FlorianWoelki/obsidian-iconize/discussions/646), not from download rank. Popularity alone is not a compatibility or maintenance check.
