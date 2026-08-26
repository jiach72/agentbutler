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
