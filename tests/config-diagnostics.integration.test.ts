import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import {
  ConfigDiagnostics,
  findConfigRegressions,
  summarizeConfigState,
} from "../src/config-diagnostics";

const dir = ".obsidian/plugins/vaultbox";
const dataPath = dir + "/data.json";
const logPath = dir + "/config-diagnostics.jsonl";

function makeAdapter(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const timestamps = new Map<string, number>();
  const writes: string[] = [];
  let nextTimestamp = 1000;
  let rejectRead = false;
  let rejectWrite = false;

  const adapter = {
    stat: async (path: string) => {
      const value = files.get(path);
      return value === undefined
        ? null
        : { type: "file", ctime: 0, mtime: timestamps.get(path) ?? 1, size: new TextEncoder().encode(value).length };
    },
    exists: async (path: string) => files.has(path),
    read: async (path: string) => {
      if (rejectRead) throw new Error("read forbidden");
      const value = files.get(path);
      if (value === undefined) throw new Error("File not found");
      return value;
    },
    write: async (path: string, text: string) => {
      if (rejectWrite) throw new Error("write forbidden");
      writes.push("write:" + path);
      files.set(path, text);
      timestamps.set(path, nextTimestamp++);
    },
    append: async (path: string, text: string) => {
      if (rejectWrite) throw new Error("write forbidden");
      writes.push("append:" + path);
      files.set(path, (files.get(path) ?? "") + text);
      timestamps.set(path, nextTimestamp++);
    },
    remove: async (path: string) => { files.delete(path); },
    rename: async (from: string, to: string) => {
      const text = files.get(from);
      if (text === undefined) throw new Error("Missing rename source");
      files.set(to, text);
      files.delete(from);
      timestamps.set(to, nextTimestamp++);
    },
  };
  const records = () => (files.get(logPath) ?? "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  return {
    files, adapter: adapter as unknown as DataAdapter,
    records, writes,
    setReadFailure: (value: boolean) => { rejectRead = value; },
    setWriteFailure: (value: boolean) => { rejectWrite = value; },
  };
}

const healthy = {
  settings: { accessToken: "never-log-access", refreshToken: "never-log-refresh", selectedFolderPath: "/private/docs" },
  pendingAuthCodeVerifier: "never-log-oauth",
  syncState: { files: { "secret-notebook.md": {}, "second.md": {} }, lastSyncedAt: 1722 },
};

