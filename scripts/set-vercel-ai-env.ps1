# Sets the AI provider variables on Vercel Production from .env.cloudflare.
#
#   & .\scripts\set-vercel-ai-env.ps1
#
# Values are piped into the Vercel CLI rather than passed as arguments, so the
# API key never appears in a command line or in terminal scrollback. Only the
# last four characters are echoed, to confirm which value went in.
#
# Note: PowerShell appends a line ending when piping to a native command, which
# is how CF_API_TOKEN ended up with a trailing carriage return and broke the
# Authorization header on 2026-11-16. src/config.ts now trims every value on
# read, so that class of fault cannot reach an HTTP header again.

# -Only limits the push to named variables. Each one is a slow npx round trip,
# and re-sending a value Vercel already holds just creates a window where the
# variable is briefly missing.
param([string[]]$Only)

$envFile = Join-Path $PSScriptRoot "..\.env.cloudflare"
if (-not (Test-Path $envFile)) { throw ".env.cloudflare not found at $envFile" }

$values = @{}
foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*([A-Z_]+)\s*=\s*(.+?)\s*$') {
    $values[$matches[1]] = $matches[2].Trim('"').Trim("'")
  }
}

# Only the key is marked sensitive. A base URL and a model name are not
# secrets, and keeping them readable makes them easy to check in the dashboard.
$names = @("AI_BASE_URL", "AI_MODEL", "AI_GATEWAY_API_KEY")
$sensitive = @{ "AI_GATEWAY_API_KEY" = $true }

if ($Only) { $names = $names | Where-Object { $Only -contains $_ } }
if ($names.Count -eq 0) { throw "Nothing selected to set." }

foreach ($name in $names) {
  if (-not $values.ContainsKey($name)) { throw "$name is missing from .env.cloudflare" }
  if ([string]::IsNullOrWhiteSpace($values[$name])) { throw "$name is empty in .env.cloudflare" }
}

foreach ($name in $names) {
  $value = $values[$name]
  $tail = $value.Substring([Math]::Max(0, $value.Length - 4))
  Write-Output ""
  Write-Output "=== $name  (ends ...$tail) ==="

  Write-Output "-- removing any existing Production value"
  npx vercel env rm $name production --yes
  if (-not $?) { Write-Output "   (nothing to remove - continuing)" }

  if ($sensitive[$name]) {
    Write-Output "-- adding as a SENSITIVE value"
    $value | npx vercel env add $name production --sensitive
    if (-not $?) {
      Write-Output "   --sensitive was rejected; adding as a normal value instead"
      $value | npx vercel env add $name production
    }
  } else {
    Write-Output "-- adding"
    $value | npx vercel env add $name production
  }

  if (-not $?) { throw "FAILED to add $name. Production may now be MISSING it - re-run this script." }
}

Write-Output ""
Write-Output "AI variables set. Nothing is deployed yet."
