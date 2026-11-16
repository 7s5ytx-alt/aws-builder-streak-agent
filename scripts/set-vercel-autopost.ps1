# Turns automatic comment posting on or off in Vercel Production.
#
#   & .\scripts\set-vercel-autopost.ps1 true
#   & .\scripts\set-vercel-autopost.ps1 false
#
# When true, the daily run publishes its Gemini-written drafts under the
# owner's name instead of parking them as `planned` for review. The quality
# gate in src/ai.ts still applies: a draft must be 60-420 characters, must not
# open with generic praise, must not closely repeat a recent comment, and its
# evidence must appear verbatim in the article. Anything failing that is
# dropped rather than posted.
#
# This is an environment variable rather than a code change so it can be turned
# off again without a deploy.

param([Parameter(Mandatory = $true)][ValidateSet("true", "false")][string]$Value)

Write-Output "Setting AUTO_POST_COMMENTS = $Value on Production"
Write-Output ""

Write-Output "-- removing any existing value"
npx vercel env rm AUTO_POST_COMMENTS production --yes
if (-not $?) { Write-Output "   (nothing to remove - continuing)" }

Write-Output "-- adding"
$Value | npx vercel env add AUTO_POST_COMMENTS production
if (-not $?) { throw "FAILED to set AUTO_POST_COMMENTS." }

Write-Output ""
Write-Output "Done. Redeploy for it to take effect: npx vercel --prod"
