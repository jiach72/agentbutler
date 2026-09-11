/**
 * 阶段 2（品牌资产替换）专项验收测试。
 *
 * 断言来源：docs/brand/02 视觉识别规范 §2.2 / §2.3 / §2.4。
 * 分两层：
 *   静态层 —— 直接读文件，验证资产内容本身符合规范；
 *   渲染层 —— 用 Playwright 打开真实应用，验证界面确实引用并正确呈现了新资产。
 * 只有两层都通过才算通过：静态合规但界面仍引用旧文件，等于没换。
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
const require = createRequire('C:/Users/jiach/.workbuddy/binaries/node/workspace/');
const { chromium } = require('playwright');

const ROOT = 'C:/Users/jiach/Documents/Agent Butler';
const BRAND = `${ROOT}/ui/public/brand`;
const DOCS = `${ROOT}/docs/brand/assets`;

const fails = [];
const oks = [];
const ok = (m) => oks.push(m);
const bad = (m) => fails.push(m);
const read = (p) => readFileSync(p, 'utf8');

/* ───────────── 静态层 ───────────── */

// 1. 规范定义（02 §2.2）的六个定稿文件必须就位
const NEEDED = ['ab-mark.svg', 'ab-mark-inverse.svg', 'ab-mark-sm.svg', 'ab-appicon.svg', 'ab-favicon.svg', 'ab-lockup-h.svg'];
const missing = NEEDED.filter((f) => !existsSync(`${BRAND}/${f}`));
if (missing.length === 0) ok(`静态 1 · 六个定稿文件全部就位（${NEEDED.length}）`);
else bad(`静态 1 · 缺文件: ${missing.join(', ')}`);

// 2. v1 命名文件必须清干净
const v1Leftover = readdirSync(BRAND).filter((f) => /^ab-icon|^ab-lockup-vertical/.test(f));
if (v1Leftover.length === 0) ok('静态 2 · 已无 v1 命名资产（ab-icon* / ab-lockup-vertical*）');
else bad(`静态 2 · 残留 v1 命名文件: ${v1Leftover.join(', ')}`);

// 3. 六个文件必须与 docs 定稿逐字一致（防止手改走样）
const drifted = NEEDED.filter(
  (f) => existsSync(`${BRAND}/${f}`) && read(`${BRAND}/${f}`) !== read(`${DOCS}/${f}`),
);
if (drifted.length === 0) ok('静态 3 · 与 docs/brand/assets 定稿逐字一致');
else bad(`静态 3 · 与定稿不一致: ${drifted.join(', ')}`);

