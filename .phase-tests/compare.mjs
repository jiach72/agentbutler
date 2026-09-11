/**
 * 阶段验收比对脚本：断言候选快照相对基线满足「结构不变、颜色按规范变」。
 *
 * 用法：node compare.mjs <baselineLabel> <candidateLabel> [--expect-color-change]
 *
 * 核心断言（缺一不可）：
 *   A. 【静默塌陷防线】候选的 --butler-* 键集合必须是基线的超集 —— 一个都不能少。
 *      少一个变量在 CSS 里不会报错，只会退化成继承值，是最难排查的失败。
 *   B. 【结构不变】间距/字号/圆角/动效/字体等非颜色变量值必须逐一相同。
 *   C. 【布局不变】关键结构元素的 boundingRect 必须完全相同。
 *   D. 【排版不变】关键元素的 font-size/line-height/padding/radius/gap 必须相同。
 *   E. 【文档高度不变】整页 scrollHeight 必须相同（塌陷的最粗粒度指标）。
 *   F. 【新变量就位】--ab-* 变量必须存在。
 *   G. 若加 --expect-color-change：颜色变量应发生预期变化（否则说明值没切换）。
 */
import { readFileSync } from 'node:fs';

const [baseLabel, candLabel] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const expectColorChange = process.argv.includes('--expect-color-change');
/**
 * 显式豁免清单：某些阶段**故意**要改特定元素的几何（例如阶段 2 把侧栏标志
 * 从 34×34 改成规范要求的 28×28）。把这些选择器列进来，它们的变化会被记为
 * 「预期内变化」而不是回归；未列出的元素仍然必须逐像素一致。
 *
 * 用 `;` 分隔以兼容含逗号的复合选择器（例如
 * ".content > .product-page, .content > [class$=\"-page\"]"）。
 * 用法：--allow=.brand-mark;.brand;.app-nav
 */
const allowArg = process.argv.find((a) => a.startsWith('--allow='));
const ALLOWED = new Set(
  (allowArg ? allowArg.slice('--allow='.length) : '').split(';').map((s) => s.trim()).filter(Boolean),
);

/**
 * `--ignore-prefix`：阶段 5B 删桥场景专用。
 * 删别名桥时，基线有 `--butler-*` 候选无，A/B 断言会大量报错；
 * 用此标志把这些「已退役」键从 A / B 检查中排除。
 * 用法：--ignore-prefix=--butler-
 */
const ignorePrefixArg = process.argv.find((a) => a.startsWith('--ignore-prefix='));
const IGNORE_PREFIX = ignorePrefixArg ? ignorePrefixArg.slice('--ignore-prefix='.length) : '';
const DIR = 'C:/Users/jiach/Documents/Agent Butler/.phase-tests';

const base = JSON.parse(readFileSync(`${DIR}/${baseLabel}.json`, 'utf8'));
const cand = JSON.parse(readFileSync(`${DIR}/${candLabel}.json`, 'utf8'));

/** 结构性变量：这些值在 token 迁移中必须逐字不变。 */
const STRUCTURAL = [
  /^--butler-space-\d+$/,
  /^--butler-text-(xs|sm|md|lg|xl|xxl)$/,
  /^--butler-radius-(card|control)$/,
  /^--butler-control-h$/,
  /^--butler-dur-(fast|base|slow)$/,
  /^--butler-ease$/,
  /^--butler-(body|mono)-font$/,
];
const isStructural = (k) => STRUCTURAL.some((re) => re.test(k));

const failures = [];
const notes = [];
const pass = (m) => notes.push(`  PASS  ${m}`);
const fail = (m) => failures.push(m);

