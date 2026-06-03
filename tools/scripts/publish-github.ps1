# Create GitHub repo and push (requires gh auth login)
# Usage: powershell -ExecutionPolicy Bypass -File scripts/publish-github.ps1 [-RepoName qtvq] [-Private]

param(
    [string]$RepoName = "qtvq",
    [switch]$Private
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $Root

function Find-Gh {
    if (Get-Command gh -ErrorAction SilentlyContinue) { return "gh" }
    $p = "$env:TEMP\gh-cli\bin\gh.exe"
    if (Test-Path $p) { return $p }
    return $null
}

$gh = Find-Gh
if (-not $gh) {
    Write-Host "GitHub CLI (gh) not found. Install from https://cli.github.com/" -ForegroundColor Yellow
    Write-Host "Or follow manual steps in GITHUB.md"
    exit 1
}

& $gh auth status 2>&1 | Out-String | ForEach-Object {
    if ($_ -match 'not logged in') {
        Write-Host "Run: gh auth login"
        exit 1
    }
}

if (-not (Test-Path ".git")) { git init }
git add -A
$status = git status --porcelain
if ($status) {
    git commit -m "Update: qtvq site"
}

git branch -M main 2>$null

$vis = if ($Private) { "--private" } else { "--public" }
Write-Host ">> Creating repo $RepoName and pushing ..."
& $gh repo create $RepoName $vis --source=. --remote=origin --push

Write-Host ""
Write-Host "Done. Open:" -ForegroundColor Green
& $gh repo view --web 2>$null
