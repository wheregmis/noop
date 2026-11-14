import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { writeMacAgent } from "../src/setup";

test("fresh macOS service directories and XML-safe paths", () => {
  const root = mkdtempSync(join(tmpdir(), "noop-mac-service-"));
  try {
    const home = join(root, "Mac & Work <test>");
    const data = join(home, "data");
    const bun = join(home, "bin/bun");
    const cli = join(home, "app/src/cli.ts");
    const plist = writeMacAgent(home, data, bun, cli, "/usr/bin:/bin", "dev.noop.daemon");
    expect(existsSync(join(data, "logs"))).toBe(true);
    expect(readFileSync(plist, "utf8")).toContain("Mac &amp; Work &lt;test&gt;");
    if (process.platform === "darwin") {
      const result = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", plist]);
      expect(result.exitCode).toBe(0);
      const service = JSON.parse(result.stdout.toString());
      expect(service.ProgramArguments).toEqual(["/usr/bin/caffeinate", "-i", bun, cli, "daemon"]);
      expect(service.EnvironmentVariables.HUB_DATA).toBe(data);
      expect(service.RunAtLoad).toBe(true);
      expect(service.KeepAlive).toBe(true);
      expect(service.StandardErrorPath).toBe(join(data, "logs/daemon.log"));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("primary initialization works on the current OS and survives reinitialization", () => {
  const root = mkdtempSync(join(tmpdir(), "noop-primary-"));
  try {
    const data = join(root, "data");
    const env = { ...process.env, NOOP_HOME: root, HUB_DATA: data, HUB_SYNC: "local", HUB_SYNC_FAKE: "" };
    for (const args of [["--primary"], []]) {
      const result = Bun.spawnSync([process.execPath, "src/cli.ts", "init", ...args], { env });
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(data, "config.toml"), "utf8")).toContain(`primary = "${hostname().split(".")[0]}"`);
      expect(existsSync(join(data, "tasks/inbox"))).toBe(true);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
