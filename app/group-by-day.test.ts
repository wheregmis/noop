import { expect, test } from "nsh/test";
import { groupByDay } from "./hub";

const at = (d: string) => ({ d: `${d}T12:00:00` });
const shape = (items: { d: string }[]) => groupByDay(items, (t) => t.d).map((g) => [g.newest, g.oldest, g.items.length]);

test("days with 3 or more tasks stay on their own", () => {
  const l = [...Array(3)].map(() => at("2026-11-10")).concat([...Array(4)].map(() => at("2026-11-09")));
  expect(shape(l)).toEqual([["2026-11-10", "2026-11-10", 3], ["2026-11-09", "2026-11-09", 4]]);
});

test("a small day joins the nearer neighbour", () => {
  const l = [...Array(3)].map(() => at("2026-11-10")).concat([at("2026-11-04")], [...Array(3)].map(() => at("2026-11-03")));
  expect(shape(l)).toEqual([["2026-11-10", "2026-11-10", 3], ["2026-11-04", "2026-11-03", 4]]);
});

test("runs of small days merge until each group has 3", () => {
  const l = [at("2026-11-10"), at("2026-11-09"), at("2026-11-08"), at("2026-11-07")];
  expect(shape(l)).toEqual([["2026-11-10", "2026-11-07", 4]]);
});

test("fewer than 3 tasks in all is one group", () => {
  expect(shape([at("2026-11-10"), at("2026-11-01")])).toEqual([["2026-11-10", "2026-11-01", 2]]);
});
