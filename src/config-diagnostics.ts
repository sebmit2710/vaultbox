import type { DataAdapter } from "obsidian";

/**
 * A device-local forensic trail for Vaultbox configuration I/O.
 * Deliberately separate from data.json, because data.json is the file under investigation.
 * Never log raw JSON, access/refresh tokens, OAuth verifiers, or note contents.
 */

export interface ConfigStateSummary {
  settingsPresent: boolean;
  refreshTokenPresent: boolean;
  folderConfigured: boolean;
  trackedFiles: number;
}

export interface ConfigDiskSnapshot {
  status: "valid" | "missing" | "invalid-json" | "unreadable";
  bytes?: number;
  mtime?: number;
  sha256?: string;
  state?: ConfigStateSummary;
}

const MAX_LOG_BYTES = 4 * 1024 * 1024;

export function summarizeConfigState(value: unknown): ConfigStateSummary {
  const record = isRecord(value) ? value : {};
  const settings = isRecord(record.settings) ? record.settings : {};
  const state = isRecord(record.syncState) ? record.syncState : {};
  const files = isRecord(state.files) ? state.files : {};

  return {
    settingsPresent: isRecord(record.settings),
    refreshTokenPresent: typeof settings.refreshToken === "string" && settings.refreshToken.length > 0,
    folderConfigured: typeof settings.selectedFolderPath === "string" && settings.selectedFolderPath.length > 0,
    trackedFiles: Object.keys(files).length,
  };
}

export function findConfigRegressions(
  before: ConfigDiskSnapshot,
  after: ConfigDiskSnapshot,
  intended: ConfigStateSummary,
): string[] {
  const issues: string[] = [];

  if (before.state?.refreshTokenPresent && !after.state?.refreshTokenPresent) {
    issues.push("stored-refresh-token-disappeared");
  }
  if (before.state?.folderConfigured && !after.state?.folderConfigured) {
    issues.push("stored-dropbox-folder-disappeared");
  }
  if ((before.state?.trackedFiles ?? 0) > 0 && (after.state?.trackedFiles ?? 0) === 0) {
    issues.push("stored-sync-tracking-disappeared");
  }
  if (intended.refreshTokenPresent && !after.state?.refreshTokenPresent) {
    issues.push("written-refresh-token-not-persisted");
  }
  if (intended.folderConfigured && !after.state?.folderConfigured) {
    issues.push("written-folder-not-persisted");
  }
  if (intended.trackedFiles > 0 && (after.state?.trackedFiles ?? 0) !== intended.trackedFiles) {
    issues.push("written-tracking-count-mismatch");
  }
  if (after.status !== "valid") {
    issues.push("data-file-not-valid-after-save");
  }

  return [...new Set(issues)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sha256(value: string): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    return "unavailable";
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class ConfigDiagnostics {
  readonly logPath: string;
  private readonly dataPath: string;
  private readonly runId = new Date().toISOString();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly adapter: DataAdapter, pluginDirectory: string) {
    this.dataPath = pluginDirectory + "/data.json";
    this.logPath = pluginDirectory + "/config-diagnostics.jsonl";
  }

  async inspect(): Promise<ConfigDiskSnapshot> {
    let metadata: { size: number; mtime: number } | null = null;
    try {
      metadata = await this.adapter.stat(this.dataPath);
      if (!metadata) {
        return { status: "missing" };
      }
    } catch {
      return { status: "unreadable" };
    }

    let raw: string;
    try {
      raw = await this.adapter.read(this.dataPath);
    } catch {
      return { status: "unreadable", bytes: metadata.size, mtime: metadata.mtime };
    }

    const snapshot: ConfigDiskSnapshot = {
      status: "invalid-json",
      bytes: new TextEncoder().encode(raw).byteLength,
      mtime: metadata.mtime,
      sha256: await sha256(raw),
    };

    try {
      const value: unknown = JSON.parse(raw);
      if (isRecord(value)) {
        snapshot.status = "valid";
        snapshot.state = summarizeConfigState(value);
      }
    } catch {
      // Record only that parsing failed; never include the malformed text.
    }
    return snapshot;
  }

  async observe(stage: string, reason: string, operation: number, intended?: unknown): Promise<ConfigDiskSnapshot> {
    const disk = await this.inspect();
    await this.enqueue({
      at: new Date().toISOString(),
      run: this.runId,
      operation,
      stage,
      reason,
      disk,
      intended: intended === undefined ? undefined : summarizeConfigState(intended),
    });
    return disk;
  }

  async note(stage: string, reason: string, operation: number, details: Record<string, unknown> = {}): Promise<void> {
    // Callers must pass only status flags/counts or fixed error codes, not raw settings.
    await this.enqueue({
      at: new Date().toISOString(),
      run: this.runId,
      operation,
      stage,
      reason,
      ...details,
    });
  }

  private async enqueue(event: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify(event) + "\n";
    const task = this.queue.then(async () => {
      try {
        const stat = await this.adapter.stat(this.logPath);
        if (stat && stat.size + line.length > MAX_LOG_BYTES) {
          const archive = this.logPath.replace(/\.jsonl$/, ".previous.jsonl");
          if (await this.adapter.exists(archive)) {
            await this.adapter.remove(archive);
          }
          await this.adapter.rename(this.logPath, archive);
        }

        if (await this.adapter.exists(this.logPath)) {
          await this.adapter.append(this.logPath, line);
        } else {
          await this.adapter.write(this.logPath, line);
        }
      } catch {
        // Diagnostics must never interrupt normal syncing or configuration writes.
        console.warn("Vaultbox: configuration diagnostic event could not be persisted.");
      }
    });

    this.queue = task.catch(() => undefined);
    await this.queue;
  }
}
