import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CODE, HOME_DIR, P, loadConfig, allowedClis, chooseCli, hostCaps } from "../src/core";
import { accountRequest } from "../src/account-ui";
import { accountCanRun, accountEnv, accountStatus, accounts, cancelLogin, hasPendingLogin, loginInfo, markAccountSuccess, pickAccount, reportFailure, retryLogins, setAccountNames, startLogin, usable } from "../src/accounts";
import { quickAsk } from "../src/runner";
import { medic } from "../src/medic";
import { encodeAccountSegment } from "../cloud/src/machine-requests";
import { learningBlockReason } from "../src/sessions";
import { drainInbound, handleOwnerMessage } from "../src/server";
import { answeredIds, ITEM_ID } from "../app/hub";
import * as notifications from "../src/notify";

const initialPath = process.env.PATH;
const local = join(HOME_DIR, "accounts"), metadata = join(local, "config.json"), state = join(local, "state.json");
const legacy = join(local, "state.before-sources.json");
let root = "";
const path = (rest = "", host = "account-machine") => `http://hub/api/machines/${host}/accounts${rest}`;
const request = async (method = "GET", rest = "", body?: unknown, host?: string) => {
  const response = await accountRequest(new Request(path(rest, host), { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  return { status: response.status, data: await response.json() as any };
};
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!await check()) { if (Date.now() > end) throw new Error("account fixture timed out"); await Bun.sleep(10); }
}
async function signedIn(name = "default") {
  const selected = accounts(loadConfig(), "claude").find((a) => a.name === name)!;
  const response = await request("POST", `/claude/${name}/login`, {}); expect(response.status).toBe(200);
  await until(() => !!loginInfo(selected)?.url);
  expect((await request("POST", `/claude/${name}/code`, { id: loginInfo(selected)!.id, code: "fixture-authorization" })).status).toBe(200);
  await until(() => !hasPendingLogin(selected));
  return selected;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "noop-account-ui-"));
  mkdirSync(P(), { recursive: true });
  rmSync(local, { recursive: true, force: true });
  rmSync(P("settings.json"), { force: true }); rmSync(P("config.local.toml"), { force: true });
  rmSync(join(HOME_DIR, "medic.json"), { force: true });
  writeFileSync(P("config.toml"), '[host]\nname = "account-machine"\n[clis]\nenabled = ["claude", "codex", "hermes"]\n');
  const fixture = join(root, "cli.ts");
  writeFileSync(fixture, `
    const args = process.argv.slice(2);
    if (args[0] === '--version') { console.log('fixture'); process.exit(0); }
    if (args[0] === 'setup-token') {
      await Bun.write(${JSON.stringify(join(root, "started"))}, 'started');
      console.log('https://claude.ai/oauth/authorize?state=temporary-fixture');
      let code = ''; for await (const chunk of Bun.stdin.stream()) { code += new TextDecoder().decode(chunk); if (/[\\r\\n]/.test(code)) break; }
      console.log('sk-ant-oat01-fixture-secret-token'); process.exit(0);
    }
    if (args[0] === 'login') {
      console.log('https://auth.openai.com/codex/device'); console.log('ABCD-EFGH');
      for (let n=0;n<500;n++) { if (await Bun.file(${JSON.stringify(join(root, "approved"))}).exists()) process.exit(0); await Bun.sleep(10); }
      process.exit(1);
    }
    await Bun.stdin.text();
    await Bun.write(${JSON.stringify(join(root, "execution.json"))}, JSON.stringify({claude:process.env.CLAUDE_CONFIG_DIR, codex:process.env.CODEX_HOME, token:process.env.CLAUDE_CODE_OAUTH_TOKEN}));
    console.log('\\x60\\x60\\x60json\\n'+JSON.stringify({status:'done',reply:'fixture',calls:[]})+'\\n\\x60\\x60\\x60');
  `);
  for (const cli of ["claude", "codex", "hermes"]) writeFileSync(join(root, cli), `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`, { mode: 0o755 });
  writeFileSync(join(root, "script"), '#!/bin/sh\nif [ "$1" = "-qfec" ]; then exec /bin/sh -c "$2"; fi\nshift 2\nexec "$@"\n', { mode: 0o755 });
  process.env.PATH = root;
});
afterEach(async () => {
  const all = ["claude", "codex", "hermes"].flatMap((cli) => accounts(loadConfig(), cli));
  for (const account of all) { const login = loginInfo(account); if (login && hasPendingLogin(account)) cancelLogin(account, login.id); }
  await until(() => all.every((account) => !hasPendingLogin(account)));
  process.env.PATH = initialPath;
  rmSync(root, { recursive: true, force: true });
});

test("account views include unverified and unavailable tools without reading or exposing credentials", async () => {
  process.env.PATH = root + "/missing";
  const response = await request();
  expect(response.status).toBe(200); expect(response.data.host).toBe("account-machine");
  expect(response.data.accounts).toHaveLength(3);
  expect(response.data.accounts.every((account: any) => account.default && account.state === "unknown")).toBe(true);
  expect(response.data.providers.every((provider: any) => !provider.available)).toBe(true);
  expect(JSON.stringify(response.data)).not.toContain(HOME_DIR);
  expect(existsSync(metadata)).toBe(false);
});

test("account controls reject malformed forms, provider/path injection and another machine before writes", async () => {
  for (const body of [null, [], {}, { cli: "other", name: "work" }, { cli: "claude", name: "../escape" }, { cli: "claude", name: "Upper" }, { cli: "claude", name: "work", dir: root }]) expect((await request("POST", "", body)).status).toBe(400);
  expect((await request("POST", "", { cli: "claude", name: "work" }, "other-machine")).status).toBe(403);
  expect((await request("PUT", "", {})).status).toBe(400);
  expect((await request("DELETE", "/other/work")).status).toBe(404);
  expect(existsSync(metadata)).toBe(false);
});

