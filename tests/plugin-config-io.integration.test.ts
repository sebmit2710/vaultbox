import { describe, expect, it } from "vitest";
import VaultboxPlugin from "../src/main";
import { ConfigDiagnostics } from "../src/config-diagnostics";
import { ConfigSafety } from "../src/config-safety";
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
  const plugin = Object.create(VaultboxPlugin.prototype) as VaultboxPlugin;
  Object.assign(plugin as object, {
    app: { vault: { adapter, configDir: ".obsidian" } },
    manifest: { id: "vaultbox", version: "1.0.11-beta.1", dir: root },
    settings: { ...saved.settings },
    syncState: { ...saved.syncState },
    pendingAuthCodeVerifier: "",
    configDiagnostics: new ConfigDiagnostics(adapter as never, root),
    configSafety: new ConfigSafety(adapter as never, root),
    configWriteQueue: Promise.resolve(),
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

  it("fails closed when a previously healthy data.json disappears before restart", async () => {
    const { plugin, files, events } = fixture();
    await plugin.loadSettings(); // Creates a verified last-known-good backup and marker.
    const backup = files.get(root + "/data.last-good.json");
    expect(backup).toContain("private-refresh-token");
    files.delete(path);

    await expect(plugin.loadSettings()).rejects.toThrow(/Vaultbox safety stop/);
    await expect(plugin.saveSettings("settings-change")).rejects.toThrow(/Vaultbox safety stop/);
    expect(files.has(path)).toBe(false);
    expect(files.get(root + "/data.last-good.json")).toBe(backup);
    expect(events().some((event) => event.stage === "read.failed")).toBe(true);
  });

  it("refuses to replace an existing Dropbox token with factory defaults", async () => {
    const { plugin, files } = fixture();
    await plugin.loadSettings();
    plugin.settings.refreshToken = "";
    plugin.settings.selectedFolderPath = "";
    plugin.syncState = { files: {}, lastSyncedAt: 0 };
    await expect(plugin.saveSettings("settings-change")).rejects.toThrow(/Vaultbox safety stop/);
    const state = JSON.parse(files.get(path)!);
    expect(state.settings.refreshToken).toBe("private-refresh-token");
    expect(Object.keys(state.syncState.files)).toEqual(["example.md"]);
  });

  it("blocks corrupt zero-byte JSON and preserves the last good backup", async () => {
    const { plugin, files, events } = fixture();
    await plugin.loadSettings();
    files.set(path, "");
    await expect(plugin.loadSettings()).rejects.toThrow(/Vaultbox safety stop/);
    await expect(plugin.saveSettings("settings-change")).rejects.toThrow(/Vaultbox safety stop/);
    expect(files.get(path)).toBe("");
    expect(files.get(root + "/data.last-good.json")).toContain("private-refresh-token");
    expect(events().some((event) => event.stage === "read.failed")).toBe(true);
  });

  it("allows explicit sync-tracking reset without erasing authentication", async () => {
    const { plugin, files } = fixture();
    await plugin.loadSettings();
    plugin.syncState = { files: {}, lastSyncedAt: 0 };
    await plugin.saveSettings("sync-state.reset");
    const state = JSON.parse(files.get(path)!);
    expect(state.settings.refreshToken).toBe("private-refresh-token");
    expect(Object.keys(state.syncState.files)).toHaveLength(0);
  });
  it("allows a real fresh installation with no configuration or marker", async () => {
    const { plugin, files } = fixture();
    files.delete(path);
    await plugin.loadSettings();
    expect(plugin.settings.refreshToken).toBe("");
    await plugin.saveSettings("settings-change");
    expect(files.has(path)).toBe(true);
    expect(files.has(root + "/data.initialized")).toBe(true);
  });

  it("detects factory defaults written by another process after a successful setup", async () => {
    const { plugin, files } = fixture();
    await plugin.loadSettings();
    const backup = files.get(root + "/data.last-good.json");
    files.set(path, JSON.stringify({
      settings: { ...DEFAULT_SETTINGS },
      syncState: { files: {}, lastSyncedAt: 0 },
    }));
    await expect(plugin.loadSettings()).rejects.toThrow(/Vaultbox safety stop/);
    expect(files.get(root + "/data.last-good.json")).toBe(backup);
    expect(JSON.parse(files.get(path)!).settings.refreshToken).toBe("");
  });

  it("serializes concurrent settings and debug-log writes without dropping either", async () => {
    const { plugin, files } = fixture();
    await plugin.loadSettings();
    await Promise.all([
      plugin.saveSettings("settings-change"),
      plugin.savePluginData({ debugLog: [{ timestamp: "2026-10-30T12:00:00.000Z", message: "test" }] }, "debug-log"),
    ]);
    const state = JSON.parse(files.get(path)!);
    expect(state.settings.refreshToken).toBe("private-refresh-token");
    expect(state.debugLog).toHaveLength(1);
    expect(files.get(root + "/data.last-good.json")).toContain("private-refresh-token");
  });

});
