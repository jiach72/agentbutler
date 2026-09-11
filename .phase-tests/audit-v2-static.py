#!/usr/bin/env python3
"""
Agent Butler UI 全量复审 · 静态扫描器（2026-09-10）
扫描 ui/src 全部 .ts/.tsx/.css，按品牌规范 v2.0 逐项断言，输出 JSON 结果。
"""
import json
import re
from pathlib import Path

ROOT = Path("C:/Users/jiach/Documents/Agent Butler/ui/src")
OUT = Path("C:/Users/jiach/Documents/Agent Butler/.phase-tests/audit-v2-static.json")

def rel(p: Path) -> str:
    return str(p.relative_to(ROOT)).replace("\\", "/")

def walk(exts):
    files = []
    for e in exts:
        files.extend(ROOT.rglob(f"*.{e}"))
    return sorted(f for f in files if f.is_file() and not f.name.endswith(".snap"))

ts_files = walk(("ts", "tsx"))
css_files = walk(("css",))
all_files = ts_files + css_files

findings = {}

def add(cat: str, item: dict):
    findings.setdefault(cat, []).append(item)

# ---------- 1. 硬编码十六进制色值 ----------
HEX_RE = re.compile(r"#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b")
for f in all_files:
    r = rel(f)
    if r == "theme/tokens.ts":
        continue  # 唯一真源
    for m in HEX_RE.finditer(f.read_text(encoding="utf-8", errors="ignore")):
        ln = f.read_text(encoding="utf-8", errors="ignore")[:m.start()].count("\n") + 1
        add("hardcoded_hex", {"file": r, "line": ln, "value": m.group(0)})

# ---------- 2. 非标圆角（仅 14/8/6 合规；50% 用于圆形豁免） ----------
RADIUS_RE = re.compile(r"border-?radius:\s*([^;\n]+);")
OK_RADIUS = {"14px", "8px", "6px", "50%", "9999px"}
for f in all_files:
    r = rel(f)
    if r.startswith("theme/"):
        continue
    for m in RADIUS_RE.finditer(f.read_text(encoding="utf-8", errors="ignore")):
        val = m.group(1).strip()
        # 拆多值（如 6px 6px 0 0）逐个核对
        parts = val.split()
        bad = [p for p in parts if p not in OK_RADIUS and not p.startswith("var(")]
        if bad:
            ln = f.read_text(encoding="utf-8", errors="ignore")[:m.start()].count("\n") + 1
            add("nonstandard_radius", {"file": r, "line": ln, "value": val, "bad_parts": bad})

# ---------- 3. z-index 魔法值（合规：0/10/20/30/50/60 或 var()） ----------
ZI_RE = re.compile(r"z-index:\s*([^;\n]+);")
OK_Z = {"0", "10", "20", "30", "50", "60", "auto", "inherit"}
for f in all_files:
    r = rel(f)
    for m in ZI_RE.finditer(f.read_text(encoding="utf-8", errors="ignore")):
        val = m.group(1).strip()
        if val in OK_Z or val.startswith("var("):
            continue
        ln = f.read_text(encoding="utf-8", errors="ignore")[:m.start()].count("\n") + 1
        add("z_index_magic", {"file": r, "line": ln, "value": val})

# ---------- 4. !important（豁免 prefers-reduced-motion 块） ----------
for f in all_files:
    r = rel(f)
    text = f.read_text(encoding="utf-8", errors="ignore")
    in_exempt = 0
    for ln, line in enumerate(text.split("\n"), 1):
        if "prefers-reduced-motion" in line:
            in_exempt = 6  # 后续 6 行视为豁免块
        if "!important" in line and "/*" not in line:
            if in_exempt > 0:
                in_exempt -= 1
                continue
            add("important_usage", {"file": r, "line": ln, "content": line.strip()[:90]})
        if in_exempt > 0 and "!important" not in line:
            in_exempt -= 1

# ---------- 5. --butler-* 残留（代码引用，注释算低危） ----------
BUTLER_RE = re.compile(r"--butler-[a-zA-Z0-9_-]+")
for f in all_files:
    r = rel(f)
    text = f.read_text(encoding="utf-8", errors="ignore")
    for m in BUTLER_RE.finditer(text):
        ln = text[:m.start()].count("\n") + 1
        line = text.split("\n")[ln - 1]
        is_comment = line.strip().startswith(("*", "//", "/*")) or ("*" in line and "var(" not in line and "butler-${" not in line)
        add("butler_ref", {"file": r, "line": ln, "value": m.group(0), "in_comment": is_comment})

# ---------- 6. 动态 CSS 变量拼接（模板字面量构造 var()） ----------
DYN_RE = re.compile(r"var\(--[a-zA-Z0-9_-]*\$\{")
for f in ts_files:
    r = rel(f)
    text = f.read_text(encoding="utf-8", errors="ignore")
    for m in DYN_RE.finditer(text):
        ln = text[:m.start()].count("\n") + 1
        add("dynamic_var_concat", {"file": r, "line": ln, "content": text.split("\n")[ln - 1].strip()[:90]})

# ---------- 7. primary 按钮密度 ----------
for f in ts_files:
    r = rel(f)
    text = f.read_text(encoding="utf-8", errors="ignore")
    n = len(re.findall(r'type="primary"', text)) + len(re.findall(r"type=\{'primary'\}", text))
    if n > 1:
        add("primary_density", {"file": r, "count": n})

