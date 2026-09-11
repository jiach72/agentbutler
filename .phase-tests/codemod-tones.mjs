/**
 * 阶段 3 一次性改造：把 v1.2 徽标 tone 字面量迁移到 v2.0 的 6 种 tone。
 *
 * 规则（依据 docs/brand/02 §1.4 与 03 §3.2）：
 *   muted → offline（确定连不上 / 未接入 / 已停止）或 unknown（还没读到数据）
 *           —— 用相邻的 label 文案判定，两者同色只能靠文案区分，所以不能一律变 unknown
 *   muted + "当前版本" → brand（§3.2 把「推荐 / 当前版本 / 已备份」划给 brand）
 *   info  → brand（蓝是交互色，不进徽标语义）
 *   pulse → unknown（紫色不在品牌色板内，语气是"进行中"）
 *
 * 打印每一处决策，便于人工复核。改完由 tsc 兜底验证没有漏网。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';

const ROOT = 'C:/Users/jiach/Documents/Agent Butler/ui/src';

const OFFLINE_HINTS = ['未接入', '未配置', '未启动', '已停止', '停止', '连不上', '离线', '不可达'];
const BRAND_LABELS = ['当前版本', '推荐', '已备份', '已确认'];

function decideNeutral(label) {
  if (label && BRAND_LABELS.some((b) => label.includes(b))) return 'brand';
  if (label && OFFLINE_HINTS.some((h) => label.includes(h))) return 'offline';
  return 'unknown';
}

/** 递归收集 .ts / .tsx（不用 git ls-files：本仓对象库损坏，git 命令不可靠）。 */
function walk(dir, rel = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const abs = `${dir}/${name}`;
    const childRel = rel ? `${rel}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, childRel));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(childRel);
  }
  return out;
}

const files = walk(ROOT);
console.log(`扫描 ${files.length} 个源文件`);

let totalChanges = 0;
const changes = [];

for (const rel of files) {
  const abs = `${ROOT}/${rel}`;
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  const before = text;

  // 1) 对象字面量 / 三元里的 tone: "muted"
  text = text.replace(/tone:\s*"muted"/g, (m, offset) => {
    const win = text.slice(Math.max(0, offset - 160), offset + 160);
    const lm = win.match(/label:\s*"([^"]*)"/);
    const tone = decideNeutral(lm ? lm[1] : null);
    changes.push(`${rel}: tone: "muted"${lm ? ` (label="${lm[1]}")` : ''} → "${tone}"`);
    return `tone: "${tone}"`;
  });

  // 2) JSX 属性 tone="muted"
  text = text.replace(/tone="muted"/g, (m, offset) => {
    const win = text.slice(Math.max(0, offset - 160), offset + 160);
    const lm = win.match(/label="([^"]*)"/) ?? win.match(/label=\{"([^"]*)"\}/);
    const tone = decideNeutral(lm ? lm[1] : null);
    changes.push(`${rel}: tone="muted"${lm ? ` (label="${lm[1]}")` : ''} → "${tone}"`);
    return `tone="${tone}"`;
  });

  // 3) info → brand
  text = text.replace(/tone:\s*"info"/g, () => {
    changes.push(`${rel}: tone: "info" → "brand"`);
    return 'tone: "brand"';
  });
  text = text.replace(/tone="info"/g, () => {
    changes.push(`${rel}: tone="info" → "brand"`);
    return 'tone="brand"';
  });

  // 4) pulse → unknown
  text = text.replace(/tone:\s*"pulse"/g, () => {
    changes.push(`${rel}: tone: "pulse" → "unknown"`);
    return 'tone: "unknown"';
  });
  text = text.replace(/tone="pulse"/g, () => {
    changes.push(`${rel}: tone="pulse" → "unknown"`);
    return 'tone="unknown"';
  });

  if (text !== before) {
    writeFileSync(abs, text, 'utf8');
    totalChanges += 1;
  }
}

console.log(`改动文件数: ${totalChanges}`);
console.log(`替换处数: ${changes.length}`);
console.log('');
const byKind = {};
for (const c of changes) {
  const k = c.replace(/^.*?: /, '').replace(/ \(.*?\)/, '').replace(/ → .*$/, '');
  byKind[k] = (byKind[k] ?? 0) + 1;
}
console.log('按类型统计:');
Object.entries(byKind).forEach(([k, v]) => console.log(`  ${k.padEnd(18)} ${v}`));
console.log('');
console.log('明细（含 label 判定依据）:');
changes.forEach((c) => console.log('  ' + c));
