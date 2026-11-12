import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliCommand, codexWritableDirs } from "../src/runner";

const tmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

test("codex can write to the owner's configured work_dirs, wherever they are", () => {
  const home = tmp("noop-home-");
  const elsewhere = tmp("noop-repos-"); // e.g. a repo root on another drive, outside the home dir
  mkdirSync(join(home, "projects"));
  const dirs = codexWritableDirs(home, [elsewhere, elsewhere, "~/projects", join(home, "missing")]);
  expect(dirs).toContain(elsewhere);
  expect(dirs.filter((d) => d === elsewhere).length).toBe(1); // listed twice, added once
  expect(dirs).toContain(join(home, "projects")); // "~" expands to the home dir
  expect(dirs).not.toContain(join(home, "missing")); // dirs that do not exist are left out
});

test("without work_dirs the writable dirs are unchanged", () => {
  const home = tmp("noop-home-");
  mkdirSync(join(home, "work"));
  expect(codexWritableDirs(home)).toEqual(codexWritableDirs(home, []));
  expect(codexWritableDirs(home)).toContain(join(home, "work"));
});

test("the codex command passes the configured work_dirs as --add-dir", () => {
  const elsewhere = tmp("noop-repos-");
  const cmd = cliCommand("codex", { resources: { work_dirs: [elsewhere] } } as any);
  const added = cmd.filter((_, i) => cmd[i - 1] === "--add-dir");
  expect(added).toContain(elsewhere);
  expect(cmd.at(-1)).toBe("-");
  expect(() => cliCommand("codex", {} as any)).not.toThrow(); // no [resources] section at all
});
