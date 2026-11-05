#!/usr/bin/env bash
# Noop installer (Linux / macOS)
#   a machine (the default; joins your Noop):  curl -fsSL https://raw.githubusercontent.com/wheregmis/noop/wheregmis/install.sh | bash -s -- [<noop-url>]
#   the first machine, once (the primary):     curl -fsSL https://raw.githubusercontent.com/wheregmis/noop/wheregmis/install.sh | bash -s -- --primary
set -euo pipefail

HOME_DIR="${NOOP_HOME:-$([ -d "$HOME/.agent-hub" ] && [ ! -d "$HOME/.noop" ] && echo "$HOME/.agent-hub" || echo "$HOME/.noop")}"
APP="$HOME_DIR/app"
REPO="https://github.com/wheregmis/noop.git"
LOG="$HOME_DIR/install.log"
mkdir -p "$HOME_DIR" && : > "$LOG"

if [ -t 1 ]; then B=$'\e[1m'; D=$'\e[2m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; N=$'\e[0m'; else B= D= G= Y= R= N=; fi
step() { printf "  %s%-30s%s" "$D" "$1" "$N"; }
ok()   { printf "%s✓%s %s\n" "$G" "$N" "${1:-}"; }
warn() { printf "%s!%s %s\n" "$Y" "$N" "$1"; }
run()  { "$@" >>"$LOG" 2>&1; }  # details go to the log, not the screen

on_fail() {
  printf "%s✗%s\n\n  Something went wrong. Asking the AI medic to fix it (details: %s)\n\n" "$R" "$N" "$LOG"
  if command -v bun >/dev/null && [ -f "$APP/src/cli.ts" ]; then
    bun "$APP/src/cli.ts" fix "install.sh failed. Log: $LOG. Finish the installation by rerunning: $0 $*" || true
  elif command -v claude >/dev/null; then
    claude -p "Noop install.sh failed on $(uname -a). Read $LOG, fix the cause, then rerun the installer." --permission-mode acceptEdits || true
  fi
}
trap on_fail ERR

printf "\n%sNoop%s — your own AI team\n\n" "$B" "$N"

step "git";  command -v git >/dev/null || { printf "%s✗%s install git first\n" "$R" "$N"; exit 1; }; ok
step "bun";  if ! command -v bun >/dev/null; then run bash -c "curl -fsSL https://bun.sh/install | bash"; export PATH="$HOME/.bun/bin:$PATH"; else run bun upgrade; fi; ok "$(bun --version)"
step "Noop"
if [ -d "$APP/.git" ]; then run git -C "$APP" pull -q --ff-only || true; else run git clone -q -b wheregmis "$REPO" "$APP"; fi
(cd "$APP" && run bun install --frozen-lockfile)
mkdir -p "$HOME/.local/bin"
ln -sf "$APP/bin/noop" "$HOME/.local/bin/noop"; ln -sf "$APP/bin/noop" "$HOME/.local/bin/hub"
ok "$(git -C "$APP" rev-parse --short HEAD)"

missing=()
for c in claude codex gh; do command -v "$c" >/dev/null || missing+=("$c"); done
step "AI tools"; if [ ${#missing[@]} -eq 0 ]; then ok "claude, codex, gh"; else warn "missing: ${missing[*]} (install and log in for full capability)"; fi
echo

export NOOP_HOME="$HOME_DIR"
# interactive: email code (joining) or Cloudflare login (--primary); the questions read the terminal, not the piped script
if [ -r /dev/tty ]; then "$APP/bin/noop" init "$@" </dev/tty; else "$APP/bin/noop" init "$@"; fi
step "background service"; run "$APP/bin/noop" install; ok
echo
"$APP/bin/noop" status --brief || true
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) printf "\n  %sAdd ~/.local/bin to your PATH to use the noop command.%s\n" "$D" "$N";; esac
echo
