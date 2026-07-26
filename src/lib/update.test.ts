import { describe, expect, it } from "vitest";
import { compareVersions, isNewerVersion, parseVersion, releaseToUpdate } from "./update";

describe("update check", () => {
  it("parses tags with optional v prefix and pre-release", () => {
    expect(parseVersion("0.1.0")).toEqual({ parts: [0, 1, 0], pre: "" });
    expect(parseVersion(" v1.2.3 ")).toEqual({ parts: [1, 2, 3], pre: "" });
    expect(parseVersion("v1.0.0-rc.1")).toEqual({ parts: [1, 0, 0], pre: "rc.1" });
    expect(parseVersion("1.2")).toBeNull();
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });

  it("compares versions by semver rules", () => {
    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    // 正式版高于预发布；预发布之间数字标识符按数值比较。
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    // 无法解析的版本视为相同，调用方按无更新处理。
    expect(compareVersions("oops", "1.0.0")).toBe(0);
  });

  it("detects newer candidates only", () => {
    expect(isNewerVersion("0.1.0", "v0.1.1")).toBe(true);
    expect(isNewerVersion("0.1.0", "v0.1.0")).toBe(false);
    expect(isNewerVersion("0.2.0", "v0.1.9")).toBe(false);
    expect(isNewerVersion("0.1.0", "not-a-version")).toBe(false);
  });

  it("builds update info from a valid newer github release", () => {
    const release = {
      tag_name: "v0.2.0",
      html_url: "https://github.com/Ssunk/ShellGrid/releases/tag/v0.2.0",
      draft: false,
      prerelease: false,
    };
    expect(releaseToUpdate(release, "0.1.0")).toEqual({
      version: "v0.2.0",
      url: "https://github.com/Ssunk/ShellGrid/releases/tag/v0.2.0",
    });
    expect(releaseToUpdate(release, "0.2.0")).toBeNull();
    expect(releaseToUpdate({ ...release, draft: true }, "0.1.0")).toBeNull();
    expect(releaseToUpdate({ ...release, prerelease: true }, "0.1.0")).toBeNull();
    expect(releaseToUpdate({ ...release, html_url: "https://evil.example/x" }, "0.1.0")).toBeNull();
    expect(releaseToUpdate({ ...release, tag_name: 42 }, "0.1.0")).toBeNull();
    expect(releaseToUpdate(null, "0.1.0")).toBeNull();
    expect(releaseToUpdate("v0.2.0", "0.1.0")).toBeNull();
  });
});
