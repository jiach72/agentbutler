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
