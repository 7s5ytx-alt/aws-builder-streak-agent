# Sets the failure-alert variables on Vercel Production from .env.cloudflare.
# Only values actually filled in locally are pushed, so this is safe to re-run
# after adding a second channel later.
#
#   & .\scripts\set-vercel-alert-env.ps1
#
# Verify the credentials first with `npm run alert:test`. An alert nobody has
# seen arrive is not an alert.

# -Only limits the push to named variables. Each one costs a slow npx round
# trip, and re-sending values Vercel already holds means a window where the
# variable is briefly absent for no reason.
param([string[]]$Only)

$envFile = Join-Path $PSScriptRoot "..\.env.cloudflare"
if (-not (Test-Path $envFile)) { throw ".env.cloudflare not found at $envFile" }

$values = @{}
foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$') {
    $values[$matches[1]] = $matches[2].Trim('"').Trim("'")
  }
}

$candidates = @("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "RESEND_API_KEY", "ALERT_EMAIL_TO", "ALERT_EMAIL_FROM")

$queue = @()
foreach ($name in $candidates) {
  if ($Only -and ($Only -notcontains $name)) { continue }
  if ($values.ContainsKey($name) -and -not [string]::IsNullOrWhiteSpace($values[$name])) { $queue += $name }
  else { Write-Output "skipping $name (not set locally)" }
}

if ($queue.Count -eq 0) { throw "Nothing to set. Fill in at least the Telegram pair." }

# Telegram needs BOTH halves or the alert silently never sends, which is the
# worst possible failure for a thing whose job is to tell you about failures.
$hasToken = $queue -contains "TELEGRAM_BOT_TOKEN"
$hasChat = $queue -contains "TELEGRAM_CHAT_ID"
if ($hasToken -ne $hasChat) { throw "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set, or neither." }

foreach ($name in $queue) {
  $value = $values[$name]
  $tail = $value.Substring([Math]::Max(0, $value.Length - 4))
  Write-Output ""
  Write-Output "=== $name  (ends ...$tail) ==="

  Write-Output "-- removing any existing Production value"
  npx vercel env rm $name production --yes
  if (-not $?) { Write-Output "   (nothing to remove - continuing)" }

  Write-Output "-- adding"
  $value | npx vercel env add $name production
  if (-not $?) { throw "FAILED to add $name. Re-run this script." }
}

Write-Output ""
Write-Output "Alert variables set. Nothing is deployed yet."
