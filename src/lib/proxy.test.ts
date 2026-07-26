import { describe, expect, it } from "vitest";
import { isValidProxyUrl, normalizeProxyUrl, sanitizeProxy, sessionProxy } from "./proxy";
import type { ProxyConfig } from "./types";

describe("proxy config", () => {
  it("prepends http scheme only when missing", () => {
    expect(normalizeProxyUrl(" 127.0.0.1:7890 ")).toBe("http://127.0.0.1:7890");
    expect(normalizeProxyUrl("http://127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
    expect(normalizeProxyUrl("SOCKS5://proxy.local:1080")).toBe("SOCKS5://proxy.local:1080");
    expect(normalizeProxyUrl("   ")).toBe("");
  });

  it("accepts only http, https and socks5 proxy urls with a host", () => {
    expect(isValidProxyUrl("http://127.0.0.1:7890")).toBe(true);
    expect(isValidProxyUrl("https://proxy.corp.example")).toBe(true);
    expect(isValidProxyUrl("socks5://127.0.0.1:1080")).toBe(true);
    expect(isValidProxyUrl("")).toBe(false);
    expect(isValidProxyUrl("not a url")).toBe(false);
    expect(isValidProxyUrl("ftp://127.0.0.1:21")).toBe(false);
    expect(isValidProxyUrl("http://")).toBe(false);
  });

  it("builds a session payload only for enabled valid proxies", () => {
    expect(sessionProxy(undefined)).toBeUndefined();
    expect(sessionProxy({ enabled: false, url: "http://127.0.0.1:7890" })).toBeUndefined();
    expect(sessionProxy({ enabled: true, url: "尚未填写" })).toBeUndefined();
    expect(sessionProxy({ enabled: true, url: "http://127.0.0.1:7890", noProxy: "  " })).toEqual({
      url: "http://127.0.0.1:7890",
    });
    expect(
      sessionProxy({ enabled: true, url: " http://127.0.0.1:7890 ", noProxy: "localhost,127.0.0.1" }),
    ).toEqual({ url: "http://127.0.0.1:7890", noProxy: "localhost,127.0.0.1" });
  });

  it("sanitizes persisted proxy values", () => {
    const valid: ProxyConfig = { enabled: true, url: "http://127.0.0.1:7890", noProxy: "localhost" };
    expect(sanitizeProxy(valid)).toBe(valid);
    const draft: ProxyConfig = { enabled: false, url: "还没写完" };
    expect(sanitizeProxy(draft)).toBe(draft);
    expect(sanitizeProxy(undefined)).toBeUndefined();
    expect(sanitizeProxy("http://127.0.0.1")).toBeUndefined();
    expect(sanitizeProxy({ enabled: true, url: "not a url" })).toBeUndefined();
    expect(sanitizeProxy({ enabled: "yes", url: "http://127.0.0.1" })).toBeUndefined();
    expect(sanitizeProxy({ enabled: true, url: "http://127.0.0.1", noProxy: 1 })).toBeUndefined();
  });
});
