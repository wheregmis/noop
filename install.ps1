# Noop installer (Windows):  irm https://raw.githubusercontent.com/wheregmis/noop/wheregmis/install.ps1 | iex
$ErrorActionPreference = "Stop"
$HomeDir = if ($env:NOOP_HOME) { $env:NOOP_HOME } elseif ((Test-Path "$HOME\.agent-hub") -and -not (Test-Path "$HOME\.noop")) { "$HOME\.agent-hub" } else { "$HOME\.noop" }
$App = "$HomeDir\app"
$Log = "$HomeDir\install.log"
New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null
Set-Content -Path $Log -Value ""

function Step($name) { Write-Host ("  {0,-30}" -f $name) -NoNewline -ForegroundColor DarkGray }
function Ok($msg = "") { Write-Host "$([char]0x2713) $msg" -ForegroundColor Green }
function Run { param([scriptblock]$b) & $b *>> $Log }

trap {
  Write-Host ([char]0x2717) -ForegroundColor Red
  Write-Host "`n  Something went wrong. Asking the AI medic to fix it (details: $Log)`n"
  if ((Get-Command bun -ErrorAction SilentlyContinue) -and (Test-Path "$App\src\cli.ts")) { bun "$App\src\cli.ts" fix "install.ps1 failed: $_ . Log: $Log" }
  elseif (Get-Command claude -ErrorAction SilentlyContinue) { claude -p "Noop install.ps1 failed on Windows: $_ . Read $Log, fix the cause, then rerun the installer." }
  break
}

Write-Host "`nNoop - your own AI team`n"
Step "bun"
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { Run { irm bun.sh/install.ps1 | iex }; $env:Path += ";$HOME\.bun\bin" } else { Run { bun upgrade } }  # an old bun cannot read a newer bun.lock
Ok (bun --version)
Step "Noop"
if (Test-Path "$App\.git") { Run { git -C $App pull -q --ff-only } } else { Run { git clone -q -b wheregmis https://github.com/wheregmis/noop.git $App } }
Push-Location $App; Run { bun install --frozen-lockfile }; Pop-Location
Ok
Step "AI tools"
$missing = @("claude", "codex", "gh") | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) }
if ($missing) { Write-Host "! missing: $($missing -join ', ') (install and log in for full capability)" -ForegroundColor Yellow } else { Ok "claude, codex, gh" }
Write-Host ""

$env:NOOP_HOME = $HomeDir
bun "$App\src\cli.ts" init @args   # joins your Noop; the first machine passes --primary
Step "background service"; Run { bun "$App\src\cli.ts" install }; Run { powercfg /change standby-timeout-ac 0 }; Ok
Write-Host ""
bun "$App\src\cli.ts" status --brief
Write-Host ""
