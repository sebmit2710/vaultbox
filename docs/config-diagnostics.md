# Investigating lost Vaultbox configuration (diagnostic branch)

This combines forensic instrumentation **with a fail-closed configuration safety guard**.
The Dropbox synchronization plan is unchanged, but Vaultbox now serializes plugin-data
writes and rejects missing, unreadable or regressed configuration data instead of silently
persisting factory defaults. This stops the known destructive follow-on behavior; it
does not yet prove the original cause of file damage.

## Where evidence is kept

Vaultbox automatically records configuration I/O in a **separate device-local file**:

`.obsidian/plugins/vaultbox/config-diagnostics.jsonl`

When the log exceeds 4 MiB, it is rotated to `config-diagnostics.previous.jsonl`.

Each JSONL entry includes UTC time, a process-run ID, an operation ID, a stage/reason,
observed `data.json` byte size, file modification time, SHA-256, JSON validity, and
**booleans/counts only** for Dropbox connection, configured folder, and sync-tracking files.
No token, authorization code, Dropbox path, note name or note content is written to the log.
The SHA-256 is a *fingerprint of the entire file*, not a recoverable backup.

Events include `read.before`, `read.result`, `write.before`, `write.after`,
`write.failed`, `write.anomaly`, and `read.mismatch`. Interleaved operation IDs
are evidence of overlapping access. A mismatch after a save may also mean an external writer.

If a configuration unexpectedly disappears, **do not reset tracking or reconnect first**.
Close Obsidian, copy both `data.json` and the diagnostic log files to a protected location,
then investigate. `data.json` contains OAuth tokens and must not be shared unredacted.

## Windows Process Monitor (optional complementary evidence)

On the affected PC, run Microsoft's Sysinternals Process Monitor (administrator rights may
be required). Set filters:
- `Path` `contains` `\\.obsidian\\plugins\\vaultbox\\data.json` → Include.
- Inspect file-system operations including `CreateFile`, `WriteFile`, `SetEndOfFileInformationFile`,
  `SetRenameInformationFile`, `CloseFile`, and their results.
- **Do not** filter to `Obsidian.exe` only; external processes are part of the investigation.

Use a disk-backed capture with limits to prevent filling the system drive. ProcMon
identifies the Windows process, but typically not which Obsidian JavaScript plugin initiated
an `Obsidian.exe` write; the Vaultbox log helps correlate the timings.

## Reproduction matrix

With a disposable test Vault and its own Dropbox test folder:
1. Launch/quit Obsidian normally (Notebook Navigator enabled and disabled).
2. Simulate sync, run a manual sync, and perform automatic sync.
3. Modify settings while sync is running.
4. Compare the diagnostic events immediately before and after each action.
5. Do **not** simulate an abrupt OS shutdown on a machine containing important work.

Because the diagnostics file itself is device-local, copy it separately if the local
vault is backed up or migrated. It is not intended to be synchronized to Dropbox.

## Safeguards and recovery

Upon loading a valid existing configuration, Vaultbox creates:
- `.obsidian/plugins/vaultbox/data.last-good.json` — verified recent snapshot (includes Dropbox OAuth tokens)
- `.obsidian/plugins/vaultbox/data.last-good.previous.json` — previous backup on rotation
- `.obsidian/plugins/vaultbox/data.initialized` — initialization marker, without secrets

Backups are stored locally beside the original configuration; they are **not**
uploaded by Vaultbox's normal synchronization policy. Do not share these files publicly.

On subsequent reads or before saving, Vaultbox refuses to overwrite a missing,
malformed or unexpectedly reset `data.json`. It also refuses writes which would
silently delete an existing refresh token, configured Dropbox folder or sync
tracking (except an explicit `Reset tracking` action).
When this protection triggers it **stops** rather than auto-restoring: this
preserves the damaged file and the diagnostic timeline for root-cause analysis.

If you encounter the safety stop:
1. Keep Obsidian closed after saving the error details, and back up `data.json`,
   `data.last-good*.json`, `data.initialized`, and `config-diagnostics*.jsonl` locally.
2. Determine why `data.json` went missing/corrupt from the diagnostics and, if available, ProcMon.
3. After verifying that `data.last-good.json` is valid and current, restore it
   to `data.json` with Obsidian closed, then reopen and simulate a sync.
4. Never commit or publish either `data.json` or the last-good backups: they contain secrets.

A genuinely fresh installation with no `data.json`, initialization marker,
or backup is permitted to initialize normally. An installation whose first observed
configuration is already missing cannot be distinguished from a fresh install
without previously created evidence: retain the pre-upgrade manual backup.

### Automated regression tests

GitHub Actions runs `npm test` and `npm run build` under Ubuntu **and Windows**.
Tests cover missing/zero-byte/corrupt configuration, token-loss prevention, explicit
tracking resets, manual synchronization preserving state, diagnostic log rotation,
and concurrent log writes. These tests simulate the Obsidian adapter/API; they are
not a full Electron GUI test.
