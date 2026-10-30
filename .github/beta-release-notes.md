## Vaultbox 1.0.11-beta.2 — Config safety and diagnostics

This beta focuses on preserving Dropbox authentication and sync tracking after
an Obsidian settings-file problem.

- Fail closed: an unreadable, missing, or unexpectedly reset `data.json` is
  no longer silently replaced with empty defaults.
- Save verified local last-known-good configuration backups, including a previous backup.
- Serialize configuration read/merge/write operations, including debug logging.
- Create a separate local forensic log `config-diagnostics.jsonl`, without
  recording OAuth tokens, note contents or the selected Dropbox path.
- Add regression tests for blank/truncated configuration, token and tracking
  loss, explicit tracking reset, concurrent saves, and manual sync.
- All automated checks execute on Windows and Linux.

**Important:** This beta stops after detecting configuration damage; it does
not automatically restore backups. When a safety stop occurs, preserve the
diagnostic logs and local `data.json` / `data.last-good*.json` files for
investigation. The backup files contain Dropbox OAuth credentials and must not
be published. The original source of the file corruption is not yet known.

After upgrading via BRAT, keep Vaultbox in Manual mode initially and confirm
that the Dropbox connection and selected folder remain intact. No
reconnection or sync-tracking reset should be necessary for a healthy upgrade.