// 4. favicon 不得含信号青（02 §1.1「信号色不做装饰、不用在品牌标志里」+ §2.4 禁用项）
const fav = read(`${ROOT}/ui/public/favicon.svg`);
if (!/#35D0BA/i.test(fav)) ok('静态 4 · favicon 不含信号青 #35D0BA');
else bad('静态 4 · favicon 仍含信号青 #35D0BA（违反 02 §1.1 / §2.4）');
if (/#C8A15A/i.test(fav) && /#0B1728/i.test(fav)) ok('静态 4b · favicon 为墨底 + 黄铜线');
else bad('静态 4b · favicon 不是墨底(#0B1728) + 黄铜线(#C8A15A)');
if (/fill="none"/.test(fav)) ok('静态 4c · 标志线条 fill:none（02 §2.4 禁止填充）');
else bad('静态 4c · favicon 线条被填充（02 §2.4 禁用）');

// 5. 小尺寸版线宽必须是 2.6（02 §2.2）
const sm = read(`${BRAND}/ab-mark-sm.svg`);
if (/stroke-width="2.6"/.test(sm)) ok('静态 5 · ab-mark-sm.svg 线宽 2.6（小尺寸加粗）');
else bad(`静态 5 · ab-mark-sm.svg 线宽不是 2.6`);
// 标准版必须是 2
const mark = read(`${BRAND}/ab-mark.svg`);
if (/stroke-width="2"/.test(mark)) ok('静态 5b · ab-mark.svg 线宽 2（标准）');
else bad('静态 5b · ab-mark.svg 线宽不是 2');

// 6. 禁用造型检查（02 §2.4）：不得有渐变 / 投影 / 描边发光
const gradientHits = NEEDED.filter((f) => /<(linearGradient|radialGradient)|filter=|<filter/i.test(read(`${BRAND}/${f}`)));
if (gradientHits.length === 0) ok('静态 6 · 无渐变 / 投影 / 发光（02 §2.4 禁用）');
else bad(`静态 6 · 含被禁用的渐变或滤镜: ${gradientHits.join(', ')}`);

// 7. 品牌角色（机器人）四件套仍在（本阶段不应误删）
const mascot = readdirSync(`${BRAND}/mascot`);
const mascotNeeded = ['robot-line.svg', 'robot-line-brand.svg', 'robot-line-inverse.svg', 'robot-badge.svg'];
const mascotMissing = mascotNeeded.filter((f) => !mascot.includes(f));
if (mascotMissing.length === 0) ok('静态 7 · 品牌角色四件套完整保留');
else bad(`静态 7 · 品牌角色缺: ${mascotMissing.join(', ')}`);

/* ───────────── 渲染层 ───────────── */

const browser = await chromium.launch();
for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript((mode) => {
    try {
      window.localStorage.setItem('butler.theme', mode);
    } catch {
      /* ignore */
    }
  }, theme);
  await ctx.route('**/ws**', (r) => r.abort());
  const page = await ctx.newPage();
  await page.goto('http://localhost:5199/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.brand-mark', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const info = await page.evaluate(() => {
    const mark = document.querySelector('.brand-mark');
    const r = mark ? mark.getBoundingClientRect() : null;
    const imgs = Array.from(document.querySelectorAll('.brand-logo')).map((el) => {
      const cs = getComputedStyle(el);
      return {
        src: el.getAttribute('src'),
        display: cs.display,
        visible: cs.display !== 'none' && el.getBoundingClientRect().width > 0,
        w: Math.round(el.getBoundingClientRect().width * 100) / 100,
        h: Math.round(el.getBoundingClientRect().height * 100) / 100,
      };
    });
    const link = document.querySelector('link[rel="icon"]');
    return {
      rect: r ? { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 } : null,
      imgs,
      faviconHref: link ? link.getAttribute('href') : null,
    };
  });

  // 8. 侧栏标志尺寸 28×28（02 §2.3）
  if (info.rect && info.rect.w === 28 && info.rect.h === 28) ok(`渲染[${theme}] 8 · 侧栏标识 28×28`);
  else bad(`渲染[${theme}] 8 · 侧栏标识尺寸为 ${JSON.stringify(info.rect)}，应为 28×28`);

  // 9. 引用的确实是新资产
  const srcs = info.imgs.map((i) => i.src);
  const litSrc = info.imgs[0]?.src;
  const darkSrc = info.imgs[1]?.src;
  if (litSrc === '/brand/ab-mark-sm.svg') ok(`渲染[${theme}] 9 · 亮色引用 ab-mark-sm.svg`);
  else bad(`渲染[${theme}] 9 · 亮色引用为 ${litSrc}`);
  if (darkSrc === '/brand/ab-mark-inverse.svg') ok(`渲染[${theme}] 9b · 深色引用 ab-mark-inverse.svg`);
  else bad(`渲染[${theme}] 9b · 深色引用为 ${darkSrc}`);
  if (!srcs.some((s) => /ab-icon/.test(s || ''))) ok(`渲染[${theme}] 9c · 已无对 ab-icon* 的引用`);
  else bad(`渲染[${theme}] 9c · 仍在引用 ab-icon*`);

  // 10. 主题切换确实生效（双图法：同一时刻只有一张可见）
  const visible = info.imgs.filter((i) => i.visible);
  const expectVisible = theme === 'dark' ? '/brand/ab-mark-inverse.svg' : '/brand/ab-mark-sm.svg';
  if (visible.length === 1 && visible[0].src === expectVisible) {
    ok(`渲染[${theme}] 10 · 双图切换正确，仅 ${expectVisible} 可见（${visible[0].w}×${visible[0].h}）`);
  } else {
    bad(`渲染[${theme}] 10 · 可见图异常: ${JSON.stringify(visible.map((v) => v.src))}，应为 [${expectVisible}]`);
  }

  // 11. favicon 已指向替换后的文件，且服务端返回的内容确实不含信号青
  if (info.faviconHref === '/favicon.svg') ok(`渲染[${theme}] 11 · <link rel=icon> 指向 /favicon.svg`);
  else bad(`渲染[${theme}] 11 · favicon href 为 ${info.faviconHref}`);
  const served = await page.evaluate(async () => {
    const res = await fetch('/favicon.svg');
    return { status: res.status, body: await res.text() };
  });
  if (served.status === 200 && !/#35D0BA/i.test(served.body)) {
    ok(`渲染[${theme}] 11b · 实际服务的 favicon（HTTP ${served.status}）不含信号青`);
  } else {
    bad(`渲染[${theme}] 11b · 服务的 favicon 异常: HTTP ${served.status}，含信号青=${/#35D0BA/i.test(served.body)}`);
  }

  await ctx.close();
}
browser.close().catch(() => {});

console.log('\n===== 阶段 2 · 品牌资产替换 · 验收 =====\n');
oks.forEach((m) => console.log(`  PASS  ${m}`));
if (fails.length > 0) {
  console.log('\n----- 失败项 -----');
  fails.forEach((m) => console.log(`  FAIL  ${m}`));
  console.log(`\n结果: 未通过（${fails.length} 项失败，${oks.length} 项通过）\n`);
  process.exit(1);
}
console.log(`\n结果: 通过（${oks.length} 项断言全部成立）\n`);
process.exit(0);
