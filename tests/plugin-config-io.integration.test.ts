import { beforeEach, describe, expect, it } from "vitest";
import { Notice } from "obsidian";
import VaultboxPlugin from "../src/main";
import { ConfigDiagnostics } from "../src/config-diagnostics";
import { DEFAULT_SETTINGS } from "../src/types";

const root = ".obsidian/plugins/vaultbox";
const path = root + "/data.json";
const logPath = root + "/config-diagnostics.jsonl";
const syncFile = {
  path: "Example.md",
  pathLower: "example.md",
  localContentHash: "a",
  remoteContentHash: "a",
  remoteRev: "1",
};

function fixture() {
  const saved = {
    settings: {
      ...DEFAULT_SETTINGS,
      accessToken: "private-access-token",
      refreshToken: "private-refresh-token",
      selectedFolderPath: "/Dropbox/Private",
      syncMode: "manual" as const,
    },
    pendingAuthCodeVerifier: "",
    syncState: { files: { "example.md": syncFile }, lastSyncedAt: 1722 },
  };
  const files = new Map<string, string>([[path, JSON.stringify(saved)]]);
  let mtime = 1000;
  const adapter = {
    stat: async (p: string) => files.has(p)
      ? { type: "file", size: new TextEncoder().encode(files.get(p)!).length, ctime: 0, mtime }
      : null,
    read: async (p: string) => {
      const content = files.get(p);
      if (content === undefined) throw new Error("Not found");
      return content;
    },
    exists: async (p: string) => files.has(p),
    write: async (p: string, text: string) => { files.set(p, text); mtime++; },
    append: async (p: string, text: string) => { files.set(p, (files.get(p) ?? "") + text); mtime++; },
    remove: async (p: string) => { files.delete(p); },
    rename: async (from: string, to: string) => {
      files.set(to, files.get(from)!); files.delete(from);
    },
  };
  const plugin = Object.assign(Object.create(VaultboxPlugin.prototype) as VaultboxPlugin, {
    app: { vault: { adapter, configDir: ".obsidian" } },
    manifest: { id: "vaultbox", version: "1.0.11-beta.1", dir: root },
    settings: { ...saved.settings },
    syncState: { ...saved.syncState },
    pendingAuthCodeVerifier: "",
    configDiagnostics: new ConfigDiagnostics(adapter as never, root),
    configOperation: 0,
    warnedAboutConfigLoss: false,
    syncInProgress: false,
    syncFinished: null,
    localChangeSyncTimer: null,
    simulationReport: "",
    debugLog: { write: () => undefined },
    loadData: async () => {
      const raw = files.get(path);
      return raw === undefined ? null : JSON.parse(raw);
    },
    saveData: async (value: unknown) => {
      files.set(path, JSON.stringify(value));
      mtime++;
    },
    buildSyncPlan: async () => ({
      operations: [],
      conflicts: [],
      summary: {
        uploads: 0, downloads: 0, localDeletes: 0, remoteDeletes: 0, conflicts: 0, noops: 1,
      },
    }),
  });

  const events = () => (files.get(logPath) ?? "").split("\n").filter(Boolean)
    .map((s) => JSON.parse(s) as Record<string, unknown>);

  return { plugin, files, events, saved };
}

beforeEach(() => { Notice.messages = []; });

describe("real Vaultbox plugin configuration I/O with mocked Obsidian storage", () => {
  it("preserves Dropbox connection and tracking during manual sync with no changes", async () => {
    const { plugin, files, events } = fixture();
    await plugin.syncNow();
    const state = JSON.parse(files.get(path)!);
    expect(state.settings.refreshToken).toBe("private-refresh-token");
    expect(state.settings.selectedFolderPath).toBe("/Dropbox/Private");
    expect(Object.keys(state.syncState.files)).toEqual(["example.md"]);
    expect(events().some((event) => event.stage === "write.after" && event.reason === "sync.manual.no-changes")).toBe(true);
    expect(events().some((event) => event.stage === "write.anomaly")).toBe(false);
    expect(files.get(logPath)).not.toContain("private-refresh-token");
  });

  it("records evidence of a corrupt file on plugin startup", async () => {
    const { plugin, files, events } = fixture();
    files.set(path, "");
    await expect(plugin.loadSettings()).rejects.toThrow();
    expect(events()[0]).toMatchObject({
      stage: "read.before",
      reason: "startup.settings",
      disk: { status: "invalid-json", bytes: 0 },
    });
    expect(files.get(path)).toBe("");
  });

  it("shows how an unreadable file could be replaced with defaults after a failed load", async () => {
    const { plugin, files, events } = fixture();
    files.delete(path); // Obsidian's loadData() returns null for a missing file.
    await plugin.loadSettings();
    await plugin.saveSettings("settings-change");
    const saved = JSON.parse(files.get(path)!);
    expect(saved.settings.refreshToken).toBe("");
    expect(saved.settings.selectedFolderPath).toBe("");
    expect(Object.keys(saved.syncState.files)).toHaveLength(0);
    expect(events().some((event) => event.stage === "read.before" && (event.disk as { status: string }).status === "missing")).toBe(true);
    expect(events().some((event) => event.stage === "write.after")).toBe(true);
  });
});
