$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker is required."
}
docker compose version | Out-Null

New-Item -ItemType Directory -Force .runtime/hermes, .runtime/openclaw | Out-Null
if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  Write-Host "Created .env from .env.example; review it before exposing the UI."
}

# 初始化凭据库主密钥。首次部署自动生成并持久化，后续部署绝不轮换，
# 否则历史 API Key 将无法解密。密钥值不打印到终端或日志。
$envContent = [System.IO.File]::ReadAllText((Join-Path (Get-Location) ".env"))
$fileMasterKey = ""
$match = [regex]::Match($envContent, '(?m)^BUTLER_SECRET_MASTER_KEY=(.*)$')
if ($match.Success) { $fileMasterKey = $match.Groups[1].Value.Trim().Trim('"', "'") }
$shellMasterKey = if ($null -eq $env:BUTLER_SECRET_MASTER_KEY) { "" } else { $env:BUTLER_SECRET_MASTER_KEY.Trim() }
if ($fileMasterKey -and $shellMasterKey -and $fileMasterKey -ne $shellMasterKey) {
  throw "shell 与 .env 中的 BUTLER_SECRET_MASTER_KEY 不一致；为避免历史凭据无法解密，请只保留同一个值。"
}
$masterKey = if ($fileMasterKey) { $fileMasterKey } else { $shellMasterKey }
if ($masterKey -and $masterKey -notmatch '^[a-fA-F0-9]{64}$' -and $masterKey -notmatch '^([A-Za-z0-9+/]{43}=|[A-Za-z0-9+/]{44}|[A-Za-z0-9_-]{43,44})$') {
  throw "BUTLER_SECRET_MASTER_KEY 格式无效；需要 32 字节 hex 或 base64/base64url。"
}
if ([string]::IsNullOrWhiteSpace($masterKey)) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $masterKey = ([Convert]::ToHexString($bytes)).ToLowerInvariant()
  if ([regex]::IsMatch($envContent, '(?m)^BUTLER_SECRET_MASTER_KEY=')) {
    $envContent = [regex]::Replace($envContent, '(?m)^BUTLER_SECRET_MASTER_KEY=.*$', "BUTLER_SECRET_MASTER_KEY=$masterKey")
  } else {
    $envContent = $envContent.TrimEnd("`r", "`n") + "`r`nBUTLER_SECRET_MASTER_KEY=$masterKey`r`n"
  }
  [System.IO.File]::WriteAllText((Join-Path (Get-Location) ".env"), $envContent)
  Write-Host "Generated and stored the Butler credential vault key in .env."
}
$env:BUTLER_SECRET_MASTER_KEY = $masterKey

$fileInternalToken = ""
$match = [regex]::Match($envContent, '(?m)^BUTLER_INTERNAL_TOKEN=(.*)$')
if ($match.Success) { $fileInternalToken = $match.Groups[1].Value.Trim().Trim('"', "'") }
$shellInternalToken = if ($null -eq $env:BUTLER_INTERNAL_TOKEN) { "" } else { $env:BUTLER_INTERNAL_TOKEN.Trim() }
$internalToken = if ($fileInternalToken) { $fileInternalToken } else { $shellInternalToken }
if ([string]::IsNullOrWhiteSpace($internalToken)) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $internalToken = ([Convert]::ToHexString($bytes)).ToLowerInvariant()
  if ([regex]::IsMatch($envContent, '(?m)^BUTLER_INTERNAL_TOKEN=')) {
    $envContent = [regex]::Replace($envContent, '(?m)^BUTLER_INTERNAL_TOKEN=.*$', "BUTLER_INTERNAL_TOKEN=$internalToken")
  } else {
    $envContent = $envContent.TrimEnd("`r", "`n") + "`r`nBUTLER_INTERNAL_TOKEN=$internalToken`r`n"
  }
  [System.IO.File]::WriteAllText((Join-Path (Get-Location) ".env"), $envContent)
  Write-Host "Generated and stored BUTLER_INTERNAL_TOKEN in .env."
}
$env:BUTLER_INTERNAL_TOKEN = $internalToken

$deploySha = ""
try {
  $deploySha = (git rev-parse HEAD 2>$null).Trim()
} catch {}
if ($deploySha) {
  $env:BUTLER_GIT_COMMIT = $deploySha
  if ([regex]::IsMatch($envContent, '(?m)^BUTLER_GIT_COMMIT=')) {
    $envContent = [regex]::Replace($envContent, '(?m)^BUTLER_GIT_COMMIT=.*$', "BUTLER_GIT_COMMIT=$deploySha")
  } else {
    $envContent = $envContent.TrimEnd("`r", "`n") + "`r`nBUTLER_GIT_COMMIT=$deploySha`r`n"
  }
  [System.IO.File]::WriteAllText((Join-Path (Get-Location) ".env"), $envContent)
}

