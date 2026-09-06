import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceStore } from "./workspace";
import { parseWorkspace } from "../../shared/workspace";
import type { WorkspaceStateV1 } from "../../src/lib/types";

const directories: string[] = [];
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "shellgrid-workspace-"));
  directories.push(directory); return directory;
}
const fallback = (): WorkspaceStateV1 => ({
  schemaVersion: 1, rootPath: "C:\\", layout: { type: "pane", paneId: "pane" },
  panes: { pane: { cwd: "C:\\", shell: "pwsh.exe", args: ["-NoLogo"] } },
});
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
describe("workspace compatibility and atomic saves", () => {
  it("round trips schema 1 and serializes simultaneous save requests", async () => {
    const path = join(await temporary(), "workspace.json");
    const store = new WorkspaceStore(path);
    const values = Array.from({ length: 25 }, (_, i) => ({ ...fallback(), rootPath: "C:\\project-" + i }));
    await Promise.all(values.map((value) => store.save(value)));
    expect(await store.load(fallback())).toEqual(values[24]);
    expect((await readdir(join(path, ".."))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
  it("preserves corrupt content before falling back and later saving", async () => {
    const directory = await temporary();
    const store = new WorkspaceStore(join(directory, "workspace.json"));
    await writeFile(store.path, "{ broken");
    expect(await store.load(fallback())).toEqual(fallback());
    const backup = (await readdir(directory)).find((name) => name.startsWith("workspace.corrupt-"))!;
    expect(await readFile(join(directory, backup), "utf8")).toBe("{ broken");
    await store.save(fallback());
    expect(await readFile(join(directory, backup), "utf8")).toBe("{ broken");
  });
  it("fills old rootPath and removes an invalid enabled proxy without losing the layout", async () => {
    const { rootPath: _, ...old } = fallback();
    const store = new WorkspaceStore(join(await temporary(), "workspace.json"));
    await writeFile(store.path, JSON.stringify({ ...old, proxy: { enabled: true, url: "ftp://bad" } }));
    expect(await store.load(fallback())).toEqual(fallback());
    expect(await readFile(store.path, "utf8")).toContain("ftp://bad");
  });
  it("round trips enabled proxies and disabled drafts, rejecting invalid enabled settings on save", async () => {
    const store = new WorkspaceStore(join(await temporary(), "workspace.json"));
    for (const proxy of [
      { enabled: true, url: "socks5h://localhost:1080", noProxy: "localhost" },
      { enabled: false, url: "草稿" },
    ]) {
      const state = { ...fallback(), proxy };
      await store.save(state);
      expect(await store.load(fallback())).toEqual(state);
    }
    expect(() => store.save({ ...fallback(), proxy: { enabled: true, url: "invalid" } })).toThrow();
  });
  it("does not overwrite a file that cannot be read or preserved", async () => {
    const store = new WorkspaceStore(join(await temporary(), "workspace.json"));
    await mkdir(store.path);
    await writeFile(join(store.path, "owned-by-user"), "keep");
    expect(await store.load(fallback())).toEqual(fallback());
    await expect(store.save(fallback())).rejects.toThrow();
    expect(await readFile(join(store.path, "owned-by-user"), "utf8")).toBe("keep");
  });
  it("validates recursive shape, count, ratios, duplicate IDs, launch arguments and schema", () => {
    const value = fallback();
    for (const invalid of [
      { ...value, schemaVersion: 2 }, { ...value, rootPath: "" },
      { ...value, panes: {} },
      { ...value, panes: { pane: { ...value.panes.pane, args: [1] } } },
      { ...value, layout: { type: "split", direction: "vertical", ratio: 0.9, first: value.layout, second: value.layout } },
      { ...value, layout: { type: "split", direction: "vertical", ratio: 0.5, first: value.layout, second: value.layout } },
    ]) expect(() => parseWorkspace(invalid)).toThrow();
    let layout = value.layout;
    const panes = { ...value.panes };
    for (let i = 0; i < 16; i++) {
      panes["new" + i] = value.panes.pane;
      layout = { type: "split", direction: "vertical", ratio: 0.5, first: layout, second: { type: "pane", paneId: "new" + i } };
    }
    expect(() => parseWorkspace({ ...value, layout, panes })).toThrow();
  });
  it("only persists schema fields, retaining unreferenced launch records for compatibility", () => {
    const value = fallback();
    const parsed = parseWorkspace({ ...value, sessionId: "runtime", output: "runtime", panes: {
      pane: { ...value.panes.pane, sessionId: "runtime", environment: { KEY: "runtime" } },
      extra: value.panes.pane,
    } });
    expect(JSON.stringify(parsed)).not.toContain("runtime");
    expect(parsed.panes.extra).toEqual(value.panes.pane);
  });
});
