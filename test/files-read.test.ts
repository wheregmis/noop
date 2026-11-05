import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FilesSql, handleFiles, handleReadFiles, initFilesSchema, prefixEnd, readable } from "../cloud/src/files";
import { listDataFiles, readDataFile } from "../src/server";

/** bun:sqlite adapter for the DO SqlStorage subset; records every query. */
function sqlOf(): FilesSql & { queries: string[] } {
  const db = new Database(":memory:");
  const queries: string[] = [];
  return {
    queries,
    exec(q: string, ...raw: any[]) {
      const b = raw.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
      queries.push(q);
      const parts = q.split(";").map((s) => s.trim()).filter(Boolean);
      let rows: any[] = [];
      for (const part of parts) {
        const st = db.query(part);
        if (/^SELECT/i.test(part)) rows = st.all(...b) as any[];
        else st.run(...b);
      }
      return { toArray: () => rows };
    },
  };
}
const b64 = (s: string) => Buffer.from(s).toString("base64");

test("readable whitelist", () => {
  expect(readable("policies/a.md")).toBe(true);
  expect(readable("decisions/closed/D-1.md")).toBe(true);
  expect(readable("config.toml")).toBe(false);
  expect(readable("decisions/open/D-2.md")).toBe(false);
  expect(readable("tasks/")).toBe(false);
  expect(readable("policies/../config.toml")).toBe(false);
  expect(prefixEnd("memory/")).toBe("memory0");
});

test("worker list/read: files table only, whitelist enforced", async () => {
  const sql = sqlOf();
  initFilesSchema(sql);
  const commit = new Request("http://x/api/files/commit", { method: "POST", body: JSON.stringify({ msg: "seed", changes: [
    { path: "policies/a.md", base_version: 0, content: b64("# Rules") },
    { path: "policies0", base_version: 0, content: b64("x") },
    { path: "config.toml", base_version: 0, content: b64("secret") },
  ] }) });
  expect((await handleFiles(sql, commit, new URL(commit.url), "m"))!.status).toBe(200);
  sql.queries.length = 0;
  let r = handleReadFiles(sql, new URL("http://x/api/files/list?prefix=policies/"))!;
  const list = await r.json() as any;
  expect(list.files.map((f: any) => f.path)).toEqual(["policies/a.md"]);
  expect(list.files[0].size).toBe(Buffer.byteLength("# Rules"));
  expect(sql.queries.some((q) => /history/.test(q))).toBe(false);
  expect(sql.queries[0]).toContain("path >= ? AND path < ?");
  r = handleReadFiles(sql, new URL("http://x/api/files/read?path=policies/a.md"))!;
  expect(((await r.json()) as any).content).toBe("# Rules");
  expect(handleReadFiles(sql, new URL("http://x/api/files/read?path=config.toml"))!.status).toBe(403);
  expect(handleReadFiles(sql, new URL("http://x/api/files/list?prefix="))!.status).toBe(403);
  expect(handleReadFiles(sql, new URL("http://x/api/files/read?path=memory/none.md"))!.status).toBe(404);
});

test("local server list/read", () => {
  const root = mkdtempSync(join(tmpdir(), "hub-read-"));
  mkdirSync(join(root, "agents/lead"), { recursive: true });
  writeFileSync(join(root, "agents/lead/profile.md"), "hi");
  writeFileSync(join(root, "config.toml"), "secret");
  expect(listDataFiles("agents", root)!.map((f) => f.path)).toEqual(["agents/lead/profile.md"]);
  expect(readDataFile("agents/lead/profile.md", root)!.content).toBe("hi");
  expect(readDataFile("config.toml", root)).toBeNull();
  expect(readDataFile("memory/x.md", root)).toBeUndefined();
  expect(listDataFiles("tasks/", root)).toBeNull();
});
