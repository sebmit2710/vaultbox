import { describe, expect, it } from "vitest";
import { findConfigRegressions, summarizeConfigState, type ConfigDiskSnapshot } from "../src/config-diagnostics";

describe("configuration forensic diagnostics", () => {
  it("summarizes configuration without exposing any token or path", () => {
    const summary = summarizeConfigState({
      settings: {
        refreshToken: "secret-refresh-token",
        accessToken: "secret-access-token",
        selectedFolderPath: "/private/Dropbox",
      },
      syncState: { files: { a: {}, b: {} } },
    });
    expect(summary).toEqual({
      settingsPresent: true,
      refreshTokenPresent: true,
      folderConfigured: true,
      trackedFiles: 2,
    });
    expect(JSON.stringify(summary)).not.toContain("secret");
    expect(JSON.stringify(summary)).not.toContain("Dropbox");
  });

  it("detects a suddenly reset file after a successful configuration write", () => {
    const before: ConfigDiskSnapshot = {
      status: "valid",
      state: { settingsPresent: true, refreshTokenPresent: true, folderConfigured: true, trackedFiles: 184 },
    };
    const after: ConfigDiskSnapshot = {
      status: "valid",
      state: { settingsPresent: true, refreshTokenPresent: false, folderConfigured: false, trackedFiles: 0 },
    };
    expect(findConfigRegressions(before, after, before.state!)).toEqual([
      "stored-refresh-token-disappeared",
      "stored-dropbox-folder-disappeared",
      "stored-sync-tracking-disappeared",
      "written-refresh-token-not-persisted",
      "written-folder-not-persisted",
      "written-tracking-count-mismatch",
    ]);
  });

  it("accepts an unchanged healthy configuration", () => {
    const healthy: ConfigDiskSnapshot = {
      status: "valid",
      state: { settingsPresent: true, refreshTokenPresent: true, folderConfigured: true, trackedFiles: 184 },
    };
    expect(findConfigRegressions(healthy, healthy, healthy.state!)).toEqual([]);
  });

  it("reports a malformed configuration file", () => {
    const empty: ConfigDiskSnapshot = { status: "invalid-json", bytes: 0 };
    const desired = { settingsPresent: true, refreshTokenPresent: true, folderConfigured: true, trackedFiles: 184 };
    expect(findConfigRegressions(empty, empty, desired)).toContain("data-file-not-valid-after-save");
  });
});