# ---------- 8. 裸 antd Badge（颜色点，无文字） ----------
for f in ts_files:
    r = rel(f)
    text = f.read_text(encoding="utf-8", errors="ignore")
    for m in re.finditer(r"<Badge\s[^>]*status=", text):
        ln = text[:m.start()].count("\n") + 1
        add("bare_badge", {"file": r, "line": ln})

# ---------- 9. 空态文案「暂无数据」 ----------
for f in ts_files:
    r = rel(f)
    text = f.read_text(encoding="utf-8", errors="ignore")
    for ln, line in enumerate(text.split("\n"), 1):
        if "暂无数据" in line and "禁" not in line and "不是" not in line and "不再" not in line:
            add("empty_anti_pattern", {"file": r, "line": ln, "content": line.strip()[:70]})

# ---------- 10. outline: none（看同块是否有替代） ----------
for f in css_files:
    r = rel(f)
    text = f.read_text(encoding="utf-8", errors="ignore")
    lines = text.split("\n")
    for ln, line in enumerate(lines, 1):
        if "outline: none" in line or "outline:none" in line:
            ctx = "\n".join(lines[ln - 1:ln + 3])
            has_alt = "box-shadow" in ctx or "outline:" in ctx.replace("outline: none", "").replace("outline:none", "")
            add("outline_none", {"file": r, "line": ln, "has_alternative": has_alt})

# ---------- 11. AI 生成内容标注覆盖 ----------
AI_OUTPUT_HINTS = ["summary", "optimization", "智能分析", "修复建议", "由模型生成"]
ai_files = set()
for f in ts_files:
    r = rel(f)
    text = f.read_text(encoding="utf-8", errors="ignore")
    has_output = any(h in text for h in AI_OUTPUT_HINTS[:4])
    has_notice = "AiGeneratedNotice" in text
    if has_output:
        ai_files.add(r)
        if not has_notice and "evolution" not in r.lower() and "logs" not in r.lower():
            add("ai_output_no_notice", {"file": r})

# ---------- 12. 禁用按钮缺 Tooltip ----------
for f in ts_files:
    r = rel(f)
    text = f.read_text(encoding="utf-8", errors="ignore")
    lines = text.split("\n")
    for ln, line in enumerate(lines, 1):
        if "disabled" in line and "<Button" in " ".join(lines[max(0, ln - 4):ln]):
            ctx = "\n".join(lines[max(0, ln - 6):ln + 8])
            if "Tooltip" not in ctx and "title=" not in ctx:
                add("disabled_no_tooltip", {"file": r, "line": ln})

# ---------- 13. 状态表达仅颜色（check：StatusBadge 之外的状态色点） ----------
# 由 8 覆盖（bare_badge）

# ---------- 14. 页面四段式模板覆盖 ----------
PAGES = {
    "/dashboard": ["pages/dashboard/DashboardPage.tsx"],
    "/skills": ["pages/skills/SkillsMarketplace.tsx"],
    "/gateway": ["pages/gateway/GatewayPage.tsx"],
    "/versions": ["pages/versions/VersionsPage.tsx"],
    "/troubleshoot": ["pages/troubleshoot/TroubleshootPage.tsx"],
    "/logs": ["pages/logs/LogsPage.tsx", "pages/logs/Logs.tsx"],
    "/core-files": ["pages/core-files/CoreFilesPage.tsx", "pages/CoreFilesPage.tsx"],
    "/evolution": ["pages/evolution/EvolutionPage.tsx"],
    "/settings": ["pages/settings/SettingsPage.tsx"],
    "/setup": ["pages/setup/SetupPage.tsx"],
    "/preferences": ["pages/preferences/PreferencesPage.tsx", "pages/PreferencesPage.tsx"],
}
template_report = {}
for route, candidates in PAGES.items():
    found = None
    for c in candidates:
        if (ROOT / c).exists():
            found = c
            break
    if not found:
        template_report[route] = {"file": None, "note": "未定位到页面文件"}
        continue
    text = (ROOT / found).read_text(encoding="utf-8", errors="ignore")
    template_report[route] = {
        "file": found,
        "section_header": "SectionHeader" in text,
        "conclusion_bar": "ConclusionBar" in text or "HeroConclusion" in text,
        "advanced_details": "AdvancedDetails" in text,
        "ai_notice": "AiGeneratedNotice" in text,
    }

result = {
    "meta": {"date": "2026-09-10", "scope": "ui/src", "files_scanned": len(all_files)},
    "findings": {k: v for k, v in findings.items() if v},
    "counts": {k: len(v) for k, v in findings.items()},
    "page_template": template_report,
}
OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

print(f"扫描 {len(all_files)} 个文件，结果写入 {OUT.name}\n")
print("=== 问题计数 ===")
for k in sorted(result["counts"]):
    print(f"  {k:<24} {result['counts'][k]}")
print("\n=== 页面模板覆盖 ===")
for route, info in template_report.items():
    if info.get("file") is None:
        print(f"  {route:<14} ?  ({info['note']})")
        continue
    marks = []
    marks.append("标题✓" if info["section_header"] else "标题✗")
    marks.append("结论条✓" if info["conclusion_bar"] else "结论条✗")
    marks.append("高级详情✓" if info["advanced_details"] else "高级详情✗")
    if info["ai_notice"]:
        marks.append("AI标注✓")
    print(f"  {route:<14} {' '.join(marks)}")