test("local account choices inherit per CLI, retain configured directories, and never delete credential files", async () => {
  const configured = join(root, "existing-code-home"); mkdirSync(configured); writeFileSync(join(configured, "auth.json"), "private-token");
  const text = readFileSync(P("config.toml"), "utf8") + `\n[[accounts]]\ncli = "codex"\nname = "old"\ndir = ${JSON.stringify(configured)}\n`;
  writeFileSync(P("config.toml"), text);
  expect(accounts(loadConfig(), "codex")[0]?.dir).toBe(configured);
  await request("POST", "", { cli: "claude", name: "work" });
  expect(accounts(loadConfig(), "claude").map((account) => account.name)).toEqual(["default", "work"]);
  expect(accounts(loadConfig(), "codex")[0]?.dir).toBe(configured);
  await request("POST", "", { cli: "codex", name: "default" });
  expect(accounts(loadConfig(), "codex").map((account) => account.name)).toEqual(["old", "default"]);
  expect(accounts(loadConfig(), "codex")[0]?.dir).toBe(configured);
  expect(accounts(loadConfig(), "codex")[1]).toMatchObject({ name: "default", dir: "", default: true });
  expect((await request("DELETE", "/codex/old")).status).toBe(200);
  expect(readFileSync(join(configured, "auth.json"), "utf8")).toBe("private-token");
  await request("DELETE", "/codex/default");
  expect(accounts(loadConfig(), "codex")).toEqual([]); expect(accountCanRun("codex", loadConfig())).toBe(false);
  expect(chooseCli({ cli: "codex" }, loadConfig())).toBeNull(); expect(hostCaps(loadConfig())).not.toContain("cli:codex");
  const apprentice = P("agents/apprentice/profile.md"), previous = existsSync(apprentice) ? readFileSync(apprentice, "utf8") : null;
  mkdirSync(P("agents/apprentice"), { recursive: true }); writeFileSync(apprentice, "# Apprentice");
  try { expect(learningBlockReason({ ...loadConfig(), clis: { enabled: ["codex"] } })).toContain("AI tool/account is available"); }
  finally { if (previous === null) rmSync(apprentice); else writeFileSync(apprentice, previous); }

  await request("POST", "", { cli: "codex", name: "default" });
  expect(accountCanRun("codex", loadConfig())).toBe(true);
  expect(chooseCli({ cli: "codex" }, loadConfig())).toBe("codex"); expect(hostCaps(loadConfig())).toContain("cli:codex");
  expect(readFileSync(P("config.toml"), "utf8")).toBe(text);
  expect(statSync(metadata).mode & 0o777).toBe(0o600);
});

test("file accounts named default retain their credential directories through UI selection changes", async () => {
  const tools = ["claude", "codex", "hermes"] as const;
  const dirs = Object.fromEntries(tools.map((cli) => [cli, join(root, `${cli}-existing-home`)]));
  const envKeys = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", hermes: "HERMES_HOME" };
  const credential = (cli: typeof tools[number]) => join(dirs[cli]!, cli === "claude" ? ".credentials.json" : "auth.json");
  for (const cli of tools) { mkdirSync(dirs[cli]!); writeFileSync(credential(cli), `fixture-private-${cli}-credentials`); }
  const config = readFileSync(P("config.toml"), "utf8") + tools.map((cli) => `\n[[accounts]]\ncli = "${cli}"\nname = "default"\ndir = ${JSON.stringify(dirs[cli])}\n`).join("");
  writeFileSync(P("config.toml"), config);
  const check = (cli: typeof tools[number]) => {
    const account = accounts(loadConfig(), cli).find((item) => item.name === "default")!;
    expect(account.dir).toBe(dirs[cli]); expect(account.default === true).toBe(false);
    expect(accountEnv(account)[envKeys[cli]]).toBe(fs.realpathSync(dirs[cli]!));
    expect(readFileSync(credential(cli), "utf8")).toBe(`fixture-private-${cli}-credentials`);
  };
  for (const cli of tools) {
    check(cli);
    const added = await request("POST", "", { cli, name: "work" });
    expect(added.status).toBe(200); check(cli);
    expect(added.data.accounts.find((item: any) => item.cli === cli && item.name === "default").default).toBe(false);
    expect(JSON.stringify(added.data)).not.toContain(dirs[cli]); expect(JSON.stringify(added.data)).not.toContain("fixture-private");
    expect((await request("PUT", "", { cli, names: ["work", "default"] })).status).toBe(200);
    expect(accounts(loadConfig(), cli).map((item) => item.name)).toEqual(["work", "default"]); check(cli);
    expect((await request("DELETE", `/${cli}/work`)).status).toBe(200); check(cli);
    expect((await request("DELETE", `/${cli}/default`)).status).toBe(200);
    expect(accounts(loadConfig(), cli)).toEqual([]);
    expect((await request("POST", "", { cli, name: "default" })).status).toBe(200); check(cli);
    expect((await request("PUT", "", { cli, names: null })).status).toBe(200); check(cli);
  }
  expect(readFileSync(P("config.toml"), "utf8")).toBe(config);
  expect(existsSync(join(root, "started"))).toBe(false); // No login was started by these configuration changes.
  expect(existsSync(join(root, "execution.json"))).toBe(false);
});

