# Connect your own accounts

The board works without any account connection. This package never uses the maintainer's accounts. Enter tokens and OAuth files in Obsidian's local setup dialogs. Keep them out of notes, GitHub and chat.

Source 1.4.0 uses **Refresh all widgets** beside Customize; the published 1.1.0 ZIP still has the older separate controls and intervals. Automatic reads run only while their Home/widget is visible; Calendar and Mail additionally require their active tab. Manual refresh also includes connected hidden modules and inactive tabs. It never connects a new account, imports issues or changes remote State.

## Google Calendar

This version reads your Google account's **primary** calendar. It does not offer a calendar selector or create/change events. Agenda opens available Google Meet and Zoom links.

### Desktop Google sign-in

1. Open [Google Cloud Console](https://console.cloud.google.com/) with your own account. Create a project or select one dedicated to your account.
2. Enable **APIs & Services → Library → Google Calendar API**.
3. Under **Google Auth platform → Branding / Audience**, configure the app. Use **Internal** where appropriate for your Workspace. For a personal Gmail account, use **External** and add your account as a test user while the app is in testing. Your Workspace administrator may need to approve it.
4. Choose **Clients → Create Client → Desktop app**. Download the client configuration as a JSON file and keep it outside your vault.
5. In Hub, choose **Connect Google Calendar → Google sign-in · desktop → Import client JSON**. Select the downloaded file, then **Sign in with Google**.
6. Grant read-only access in your browser. Return to Obsidian and wait for the setup dialog to close itself. The first month must load successfully before the connection is saved.
7. Check **Agenda**, then reopen Obsidian to verify that the saved connection works.

The requested scope is `calendar.events.owned.readonly`. Access tokens and events stay in memory. Client details and refresh tokens are stored in Obsidian Keychain, the app's local secret storage. A visible Calendar tab refreshes roughly every ten minutes. Google's [Desktop OAuth setup guide](https://developers.google.com/workspace/calendar/api/quickstart/python) explains client creation. You do not need its Python sample or pip packages for this plugin.

Google may limit refresh tokens for External apps in testing. If access later expires, sign in again and check your Google project's publishing/organization policy. See [Google's OAuth guide](https://developers.google.com/identity/protocols/oauth2).

### Private iCal alternative

If Google Calendar provides **Settings for my calendars → Integrate calendar → Secret address in iCal format**, enter that address in Hub's **Private iCal link** field. Workspace policy may hide this option. Use OAuth in that case. You do not need to make your calendar public. Treat the private iCal address as a secret.

**Disconnect** removes this device's saved connection. To revoke Google-side access, use **Google account permissions** in the setup dialog.

## Apple Mail (macOS)

1. Set up and enable your accounts in Apple Mail on this Mac. Let Mail finish syncing.
2. Select the **Mail** tab beside Calendar, then **Connect Mail**.
3. If macOS asks, allow **Obsidian → Mail** Automation access. No password or token is entered in Hub.
4. Use **All / Unread** and the account selector to filter the loaded messages. **Refresh all widgets** reads again. Automatic reads run about ten minutes after the previous read finishes while the Mail tab is visible.

The reader samples the first 50 messages returned by Apple Mail from each enabled account's inbox, then sorts the combined sample by received time. It does not guarantee the globally newest 50 messages. Each filtered view displays at most 50 rows. Unread filters this sample. Its count can differ from the total in Apple Mail. Archives, sent mail and other folders are excluded.

Up to 20 enabled accounts are supported. Each must expose exactly one top-level inbox named `INBOX`, `Inbox`, `Gelen Kutusu`, `Gelen` or `Gelenler`. An unknown or ambiguous inbox fails the whole refresh and keeps the previous list. A large first read can take up to 90 seconds. Permission denial stops automatic retries until a successful explicit retry.

The bundled `scripts/read-mail.applescript` runs through macOS `/usr/bin/osascript`, without a shell, Python or any package installation. The requested fields are account and message identity, sender, subject, received time and read status. Message bodies, attachments and passwords are not read. Metadata stays in memory. Device-local browser storage holds an enabled preference, without account or message data.

Clicking a row opens that exact message in Apple Mail and may mark it read. Hub has no send, delete or explicit mark-read command. **Mail settings → Disconnect Mail** stops reads and clears the in-memory list. Remove Automation permission under **System Settings → Privacy & Security → Automation** if desired. Connect separately on every Mac. Calendar and Mail share visibility under **Customize**.

## YouTrack

### Requirements

- Your HTTPS YouTrack server with `/mcp` support. This release supports a server at the hostname root, without a custom port or a subpath such as `/youtrack`.
- Your account's **login**, which may differ from its display name.
- One project's short key, such as `TEAM`.
- A **permanent token** from your own account with the **YouTrack** scope.
- **Python 3.11+** on your Mac. Use the [python.org macOS installer](https://www.python.org/downloads/macos/) if needed. The plugin selects `/opt/homebrew/bin/python3` first, then `/usr/local/bin/python3`. Update the first existing interpreter if it is too old. No pip packages are required.

Create a token under your YouTrack profile's **Account Security → Tokens / New token**. Your administrator may restrict this feature. See JetBrains' [permanent token guide](https://www.jetbrains.com/help/youtrack/cloud/manage-permanent-token.html) and [MCP server documentation](https://www.jetbrains.com/help/youtrack/cloud/model-context-protocol-server.html).

### Connect

1. Open **YouTrack settings** in Hub.
2. Enter your **Server**, such as `company.youtrack.cloud`.
3. Enter **Your login** and **Project key**.
4. Paste your **Permanent token** in the local masked field.
5. Leave **Board status sync** off for the initial setup, then choose **Connect**.
6. The dialog closes after identity and list validation. Use **Refresh all widgets** to load unresolved issues assigned to you. While the YouTrack widget is visible, its read-only snapshot refreshes about every six hours. A fresh saved snapshot defers the startup read; a failed read keeps the previous snapshot and waits six hours before an automatic retry in that running session. Manual refresh can retry sooner. Hidden views and device sleep defer automatic reads; this is not a background note mirror.

This adapter expects MCP issue responses with scalar **Assignee, State and Priority** fields. State names can differ and are configurable. Multiple assignees or custom field schemas may require adapter changes. [AGENTS.md](../AGENTS.md) explains the boundaries. Logins support letters, digits and `_ . @ + -`. Project keys use uppercase letters, digits and underscores, starting with a letter. An empty list alone does not prove the project is empty: also check the key and issue visibility.

### Local imports and optional State sync

Drag an issue from the widget onto a board column, or right-click → **Add to …**. Its description, available comments and bounded attachments are copied into `Hub/YouTrack` and `Hub/Attachments/YouTrack`. Reimporting uses the same card. Write in **My notes**. Refresh does not overwrite your local content.

To change remote State from the board, open **Board status sync → Enable remote status changes** and set the three State names, such as `Open / Doing / Closed`. Saving these settings does not bulk-update existing cards. Subsequent selected imports and column changes update that issue's **State** field. Moving out of Done can reopen it. Descriptions, comments and worklogs are never sent.

If a write fails, the local card remains. **Retry** sends its current local column. Uncertain writes are not replayed automatically. New imports/State writes are blocked while a connection change is being validated.

The token and profile stay in Obsidian Keychain. A helper process receives them through stdin for that operation, never command-line arguments, environment secrets or Codex/Claude configuration files. The `youtrack-widget.json` snapshot is a local file excluded from Git. An old local copy with the same issue ID from another account or server blocks import. Move the old copy outside Hub or use a separate vault.

## Slack

The inbox reads incoming one-to-one DMs, personal mentions, and optionally a notes channel and user group. Your outgoing DMs and group DMs are excluded from the DM source. The view covers a bounded set of recent messages. It does not track unread counts or provide a full archive.

1. In [Slack app management](https://api.slack.com/apps), create an app for your workspace or use an approved app. **From scratch** is sufficient. No bot, server or event subscription is needed.
2. Under **OAuth & Permissions → User Token Scopes**, add `search:read`, `users:read`, `im:read`, `im:history`. Use the **User Token Scopes** section.
3. For a notes channel, also add `channels:read` and `channels:history`. A private channel also needs `groups:read` and `groups:history`.
4. For a user group, also add `usergroups:read`. Your workspace must support groups and you must be a member of the selected group.
5. Choose **Install to Workspace**, or **Reinstall to Workspace** after changing scopes. Administrator approval may be required. Copy the **User OAuth Token** (`xoxp-…`) on your computer.
6. Open **Connect Slack** in Hub. Enter the token in the masked field. Optionally enter a joined **Notes channel**, such as `my-notes`, and a **User group** handle, such as `design-team`. Either field may be blank. Leading `#` / `@` is removed.
7. Choose **Connect Slack**. Messages appear after account, source and Keychain checks. To change sources later, open settings. A blank token field keeps the saved token.

Filters are **All / DMs / @Me**, plus **#Notes / @Group** when configured. The newest 50 results per source from the last seven days are combined. Each filter shows at most 50 rows. A visible widget refreshes roughly every five minutes and respects Slack rate limits. **Slack settings → Inbox details** lists scope and truncation information.

Slack's `search.messages` access policy and workspace search behavior affect results. Adding scopes alone may not solve an organization-level API restriction. See [Slack app setup](https://docs.slack.dev/quickstart/) and [search.messages](https://docs.slack.dev/reference/methods/search.messages/).

**Disconnect** clears the local token and in-memory messages. It does not revoke the Slack app's server-side permissions. Use Slack app management to revoke them. Connect separately on each Mac. Never export Keychain secrets into the vault.
