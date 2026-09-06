import { describe, expect, it } from "vitest";
import { directoryPath, externalUrl, gitDiffRequest, gitMutation, trustedUrl } from "./security";
describe("desktop IPC boundary", () => {
  it("limits external links to HTTP and HTTPS", () => {
    expect(externalUrl("https://example.com")).toBe("https://example.com/");
    expect(externalUrl("http://localhost/test")).toBe("http://localhost/test");
    for (const value of ["file:///C:/Windows", "javascript:alert(1)", "shell:AppsFolder", "ftp://example.com", {}, ""]) {
      expect(() => externalUrl(value)).toThrow();
    }
  });
  it("only trusts the exact app entry, allowing in-page hashes", () => {
    expect(trustedUrl("file:///D:/app/index.html#search", "file:///D:/app/index.html")).toBe(true);
    expect(trustedUrl("file:///D:/app/evil.html", "file:///D:/app/index.html")).toBe(false);
    expect(trustedUrl("http://127.0.0.1:1420/", "http://127.0.0.1:1420/")).toBe(true);
    expect(trustedUrl("http://127.0.0.1:1421/", "http://127.0.0.1:1420/")).toBe(false);
    expect(trustedUrl("https://127.0.0.1:1420/", "http://127.0.0.1:1420/")).toBe(false);
  });
  it("validates Git operations, absolute workspace paths and repository-relative file paths", () => {
    expect(directoryPath("C:\\repo")).toBe("C:\\repo");
    expect(gitMutation({ type: "stage", path: "C:\\repo", paths: ["a[1].txt"] })).toMatchObject({ type: "stage" });
    for (const filePath of ["..\\secret", "C:\\secret", "file:stream", "a\0b"]) {
      expect(() => gitDiffRequest({ path: "C:\\repo", filePath, staged: false })).toThrow();
    }
    expect(() => gitMutation({ type: "exec", path: "C:\\repo", command: "x" })).toThrow();
    expect(() => gitMutation({ type: "push", path: "C:\\repo", remote: null, forceWithLease: "yes" })).toThrow();
    expect(() => directoryPath("relative")).toThrow();
  });
});
