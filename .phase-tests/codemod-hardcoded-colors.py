#!/usr/bin/env python3
"""
Phase 4B codemod: 替换 §2.3 列出的硬编码色值为品牌 token。

两阶段：
1) `var(--ant-color-X, #Y)` 改写为 `var(--ab-Y-name)`。
2) 裸 `#Y` 字面量改写为 `var(--ab-Y-name)`。

文件原地改写；原始内容须先用 snap.mjs 备份（不要靠脚本处理）。
"""
import re
import sys
from pathlib import Path

# 阶段 1：var(--ant-color-*, #X) → var(--ab-X-name)
VAR_REPLACEMENTS = [
    (r'var\(--ant-color-primary,\s*#2f54eb\)',                       'var(--ab-primary)'),
    (r'var\(--ant-color-primary,\s*#1677ff\)',                       'var(--ab-primary)'),
    (r'var\(--ant-color-primary-bg,\s*#f0f5ff\)',                    'var(--ab-primary-soft)'),
    (r'var\(--ant-color-primary-bg-hover,\s*#f0f5ff\)',              'var(--ab-primary-soft)'),
    (r'var\(--ant-color-primary-border,\s*#adc6ff\)',                'var(--ab-primary-soft-border)'),
    (r'var\(--ant-color-primary-border-hover,\s*#adc6ff\)',         'var(--ab-primary-soft-border)'),
    (r'var\(--ant-color-success,\s*#52c41a\)',                       'var(--ab-ok)'),
    (r'var\(--ant-color-success-bg,\s*#f6ffed\)',                    'var(--ab-ok-soft)'),
    (r'var\(--ant-color-warning,\s*#faad14\)',                       'var(--ab-warn)'),
    (r'var\(--ant-color-warning-bg,\s*#fffbe6\)',                    'var(--ab-warn-soft)'),
    (r'var\(--ant-color-error,\s*#ff4d4f\)',                         'var(--ab-error)'),
    (r'var\(--ant-color-error-bg,\s*#fff2f0\)',                      'var(--ab-error-soft)'),
    (r'var\(--ant-color-text,\s*#1d2129\)',                          'var(--ab-text)'),
    (r'var\(--ant-color-text-secondary,\s*#4e5969\)',                'var(--ab-text-2)'),
    (r'var\(--ant-color-text-tertiary,\s*#86909c\)',                 'var(--ab-text-3)'),
    (r'var\(--ant-color-text-quaternary,\s*#bfbfbf\)',               'var(--ab-text-4)'),
    (r'var\(--ant-color-border-secondary,\s*#e5e6eb\)',              'var(--ab-border)'),
    (r'var\(--ant-color-border,\s*#e5e6eb\)',                        'var(--ab-border)'),
    (r'var\(--ant-color-split,\s*#c9cdd4\)',                         'var(--ab-border-strong)'),
    (r'var\(--ant-color-fill-tertiary,\s*#f7f8fa\)',                 'var(--ab-sunken)'),
    (r'var\(--ant-color-fill-tertiary,\s*#f0f1f3\)',                 'var(--ab-sunken)'),
    (r'var\(--ant-color-fill-quaternary,\s*#f0f1f3\)',               'var(--ab-sunken)'),
    (r'var\(--ant-color-bg-container,\s*#fff\)',                     'var(--ab-surface)'),
    (r'var\(--ant-color-bg-elevated,\s*#fff\)',                      'var(--ab-surface)'),
    (r'var\(--ant-color-bg-layout,\s*#f7f8fa\)',                     'var(--ab-sunken)'),
    (r'var\(--ant-color-bg-layout,\s*#f5f5f5\)',                     'var(--ab-sunken)'),
    (r'var\(--ant-color-fill,\s*#f7f8fa\)',                          'var(--ab-sunken)'),
    (r'var\(--ant-color-fill-content,\s*#f7f8fa\)',                  'var(--ab-sunken)'),
]

