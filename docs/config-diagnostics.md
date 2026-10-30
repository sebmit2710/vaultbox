# Investigating lost Vaultbox configuration (diagnostic branch)

This is an **instrumentation-only** change; it does not alter the Dropbox sync plan, overwrite policy,
configuration format, or serialize existing `data.json` writes. Do not treat it as the permanent fix.

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
