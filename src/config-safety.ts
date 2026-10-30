import type { DataAdapter } from "obsidian";
import { summarizeConfigState, type ConfigStateSummary } from "./config-diagnostics";

/**
 * Protects the original data.json against a missing/corrupt/stale load being
 * persisted as a new, empty configuration. Backup contains OAuth credentials:
 * keep all files inside the private Obsidian plugin directory.
 */
export class ConfigSafety {
  readonly dataPath: string;
  readonly backupPath: string;
  readonly previousBackupPath: string;
  readonly markerPath: string;
  private blocked = false;

  constructor(private readonly adapter: DataAdapter, directory: string) {
    this.dataPath = directory + "/data.json";
    this.backupPath = directory + "/data.last-good.json";
    this.previousBackupPath = directory + "/data.last-good.previous.json";
    this.markerPath = directory + "/data.initialized";
  }

  async assertReadable(): Promise<void> {
    if (this.blocked) throw this.error("previous configuration safety failure");
    const data = await this.readRecord(this.dataPath);
    const backup = await this.readBestBackup();

    if (data === null) {
      if (await this.adapter.exists(this.markerPath) || backup) {
        this.blocked = true;
        throw this.error("previously initialized configuration is missing");
      }
      return; // Genuine first installation: no config or initialization marker.
    }

    if (data === "invalid") {
      this.blocked = true;
      throw this.error("configuration is corrupt or unreadable");
    }

    const currentState = summarizeConfigState(data);
    if (backup) {
      const protectedState = summarizeConfigState(backup);
      if (losesState(protectedState, currentState, false)) {
        this.blocked = true;
        throw this.error("configuration has unexpectedly lost Dropbox connection or tracking");
      }
    }
    // On upgrade of an existing installation, capture the last known good file
    // before any later action can overwrite it.
    if (!(await this.adapter.exists(this.markerPath))) {
      if (isMeaningful(currentState)) await this.writeBackup(data);
      await this.adapter.write(this.markerPath, "initialized\n");
    } else if (!backup && isMeaningful(currentState)) {
      await this.writeBackup(data);
    }
  }

  async assertWritable(next: unknown, reason: string): Promise<void> {
    await this.assertReadable();
    if (this.blocked) throw this.error("writes are blocked");

    const current = await this.readRecord(this.dataPath);
    if (current === "invalid") {
      this.blocked = true;
      throw this.error("configuration became unreadable before write");
    }

    const nextState = summarizeConfigState(next);
    const previousState = current && current !== "invalid"
      ? summarizeConfigState(current)
      : null;
    const backup = await this.readBestBackup();
    const protectedState = backup && summarizeConfigState(backup);
    const allowReset = reason === "sync-state.reset";

    if ((previousState && losesState(previousState, nextState, allowReset)) ||
        (protectedState && losesState(protectedState, nextState, allowReset))) {
      this.blocked = true;
      throw this.error("write would erase an existing Dropbox connection or synchronization history");
    }

    // Never write over a pre-existing file if it disappeared between load and save.
    if (!current && (await this.adapter.exists(this.markerPath) || backup)) {
      this.blocked = true;
      throw this.error("configuration disappeared before write");
    }
  }

  async afterWrite(next: unknown): Promise<void> {
    const data = await this.readRecord(this.dataPath);
    if (!data || data === "invalid") {
      this.blocked = true;
      throw this.error("saved configuration is missing or invalid");
    }
    const expected = summarizeConfigState(next);
    const actual = summarizeConfigState(data);
    if (losesState(expected, actual, false) || actual.trackedFiles !== expected.trackedFiles) {
      this.blocked = true;
      throw this.error("saved configuration did not retain its expected state");
    }

    if (isMeaningful(actual)) {
      await this.writeBackup(data);
    }
    if (!(await this.adapter.exists(this.markerPath))) {
      await this.adapter.write(this.markerPath, "initialized\n");
    }
  }

  private async readRecord(path: string): Promise<Record<string, unknown> | "invalid" | null> {
    try {
      if (!(await this.adapter.exists(path))) return null;
      const text = await this.adapter.read(path);
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed) || !isRecord(parsed.settings) || !isRecord(parsed.syncState)) {
        return "invalid";
      }
      return parsed;
    } catch {
      return "invalid";
    }
  }

  private async readBestBackup(): Promise<Record<string, unknown> | null> {
    for (const path of [this.backupPath, this.previousBackupPath]) {
      const data = await this.readRecord(path);
      if (data && data !== "invalid" && isMeaningful(summarizeConfigState(data))) return data;
    }
    return null;
  }

  private async writeBackup(data: Record<string, unknown>): Promise<void> {
    const temp = this.backupPath + ".tmp";
    const raw = JSON.stringify(data);
    await this.adapter.write(temp, raw);
    // Verify temporary backup before promoting it over the current good backup.
    if (await this.adapter.read(temp) !== raw) {
      throw this.error("backup verification failed");
    }
    if (await this.adapter.exists(this.backupPath)) {
      if (await this.adapter.exists(this.previousBackupPath)) {
        await this.adapter.remove(this.previousBackupPath);
      }
      await this.adapter.rename(this.backupPath, this.previousBackupPath);
    }
    await this.adapter.rename(temp, this.backupPath);
  }

  private error(reason: string): Error {
    return new Error(
      "Vaultbox safety stop: " + reason +
      ". No configuration was overwritten. Preserve data.json, data.last-good*.json and config-diagnostics.jsonl.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isMeaningful(state: ConfigStateSummary): boolean {
  return state.refreshTokenPresent || state.folderConfigured || state.trackedFiles > 0;
}
function losesState(before: ConfigStateSummary, after: ConfigStateSummary, allowReset: boolean): boolean {
  return (before.refreshTokenPresent && !after.refreshTokenPresent) ||
    (before.folderConfigured && !after.folderConfigured) ||
    (!allowReset && before.trackedFiles > 0 && after.trackedFiles === 0);
}
