import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupImages, imageExtension, IMAGE_RETENTION_MS, MAX_IMAGE_BYTES, saveClipboardImage } from "./clipboard";

const dirs: string[] = [];
async function temporary() { const path = await mkdtemp(join(tmpdir(), "shellgrid-images-")); dirs.push(path); return path; }
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
describe("clipboard image service", () => {
  it("recognizes the five supported bitmap signatures", () => {
    expect(imageExtension(png)).toBe("png");
    expect(imageExtension(Buffer.from([255, 216, 255, 0]))).toBe("jpg");
    expect(imageExtension(Buffer.from("GIF87a"))).toBe("gif");
    expect(imageExtension(Buffer.from("GIF89a"))).toBe("gif");
    expect(imageExtension(Buffer.from("RIFFxxxxWEBPdata"))).toBe("webp");
    expect(imageExtension(Buffer.from("BMdata"))).toBe("bmp");
    expect(imageExtension(Buffer.from("not an image"))).toBeUndefined();
  });
  it("writes the bytes exactly to uniquely generated paths", async () => {
    const directory = await temporary();
    const path = await saveClipboardImage(directory, png);
    expect(dirname(path)).toBe(directory);
    expect(basename(path)).toMatch(/^clipboard-[\d]+-[\da-f-]+\.png$/);
    expect(await readFile(path)).toEqual(png);
    expect(await saveClipboardImage(directory, png)).not.toBe(path);
  });
  it("rejects wrong IPC shapes, empty, unsupported and oversized data", async () => {
    const directory = await temporary();
    for (const value of [[], "base64", new Uint8Array(), Buffer.from("text"), Buffer.alloc(MAX_IMAGE_BYTES + 1)]) {
      await expect(saveClipboardImage(directory, value)).rejects.toThrow();
    }
    expect(await readdir(directory)).toEqual([]);
  });
  it("cleans only owned files older than seven days", async () => {
    const directory = await temporary();
    for (const name of ["clipboard-old.png", "user.png", "clipboard-fresh.png"]) await writeFile(join(directory, name), png);
    const old = new Date(Date.now() - IMAGE_RETENTION_MS - 10_000);
    await utimes(join(directory, "clipboard-old.png"), old, old);
    await utimes(join(directory, "user.png"), old, old);
    await cleanupImages(directory);
    expect((await readdir(directory)).sort()).toEqual(["clipboard-fresh.png", "user.png"]);
  });
});
