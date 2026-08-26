#Requires -Version 7
<#
.SYNOPSIS
  一键刷新 Windows -> WSL 的 netsh portproxy 规则。

.DESCRIPTION
  WSL 重启后 IP 会变化，旧的 portproxy 规则随即失效。本脚本读取当前 WSL IP，
  删除同监听地址/端口的旧规则并重建。需要管理员权限。

.EXAMPLE
  # 管理员 PowerShell 中执行：
  .\scripts\fix-portproxy.ps1                 # 默认转发 127.0.0.1:7531
  .\scripts\fix-portproxy.ps1 -Port 7531 -ListenAddress 0.0.0.0
#>
param(
  [int]$Port = 7531,
  [string]$ListenAddress = "127.0.0.1"
)

$ErrorActionPreference = "Stop"

# netsh portproxy 写入系统配置，必须管理员
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "ERROR: 请以管理员身份运行（netsh portproxy 需要管理员权限）。" -ForegroundColor Red
  exit 1
}

# 取当前 WSL IP（hostname -I 可能输出多个地址，取第一个）
$wslOut = & wsl.exe hostname -I 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($wslOut -join ""))) {
  Write-Host "ERROR: 无法获取 WSL IP（wsl hostname -I 失败），确认 WSL 已启动。" -ForegroundColor Red
  exit 1
}
$wslIp = (($wslOut -join " ") -split "\s+" | Where-Object { $_ })[0]
Write-Host "当前 WSL IP: $wslIp"

Write-Host ""
Write-Host "== 现有规则 =="
netsh interface portproxy show v4tov4

# 删除同监听地址/端口的旧规则（不存在时报错但无害），再写新规则
try {
  netsh interface portproxy delete v4tov4 "listenaddress=$ListenAddress" "listenport=$Port" 2>$null | Out-Null
} catch { }

netsh interface portproxy add v4tov4 "listenaddress=$ListenAddress" "listenport=$Port" "connectaddress=$wslIp" "connectport=$Port"

Write-Host ""
Write-Host "== 新规则 =="
netsh interface portproxy show v4tov4
Write-Host ""
Write-Host "完成。http://${ListenAddress}:${Port} 已指向 WSL $wslIp；备选直连 http://${wslIp}:${Port}"
