#!/usr/bin/env python3
"""
Phase 5B codemod：把 ui/src 下所有 --butler-* 引用替换为 --ab-*。

完整映射表（来自 tokens.ts 桥接表 + applyThemeCssBridge + legacyOnlyVars）：

  - 颜色/语义别名：47 个 --butler-* 各自映射到 --ab-* 同源项
  - 结构型别名：space-1..7、text-{xs..xxl}、radius-card/control、dur-fast/base/slow、ease
  - 局部定义别名（出现在 taste.css 的 :root 块）：
      --butler-content-max   -> --ab-content-max
      --butler-focus-offset  -> --ab-focus-offset
      --butler-stat-accent   -> --ab-stat-accent
  - 通知角标（即将退役的 legacyOnlyVars）：
      --butler-notification-badge     -> --ab-error
      --butler-notification-badge-on  -> --ab-on-primary
  - 体素别名无对应：--butler-card-highlight（0 引用，直接删）

边界：仅处理 ui/src/**（排除 tokens.ts 自身，它在删桥阶段一并删）。
"""
import re
import sys
from pathlib import Path

# === 颜色 / 语义映射表 ===
COLOR_MAP = {
    "--butler-bg": "--ab-canvas",
    "--butler-surface": "--ab-surface",
    "--butler-surface-subtle": "--ab-surface-2",
    "--butler-sunken": "--ab-sunken",
    "--butler-raised": "--ab-surface-2",
    "--butler-surface-strong": "--ab-surface-2",
    "--butler-rule": "--ab-border",
    "--butler-rule-strong": "--ab-border-strong",
    "--butler-ink": "--ab-text",
    "--butler-ink-soft": "--ab-text-2",
    "--butler-ink-faint": "--ab-text-3",
    "--butler-muted": "--ab-text-3",
    "--butler-text-muted": "--ab-text-3",
    "--butler-accent": "--ab-primary",
    "--butler-accent-hover": "--ab-primary-hover",
    "--butler-accent-press": "--ab-primary-press",
    "--butler-accent-soft": "--ab-primary-soft",
    "--butler-accent-soft-border": "--ab-primary-soft-border",
    "--butler-on-accent": "--ab-on-primary",
    "--butler-brand": "--ab-brand",
    "--butler-brand-soft": "--ab-brand-soft",
    "--butler-brand-line": "--ab-brand-line",
    "--butler-ok": "--ab-ok",
    "--butler-ok-soft": "--ab-ok-soft",
    "--butler-warn": "--ab-warn",
    "--butler-warn-soft": "--ab-warn-soft",
    "--butler-error": "--ab-error",
    "--butler-error-soft": "--ab-error-soft",
    "--butler-offline": "--ab-offline",
    "--butler-offline-soft": "--ab-offline-soft",
    # v1.2 信号青 → v2 黄铜（brand）已退役
    "--butler-teal": "--ab-brand",
    "--butler-teal-soft": "--ab-brand-soft",
    # v1.2 暖橙 → v2 提醒色（warn）已退役
    "--butler-cinnabar": "--ab-warn",
    "--butler-cinnabar-soft": "--ab-warn-soft",
    # 阴影、焦点
    "--butler-shadow": "--ab-shadow-1",
    "--butler-shadow-strong": "--ab-shadow-2",
    "--butler-focus-ring": "--ab-focus",
    "--butler-focus": "--ab-primary",
    # 通知角标（legacyOnlyVars，仅 primitives.css 用）
    "--butler-notification-badge": "--ab-error",
    "--butler-notification-badge-on": "--ab-on-primary",
}

# === 结构型映射 ===
STRUCT_MAP = {}
for _i in range(1, 8):
    STRUCT_MAP[f"--butler-space-{_i}"] = f"--ab-space-{_i}"
for _k in ("xs", "sm", "md", "lg", "xl", "xxl"):
    STRUCT_MAP[f"--butler-text-{_k}"] = f"--ab-text-size-{_k}"
STRUCT_MAP["--butler-radius-card"] = "--ab-r-card"
STRUCT_MAP["--butler-radius-control"] = "--ab-r-ctl"
STRUCT_MAP["--butler-dur-fast"] = "--ab-dur-fast"
STRUCT_MAP["--butler-dur-base"] = "--ab-dur-base"
STRUCT_MAP["--butler-dur-slow"] = "--ab-dur-slow"
STRUCT_MAP["--butler-ease"] = "--ab-ease"
STRUCT_MAP["--butler-body-font"] = "--ab-font"
STRUCT_MAP["--butler-mono-font"] = "--ab-mono"
STRUCT_MAP["--butler-control-h"] = "--ab-control-h"

# === taste.css 局部变量镜像（在 tokens.ts 中即将新增）===
LOCAL_MAP = {
    "--butler-content-max": "--ab-content-max",
    "--butler-focus-offset": "--ab-focus-offset",
    "--butler-stat-accent": "--ab-stat-accent",
}

ALL_MAP = {**COLOR_MAP, **STRUCT_MAP, **LOCAL_MAP}

# 按键长倒序匹配，避免 `--butler-surface` 抢先吃掉 `--butler-surface-subtle`
SORTED_KEYS = sorted(ALL_MAP.keys(), key=len, reverse=True)
# 关键字面：escape `-` 作为正则字面
PATTERN = re.compile(
    "(" + "|".join(re.escape(k) for k in SORTED_KEYS) + r")(?![-a-zA-Z0-9_])"
)

ROOT = Path("C:/Users/jiach/Documents/Agent Butler/ui/src")
EXCLUDE = {"theme/tokens.ts", "theme/tokens.ts.snap"}  # bridge 自身由删桥阶段处理


def process(file_path: Path) -> int:
    text = file_path.read_text(encoding="utf-8")
    counter = {k: 0 for k in ALL_MAP}

    def repl(m: re.Match) -> str:
        key = m.group(1)
        counter[key] += 1
        return ALL_MAP[key]

    new = PATTERN.sub(repl, text)
    n = sum(counter.values())
    if n:
        file_path.write_text(new, encoding="utf-8")
    return n


if __name__ == "__main__":
    files = list(ROOT.rglob("*.tsx")) + list(ROOT.rglob("*.ts")) + list(ROOT.rglob("*.css"))
    files = [f for f in files if not str(f).endswith(".snap") and str(f.relative_to(ROOT)) not in EXCLUDE]
    total = 0
    for f in sorted(files):
        n = process(f)
        if n:
            print(f"  ✓ {str(f.relative_to(ROOT)):<48}  替换 {n} 处")
            total += n
    print(f"\n合计 {total} 处替换，{len([1 for _ in files if _])} 个文件遍历")
