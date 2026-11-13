import { expect, test } from "bun:test";
import { badgeCount } from "../app/badge";

const status = (decisions: { id: string; kind: string; held: boolean }[]) => ({ decisions });

test("the badge counts the hub's open cards, not the ask events still in the feed", () => {
  // D-0004 answered from the chat: the hub closed it, but its ask event stays in the feed and no owner message names it
  expect(badgeCount(status([]), new Set(), 1)).toBe(0);
});

test("a card answered in this app leaves the badge before the hub's status catches up", () => {
  const open = status([{ id: "D-0001", kind: "decision", held: true }]);
  expect(badgeCount(open, new Set(), 1)).toBe(1);
  expect(badgeCount(open, new Set(["D-0001"]), 0)).toBe(0);
});

test("proposals count even while unheld; decisions only once held", () => {
  const s = status([
    { id: "P-0002", kind: "proposals", held: false },
    { id: "D-0003", kind: "decision", held: false },
    { id: "D-0004", kind: "menu", held: true },
  ]);
  expect(badgeCount(s, new Set(), 0)).toBe(2);
});

test("before the dashboard arrives the feed's asks are all there is", () => {
  expect(badgeCount(null, new Set(), 2)).toBe(2);
});
