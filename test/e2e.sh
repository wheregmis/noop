#!/usr/bin/env bash
# End-to-end: sandbox data mirror synced to an offline fake of the Worker files API
# (HUB_SYNC_FAKE = the real cloud/src/files.ts over a local SQLite file), fake agent CLIs, run ticks.
set -euo pipefail
if [ "${NOOP_E2E_CLEAN:-}" != 1 ]; then
  exec env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin NOOP_E2E_CLEAN=1 NOOP_E2E_BUN="$(command -v bun)" /bin/bash "$0"
fi
SRC=$(cd "$(dirname "$0")/.." && pwd)
W=$(mktemp -d /tmp/noop-e2e.XXXXXX); trap 'rm -rf "$W"' EXIT
mkdir -p "$W/home" "$W/tmp" "$W/bin"
ln -s "${NOOP_E2E_BUN:?}" "$W/bin/bun"
export PATH="$W/bin:/usr/bin:/bin:/usr/sbin:/sbin" NOOP_HOME="$W/home" TMPDIR="$W/tmp"
export HUB_DATA="$W/data" HUB_HOST=pc HUB_SYNC_FAKE="$W/worker.sqlite" HUB_NO_MEDIC=1
cd "$SRC"; hub() { bun "$SRC/src/cli.ts" "$@"; }
hub init --primary >/dev/null
cd "$W/data"
cat > "$W/fake-agent" <<'F'
#!/usr/bin/env bash
if [ "${1:-}" = --version ]; then echo noop-fixture-1; exit; fi
p=$(cat)
if grep -q "You are the owner.s JUDGE" <<<"$p"; then echo '```json
{"verdict":"hold","reason":"new taste call"}
```'; exit; fi
if grep -q "You place tasks for an AI agent fleet" <<<"$p"; then
  echo '```json'; grep -oE '^- T-[0-9]+' <<<"$p" | sed 's/^- //' | awk 'BEGIN{printf "{"} {printf "%s\"%s\": {\"requires\": \"\", \"cli\": \"claude\", \"difficulty\": \"normal\"}", (NR>1?",":""), $0} END{print "}"}'; echo '```'; exit
