# Bulk-loads all the edge-rush D1 SQL files into the real (remote) Cloudflare database.
# Run from PowerShell, from inside the edge-rush\d1\sql folder (or adjust $sqlDir below).
#
# One-time setup (skip if already done):
#   npm install -g wrangler
#   wrangler login
#
# Usage:
#   cd C:\Users\jeffr\Documents\edge-rush\d1\sql
#   ..\..\import.ps1

$ErrorActionPreference = "Stop"
$db = "edge-rush"   # database name; the id is b3234230-248f-49fa-bf7e-965ab93cea3a if you'd rather use that
$sqlDir = $PSScriptRoot + "\sql"

# Files that already succeeded in a previous run are logged here by leaf name
# (one per line). On a re-run, anything already in this log is skipped
# entirely -- no re-upload, no re-check -- instead of paying wrangler's
# upload+execute round trip again for files whose data is already safely in
# D1. This is what makes re-running after a failure fast: only the file that
# failed (and anything after it) actually gets sent to Cloudflare.
#
# IMPORTANT: only a file that ran to full success gets logged. If you ever
# have to manually delete/redo data that a specific file loaded (e.g. to fix
# a corrupted range), remove that file's line from imported.log too, or it
# will be silently skipped on the next run even though the data's gone.
$doneLog = "$PSScriptRoot\imported.log"
if (-not (Test-Path $doneLog)) { New-Item -ItemType File -Path $doneLog | Out-Null }
$done = [System.Collections.Generic.HashSet[string]]::new(
    [string[]](Get-Content $doneLog -ErrorAction SilentlyContinue)
)

function Run-File($file) {
    $leaf = Split-Path $file -Leaf
    if ($done.Contains($leaf)) {
        Write-Host "Skipping $leaf (already imported)" -ForegroundColor DarkGray
        return
    }
    Write-Host "Importing $file ..." -ForegroundColor Cyan
    wrangler d1 execute $db --remote --yes --file="$file"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAILED on $file -- fix the issue and re-run this script (it's safe to re-run; every insert uses OR IGNORE)." -ForegroundColor Red
        exit 1
    }
    Add-Content -Path $doneLog -Value $leaf
    $done.Add($leaf) | Out-Null
}

# Order matters: dimension tables (team/season/game_type/position/stadium/coach/referee)
# were already loaded directly via chat -- this script only needs to fill in the rest.

Run-File "$sqlDir\00_player.sql"          # remaining player rows (idempotent, OR IGNORE)
Run-File "$sqlDir\01_game.sql"            # 7,548 games

# team_game/player_game are split into a "hub" file (10a/20a) and a "category"
# file (10b/20b) per season. The hub file MUST finish loading before its
# category file runs -- the category tables' foreign key points at the hub
# table, and wrangler's bulk-file loader does not guarantee it executes a
# single file's statements in top-to-bottom order, which caused spurious
# FOREIGN KEY errors when hub + category inserts were bundled in one file.
# Sorting "10a_*" before "10b_*" (and "20a_*" before "20b_*") preserves the
# required order.

Get-ChildItem "$sqlDir\10a_team_game_hub_*.sql" | Sort-Object Name | ForEach-Object {
    Run-File $_.FullName
}
Get-ChildItem "$sqlDir\10b_team_game_cat_*.sql" | Sort-Object Name | ForEach-Object {
    Run-File $_.FullName
}

Get-ChildItem "$sqlDir\20a_player_game_hub_*.sql" | Sort-Object Name | ForEach-Object {
    Run-File $_.FullName
}
Get-ChildItem "$sqlDir\20b_player_game_cat_*.sql" | Sort-Object Name | ForEach-Object {
    Run-File $_.FullName
}

Get-ChildItem "$sqlDir\30_injury_*.sql" | Sort-Object Name | ForEach-Object {
    Run-File $_.FullName
}

Write-Host "`nDone. Verify row counts with:" -ForegroundColor Green
Write-Host "  wrangler d1 execute $db --remote --command=`"SELECT (SELECT COUNT(*) FROM game) game, (SELECT COUNT(*) FROM team_game) team_game, (SELECT COUNT(*) FROM player_game) player_game, (SELECT COUNT(*) FROM injury_report) injury_report, (SELECT COUNT(*) FROM player) player;`""
