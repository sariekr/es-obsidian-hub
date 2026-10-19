# Troubleshooting

| Symptom | What to check |
| --- | --- |
| Empty screen or ordinary notes instead of the board | Does the selected vault contain the hidden `.obsidian` folder? Open `Hub/Kanban Board.base`. |
| `Unknown view type: kanban-view` | Enable both supplied plugins under **Settings → Community plugins**, then close settings. If automatic recovery does not work, close and reopen the board tab. |
| Home or Add to board is missing | Check **ES Obsidian Hub** is enabled, the correct vault/config folder is open, and the Base view is **Board**. |
| The plugin cannot load | Run the checker. If runtime files are missing, extract a complete release into a new folder. |
| The folder sidebar is hidden | Use the upper-left sidebar toggle. In a fresh vault, Files starts selected with Search and Bookmarks at the top. Existing workspaces retain their own layout. |
| Add to board is disabled | The note must be under `Hub`. Root documents such as README and AGENTS are outside board membership scope. |
| A note remains after Remove from board | It may have an inline `#kanban` tag in its body. The plugin does not silently rewrite your prose; remove that tag yourself. |
| A Type folder is missing | Types come from direct Hub subfolders. Nested folders, utility folders and loose files are excluded. |
| A Done card disappears later | The main Board hides cards seven days after completion. Find them with **Customize → Show board controls → By Status**. Their files are not deleted. |
| Columns look narrow or scroll sideways | Narrow panels scroll widgets horizontally. Enlarge the window or drag the widget separator upward. Visible card count depends on window height. |
| Mail is missing | Update the complete Extras runtime to 1.1.0, including `scripts/read-mail.applescript`, and reload the plugin. Select the Mail tab in the left tile. |
| Mail access was not allowed | Enable Obsidian → Mail under System Settings → Privacy & Security → Automation, then explicitly retry Connect or Refresh. |
| Mail refresh times out or cannot identify an inbox | Open Apple Mail and let it finish syncing. Every enabled account must expose exactly one supported top-level inbox; see the connection guide. The previous successful list remains visible. |
| Mail unread count differs from Apple Mail | Unread filters the bounded inbox sample; it is not a total unread counter. |
| YouTrack reports a Python error | Run `python3 scripts/check-setup.py`. The first existing `/opt/homebrew/bin/python3` or `/usr/local/bin/python3` must be 3.11+. |
| YouTrack identity check fails | Use your exact account login. It may differ from your display name. The token must belong to that account and have the YouTrack scope. |
| YouTrack shows an empty list | Check the project key, unresolved issues assigned to you, and server MCP visibility. An incorrect project key can also produce an empty result. |
| YouTrack State does not change | Sync starts off. To enable it, configure **YouTrack settings → Board status sync** with real State names. Remote writes require a subsequent selected import, column change or explicit Sync status action. |
| Google returns 403 / API disabled | Enable Calendar API in the project owning your OAuth client, and check Workspace approval. |
| Slack reports missing scope | Add scopes under **User Token Scopes**, reinstall the app, then reconnect with its User OAuth Token. |
| Slack cannot find a channel/group | You must belong to the selected channel/group. Enter a channel name or group handle. URLs and display titles are invalid. Leave optional fields blank if unwanted. |
| Connections are absent on another Mac | Connect separately on each device. Copying a vault does not transfer Keychain credentials. |
| Keep a Scratchpad draft when switching devices | Click **Save** first. Recovery drafts are local and do not Sync. |

From a Terminal opened in the vault folder, run:

```sh
python3 scripts/check-setup.py
```

This command reads package files without credentials, network requests or writes. You can share its output with Codex. Do not include tokens, OAuth JSON or screenshots of private messages. [AGENTS.md](../AGENTS.md) explains how to troubleshoot while preserving existing notes.
