# Sets the Cloudflare account variables on Vercel Production from
# .env.cloudflare. Only pairs that are filled in locally are touched, so this
# is safe to re-run after adding another account.
#
#   & .\scripts\set-vercel-cf-env.ps1
#
# Values are piped into the Vercel CLI rather than passed as arguments, so a
# token never appears in a command line or in terminal scrollback. Only the
# last four characters are echoed, to confirm which value went in.
#
# Note: PowerShell appends a line ending when piping to a native command. That
# is how CF_API_TOKEN gained a trailing carriage return under Vercel CLI 46 and
# broke the Authorization header on 2026-11-16. CLI 65 strips it, and
# src/config.ts trims every value on read, so the fault is covered twice.

$envFile = Join-Path $PSScriptRoot "..\.env.cloudflare"
if (-not (Test-Path $envFile)) { throw ".env.cloudflare not found at $envFile" }

$values = @{}
foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$') {
    $values[$matches[1]] = $matches[2].Trim('"').Trim("'")
  }
}

$pairs = @(
  @("CF_ACCOUNT_ID",   "CF_API_TOKEN"),
  @("CF_ACCOUNT_ID_2", "CF_API_TOKEN_2"),
  @("CF_ACCOUNT_ID_3", "CF_API_TOKEN_3")
)

$queue = @()
foreach ($pair in $pairs) {
  $idName = $pair[0]; $tokenName = $pair[1]
  $hasId = $values.ContainsKey($idName) -and -not [string]::IsNullOrWhiteSpace($values[$idName])
  $hasToken = $values.ContainsKey($tokenName) -and -not [string]::IsNullOrWhiteSpace($values[$tokenName])
  if ($hasId -and $hasToken) { $queue += $idName; $queue += $tokenName }
  elseif ($hasId -or $hasToken) { throw "$idName and $tokenName must both be filled in, or neither. The app refuses to start otherwise." }
  else { Write-Output "skipping $idName / $tokenName (not set locally)" }
}

if ($queue.Count -eq 0) { throw "Nothing to set. Fill in at least CF_ACCOUNT_ID and CF_API_TOKEN." }

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
  if (-not $?) { throw "FAILED to add $name. Production may now be MISSING it - re-run this script." }
}

Write-Output ""
Write-Output "Cloudflare variables set. Nothing is deployed yet."