describe("configuration disk I/O forensic integration", () => {
  it("logs before/after snapshots without leaking tokens, filenames, or paths", async () => {
    const env = makeAdapter({ [dataPath]: JSON.stringify(healthy) });
    const diagnostics = new ConfigDiagnostics(env.adapter, dir);

    const before = await diagnostics.observe("write.before", "sync.manual", 17, healthy);
    env.files.set(dataPath, JSON.stringify(healthy, null, 2));
    const after = await diagnostics.observe("write.after", "sync.manual", 17, healthy);

    expect(before).toMatchObject({
      status: "valid",
      state: { refreshTokenPresent: true, folderConfigured: true, trackedFiles: 2 },
    });
    expect(after).toMatchObject({ status: "valid" });
    expect(after.sha256).not.toEqual(before.sha256);
    expect(findConfigRegressions(before, after, summarizeConfigState(healthy))).toEqual([]);
    expect(env.records().map((item) => item.stage)).toEqual(["write.before", "write.after"]);
    const output = env.files.get(logPath)!;
    for (const secret of ["never-log-access", "never-log-refresh", "never-log-oauth", "secret-notebook.md", "/private/docs"]) {
      expect(output).not.toContain(secret);
    }
  });

  it.each([
    ["zero-byte", ""],
    ["truncated-json", '{"settings":{"refreshToken":'],
    ["null-json", "null"],
    ["array-json", "[]"],
  ])("records %s file damage without overwriting file", async (_name, corrupted) => {
    const env = makeAdapter({ [dataPath]: corrupted });
    const diagnostics = new ConfigDiagnostics(env.adapter, dir);
    const snapshot = await diagnostics.observe("read.before", "startup.settings", 1);
    expect(snapshot.status).toBe("invalid-json");
    expect(snapshot.bytes).toBe(new TextEncoder().encode(corrupted).length);
    expect(env.files.get(dataPath)).toBe(corrupted);
    expect(env.records()).toHaveLength(1);
  });

  it("distinguishes absent file from a present zero-byte file", async () => {
    const env = makeAdapter();
    const diagnostics = new ConfigDiagnostics(env.adapter, dir);
    const absent = await diagnostics.inspect();
    expect(absent.status).toBe("missing");
    env.files.set(dataPath, "");
    const empty = await diagnostics.inspect();
    expect(empty).toMatchObject({ status: "invalid-json", bytes: 0 });
  });

  it("detects both an external reset and the next blank settings write", async () => {
    const env = makeAdapter({ [dataPath]: JSON.stringify(healthy) });
    const diagnostics = new ConfigDiagnostics(env.adapter, dir);
    const before = await diagnostics.observe("write.before", "sync.manual", 2, healthy);
    const factoryDefaults = {
      settings: { accessToken: "", refreshToken: "", selectedFolderPath: "" },
      syncState: { files: {}, lastSyncedAt: 0 },
    };
    env.files.set(dataPath, JSON.stringify(factoryDefaults));
    const after = await diagnostics.observe("write.after", "sync.manual", 2, healthy);
    const regressions = findConfigRegressions(before, after, summarizeConfigState(healthy));
    expect(regressions).toContain("stored-refresh-token-disappeared");
    expect(regressions).toContain("stored-sync-tracking-disappeared");
    await diagnostics.note("write.anomaly", "sync.manual", 2, { anomalyCodes: regressions });
    const log = env.records();
    expect(log[2].stage).toBe("write.anomaly");
    expect(log[2].anomalyCodes).toEqual(regressions);
  });

  it("can distinguish a failure to read a valid existing file", async () => {
    const env = makeAdapter({ [dataPath]: JSON.stringify(healthy) });
    const diagnostics = new ConfigDiagnostics(env.adapter, dir);
    env.setReadFailure(true);
    const snapshot = await diagnostics.observe("read.before", "startup.settings", 1);
    expect(snapshot.status).toBe("unreadable");
    expect(snapshot.bytes).toBeGreaterThan(0);
    expect(env.records()).toHaveLength(1);
  });

  it("serializes concurrent log writes without losing events", async () => {
    const env = makeAdapter({ [dataPath]: JSON.stringify(healthy) });
    const diagnostics = new ConfigDiagnostics(env.adapter, dir);
    await Promise.all(Array.from({ length: 80 }, (_, i) => diagnostics.observe("read.before", "load-test", i)));
    expect(env.records()).toHaveLength(80);
    expect(new Set(env.records().map((x) => x.operation)).size).toBe(80);
    expect(env.records().every((x) => x.run === env.records()[0].run)).toBe(true);
  });

  it("rotates the diagnostic log once the cap is exceeded", async () => {
    const env = makeAdapter({
      [dataPath]: JSON.stringify(healthy),
      [logPath]: "X".repeat(4 * 1024 * 1024),
    });
    const diagnostics = new ConfigDiagnostics(env.adapter, dir);
    await diagnostics.note("read.result", "test", 1);
    expect(env.files.get(dir + "/config-diagnostics.previous.jsonl")?.length).toBe(4 * 1024 * 1024);
    expect(env.records()).toHaveLength(1);
    expect(env.records()[0].stage).toBe("read.result");
  });

  it("never breaks synchronization when diagnostic logging is inaccessible", async () => {
    const env = makeAdapter({ [dataPath]: JSON.stringify(healthy) });
    env.setWriteFailure(true);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const diagnostics = new ConfigDiagnostics(env.adapter, dir);
      await expect(diagnostics.observe("read.before", "startup.settings", 1)).resolves.toMatchObject({
        status: "valid",
      });
      expect(warning).toHaveBeenCalled();
      expect(env.files.has(logPath)).toBe(false);
    } finally {
      warning.mockRestore();
    }
  });
});
