#!/usr/bin/env python3
"""给 ui-audit-report.html 的差距表格逐行标注迁移完成状态。

策略：
- DONE_ROWS：已完整修复的行（按行内特征文本匹配）→ 在级别徽标后追加 b-done「已修复」
- PART_ROWS：部分完成的行 → 追加 b-warn「部分完成」
- 其余（页面模板逐页表里未接入的页）→ 不动，保留原始「缺」标记
"""
from pathlib import Path

F = Path("C:/Users/jiach/Documents/Agent Butler/docs/brand/ui-audit-report.html")

# 特征文本（行内唯一或足够特异）→ 状态
DONE_ROWS = [
    # §01 差距总览
    ("亮色主色", "P0"),
    ("暗色主色", "P0"),
    ("黄铜的角色", "P0"),
    ("中性色", "P0"),
    ("硬编码色值", "P0"),
    ("favicon", "P0"),
    ("徽标 tone", "P1"),
    ("危险弹窗", "P1"),
    ("AI 内容标注", "P1"),
    ("焦点可见", "P1"),
    ("侧栏 / 内容区", "P2"),
    ("圆角", "P2"),
    ("z-index", "P2"),
    # §05 品牌资产表
    ("墨底 <code data-page-node-id=\"AnxMa8Hdsfi95HKAiCsyDW\">#0B1728</code>", "P0"),
    ("ab-mark-sm.svg", "P0"),
    ("v1 命名，缺 6 个定稿文件", "P0"),
]

text = F.read_text(encoding="utf-8")
lines = text.split("\n")
done = part = 0

for i, line in enumerate(lines):
    for key, level in DONE_ROWS:
        if key in line and f'<span class="badge b-error" data-page-node-id' in line and f">{level}</span>" in line and "b-done" not in line:
            lines[i] = line.replace(
                f'<span class="badge b-error"',
                f'<span class="badge b-done">已修复</span><span class="badge b-error"',
                1,
            )
            done += 1
            break
    else:
        # 部分完成行
        if "页面模板" in line and 'badge b-warn' in line and "b-done" not in line:
            lines[i] = line.replace(
                '<span class="badge b-warn"',
                '<span class="badge b-warn">部分完成</span><span class="badge b-warn"',
                1,
            )
            part += 1
        elif ("主按钮" in line and 'badge b-warn' in line and "b-done" not in line
              and "每屏 ≤ 1" in line):
            lines[i] = line.replace(
                '<span class="badge b-warn"',
                '<span class="badge b-warn">部分完成</span><span class="badge b-warn"',
                1,
            )
            part += 1

F.write_text("\n".join(lines), encoding="utf-8")
print(f"已修复标注 {done} 行，部分完成标注 {part} 行")