# 阶段 2：裸 hex 字面量 → var(--ab-X-name)（用负回看避免吃掉 URL/其他字段的字符）
HEX_REPLACEMENTS = [
    (r'(?<![0-9a-zA-Z_])#2f54eb(?![0-9a-fA-F])',  'var(--ab-primary)'),
    (r'(?<![0-9a-zA-Z_])#f0f5ff(?![0-9a-fA-F])',  'var(--ab-primary-soft)'),
    (r'(?<![0-9a-zA-Z_])#adc6ff(?![0-9a-fA-F])',  'var(--ab-primary-soft-border)'),
    (r'(?<![0-9a-zA-Z_])#52c41a(?![0-9a-fA-F])',  'var(--ab-ok)'),
    (r'(?<![0-9a-zA-Z_])#f6ffed(?![0-9a-fA-F])',  'var(--ab-ok-soft)'),
    (r'(?<![0-9a-zA-Z_])#faad14(?![0-9a-fA-F])',  'var(--ab-warn)'),
    (r'(?<![0-9a-zA-Z_])#ff4d4f(?![0-9a-fA-F])',  'var(--ab-error)'),
    (r'(?<![0-9a-zA-Z_])#1d2129(?![0-9a-fA-F])',  'var(--ab-text)'),
    (r'(?<![0-9a-zA-Z_])#4e5969(?![0-9a-fA-F])',  'var(--ab-text-2)'),
    (r'(?<![0-9a-zA-Z_])#86909c(?![0-9a-fA-F])',  'var(--ab-text-3)'),
    (r'(?<![0-9a-zA-Z_])#bfbfbf(?![0-9a-fA-F])',  'var(--ab-text-4)'),
    (r'(?<![0-9a-zA-Z_])#e5e6eb(?![0-9a-fA-F])',  'var(--ab-border)'),
    (r'(?<![0-9a-zA-Z_])#c9cdd4(?![0-9a-fA-F])',  'var(--ab-border-strong)'),
    (r'(?<![0-9a-zA-Z_])#f7f8fa(?![0-9a-fA-F])',  'var(--ab-sunken)'),
    (r'(?<![0-9a-zA-Z_])#f0f1f3(?![0-9a-fA-F])',  'var(--ab-sunken)'),
    (r'(?<![0-9a-zA-Z_])#fff(?![0-9a-fA-F])',     'var(--ab-surface)'),
]

ROOT = Path('C:/Users/jiach/Documents/Agent Butler/ui/src')


def process(file_path: Path) -> tuple[int, int]:
    text = file_path.read_text(encoding='utf-8')
    var_count = 0
    for pat, rep in VAR_REPLACEMENTS:
        new, n = re.subn(pat, rep, text)
        if n:
            text = new
            var_count += n

    hex_count = 0
    for pat, rep in HEX_REPLACEMENTS:
        new, n = re.subn(pat, rep, text)
        if n:
            text = new
            hex_count += n

    if var_count or hex_count:
        file_path.write_text(text, encoding='utf-8')
    return var_count, hex_count


if __name__ == '__main__':
    files = sys.argv[1:] or [
        'pages/skills/marketplace.css',
        'pages/core-files.css',
        'pages/settings/settings.css',
        'components/StatStrip.tsx',
        'pages/skills/StagedRiskDetails.tsx',
        'pages/gateway/RelayControlCard.tsx',
    ]
    total_var = total_hex = 0
    for rel in files:
        p = ROOT / rel
        if not p.exists():
            print(f'  ✗ 跳过 {rel}（不存在）')
            continue
        vc, hc = process(p)
        total_var += vc
        total_hex += hc
        print(f'  {"✓" if vc or hc else "-"} {rel:<42} var={vc:>2}  hex={hc:>2}')
    print(f'\n合计 var 替换 {total_var} 处 + hex 替换 {total_hex} 处')
