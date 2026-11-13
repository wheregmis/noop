#!/usr/bin/env bash
# End-to-end: sandbox data mirror synced to an offline fake of the Worker files API
# (HUB_SYNC_FAKE = the real cloud/src/files.ts over a local SQLite file), fake agent CLIs, run ticks.
set -euo pipefail
trap 'echo "FAIL: e2e.sh line $LINENO: $BASH_COMMAND" >&2' ERR
SRC=$(cd "$(dirname "$0")/.." && pwd)
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
export NOOP_HOME="$W" HUB_DATA="$W/data" HUB_HOST=pc HUB_SYNC_FAKE="$W/worker.sqlite"
cd "$SRC"; hub() { bun "$SRC/src/cli.ts" "$@"; }
hub init --primary >/dev/null
cd "$W/data"
cat > "$W/fake-agent" <<'F'
#!/usr/bin/env bash
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
elif grep -q "^# Task T-[0-9]*: SPLIT" <<<"$p" && ! grep -q "Results from delegated subtasks" <<<"$p"; then echo '```json
{"status":"delegated","summary":"split in two","followups":[{"title":"part one","agent":"reviewer"},{"title":"part two","agent":"rust-maintainer"}]}
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
[idle]
enabled = false
F
# judge uses 'claude' binary directly → shim PATH
mkdir -p "$W/bin"; ln -s "$W/fake-agent" "$W/bin/claude"; export PATH="$W/bin:$PATH"
sed -i.bak 's/^\[\[routine\]\]/[[routine_disabled]]/' config.toml && rm config.toml.bak
hub add "plain task" -a rust-maintainer >/dev/null
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
RT=$(bun -e "import {newTask,setApprovalGate} from '$SRC/src/core.ts'; import {needsApproval} from '$SRC/src/autonomy.ts'; import {loadConfig} from '$SRC/src/core.ts'; setApprovalGate(s=>needsApproval(loadConfig(),s)); console.log(newTask('routine job','x',{source:'routine:pr-review'}))")
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
# a second host joins and mirrors the same data
NOOP_HOME="$W/w2" HUB_DATA="$W/w2/data" HUB_HOST=w2 bun "$SRC/src/cli.ts" init --worker http://unused --token x >/dev/null
cmp tasks/done/T-0001.md "$W/w2/data/tasks/done/T-0001.md"
test ! -e "$W/w2/data/config.local.toml.pc" && ! grep -q fake-agent "$W/w2/data/config.local.toml"
echo "E2E OK"; cat journal/*.md
