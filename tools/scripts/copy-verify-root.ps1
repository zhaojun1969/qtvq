# Copy verify/*.txt and MP_verify*.txt to static stage root
param(
    [Parameter(Mandatory = $true)][string]$Stage,
    [Parameter(Mandatory = $true)][string]$Root
)

$copied = 0
$verifyDir = Join-Path $Root "verify"
if (Test-Path $verifyDir) {
    Get-ChildItem $verifyDir -File | ForEach-Object {
        if ($_.Name -in @('README.md', '.gitkeep')) { return }
        Copy-Item $_.FullName (Join-Path $Stage $_.Name) -Force
        Write-Host ">> verify root: $($_.Name)"
        $script:copied++
    }
}
Get-ChildItem $Root -Filter "MP_verify*.txt" -File -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $Stage $_.Name) -Force
    Write-Host ">> verify root: $($_.Name)"
    $script:copied++
}
if ($copied -eq 0) {
    Write-Host ">> No domain verify files (optional: add to verify/)" -ForegroundColor Yellow
}
