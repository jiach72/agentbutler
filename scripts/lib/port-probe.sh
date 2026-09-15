#!/usr/bin/env bash
# 宿主端口监听探测（deploy.sh 与 bridge-healthcheck.sh 共用；只 source，不直接执行）。
#
# 为什么要单独抽出来：BSD/macOS 的 netstat 与 Linux 的不是同一个工具——
# `-l` 表示 loopback 而不是 listening、`-t` 根本不存在，监听地址还写成
# `.8755` 这种点号形式。拿 Linux 惯用的 `netstat -ltn | grep ':8755 '` 去跑
# macOS 会**确定性**返回「没在听」，于是体检脚本在客户机器上恒报 FAIL（A3）。
#
# 用法（调用方 source 本文件后调用）：
#   probe_port_listening 8755
# 返回三态：
#   0 = 有进程在监听
#   1 = 探测工具可用，但确实没人在监听
#   2 = 本机没有任何可用探测工具（调用方应 WARN 跳过，不能当成「没监听」）
probe_port_listening() {
  local port="${1:-}"
  local os=""
  local out=""
  [[ -n "$port" ]] || return 2
  os="$(uname -s 2>/dev/null || echo unknown)"

  # Darwin/BSD：ss 不存在、netstat 语义不同，一律走 lsof（macOS 自带）。
  # -n 不反解域名、-P 不反解端口名，避免 DNS 抖动把探测拖慢。
  if [[ "$os" == "Darwin" ]]; then
    command -v lsof >/dev/null 2>&1 || return 2
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    return 1
  fi

  # Linux/其他：优先 ss，回退 netstat，最后才是 lsof（lsof 在最小化镜像里常缺席）。
  # 先把输出取回变量再 grep：管道配合 pipefail 时 `grep -q` 命中即退出会让上游
  # 命令收到 SIGPIPE（141），把「命中」误判成失败。
  if command -v ss >/dev/null 2>&1; then
    out="$(ss -ltn 2>/dev/null || true)"
    if printf '%s\n' "$out" | grep -q ":${port}[[:space:]]"; then
      return 0
    fi
    return 1
  fi
  if command -v netstat >/dev/null 2>&1; then
    out="$(netstat -ltn 2>/dev/null || true)"
    if printf '%s\n' "$out" | grep -q ":${port}[[:space:]]"; then
      return 0
    fi
    return 1
  fi
  if command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    return 1
  fi
  return 2
}
