#!/usr/bin/env bash
# scripts/collect-logs.sh — 安全聚合部署与诊断日志（防递归自吞）
#
# 背景：直接使用 `for f in $dir/*.log; do ...; done > $dir/ALL-LOGS.log`
# 会导致通配符命中正在写入的自身文件，死循环导致日志文件无限膨胀（实测 2 分钟吞成 77GB）。
# 本脚本通过两重防护彻底消除该事故：
#   1. 仅匹配有数字序号的前缀日志（如 `[0-9][0-9]-*.log`），显式排除自身及聚合文件；
#   2. 聚合内容先写入独立的系统临时目录（/tmp），完全写毕后再原子移动（mv）至目标路径。
#
set -euo pipefail

TARGET_DIR="${1:-.}"
if [[ ! -d "$TARGET_DIR" ]]; then
  echo "ERROR: 目标日志目录不存在：$TARGET_DIR" >&2
  exit 1
fi
TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"

DATE_TAG="$(date +%Y%m%d)"
OUTPUT_FILE="${2:-$TARGET_DIR/ALL-LOGS-${DATE_TAG}.log}"
TEMP_OUTPUT="$(mktemp "${TMPDIR:-/tmp}/butler-collect-logs-XXXXXX.log")"

echo "=== 正在归集日志: $TARGET_DIR ==="
echo "临时写入路径: $TEMP_OUTPUT"

log_count=0
# 只匹配 00- 99- 开头的编号日志，按文件名升序排列
shopt -s nullglob
files=("$TARGET_DIR"/[0-9][0-9]-*.log)
shopt -u nullglob

if [[ ${#files[@]} -eq 0 ]]; then
  echo "WARNING: 目录中未找到序号日志（[0-9][0-9]-*.log）" >&2
fi

for f in "${files[@]}"; do
  base="$(basename "$f")"
  # 防护：绝对不聚合任何自身或含有 ALL-LOGS 的文件
  if [[ "$base" == *"ALL-LOGS"* ]]; then
    continue
  fi

  size=$(wc -c < "$f" | tr -d ' ')
  echo "  + 收集 $base ($size 字节)"
  {
    echo ""
    echo "▶ $base ($size 字节)"
    echo "----------------------------------------"
    cat "$f"
    echo ""
  } >> "$TEMP_OUTPUT"
  log_count=$((log_count + 1))
done

# 完成后原子移动至最终目录
mv -f "$TEMP_OUTPUT" "$OUTPUT_FILE"
total_size=$(wc -c < "$OUTPUT_FILE" | tr -d ' ')

echo "=== 归集完成 ==="
echo "共合并 ${log_count} 份日志"
echo "产物路径: $OUTPUT_FILE (${total_size} 字节)"
