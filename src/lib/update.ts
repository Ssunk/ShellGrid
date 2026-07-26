/** 更新检查：对比 GitHub 最新发布 Release 的 tag 与当前版本，只提示不自动下载安装。 */

export const UPDATE_REPO = "Ssunk/ShellGrid";
const RELEASE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;

export interface UpdateInfo {
  /** 规范化后的最新版本号，保留 tag 的原始写法（如 "v0.2.0"）。 */
  version: string;
  /** GitHub 发布页地址，经 open_external 打开。 */
  url: string;
}

interface ParsedVersion {
  parts: [number, number, number];
  pre: string;
}

export function parseVersion(value: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/.exec(value.trim());
  if (!match) return null;
  return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? "" };
}

// 按 semver 规则比较预发布段：正式版高于预发布，数字标识符按数值比较且低于字母标识符。
function comparePre(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const left = a.split(".");
  const right = b.split(".");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index];
    const y = right[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) < Number(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** 返回 -1/0/1；任一版本无法解析时返回 0，调用方按"无更新"处理。 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) {
      return left.parts[index] < right.parts[index] ? -1 : 1;
    }
  }
  return comparePre(left.pre, right.pre);
}

export function isNewerVersion(current: string, candidate: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/** 解析 GitHub Release 载荷；仅在候选版本更新且发布页是 GitHub 地址时返回更新信息。 */
export function releaseToUpdate(payload: unknown, currentVersion: string): UpdateInfo | null {
  if (!payload || typeof payload !== "object") return null;
  const release = payload as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
  if (typeof release.tag_name !== "string" || typeof release.html_url !== "string") return null;
  if (release.draft === true || release.prerelease === true) return null;
  if (!release.html_url.startsWith("https://github.com/")) return null;
  if (!isNewerVersion(currentVersion, release.tag_name)) return null;
  return { version: release.tag_name.trim(), url: release.html_url };
}

/** 返回 null 表示已是最新（含仓库尚无发布版本）；网络或接口异常时抛出。 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo | null> {
  const response = await fetch(RELEASE_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub API 返回 ${response.status}`);
  return releaseToUpdate(await response.json(), currentVersion);
}
