// What the app's badge and the tray count: the hub's open cards, not the ask events in the feed. No UI, no I/O,
// so the repository's bun tests can run it (hub.ts reaches the client's signals through i18n).

/** A card as /api/status reports it (the shape of Status.decisions). */
type Card = { id: string; kind: string; held: boolean };

/** A card that waits for the owner: a held decision, or a proposals list (unheld until its notice goes out). */
export const isWaiting = (d: Card) => d.held || d.kind === "proposals";

/**
 * A card answered without naming its id leaves the hub's open list at once but keeps its ask event, and answeredIds
 * cannot see it answered: the chat brain's answer_decision posts a notice ("收到 D-0004：…"), not an owner message.
 * Counting the feed's asks therefore kept the badge on "1" for a card closed days before, until its event aged out of
 * the feed (D-0004). The hub's open list — the sidebar's list — is the one that knows.
 * `asks` is the feed's pending count: all there is to go by before the dashboard arrives.
 */
export function badgeCount(status: { decisions: Card[] } | null, answered: Set<string>, asks: number): number {
  if (!status) return asks;
  return status.decisions.filter((d) => isWaiting(d) && !answered.has(d.id)).length;
}
