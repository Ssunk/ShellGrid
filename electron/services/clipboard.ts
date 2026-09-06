import { randomUUID } from "node:crypto";
import { mkdir, readdir, lstat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const IMAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export function imageExtension(bytes: Uint8Array): string | undefined {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "jpg";
  if (["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii"))) return "gif";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (data.subarray(0, 2).toString("ascii") === "BM") return "bmp";
  return undefined;
}
export async function cleanupImages(directory: string, now = Date.now()): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.startsWith("clipboard-")).map(async (entry) => {
    const path = join(directory, entry.name);
    const stat = await lstat(path).catch(() => null);
    if (stat?.isFile() && now - stat.mtimeMs > IMAGE_RETENTION_MS) await unlink(path).catch(() => {});
  }));
}
export async function saveClipboardImage(directory: string, value: unknown): Promise<string> {
  if (!(value instanceof Uint8Array)) throw new Error("剪贴板图片数据无效");
  if (value.length === 0) throw new Error("剪贴板图片为空");
  if (value.length > MAX_IMAGE_BYTES) throw new Error("剪贴板图片超过 20 MiB 限制");
  const extension = imageExtension(value);
  if (!extension) throw new Error("剪贴板内容不是支持的图片格式");
  await mkdir(directory, { recursive: true });
  await cleanupImages(directory);
  const path = join(directory, "clipboard-" + Date.now() + "-" + randomUUID() + "." + extension);
  await writeFile(path, value, { flag: "wx" });
  return path;
}
