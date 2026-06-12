# Sync qtvq Markdown docs to local Obsidian vault (obsidian/)



$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path

$Vault = Join-Path $Root "obsidian"



Set-Location $Root



$map = @(

    @{ Src = "README.md"; Dest = "00-home/README.md" },

    @{ Src = "DEPLOY.md"; Dest = "01-deploy/DEPLOY.md" },

    @{ Src = "GITHUB.md"; Dest = "01-deploy/GITHUB.md" },

    @{ Src = "docs/DUAL-DEPLOY.md"; Dest = "01-deploy/DUAL-DEPLOY.md" },

    @{ Src = "docs/CLOUDFLARE-TOKEN.md"; Dest = "01-deploy/CLOUDFLARE-TOKEN.md" },

    @{ Src = "docs/DOMAIN-qtvq.cn.md"; Dest = "01-deploy/DOMAIN-qtvq.cn.md" },

    @{ Src = "docs/FIX-WORKERS-AI.md"; Dest = "02-ops/FIX-WORKERS-AI.md" },

    @{ Src = "docs/OBS.md"; Dest = "02-ops/OBS.md" },

    @{ Src = "docs/OSS-BACKUP.md"; Dest = "02-ops/OSS-BACKUP.md" },

    @{ Src = "docs/MAIL-SMTP.md"; Dest = "02-ops/MAIL-SMTP.md" },

    @{ Src = "docs/RAG.md"; Dest = "02-ops/RAG.md" },

    @{ Src = "docs/SPEECH-ASR.md"; Dest = "02-ops/SPEECH-ASR.md" },

    @{ Src = "docs/GIT-PRIVATE.md"; Dest = "03-collab/GIT-PRIVATE.md" },

    @{ Src = "docs/GITEE-SETUP.md"; Dest = "03-collab/GITEE-SETUP.md" },

    @{ Src = "docs/MULTI-PLATFORM.md"; Dest = "04-platform/MULTI-PLATFORM.md" },

    @{ Src = "apps/README.md"; Dest = "04-platform/apps-README.md" },

    @{ Src = "apps/qtvq-uni/README.md"; Dest = "04-platform/qtvq-uni-README.md" },

    @{ Src = "context/CONTEXT-SNAPSHOT.md"; Dest = "05-context/CONTEXT-SNAPSHOT.md" }

)



New-Item -ItemType Directory -Force -Path $Vault | Out-Null



$synced = @()

foreach ($item in $map) {

    $srcPath = Join-Path $Root $item.Src

    if (-not (Test-Path $srcPath)) {

        Write-Host "Skip missing: $($item.Src)" -ForegroundColor Yellow

        continue

    }

    $destPath = Join-Path $Vault $item.Dest

    $destDir = Split-Path $destPath -Parent

    if (-not (Test-Path $destDir)) {

        New-Item -ItemType Directory -Force -Path $destDir | Out-Null

    }

    Copy-Item -LiteralPath $srcPath -Destination $destPath -Force

    $synced += $item.Dest

}



$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'

$index = @"

---

title: QTVQ Index

updated: $stamp

tags: [qtvq, index]

---



# QTVQ Documentation



Auto-synced from ``d:\qtvq`` via ``pnpm sync:obs``. Edits here may be overwritten.



## Deploy



- [[00-home/README|README]]

- [[01-deploy/DEPLOY|DEPLOY]]

- [[01-deploy/DUAL-DEPLOY|Dual deploy]]

- [[01-deploy/CLOUDFLARE-TOKEN|Cloudflare Token]]

- [[01-deploy/DOMAIN-qtvq.cn|Domain]]

- [[01-deploy/GITHUB|GitHub]]



## Ops & Backup



- [[02-ops/OBS|OBS context]]

- [[02-ops/OSS-BACKUP|OSS API backup]]

- [[02-ops/MAIL-SMTP|Mail SMTP]]

- [[02-ops/RAG|RAG index]]

- [[02-ops/SPEECH-ASR|Speech ASR]]

- [[02-ops/FIX-WORKERS-AI|Workers AI]]



## Collaboration



- [[03-collab/GIT-PRIVATE|Git private]]

- [[03-collab/GITEE-SETUP|Gitee]]



## Multi-platform



- [[04-platform/MULTI-PLATFORM|Multi-platform]]

- [[04-platform/qtvq-uni-README|uni-app]]



## Context



- [[05-context/CONTEXT-SNAPSHOT|Snapshot]]



---

Files: $($synced.Count) | Last sync: $stamp

"@



Set-Content -Path (Join-Path $Vault "00-INDEX.md") -Value $index -Encoding UTF8



$obsCfg = Join-Path $env:APPDATA "obsidian\obsidian.json"

if (Test-Path $obsCfg) {

    $json = Get-Content $obsCfg -Raw -Encoding UTF8 | ConvertFrom-Json

    $normVault = $Vault.Replace('\', '/').ToLower()

    $updated = $false

    foreach ($prop in $json.vaults.PSObject.Properties) {

        $p = ($prop.Value.path -replace '\\', '/').ToLower()

        if ($p -eq $normVault -or $p -match 'qtvq') {

            $prop.Value.path = $Vault

            $prop.Value.ts = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())

            $updated = $true

        }

    }

    if (-not $updated) {

        $id = ([guid]::NewGuid().ToString('n')).Substring(0, 16)

        $entry = [PSCustomObject]@{ path = $Vault; ts = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) }

        $json.vaults | Add-Member -NotePropertyName $id -NotePropertyValue $entry

    }

    $json | ConvertTo-Json -Depth 5 -Compress | Set-Content $obsCfg -Encoding UTF8

    Write-Host "Obsidian vault registered: $Vault"

}



Write-Host "Synced $($synced.Count) files -> $Vault"

Write-Host "Open Obsidian and select vault: $Vault"


