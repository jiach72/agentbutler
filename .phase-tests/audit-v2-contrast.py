#!/usr/bin/env python3
"""复审 3：解析 tokens.ts 常量并计算 WCAG 对比度（亮/暗双主题）。"""
import re
from pathlib import Path

src = Path("C:/Users/jiach/Documents/Agent Butler/ui/src/theme/tokens.ts").read_text(encoding="utf-8")

# ---- 提取顶层常量表：const ink = {...} / const butlerBlue = {...} / const brass = {...} / const signal = {...} ----
def grab_const(name):
    m = re.search(rf"const {name}\b[^=]*=\s*\{{", src)
    if not m:
        return {}
    i = m.end() - 1
    depth = 0
    for j in range(i, len(src)):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                break
    body = src[i:j + 1]
    out = dict(re.findall(r"(\w+):\s*\"(#[0-9A-Fa-f]{6})\"", body))
    return out

ink = grab_const("ink")
butler_blue = grab_const("butlerBlue")
brass = grab_const("brass")
signal = grab_const("signal")
signal_dark = grab_const("signalDark")

def resolve(expr: str, theme: str):
    expr = expr.strip()
    m = re.fullmatch(r"#([0-9A-Fa-f]{6})", expr)
    if m:
        return m.group(0)
    m = re.fullmatch(r"(\w+)\[(\w+)\]", expr)
    if m:
        table = {"ink": ink, "butlerBlue": butler_blue, "brass": brass}.get(m.group(1), {})
        return table.get(m.group(2))
    m = re.fullmatch(r"signal\.(\w+)", expr)
    if m:
        return (signal_dark if theme == "dark" else signal).get(m.group(1))
    return None

def grab_palette(name, theme):
    m = re.search(rf"const {name}\b[^=]*=\s*\{{", src)
    i = m.end() - 1
    depth = 0
    for j in range(i, len(src)):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                break
    body = src[i:j + 1]
    out = {}
    for k, v in re.findall(r"(\w+):\s*([^,\n]+)", body):
        c = resolve(v, theme)
        if c:
            out[k] = c
    return out

light = grab_palette("lightPalette", "light")
dark = grab_palette("darkPalette", "dark")

def lum(h):
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))
    f = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)

def ratio(a, b):
    la, lb = lum(a), lum(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)

pairs = [
    ("正文/表面", "text", "surface"), ("正文/画布", "text", "canvas"),
    ("次级/表面", "text2", "surface"), ("辅助/表面", "text3", "surface"),
    ("占位/表面", "text4", "surface"),
    ("主色/表面", "primary", "surface"), ("按钮字/主色", "onPrimary", "primary"),
    ("ok/表面", "ok", "surface"), ("warn/表面", "warn", "surface"),
    ("error/表面", "error", "surface"), ("黄铜/表面", "brand", "surface"),
]
rows = []
print(f"{'配对':<12} {'亮色':>7} {'暗色':>7}  判定")
for label, fg, bg in pairs:
    l = ratio(light[fg], light[bg]) if fg in light and bg in light else None
    dk = ratio(dark[fg], dark[bg]) if fg in dark and bg in dark else None
    ls = f"{l:.2f}" if l else "—"
    ds = f"{dk:.2f}" if dk else "—"
    v = ""
    if l and dk:
        mn = min(l, dk)
        v = "✓≥4.5 文本" if mn >= 4.5 else ("△≥3 大字/组件" if mn >= 3 else "✗<3")
    print(f"{label:<12} {ls:>7} {ds:>7}  {v}")
    rows.append({"pair": label, "light": ls, "dark": ds, "verdict": v})

Path("C:/Users/jiach/Documents/Agent Butler/.phase-tests/audit-v2-contrast.json").write_text(
    str(rows).replace("'", '"'), encoding="utf-8")