fi
if grep -q "Decision D-" <<<"$p"; then echo '```json
{"status":"done","summary":"followed owner decision"}
```'
elif grep -q "Draft the steps of this plan" <<<"$p"; then echo '```json
{"status":"done","summary":"three steps","followups":[{"title":"PLANSTEP one","body":"first","agent":"lead"},{"title":"PLANSTEP two","agent":"reviewer"},{"title":"PLANSTEP three","agent":"lead"}]}
```'
elif grep -q "^# Task T-[0-9]*: PLANSTEP" <<<"$p"; then
  n=$(grep -m1 -oE "^# Task T-[0-9]*: PLANSTEP [a-z]+" <<<"$p" | awk '{print $NF}'); printf '%s' "$p" > "$(dirname "$0")/prompt-$n.txt"
  if [ "$n" = two ] && [ ! -e "$(dirname "$0")/two-failed" ]; then touch "$(dirname "$0")/two-failed"; echo '```json
{"status":"failed","summary":"step two broke"}
```'; else echo '```json
{"status":"done","summary":"finished '"$n"'"}
```'; fi
elif grep -q "^# Task T-[0-9]*: SPLIT" <<<"$p" && ! grep -q "Results from delegated subtasks" <<<"$p"; then echo '```json
{"status":"delegated","summary":"split in two","followups":[{"title":"part one","agent":"reviewer"},{"title":"part two","agent":"maintainer"}]}
```'
elif grep -q "^# Task T-[0-9]*: part" <<<"$p"; then echo '```json
{"status":"done","summary":"part finished"}
```'
elif grep -q "^# Task T-[0-9]*: ASKME" <<<"$p"; then echo '```json
{"status":"needs_decision","summary":"prepared","question":"Ship it?","options":["A: yes","B: no"],"recommendation":"A","lessons":["owner likes options"]}
```'
else echo '```json
{"status":"done","summary":"did it","followups":[{"title":"child task","agent":"reviewer"}]}
```'; fi
F
chmod +x "$W/fake-agent"
cat > config.local.toml <<F
[fleet]
primary = "pc"
[clis.claude]
command = ["$W/fake-agent"]
[judge]
cli = "claude"
[autonomy]
batch_minutes = 0
[clis]
enabled = ["claude"]
preference = ["claude"]
[idle]
enabled = false
[resources]
cleanup_enabled = false
[[accounts]]
cli = "claude"
name = "fixture"
dir = "$W/provider-home"
F
# judge uses 'claude' binary directly → shim PATH
ln -s "$W/fake-agent" "$W/bin/claude"
cat > "$W/bin/gh" <<'F'
#!/bin/sh
if [ "$*" != 'api rate_limit' ]; then echo 'unexpected fixture gh call' >&2; exit 1; fi
printf '%s\n' '{"resources":{"core":{"remaining":5000,"reset":4102444800},"graphql":{"remaining":5000,"reset":4102444800}}}'
F
chmod +x "$W/bin/gh"
hub role add maintainer >/dev/null
hub role add release-manager >/dev/null
sed -i.bak 's/^\[\[routine\]\]/[[routine_disabled]]/' config.toml && rm config.toml.bak
hub add "plain task" -a maintainer >/dev/null
hub add "ASKME task" -a release-manager >/dev/null
hub add "windows only" -r os:windows >/dev/null
# how many tasks one tick runs depends on the host load (a busy macOS runner runs one), so tick until a condition holds
tick_until() { for _ in 1 2 3 4 5 6 7 8; do hub tick >/dev/null; eval "$1" && return; done; }
tick_until "test -f tasks/done/T-0001.md && grep -qs held: decisions/open/D-0001.md"
hub status
test -f tasks/done/T-0001.md || { echo "FAIL: T-0001 should be done"; exit 1; }
test -f tasks/blocked/T-0002.md && test -f decisions/open/D-0001.md
grep -q held: decisions/open/D-0001.md
ls tasks/*/T-0004.md >/dev/null  # follow-up created
grep -q parked tasks/inbox/T-0003.md
hub decide D-0001 "A"
tick_until "test -f tasks/done/T-0002.md"
test -f tasks/done/T-0002.md && test -f decisions/closed/D-0001.md
grep -q "owner likes options" agents/release-manager/memory.md
test "$(bun -e "import {Database} from 'bun:sqlite'; console.log(new Database('$W/worker.sqlite').query('SELECT COUNT(DISTINCT ts) AS n FROM history').get().n)")" -gt 5
# onboarding: self-generated (routine) work waits for approval; owner-derived follow-ups do not
ls tasks/done/T-0004.md >/dev/null   # follow-up of an owner task ran without approval
RT=$(bun -e "import {newTask,setApprovalGate} from '$SRC/src/core.ts'; import {needsApproval} from '$SRC/src/autonomy.ts'; import {loadConfig} from '$SRC/src/core.ts'; setApprovalGate((s,a)=>needsApproval(loadConfig(),s,a)); console.log(newTask('routine job','x',{source:'routine:pr-review'}))")
test -f tasks/proposed/$RT.md
hub tick >/dev/null
P=$(ls decisions/open | grep '^P-' | head -1 | sed 's/.md//'); test -n "$P"
hub decide "$P" all
test -f tasks/inbox/$RT.md
tick_until "test -f tasks/done/$RT.md"
test -f tasks/done/$RT.md
# owner request → delegate → children run without approval → parent consolidates
SPL=$(hub add "SPLIT big job" | tail -1)
tick_until "grep -qs 'Results from delegated subtasks' tasks/done/$SPL.md"
grep -q "Results from delegated subtasks" tasks/done/$SPL.md
! grep -l "parent: $SPL" tasks/proposed/*.md 2>/dev/null
# a project's work stays in its folder: follow-ups inherit the project, and the agent is told about it
mkdir -p "$W/site"
printf -- '---\nname: Site\npath: %s\nhost: pc\n---\nSITE-RULE: test first.\n' "$W/site" > projects-site.tmp; mkdir -p projects; mv projects-site.tmp projects/site.md
PJ=$(hub add "SPLIT project job" --project site)
tick_until "test -f tasks/done/$PJ.md"
test -f "tasks/done/$PJ.md"
grep -q "^project: site" "tasks/done/$PJ.md" && grep -q "^repo: $W/site" "tasks/done/$PJ.md"
KIDS=$(grep -l "^parent: $PJ\|source: followup:$PJ" tasks/done/*.md)
test "$(echo "$KIDS" | wc -l | tr -d ' ')" = 2
for k in $KIDS; do grep -q "^project: site" "$k" && grep -q "^repo: $W/site" "$k" && grep -q "^host: pc" "$k"; done
# a plan: drafted, approved, one step at a time with each seeing the last. Every tick is a fresh process, so it survives restarts
PL=$(hub plan new "E2E plan goal" --project site | cut -d' ' -f1)
pstat() { hub plan show "$PL" | bun -e 'const p=JSON.parse(await Bun.stdin.text()); console.log(p.status, p.steps.map((s)=>s.status).join(","))'; }
tick_until 'pstat | grep -q "^review"'
test "$(pstat)" = "review pending,pending,pending"
hub plan approve "$PL" >/dev/null
tick_until 'test -f "$W/prompt-one.txt" && pstat | grep -q "done,"'
tick_until 'pstat | grep -q "^done"'
test "$(pstat)" = "done done,done,done"
grep -q "\[YOUR STEP\] PLANSTEP one" "$W/prompt-one.txt"
grep -q "\[done\] PLANSTEP one" "$W/prompt-three.txt" && grep -q "Result: finished one" "$W/prompt-three.txt" && grep -q "Result: finished two" "$W/prompt-three.txt"
grep -q "agent/plan-$PL" "$W/prompt-three.txt" && grep -q "SITE-RULE" "$W/prompt-three.txt"
test -f "$W/two-failed"   # step two failed once, the engine retried it, and the plan waited instead of stopping
test "$(grep -l "^plan: $PL" tasks/done/*.md | wc -l | tr -d ' ')" = 3
! grep -l "^plan: $PL" tasks/inbox/*.md tasks/active/*.md 2>/dev/null
test "$(ls tasks/done | xargs -I{} grep -l "plan_draft: $PL" tasks/done/{} | wc -l | tr -d ' ')" = 1
# continuing goes back through the planner
hub plan continue "$PL" also do more >/dev/null
tick_until 'pstat | grep -q "^review"'
test "$(pstat)" = "review done,done,done,pending,pending,pending"
# a second host joins and mirrors the same data
NOOP_HOME="$W/w2/home" HUB_DATA="$W/w2/data" HUB_HOST=w2 bun "$SRC/src/cli.ts" init --worker http://unused --token x >/dev/null
cmp tasks/done/T-0001.md "$W/w2/data/tasks/done/T-0001.md"
test ! -e "$W/w2/data/config.local.toml.pc" && ! grep -q fake-agent "$W/w2/data/config.local.toml"
echo "E2E OK"; cat journal/*.md