$env:BUTLER_HOST_OS = "Windows"
$env:BUTLER_HOST_ARCH = if ([System.Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }

# 探测 Windows 宿主真实客观硬件（供容器内 Ollama 自适应推荐引擎精准评估）
try {
  $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
  $allProcs = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue
  $firstProc = $allProcs | Select-Object -First 1
  if ($cs -and $cs.TotalPhysicalMemory) {
    $env:BUTLER_HOST_MEM_GB = [string][math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
  }
  if ($allProcs) {
    $totalCores = ($allProcs | Measure-Object -Property NumberOfCores -Sum).Sum
    $totalLogicals = ($allProcs | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
    if ($totalCores) { $env:BUTLER_HOST_CORES = [string]$totalCores }
    if ($totalLogicals) { $env:BUTLER_HOST_LOGICAL_CORES = [string]$totalLogicals }
    if ($firstProc -and $firstProc.Name) { $env:BUTLER_HOST_CPU_MODEL = $firstProc.Name.Trim() }
  }
} catch {
  # 探测异常平滑忽略
}

function Set-EnvVar([string]$Key, [string]$Val) {
  if (-not $Val) { return }
  if ([regex]::IsMatch($script:envContent, "(?m)^$Key=")) {
    $script:envContent = [regex]::Replace($script:envContent, "(?m)^$Key=.*$", "$Key=$Val")
  } else {
    $script:envContent = $script:envContent.TrimEnd("`r", "`n") + "`r`n$Key=$Val`r`n"
  }
}

Set-EnvVar "BUTLER_HOST_OS" $env:BUTLER_HOST_OS
Set-EnvVar "BUTLER_HOST_ARCH" $env:BUTLER_HOST_ARCH
if ($env:BUTLER_HOST_MEM_GB) { Set-EnvVar "BUTLER_HOST_MEM_GB" $env:BUTLER_HOST_MEM_GB }
if ($env:BUTLER_HOST_CORES) { Set-EnvVar "BUTLER_HOST_CORES" $env:BUTLER_HOST_CORES }
if ($env:BUTLER_HOST_LOGICAL_CORES) { Set-EnvVar "BUTLER_HOST_LOGICAL_CORES" $env:BUTLER_HOST_LOGICAL_CORES }
if ($env:BUTLER_HOST_CPU_MODEL) { Set-EnvVar "BUTLER_HOST_CPU_MODEL" $env:BUTLER_HOST_CPU_MODEL }

[System.IO.File]::WriteAllText((Join-Path (Get-Location) ".env"), $envContent)

# ---- 升级前备份数据卷（失败默认阻断部署；与 deploy.sh 同一口径）----
function Read-EnvValue([string]$Key) {
  $m = [regex]::Match($envContent, "(?m)^$Key=(.*)$")
  if ($m.Success) { return $m.Groups[1].Value.Trim().Trim('"', "'") }
  return ""
}

$dataVolume = if ($env:BUTLER_DATA_VOLUME) { $env:BUTLER_DATA_VOLUME.Trim() } else { Read-EnvValue "BUTLER_DATA_VOLUME" }
if (-not $dataVolume) { $dataVolume = "agent-butler-data" }
docker volume inspect $dataVolume *> $null
if ($LASTEXITCODE -eq 0) {
  New-Item -ItemType Directory -Force backups | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupName = "butler-data-$stamp.tgz"
  Write-Host "Backing up data volume '$dataVolume' to backups/$backupName ..."
  $runningIds = (docker compose ps -q butler-gateway butler-watch butler-web | Out-String).Trim()
  $wasRunning = $runningIds -ne ""
  if ($wasRunning) { docker compose stop *> $null }
  docker run --rm -v "${dataVolume}:/data:ro" -v "${PWD}/backups:/backup" alpine tar czf "/backup/$backupName" --exclude "./backups" -C /data .
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Backup OK."
    $keepRaw = if ($env:BUTLER_BACKUP_KEEP) { $env:BUTLER_BACKUP_KEEP.Trim() } else { Read-EnvValue "BUTLER_BACKUP_KEEP" }
    $keep = 4
    if ($keepRaw -match '^\d+$') { $keep = [int]$keepRaw }
    Get-ChildItem backups -Filter "butler-data-*.tgz" |
      Sort-Object LastWriteTime -Descending |
      Select-Object -Skip $keep |
      ForEach-Object { Remove-Item $_.FullName -Force; Write-Host "Pruned old backup: $($_.Name)" }
  } else {
    if ($wasRunning) { docker compose start *> $null }
    $allowRaw = if ($env:BUTLER_ALLOW_UNBACKED_DEPLOY) { $env:BUTLER_ALLOW_UNBACKED_DEPLOY.Trim() } else { Read-EnvValue "BUTLER_ALLOW_UNBACKED_DEPLOY" }
    if ($allowRaw -ne "true") {
      throw "数据卷备份失败，已停止部署。设置 BUTLER_ALLOW_UNBACKED_DEPLOY=true 才可强制继续。"
    }
    Write-Warning "数据卷备份失败，按 BUTLER_ALLOW_UNBACKED_DEPLOY=true 继续。"
  }
  if ($wasRunning) { Write-Host "Existing containers were stopped for a consistent volume snapshot." }
}

docker compose config -q
docker compose up -d --build
docker compose ps

for ($attempt = 0; $attempt -lt 30; $attempt++) {
  $webReady = $false
  $gatewayReady = $false
  $watchReady = $false
  try {
    docker compose exec -T butler-web node -e "fetch('http://127.0.0.1:7531/api/health').then(async (r) => { const b = await r.json(); process.exit(r.ok && b.ok === true && b.gateway === true ? 0 : 1); }).catch(() => process.exit(1))" | Out-Null
    $webReady = ($LASTEXITCODE -eq 0)
    docker compose exec -T butler-gateway node -e "fetch('http://127.0.0.1:7532/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" | Out-Null
    $gatewayReady = ($LASTEXITCODE -eq 0)
    docker compose exec -T butler-watch node -e "fetch('http://127.0.0.1:7533/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" | Out-Null
    $watchReady = ($LASTEXITCODE -eq 0)
    if ($webReady -and $gatewayReady -and $watchReady) {
      $published = (docker compose port butler-web 7531 | Select-Object -First 1)
      Write-Host "Agent Butler is ready: http://$published"
      exit 0
    }
    Start-Sleep -Seconds 2
  } catch {
    Start-Sleep -Seconds 2
  }
}

throw "Agent Butler did not become healthy. Check: docker compose logs --tail=200"
