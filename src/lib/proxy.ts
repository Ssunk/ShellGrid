import type { ProxyConfig } from "./types";

// 与 Rust 端 workspace::ProxyConfig::validate 保持一致的协议白名单。
const PROXY_SCHEMES = new Set(["http:", "https:", "socks5:", "socks5h:"]);

/** 会话创建时随 create 消息发送给 Rust 端的代理载荷。 */
export interface SessionProxy {
  url: string;
  noProxy?: string;
}

/** 用户省略协议时按 http 代理处理，例如 "127.0.0.1:7890"。 */
export function normalizeProxyUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0 || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

export function isValidProxyUrl(input: string): boolean {
  try {
    const url = new URL(input.trim());
    return PROXY_SCHEMES.has(url.protocol) && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** 仅当代理已启用且地址合法时返回载荷；其余情况返回 undefined，create 消息不携带代理。 */
export function sessionProxy(proxy: ProxyConfig | undefined): SessionProxy | undefined {
  if (!proxy?.enabled || !isValidProxyUrl(proxy.url)) return undefined;
  const noProxy = proxy.noProxy?.trim();
  return noProxy ? { url: proxy.url.trim(), noProxy } : { url: proxy.url.trim() };
}

/** 持久化状态中的代理字段形状或取值非法时返回 undefined，让调用方剥离而不是整体回退。 */
export function sanitizeProxy(value: unknown): ProxyConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const proxy = value as Partial<ProxyConfig>;
  if (typeof proxy.enabled !== "boolean" || typeof proxy.url !== "string") return undefined;
  if (proxy.noProxy !== undefined && typeof proxy.noProxy !== "string") return undefined;
  if (proxy.enabled && !isValidProxyUrl(proxy.url)) return undefined;
  return value as ProxyConfig;
}