for (const theme of ['light', 'dark']) {
  const b = base.themes[theme];
  const c = cand.themes[theme];
  if (!b || !c) {
    fail(`[${theme}] 快照缺失`);
    continue;
  }

  /* ---- A. 键集合超集（已退役前缀忽略） ---- */
  const bKeys = Object.keys(b.vars);
  const bKeysFiltered = IGNORE_PREFIX ? bKeys.filter((k) => !k.startsWith(IGNORE_PREFIX)) : bKeys;
  const cKeys = new Set(Object.keys(c.vars));
  const missing = bKeysFiltered.filter((k) => !cKeys.has(k));
  if (missing.length === 0) {
    pass(`[${theme}] A 键集合无缺失${IGNORE_PREFIX ? `（已忽略 ${IGNORE_PREFIX}* 前缀）` : ''}（基线 ${bKeysFiltered.length} 个键全部保留）`);
  } else {
    fail(`[${theme}] A 缺失 ${missing.length} 个变量 → CSS 将静默退化为继承值:`);
    missing.forEach((k) => fail(`         ${k}  (基线值 ${b.vars[k]})`));
  }

  /* ---- B. 结构变量值不变（已退役前缀忽略） ---- */
  const structDiffs = [];
  const bKeysForB = IGNORE_PREFIX ? bKeys.filter((k) => !k.startsWith(IGNORE_PREFIX)) : bKeys;
  for (const k of bKeysForB) {
    if (!isStructural(k)) continue;
    if (c.vars[k] !== b.vars[k]) structDiffs.push(`${k}: ${b.vars[k]} → ${c.vars[k]}`);
  }
  if (structDiffs.length === 0) {
    const n = bKeys.filter(isStructural).length;
    pass(`[${theme}] B 结构变量 ${n} 个逐字不变（间距/字号/圆角/动效/字体）`);
  } else {
    fail(`[${theme}] B 结构变量被改动 ${structDiffs.length} 处（会导致布局或排版漂移）:`);
    structDiffs.forEach((d) => fail(`         ${d}`));
  }

  /* ---- C. 布局几何不变（豁免清单除外） ---- */
  const geoDiffs = [];
  const geoExpected = [];
  for (const [sel, g] of Object.entries(b.geo)) {
    const cg = c.geo[sel];
    if (JSON.stringify(g) === JSON.stringify(cg)) continue;
    const line = `${sel}: ${JSON.stringify(g)} → ${JSON.stringify(cg)}`;
    if (ALLOWED.has(sel)) geoExpected.push(line);
    else geoDiffs.push(line);
  }
  if (geoDiffs.length === 0) {
    const n = Object.keys(b.geo).length;
    if (geoExpected.length > 0) {
      pass(`[${theme}] C 布局几何 ${n - geoExpected.length}/${n} 一致，${geoExpected.length} 处为豁免项内的预期变化:`);
      geoExpected.forEach((d) => notes.push(`         预期 ${d}`));
    } else {
      pass(`[${theme}] C 布局几何 ${n} 个元素完全一致`);
    }
  } else {
    fail(`[${theme}] C 布局几何出现 ${geoDiffs.length} 处非预期变化:`);
    geoDiffs.forEach((d) => fail(`         ${d}`));
    geoExpected.forEach((d) => notes.push(`         预期(已豁免) ${d}`));
  }

  /* ---- D. 排版取样不变 ---- */
  const styleDiffs = [];
  for (const [sel, s] of Object.entries(b.style)) {
    const cs = c.style[sel] ?? {};
    for (const [p, v] of Object.entries(s)) {
      if (cs[p] !== v) styleDiffs.push(`${sel}.${p}: ${v} → ${cs[p]}`);
    }
  }
  if (styleDiffs.length === 0) {
    pass(`[${theme}] D 排版取样（font/padding/radius/gap）完全一致`);
  } else {
    fail(`[${theme}] D 排版取样变化 ${styleDiffs.length} 处:`);
    styleDiffs.slice(0, 12).forEach((d) => fail(`         ${d}`));
  }

  /* ---- E. 文档高度 / 节点数 ---- */
  if (b.docHeight === c.docHeight) pass(`[${theme}] E 整页 scrollHeight 一致（${b.docHeight}px）`);
  else fail(`[${theme}] E 整页高度变化: ${b.docHeight}px → ${c.docHeight}px（疑似布局塌陷）`);

  if (b.nodeCount === c.nodeCount) pass(`[${theme}] F DOM 节点数一致（${b.nodeCount}）`);
  else fail(`[${theme}] F DOM 节点数变化: ${b.nodeCount} → ${c.nodeCount}（结构异常增减）`);

  /* ---- E2. 文本度量（字体解析是否漂移） ---- */
  const bm = b.textMetrics;
  const cm = c.textMetrics;
  if (!bm || !cm) {
    fail(`[${theme}] E2 缺少文本度量数据（请重新捕获基线）`);
  } else if (bm.width === cm.width && bm.height === cm.height && bm.resolvedFont === cm.resolvedFont) {
    pass(`[${theme}] E2 文本度量与字体解析一致（宽 ${bm.width}px / 高 ${bm.height}px）`);
  } else {
    fail(`[${theme}] E2 文本度量漂移（字体解析变化会导致全站文字换行位置改变）:`);
    fail(`         宽 ${bm.width} → ${cm.width} / 高 ${bm.height} → ${cm.height}`);
    if (bm.resolvedFont !== cm.resolvedFont) fail(`         字体栈: ${bm.resolvedFont} → ${cm.resolvedFont}`);
  }

  /* ---- G. --ab-* 就位 ---- */
  const abKeys = Object.keys(c.vars).filter((k) => k.startsWith('--ab-'));
  if (abKeys.length > 0) pass(`[${theme}] G --ab-* 新变量已就位（${abKeys.length} 个）`);
  else fail(`[${theme}] G --ab-* 变量缺失`);

  /* ---- H. 颜色变化符合预期 ---- */
  const colorChangedBase = bKeys.filter((k) => !isStructural(k) && c.vars[k] !== b.vars[k]);
  const colorChanged = IGNORE_PREFIX
    ? colorChangedBase.filter((k) => !k.startsWith(IGNORE_PREFIX))
    : colorChangedBase;
  const removedViaPrefix = IGNORE_PREFIX
    ? colorChangedBase.length - colorChanged.length
    : 0;
  if (expectColorChange) {
    if (colorChanged.length > 0) {
      pass(`[${theme}] H 颜色变量按预期变化 ${colorChanged.length} 处${IGNORE_PREFIX ? `（已忽略 ${IGNORE_PREFIX}* 前缀的 ${removedViaPrefix} 个删除）` : ''}，例如:`);
      colorChanged.slice(0, 5).forEach((k) => notes.push(`         ${k}: ${b.vars[k]} → ${c.vars[k]}`));
    } else if (IGNORE_PREFIX && colorChangedBase.length > 0) {
      // 用了 --ignore-prefix 且基线有这些前缀的"颜色变化"全被归为删键 N/A。
      pass(`[${theme}] H 颜色变量通过 --ignore-prefix 屏蔽：基线 ${colorChangedBase.length} 个 ${IGNORE_PREFIX}* 已被视作删键`);
    } else {
      fail(`[${theme}] H 期望颜色变化但未检测到任何变化`);
    }
  } else if (colorChanged.length === 0) {
    pass(`[${theme}] H 颜色变量零变化（本次阶段为值中性迁移）`);
  } else {
    fail(`[${theme}] H 本阶段不应改变颜色，但检测到 ${colorChanged.length} 处变化:`);
    colorChanged.slice(0, 10).forEach((k) => fail(`         ${k}: ${b.vars[k]} → ${c.vars[k]}`));
  }
}

console.log(`\n===== 阶段验收比对: ${baseLabel} → ${candLabel} =====\n`);
notes.forEach((n) => console.log(n));
if (failures.length > 0) {
  console.log('\n----- 失败项 -----');
  failures.forEach((f) => console.log(`  FAIL  ${f}`));
  console.log(`\n结果: 未通过（${failures.length} 项失败）\n`);
  process.exit(1);
}
console.log('\n结果: 通过（全部断言成立）\n');