test("failed atomic metadata replacement preserves selections and returns no private paths", async () => {
  await request("POST", "", { cli: "claude", name: "work" });
  const before = readFileSync(metadata, "utf8"), rename = fs.renameSync;
  const failed = spyOn(fs, "renameSync").mockImplementation((from, to) => { if (to === metadata) throw new Error(`private error ${root}`); rename(from, to); });
  try {
    for (const [method, body] of [["POST", { cli: "claude", name: "second" }], ["PUT", { cli: "claude", names: null }], ["PUT", { cli: "claude", names: ["work", "default"] }]] as const) {
      const response = await request(method, "", body);
      expect(response.status).toBe(500); expect(JSON.stringify(response.data)).not.toContain(root);
      expect(readFileSync(metadata, "utf8")).toBe(before); expect(readdirSync(local).some((file) => file.endsWith(".tmp"))).toBe(false);
    }
  } finally { failed.mockRestore(); }
});

test("default Claude uses its source-bound captured token while safe account views never expose it", async () => {
  const first = await request(); expect(first.data.accounts[0].state).toBe("unknown");
  const account = await signedIn(), saved = JSON.parse(readFileSync(state, "utf8"));
  saved.accounts["claude-default"].last_error = `private ${root}`; writeFileSync(state, JSON.stringify(saved));
  expect(accountEnv(account).CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-fixture-secret-token");
  expect(JSON.stringify(first.data)).not.toContain("private"); expect(JSON.stringify(first.data)).not.toContain(root);
  markAccountSuccess(account);
  expect((await request()).data.accounts.find((item: any) => item.cli === "claude").state).toBe("ok");
});

test("unbound and invalid-source cached authentication is preserved privately before becoming Not checked", async () => {
  mkdirSync(local, { recursive: true });
  const original = JSON.stringify({ seq: 7, accounts: {
    "claude-default": { token: "legacy-normal-token", verified_at: new Date().toISOString(), cooldown_until: "2099-01-01T00:00:00Z", needs_login: true },
    "codex-default": { source: "not-a-source", verified_at: new Date().toISOString(), cooldown_until: "2099-01-01T00:00:00Z" },
  } });
  writeFileSync(state, original, { mode: 0o600 });
  const directory = join(root, "restored-file-home"); mkdirSync(directory); const credentials = join(directory, ".credentials.json"); writeFileSync(credentials, "untouched credential file");
  writeFileSync(P("config.local.toml"), `[[accounts]]\ncli='claude'\nname='default'\ndir=${JSON.stringify(directory)}\n`);
  const selected = accounts(loadConfig(), "claude")[0]!;
  expect(accountEnv(selected)).toMatchObject({ CLAUDE_CONFIG_DIR: fs.realpathSync(directory), CLAUDE_CODE_OAUTH_TOKEN: "" });
  const response = await request(); expect(response.status).toBe(200);
  expect(response.data.accounts.every((a: any) => a.state === "unknown")).toBe(true);
  expect(readFileSync(legacy, "utf8")).toBe(original); expect(statSync(legacy).mode & 0o777).toBe(0o600);
  const current = JSON.parse(readFileSync(state, "utf8"));
  for (const cli of ["claude", "codex"]) expect(current.accounts[`${cli}-default`]).toEqual({ source: expect.any(String) });
  expect(JSON.stringify(response.data)).not.toContain("legacy-normal-token"); expect(JSON.stringify(response.data)).not.toContain(directory);
  markAccountSuccess(selected); expect(readFileSync(legacy, "utf8")).toBe(original);
  expect(readFileSync(credentials, "utf8")).toBe("untouched credential file");
});

test("failed legacy preservation keeps cached credentials unchanged and leaves no partial backup", () => {
  mkdirSync(local, { recursive: true }); const original = JSON.stringify({ seq: 0, accounts: { "claude-default": { token: "legacy-token" } } });
  writeFileSync(state, original, { mode: 0o600 }); const link = fs.linkSync;
  const failed = spyOn(fs, "linkSync").mockImplementation((from, to) => { if (String(to) === legacy) throw new Error("fixture backup failure"); return link(from, to); });
  try {
    expect(() => accountEnv(accounts(loadConfig(), "claude")[0]!)).toThrow("backup failure");
    expect(readFileSync(state, "utf8")).toBe(original); expect(existsSync(legacy)).toBe(false);
    expect(readdirSync(local).some((file) => file.endsWith(".tmp"))).toBe(false);
  } finally { failed.mockRestore(); }
  expect(accountEnv(accounts(loadConfig(), "claude")[0]!).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  expect(readFileSync(legacy, "utf8")).toBe(original);
});

test("unsafe or mismatched legacy backups cannot authorize invalidation or follow a linked file", () => {
  mkdirSync(local, { recursive: true }); const original = JSON.stringify({ seq: 0, accounts: { "claude-default": { token: "still-preserved" } } });
  writeFileSync(state, original, { mode: 0o600 }); const target = join(root, "unrelated.json"); writeFileSync(target, original);
  fs.symlinkSync(target, legacy); const read = fs.readFileSync; let followed = false;
  const check = spyOn(fs, "readFileSync").mockImplementation(((file: any, ...options: any[]) => {
    if (String(file) === legacy) { followed = true; throw new Error("linked backup was read"); }
    return (read as any)(file, ...options);
  }) as typeof fs.readFileSync);
  try { expect(() => accountEnv(accounts(loadConfig(), "claude")[0]!)).toThrow("could not be verified"); expect(followed).toBe(false); }
  finally { check.mockRestore(); rmSync(legacy); }
  for (const data of ["{bad-json", '{"accounts":{}}']) {
    writeFileSync(legacy, data, { mode: 0o600 });
    expect(() => accountEnv(accounts(loadConfig(), "claude")[0]!)).toThrow();
    expect(readFileSync(state, "utf8")).toBe(original); expect(readFileSync(legacy, "utf8")).toBe(data); rmSync(legacy);
  }
  expect(readFileSync(target, "utf8")).toBe(original);
});

test("an old run cannot use tokens or update the status of a replacement named-default source", async () => {
  const old = await signedIn();
  const folder = join(root, "new-account-home"); mkdirSync(folder);
  writeFileSync(P("config.local.toml"), `[[accounts]]\ncli='claude'\nname='default'\ndir=${JSON.stringify(folder)}\n`);
  const current = accounts(loadConfig(), "claude")[0]!;
  expect(accountEnv(current).CLAUDE_CODE_OAUTH_TOKEN).toBe(""); expect(accountStatus(current).state).toBe("unknown");
  markAccountSuccess(current); const before = readFileSync(state, "utf8"); rmSync(join(root, "started"));
  markAccountSuccess(old); await reportFailure(old, "auth", "expired old source", loadConfig());
  expect(readFileSync(state, "utf8")).toBe(before); expect(usable(old)).toBe(false); expect(loginInfo(old)).toBeUndefined();
  expect(() => accountEnv(old)).toThrow("source changed");
  await expect(startLogin(old, loadConfig(), { notify: false })).rejects.toThrow("source changed");
  expect(existsSync(join(root, "started"))).toBe(false);
});

test("normal account source snapshots include ambient homes and reject late callbacks after an environment change", async () => {
  for (const [cli, variable] of [["claude", "CLAUDE_CONFIG_DIR"], ["codex", "CODEX_HOME"], ["hermes", "HERMES_HOME"]] as const) {
    const previous = process.env[variable];
    try {
      process.env[variable] = join(root, `${cli}-ambient-a`);
      const old = accounts(loadConfig(), cli)[0]!; markAccountSuccess(old);
      const first = JSON.parse(readFileSync(state, "utf8")).accounts[`${cli}-default`].source;
      process.env[variable] = join(root, `${cli}-ambient-b`);
      const current = accounts(loadConfig(), cli)[0]!;
      expect(accountStatus(current).state).toBe("unknown"); const before = readFileSync(state, "utf8");
      expect(JSON.parse(before).accounts[`${cli}-default`].source).not.toBe(first);
      markAccountSuccess(old); await reportFailure(old, "quota", "old-source quota", loadConfig());
      expect(readFileSync(state, "utf8")).toBe(before); expect(() => accountEnv(old)).toThrow("source changed");
      expect(accountEnv(current)[variable]).toBe(join(fs.realpathSync(root), `${cli}-ambient-b`));
    } finally { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; }
  }
});

test("task-default restrictions never claim global account exhaustion while another enabled tool is usable", async () => {
  const notices: string[] = [], notice = spyOn(notifications, "notify").mockImplementation(async (text) => { notices.push(text); return []; });
  const outgoing = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new Error("unexpected account fixture network call"); }) as unknown as typeof fetch);
  try {
    mkdirSync(P("journal"), { recursive: true });
    writeFileSync(P("config.toml"), '[host]\nname="account-machine"\n[clis]\nenabled=["claude","codex"]\n');
    for (const preference of [[], ["claude"]]) {
      rmSync(state, { force: true }); notices.length = 0;
      writeFileSync(P("settings.json"), JSON.stringify({ clis: { preference, agents: { other: ["codex"] } } }));
      const cfg = loadConfig(), codex = accounts(cfg, "codex")[0]!;
      markAccountSuccess(codex); expect(allowedClis({ agent: "other" }, cfg)).toEqual(["codex"]); expect(allowedClis({ cli: "codex" }, cfg)).toEqual(["codex"]);
      expect(pickAccount(cfg, ["codex"])?.name).toBe(codex.name);
      await reportFailure(accounts(cfg, "claude")[0]!, "quota", "rate limit quota exceeded", cfg);
      expect(notices).toHaveLength(1); expect(notices[0]).toContain("eligible tasks can use codex");
      expect(notices[0]).not.toContain("No AI is available"); expect(notices[0]).not.toContain("fleet is paused");
      expect(JSON.parse(readFileSync(state, "utf8")).alerted?.all).toBeUndefined(); expect(accountStatus(codex).state).toBe("ok");
    }
    expect(outgoing).not.toHaveBeenCalled(); expect(existsSync(join(root, "started"))).toBe(false); expect(existsSync(join(root, "execution.json"))).toBe(false);
  } finally { notice.mockRestore(); outgoing.mockRestore(); }
});

