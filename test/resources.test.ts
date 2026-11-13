import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskAlertDue, staleDerivedData } from "../src/resources";

const plist = (date: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>LastAccessedDate</key><date>${date}</date>
<key>WorkspacePath</key><string>/x/App.xcworkspace</string></dict></plist>`;

test.skipIf(process.platform !== "darwin")("staleDerivedData picks idle and orphaned project folders only", async () => {
  const root = mkdtempSync(join(tmpdir(), "dd-"));
  const now = Date.parse("2026-11-06T00:00:00Z");
  const mk = (name: string, date?: string) => {
    mkdirSync(join(root, name));
    if (date) writeFileSync(join(root, name, "info.plist"), plist(date));
  };
  mk("App-active", "2026-11-05T00:00:00Z");
  mk("App-idle", "2026-10-20T00:00:00Z");
  mk("App-orphan");
  utimesSync(join(root, "App-orphan"), new Date(now - 3 * 86400e3), new Date(now - 3 * 86400e3));
  for (const shared of ["ModuleCache.noindex", "SDKExplicitPrecompiledModules", "Files-abc"]) mk(shared);
  try {
    const got = (await staleDerivedData(root, 7, now)).map((p) => p.slice(root.length + 1)).sort();
    expect(got).toEqual(["App-idle", "App-orphan"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("diskAlertDue alerts once, then only after 6h or another 5GB drop", () => {
  const at = 1_800_000_000_000;
  expect(diskAlertDue({ at: 0, freeGB: Infinity }, at, 51)).toBe(true); // never alerted
  expect(diskAlertDue({ at, freeGB: 51 }, at + 30 * 60_000, 51)).toBe(false); // the 30-min re-alert loop
  expect(diskAlertDue({ at, freeGB: 51 }, at + 5.9 * 3600_000, 50)).toBe(false);
  expect(diskAlertDue({ at, freeGB: 51 }, at + 30 * 60_000, 46)).toBe(true); // worse by 5GB
  expect(diskAlertDue({ at, freeGB: 51 }, at + 6 * 3600_000, 51)).toBe(true); // reminder after 6h
});
