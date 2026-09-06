import { describe, expect, it } from "vitest";
import { sessionEnvironment, shellArguments, SHELL_INTEGRATION } from "./launch";
import type { CreateCommand } from "../../shared/protocol";
describe("PowerShell launch compatibility", () => {
  it("loads Profile by default and only appends a cwd prompt integration for interactive PowerShell", () => {
    expect(shellArguments("C:\\PowerShell\\PWSH.EXE", ["-NoLogo"])).toEqual(["-NoLogo", "-NoExit", "-Command", SHELL_INTEGRATION]);
    for (const args of [["-Command", "exit"], ["-File", "x.ps1"], ["-EncodedCommand", "ZQB4AGkAdAA="]]) {
      expect(shellArguments("pwsh.exe", args)).toEqual(args);
    }
    expect(SHELL_INTEGRATION).not.toMatch(/history|ReadLine|Get-Content/i);
    expect(shellArguments("other.exe", ["a"])).toEqual(["a"]);
  });
  it("sets proxy variables case-insensitively for new shells without changing the host environment", () => {
    const base = { Path: "C:\\Windows", http_proxy: "old", NO_PROXY: "old", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "old" };
    const env = sessionEnvironment({ proxy: { url: " http://localhost:7890 ", noProxy: " localhost " } } as CreateCommand, base);
    expect(env.HTTP_PROXY).toBe("http://localhost:7890");
    expect(env.HTTPS_PROXY).toBe(env.HTTP_PROXY);
    expect(env.ALL_PROXY).toBe(env.HTTP_PROXY);
    expect(env.NO_PROXY).toBe("localhost");
    expect(env.http_proxy).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(base.http_proxy).toBe("old");
    expect(sessionEnvironment({} as CreateCommand, { HTTPS_PROXY: "inherited" }).HTTPS_PROXY).toBe("inherited");
    const withoutBypass = sessionEnvironment({ proxy: { url: "http://localhost:7890" } } as CreateCommand, { no_proxy: "*" });
    expect(withoutBypass.no_proxy).toBeUndefined();
    expect(withoutBypass.NO_PROXY).toBeUndefined();
  });
});