test("canonical credential homes match child environments and remain stable when missing leaves are created", () => {
  const cwd = process.cwd(), previous = process.env.CODEX_HOME;
  try {
    process.chdir(root); writeFileSync(P("config.local.toml"), "[[accounts]]\ncli='claude'\nname='work'\ndir='new/credentials'\n");
    const selected = accounts(loadConfig(), "claude")[0]!, env = accountEnv(selected), home = join(fs.realpathSync(root), "new/credentials");
    expect(env.CLAUDE_CONFIG_DIR).toBe(home); markAccountSuccess(selected);
    expect(accountStatus(accounts(loadConfig(), "claude")[0]!).state).toBe("ok");
    const workspace = join(root, "other-project"); mkdirSync(workspace);
    const child = Bun.spawnSync([process.execPath, "-e", "process.stdout.write(process.env.CLAUDE_CONFIG_DIR ?? '')"], { cwd: workspace, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0); expect(child.stdout.toString()).toBe(home);
    process.env.CODEX_HOME = "ambient/credentials";
    const normal = accounts(loadConfig(), "codex")[0]!;
    expect(accountEnv(normal).CODEX_HOME).toBe(join(fs.realpathSync(root), "ambient/credentials"));
  } finally { process.chdir(cwd); if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
});

test("retargeting a credential symlink invalidates its cached token and rejects old run callbacks", async () => {
  const first = join(root, "source-a"), second = join(root, "source-b"), alias = join(root, "account-link"); mkdirSync(first); mkdirSync(second); fs.symlinkSync(first, alias);
  writeFileSync(P("config.local.toml"), `[[accounts]]\ncli='claude'\nname='default'\ndir=${JSON.stringify(alias)}\n`);
  const old = await signedIn(); expect(accountEnv(old).CLAUDE_CONFIG_DIR).toBe(fs.realpathSync(first));
  rmSync(alias); fs.symlinkSync(second, alias);
  const current = accounts(loadConfig(), "claude")[0]!; expect(accountEnv(current)).toMatchObject({ CLAUDE_CONFIG_DIR: fs.realpathSync(second), CLAUDE_CODE_OAUTH_TOKEN: "" });
  const before = readFileSync(state, "utf8"); markAccountSuccess(old); await reportFailure(old, "auth", "old alias", loadConfig());
  expect(readFileSync(state, "utf8")).toBe(before); expect(accountStatus(current).state).toBe("unknown"); expect(() => accountEnv(old)).toThrow("source changed");
});

test("a changed source cancels and fences its old pending sign-in challenge", async () => {
  const old = accounts(loadConfig(), "claude")[0]!; expect((await request("POST", "/claude/default/login", {})).status).toBe(200);
  await until(() => !!loginInfo(old)?.url); const id = loginInfo(old)!.id;
  const folder = join(root, "replacement-login"); mkdirSync(folder); writeFileSync(P("config.local.toml"), `[[accounts]]\ncli='claude'\nname='default'\ndir=${JSON.stringify(folder)}\n`);
  const current = accounts(loadConfig(), "claude")[0]!; expect(accountStatus(current).state).toBe("unknown");
  expect((await request("POST", "/claude/default/code", { id, code: "must-not-reach-old-login" })).status).toBe(409);
  await until(() => !hasPendingLogin(old)); expect(loginInfo(current)).toBeUndefined();
  expect(accountEnv(current).CLAUDE_CODE_OAUTH_TOKEN).toBe(""); expect(accountStatus(current).state).toBe("unknown");
});

test("dangling or inaccessible credential homes fail before cached authentication changes", () => {
  const alias = join(root, "dangling"); fs.symlinkSync(join(root, "missing-target"), alias);
  writeFileSync(P("config.local.toml"), `[[accounts]]\ncli='claude'\nname='work'\ndir=${JSON.stringify(alias)}\n`);
  const broken = accounts(loadConfig(), "claude")[0]!;
  expect(usable(broken)).toBe(false); expect(accountStatus(broken).state).toBe("unknown");
  expect(() => accountEnv(broken)).toThrow("source changed"); expect(existsSync(state)).toBe(false);
  rmSync(alias); mkdirSync(alias); const realpath = fs.realpathSync;
  const denied = spyOn(fs, "realpathSync").mockImplementation(((value: any, ...options: any[]) => {
    if (resolve(String(value)) === resolve(alias)) throw Object.assign(new Error("fixture permission denied"), { code: "EACCES" });
    return (realpath as any)(value, ...options);
  }) as typeof fs.realpathSync);
  try { expect(usable(accounts(loadConfig(), "claude")[0]!)).toBe(false); expect(existsSync(state)).toBe(false); }
  finally { denied.mockRestore(); rmSync(P("config.local.toml")); }
});

test("invalid credential homes remain removable and never poison other selected accounts", async () => {
  const good = join(root, "good-home"), bad = join(root, "bad-home"); mkdirSync(good); fs.symlinkSync(join(root, "missing-home"), bad);
  writeFileSync(P("config.local.toml"), `[[accounts]]\ncli='claude'\nname='good'\ndir=${JSON.stringify(good)}\n[[accounts]]\ncli='claude'\nname='bad'\ndir=${JSON.stringify(bad)}\n`);
  setAccountNames("claude", ["good"]);
  expect((await request()).status).toBe(200); expect(accountEnv(accounts(loadConfig(), "claude")[0]!).CLAUDE_CONFIG_DIR).toBe(fs.realpathSync(good));
  setAccountNames("claude", ["good", "bad"]);
  const response = await request(); expect(response.status).toBe(200);
  expect(response.data.accounts.find((a: any) => a.cli === "claude" && a.name === "bad").state).toBe("unknown");
  const login = await request("POST", "/claude/bad/login", {}); expect(login.status).toBe(409); expect(login.data.error).toContain("unavailable"); expect(JSON.stringify(login.data)).not.toContain(bad);
  expect((await request("PUT", "", { cli: "claude", names: ["bad", "good"] })).status).toBe(200);
  expect(pickAccount(loadConfig(), ["claude"])?.name).toBe("good");
  await retryLogins(loadConfig());
  expect((await request("DELETE", "/claude/bad")).status).toBe(200);
  expect(accounts(loadConfig(), "claude").map((a) => a.name)).toEqual(["good"]);
  expect(existsSync(join(root, "started"))).toBe(false);
});

test("Claude UI sign-in exposes a safe pending challenge and binds authorization to this account", async () => {
  const first = await request("POST", "/claude/default/login", {});
  expect(first.status).toBe(200);
  let login = first.data.accounts.find((account: any) => account.cli === "claude").login;
  await until(async () => { login = (await request()).data.accounts.find((account: any) => account.cli === "claude").login; return !!login.url; });
  expect(login.id).toMatch(/^L-\d+/); expect(login.url).toContain("https://claude.ai/");
  expect(login).toMatchObject({ needs_code: true, status: "waiting" });
  expect((await request("POST", "/claude/default/login", {})).data.accounts.find((account: any) => account.cli === "claude").login.id).toBe(login.id);
  await request("POST", "", { cli: "claude", name: "other" });
  expect((await request("POST", "/claude/other/code", { id: login.id, code: "authorization-fixture" })).status).toBe(409);
  expect((await request("POST", "/claude/default/code", { id: login.id, code: "bad\ncode" })).status).toBe(400);
  expect((await request("POST", "/claude/default/code", { id: login.id, code: "authorization-fixture" })).status).toBe(200);
  let completed: any;
  await until(async () => { completed = (await request()).data.accounts.find((account: any) => account.cli === "claude" && account.name === "default"); return completed.login?.status === "complete"; });
  expect(completed.state).toBe("ok"); expect(completed.login.url).toBeUndefined();
  expect(readFileSync(state, "utf8")).toContain("sk-ant-oat01-fixture-secret-token");
  expect(JSON.stringify(completed)).not.toContain("fixture-secret-token"); expect(statSync(state).mode & 0o777).toBe(0o600);
});

test("pending sign-ins must be cancelled before removal and codes cannot reach cancelled sessions", async () => {
  const first = await request("POST", "/claude/default/login", {});
  const login = first.data.accounts.find((account: any) => account.cli === "claude").login;
  expect((await request("DELETE", "/claude/default")).status).toBe(409);
  expect((await request("POST", "/claude/default/cancel", { id: "L-9999" })).status).toBe(409);
  expect((await request("POST", "/claude/default/cancel", { id: login.id })).status).toBe(200);
  expect((await request("POST", "/claude/default/code", { id: login.id, code: "fixture" })).status).toBe(409);
  await until(() => !hasPendingLogin(accounts(loadConfig(), "claude")[0]!));
  expect((await request("DELETE", "/claude/default")).status).toBe(200);
});

test("Codex device sign-in needs no pasted code and disabled execution tools can still be configured", async () => {
  expect((await request("POST", "/hermes/default/login", {})).status).toBe(409);
  writeFileSync(P("settings.json"), JSON.stringify({ configuration: { clis: { enabled: ["codex"] } } }));
  expect((await request("POST", "/claude/default/login", {})).status).toBe(200);
  const first = await request("POST", "/codex/default/login", {}); expect(first.status).toBe(200);
  let login: any;
  await until(async () => { login = (await request()).data.accounts.find((account: any) => account.cli === "codex").login; return !!login.user_code; });
  expect(login).toMatchObject({ needs_code: false, user_code: "ABCD-EFGH", url: "https://auth.openai.com/codex/device" });
  expect((await request("POST", "/codex/default/code", { id: login.id, code: "irrelevant" })).status).toBe(409);
  writeFileSync(join(root, "approved"), "approved");
  await until(async () => (await request()).data.accounts.find((account: any) => account.cli === "codex").login?.status === "complete");
});

test("routing, judge and medic respect the selected account pool and use named-account credentials", async () => {
  setAccountNames("claude", ["work"]);
  const cfg = { clis: { enabled: ["claude"] } }, account = accounts(cfg, "claude")[0]!;
  expect((await quickAsk("route", cfg, join(root, "route.log"))).reply).toBe("fixture");
  expect(JSON.parse(readFileSync(join(root, "execution.json"), "utf8"))).toMatchObject({ claude: fs.realpathSync(account.dir), token: "" });
  // decisions.test mocks ask globally; a fresh process verifies its real account environment.
  const judge = async () => {
    const code = `import { ask } from ${JSON.stringify(join(CODE, "src/runner.ts"))}; console.log(JSON.stringify(await ask("judge", ${JSON.stringify(cfg)}, ${JSON.stringify(join(root, "judge.log"))})));`;
    const child = Bun.spawn([process.execPath, "-e", code], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const text = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    return JSON.parse(text);
  };
  expect((await judge()).reply).toBe("fixture");
  expect(JSON.parse(readFileSync(join(root, "execution.json"), "utf8")).claude).toBe(fs.realpathSync(account.dir));
  setAccountNames("claude", []);
  expect(await quickAsk("paused", cfg, join(root, "paused.log"))).toBeNull();
  expect(await judge()).toBeNull();
  expect(await medic("paused", cfg)).toBeNull(); expect(existsSync(join(HOME_DIR, "medic.json"))).toBe(false);
});

test("first sign-ins on independent machines have unpredictable IDs and reject another machine's ID", async () => {
  const launch = async (host: string, foreign?: string) => {
    const home = join(root, host), data = join(home, "data"); mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.toml"), `[host]\nname = "${host}"\n`);
    const code = `
      import { accountRequest } from ${JSON.stringify(join(CODE, "src/account-ui.ts"))};
      import { accounts, hasPendingLogin } from ${JSON.stringify(join(CODE, "src/accounts.ts"))};
      import { loadConfig } from ${JSON.stringify(join(CODE, "src/core.ts"))};
      const base = ${JSON.stringify(`http://hub/api/machines/${host}/accounts/claude/default`)};
      const call = async (action, body) => accountRequest(new Request(base+action, {method:'POST',body:JSON.stringify(body)}));
      const first = await (await call('/login',{})).json(); const id = first.accounts.find(a=>a.cli==='claude').login.id;
      const wrong = ${JSON.stringify(foreign ?? null)};
      const cross = wrong ? (await call('/code',{id:wrong,code:'fixture-code'})).status : null;
      await call('/cancel',{id});
      while (hasPendingLogin(accounts(loadConfig(),'claude')[0])) await Bun.sleep(10);
      console.log(JSON.stringify({id,cross}));
    `;
    const child = Bun.spawn([process.execPath, "-e", code], { env: { ...process.env, NOOP_HOME: home, HUB_DATA: data }, stdout: "pipe", stderr: "pipe" });
    const text = await new Response(child.stdout).text(); expect(await child.exited).toBe(0);
    return JSON.parse(text);
  };
  const first = await launch("first-machine"), second = await launch("second-machine", first.id);
  expect(first.id).toMatch(/^L-\d{39}$/); expect(second.id).toMatch(/^L-\d{39}$/);
  expect(second.id).not.toBe(first.id); expect(second.cross).toBe(409);
});

test("long numeric and legacy login IDs remain accepted in chat and notification replies", async () => {
  const long = "L-123456789012345678901234567890123456789";
  for (const id of [long, "L-0001", "D-0001", "D-M0001", "P-0001"]) {
    expect(ITEM_ID.test(id)).toBe(true);
    expect(answeredIds([{ id: "fixture", ts: "", from: "owner", kind: "owner", text: `${id} fixture` }]).has(id)).toBe(true);
    drainInbound();
    await handleOwnerMessage(`${id} fixture`);
    expect(drainInbound()).toEqual([{ id, answer: "fixture", source: "chat" }]);
  }
  await handleOwnerMessage("fixture", long);
  expect(drainInbound()).toEqual([{ id: long, answer: "fixture", source: "chat" }]);
  // Other suites replace notify's exports; exercise the real notification parser in isolation.
  const code = `
    import { pollReplies } from ${JSON.stringify(join(CODE, "src/notify.ts"))};
    const id=${JSON.stringify(long)};
    globalThis.fetch=async()=>Response.json({messages:[{text:id+' fixture',ts:String(Date.now()/1000)}]});
    console.log(JSON.stringify(await pollReplies({notify:{slack_bot_token:'fixture',slack_channel:'fixture'}},new Set([id]))));
  `;
  const child = Bun.spawn([process.execPath, "-e", code], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const text = await new Response(child.stdout).text(); expect(await child.exited).toBe(0);
  expect(JSON.parse(text)).toEqual([{ id: long, answer: "fixture", source: "slack" }]);
});

test("account order controls selection without creating or removing accounts or changing other tools", async () => {
  await request("POST", "", { cli: "claude", name: "work" });
  await request("POST", "", { cli: "codex", name: "other" });
  const codex = accounts(loadConfig(), "codex");
  const response = await request("PUT", "", { cli: "claude", names: ["work", "default"] });
  expect(response.status).toBe(200);
  expect(response.data.accounts.filter((account: any) => account.cli === "claude").map((account: any) => account.name)).toEqual(["work", "default"]);
  expect(pickAccount(loadConfig(), ["claude"])?.name).toBe("work");
  expect(accounts(loadConfig(), "codex")).toEqual(codex);
});

test("reset follows current file account defaults and custom directories while preserving credentials and other tools", async () => {
  const custom = join(root, "file-profile"); mkdirSync(custom); writeFileSync(join(custom, "auth.json"), "private-fixture");
  const original = readFileSync(P("config.toml"), "utf8");
  writeFileSync(P("config.toml"), original + `\n[[accounts]]\ncli = "codex"\nname = "file-first"\ndir = ${JSON.stringify(custom)}\n`);
  await request("POST", "", { cli: "codex", name: "ui-only" });
  await request("POST", "", { cli: "claude", name: "unrelated" });
  const other = accounts(loadConfig(), "claude");
  writeFileSync(P("config.toml"), readFileSync(P("config.toml"), "utf8") + '\n[[accounts]]\ncli = "codex"\nname = "file-later"\n');
  expect(accounts(loadConfig(), "codex").map((account) => account.name)).toEqual(["file-first", "ui-only"]);
  const result = await request("PUT", "", { cli: "codex", names: null });
  expect(result.status).toBe(200);
  expect(accounts(loadConfig(), "codex").map((account) => account.name)).toEqual(["file-first", "file-later"]);
  expect(accounts(loadConfig(), "codex")[0]?.dir).toBe(custom);
  expect(readFileSync(join(custom, "auth.json"), "utf8")).toBe("private-fixture");
  expect(accounts(loadConfig(), "claude")).toEqual(other);
  expect(Object.hasOwn(JSON.parse(readFileSync(metadata, "utf8")), "codex")).toBe(false);
  await request("DELETE", "/claude/default"); await request("DELETE", "/claude/unrelated");
  expect(accounts(loadConfig(), "claude")).toEqual([]);
  expect((await request("PUT", "", { cli: "claude", names: null })).status).toBe(200);
  expect(accounts(loadConfig(), "claude")).toEqual([{ cli: "claude", name: "default", dir: "", default: true }]);
});

test("reset cannot drop a pending sign-in but reordering preserves it", async () => {
  await request("POST", "", { cli: "claude", name: "work" });
  const started = await request("POST", "/claude/work/login", {});
  const id = started.data.accounts.find((account: any) => account.cli === "claude" && account.name === "work").login.id;
  const before = readFileSync(metadata, "utf8");
  expect((await request("PUT", "", { cli: "claude", names: null })).status).toBe(409);
  expect(readFileSync(metadata, "utf8")).toBe(before);
  const reordered = await request("PUT", "", { cli: "claude", names: ["work", "default"] });
  expect(reordered.status).toBe(200); expect(reordered.data.accounts[0].login.id).toBe(id);
  await request("POST", "/claude/work/cancel", { id });
  await until(() => !hasPendingLogin(accounts(loadConfig(), "claude")[0]!));
  expect((await request("PUT", "", { cli: "claude", names: null })).status).toBe(200);
});

test("malformed or stale account orders never change local selections", async () => {
  await request("POST", "", { cli: "claude", name: "work" });
  const before = readFileSync(metadata, "utf8");
  for (const body of [null, [], {}, { cli: "unknown", names: null }, { cli: "claude", names: "work" }, { cli: "claude", names: ["work", "work"] }, { cli: "claude", names: ["bad\nname"] }, { cli: "claude", names: Array.from({ length: 101 }, (_, n) => `n${n}`) }, { cli: "claude", names: null, dir: root }]) {
    expect((await request("PUT", "", body)).status).toBe(400);
    expect(readFileSync(metadata, "utf8")).toBe(before);
  }
  for (const names of [[], ["work"], ["default", "other"], ["default", "work", "other"], ["../work"]]) {
    expect((await request("PUT", "", { cli: "claude", names })).status).toBe(409);
    expect(readFileSync(metadata, "utf8")).toBe(before);
  }
  expect((await request("PUT", "", { cli: "claude", names: null }, "other-machine")).status).toBe(403);
  expect(readFileSync(metadata, "utf8")).toBe(before);
});

test("legacy account names remain manageable and preserve configured credentials without becoming filesystem paths", async () => {
  const names = ["Work", "Work account", "研究", "team/primary", "%2F", ".", "..", "~Special"];
  const base = readFileSync(P("config.toml"), "utf8"), custom = join(root, "legacy-custom-home");
  mkdirSync(custom); writeFileSync(join(custom, "auth.json"), "private-legacy-fixture");
  const config = base + names.map((name, index) => `\n[[accounts]]\ncli = "claude"\nname = ${JSON.stringify(name)}\n${index === 0 ? `dir = ${JSON.stringify(custom)}\n` : ""}`).join("");
  writeFileSync(P("config.toml"), config);
  const oldImplicit = join(local, "claude-Work account"); mkdirSync(oldImplicit, { recursive: true }); writeFileSync(join(oldImplicit, ".credentials.json"), "private-implicit-fixture");
  const view = await request(); expect(view.status).toBe(200);
  expect(view.data.accounts.filter((account: any) => account.cli === "claude").map((account: any) => account.name)).toEqual(names);
  expect(JSON.stringify(view.data)).not.toContain("private-legacy-fixture"); expect(JSON.stringify(view.data)).not.toContain(custom);
  expect(accounts(loadConfig(), "claude").find((account) => account.name === "Work account")?.dir).toBe(oldImplicit);
  for (const name of names) {
    const encoded = encodeAccountSegment(name), started = await request("POST", `/claude/${encoded}/login`, {});
    expect(started.status).toBe(200);
    const id = started.data.accounts.find((account: any) => account.cli === "claude" && account.name === name).login.id;
    if (name === "研究") expect((await request("POST", `/claude/${encoded}/code`, { id, code: "legacy-fixture" })).status).toBe(200);
    else expect((await request("POST", `/claude/${encoded}/cancel`, { id })).status).toBe(200);
    await until(() => !hasPendingLogin(accounts(loadConfig(), "claude").find((account) => account.name === name)!));
  }
  const reversed = [...names].reverse();
  expect((await request("PUT", "", { cli: "claude", names: reversed })).status).toBe(200);
  expect(pickAccount(loadConfig(), ["claude"])?.name).toBe(reversed[0]);
  for (const name of names) expect((await request("DELETE", `/claude/${encodeAccountSegment(name)}`)).status).toBe(200);
  expect(accounts(loadConfig(), "claude")).toEqual([]);
  expect((await request("PUT", "", { cli: "claude", names: null })).status).toBe(200);
  expect(accounts(loadConfig(), "claude").map((account) => account.name)).toEqual(names);
  expect(accounts(loadConfig(), "claude")[0]?.dir).toBe(custom);
  expect(readFileSync(join(custom, "auth.json"), "utf8")).toBe("private-legacy-fixture");
  expect(readFileSync(join(oldImplicit, ".credentials.json"), "utf8")).toBe("private-implicit-fixture");
  for (const name of names) expect((await request("POST", "", { cli: "claude", name })).status).toBe(400);
  expect((await request("POST", "/claude/%2F/login", {})).status).toBe(404); // %2F is a literal stored name, not a slash.
  expect((await request("POST", "/claude/team/primary/login", {})).status).toBe(404);
  expect((await request("DELETE", `/claude/${encodeAccountSegment("../escape")}`)).status).toBe(404);
  await request("PUT", "", { cli: "claude", names });
  writeFileSync(P("config.toml"), base); // Retained selections with no file match get safe managed homes.
  for (const account of accounts(loadConfig(), "claude")) expect(account.dir).toMatch(new RegExp(`^${local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/claude-legacy-[0-9a-f]{64}$`));
});


test("configured implicit nested credential homes stay in place while escapes use managed hashes", () => {
  const name = "Personal/Office", home = join(local, "claude-Personal", "Office");
  mkdirSync(home, { recursive: true }); writeFileSync(join(home, ".credentials.json"), "private-nested-fixture");
  const cfg = { accounts: [{ cli: "claude", name }, { cli: "claude", name: "../../../../escape" }] };
  const selected = accounts(cfg, "claude");
  expect(selected[0]?.dir).toBe(home);
  expect(readFileSync(join(selected[0]!.dir, ".credentials.json"), "utf8")).toBe("private-nested-fixture");
  expect(selected[1]?.dir.startsWith(join(local, "claude-legacy-"))).toBe(true);
  expect(selected[1]?.dir).not.toContain("escape");
  setAccountNames("claude", [name]);
  expect(accounts({}, "claude")[0]?.dir.startsWith(join(local, "claude-legacy-"))).toBe(true);
  expect(readFileSync(join(home, ".credentials.json"), "utf8")).toBe("private-nested-fixture");
});
