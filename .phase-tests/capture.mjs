/**
 * 阶段验收捕获脚本：抓取运行时的品牌 CSS 变量 + 布局几何 + 截图。
 *
 * 用法：
 *   node capture.mjs --record phase0-baseline   # 被动录制 API 响应 + 抓快照
 *   node capture.mjs phase1-candidate           # 用夹具回放 + 抓快照
 *
 * 为什么要夹具：本机 7531 有真实后端在跑，仪表盘数据（上次检查时间、计数）每次
 * 捕获都会变，会让 docHeight 之类的断言产生假失败。录制后固定回放，两次捕获的
 * 输入与 DOM 才可比。
 *
 * 为什么录制用「被动监听」而不是 route.fetch()：实测 route.fetch() 重发的请求会被
 * 后端判为未授权（全部 401），页面退化成访问口令弹窗而非仪表盘 —— 那样测的就不是
 * 真实界面了。所以录制阶段完全不拦截请求，只用 page.on('response') 旁路抄收响应体；
 * 回放阶段才用 route.fulfill 提供冻结数据。
 *
 * /ws 是实时事件流，两个阶段一律阻断，保证两次渲染一致。
 *
 * 为什么同时抓数值而非只截图：Token 迁移的验收关键是
 * 「结构/排版零变化、颜色按规范变化」。目视截图不可靠，所以抓可断言的数值。
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
const require = createRequire('C:/Users/jiach/.workbuddy/binaries/node/workspace/');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const RECORD = args.includes('--record');
const LABEL = args.find((a) => !a.startsWith('--')) ?? 'baseline';
const BASE = process.env.CAPTURE_URL ?? 'http://localhost:5199';
const OUT = 'C:/Users/jiach/Documents/Agent Butler/.phase-tests';
const FIXTURES = `${OUT}/api-fixtures.json`;
mkdirSync(OUT, { recursive: true });

/** 布局骨架选择器：这些元素的几何在 token 迁移中必须保持不变。 */
const GEO_SELECTORS = [
  '.app',
  '.app-sider',
  '.app-main',
  '.app-topbar',
  '.content',
  '.brand',
  '.brand-mark',
  '.app-nav',
  '.sidebar-bottom',
  '.topbar-leading',
  '.topbar-actions',
  '.content > .product-page, .content > [class$="-page"]',
  '.ant-alert',
  '.ant-card',
  '.ant-btn-primary',
  '.ant-collapse',
];

/** 排版取样：字号/行高/内边距/圆角/间距在迁移中必须保持不变。 */
const STYLE_PROPS = [
  'fontSize',
  'lineHeight',
  'fontWeight',
  'fontFamily',
  'paddingTop',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'gap',
  'borderTopWidth',
];

const fixtures = existsSync(FIXTURES)
  ? JSON.parse(readFileSync(FIXTURES, 'utf8'))
  : { responses: {} };
const recorded = {};
const missed = [];

const result = { label: LABEL, url: BASE, capturedAt: new Date().toISOString(), themes: {} };
const browser = await chromium.launch();

for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  // 主题在 ThemeProvider 首帧读取，必须在页面脚本执行前写入 localStorage。
  await ctx.addInitScript((mode) => {
    try {
      window.localStorage.setItem('butler.theme', mode);
    } catch {
      /* ignore */
    }
  }, theme);

  // 事件流一律阻断，保证两次渲染一致。
  await ctx.route('**/ws**', (route) => route.abort());

  const page = await ctx.newPage();

  if (RECORD) {
    // 被动抄收：不改变请求本身，所以鉴权行为与真实浏览器一致。
    page.on('response', async (res) => {
      let url;
      try {
        url = new URL(res.url());
      } catch {
        return;
      }
      if (!url.pathname.startsWith('/api')) return;
      const key = url.pathname + url.search;
      try {
        recorded[key] = {
          status: res.status(),
          contentType: res.headers()['content-type'] ?? 'application/json',
          body: await res.text(),
        };
      } catch {
        /* 响应体不可读（重定向等）时忽略 */
      }
    });
  } else {
    await ctx.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const key = url.pathname + url.search;
      const fx = fixtures.responses[key];
      if (fx) {
        await route.fulfill({ status: fx.status, contentType: fx.contentType, body: fx.body });
      } else {
        missed.push(key);
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: '{"error":"no fixture"}',
        });
      }
    });
  }

  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.app-topbar', { timeout: 20000 }).catch(() => {});
  // 等仪表盘数据落位：结论条出现即认为首屏数据已到。
  await page
    .waitForFunction(
      () => document.querySelectorAll('.ant-alert').length > 0,
      undefined,
      { timeout: 15000 },
    )
    .catch(() => {});
  await page.waitForTimeout(3500);

  const snapshot = await page.evaluate(
    ({ geoSelectors, styleProps }) => {
      const root = document.documentElement;

      // 1) 内联 CSS 变量（applyThemeCssBridge 直接写在 documentElement.style 上）
      const vars = {};
      for (const name of Array.from(root.style)) {
        if (name.startsWith('--')) vars[name] = root.style.getPropertyValue(name).trim();
      }

      // 2) 布局几何
      const geo = {};
      for (const sel of geoSelectors) {
        const el = document.querySelector(sel);
        if (!el) {
          geo[sel] = null;
          continue;
        }
        const r = el.getBoundingClientRect();
        geo[sel] = {
          x: Math.round(r.x * 100) / 100,
          y: Math.round(r.y * 100) / 100,
          w: Math.round(r.width * 100) / 100,
          h: Math.round(r.height * 100) / 100,
        };
      }

      // 3) 排版取样
      const style = {};
      for (const sel of geoSelectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const cs = getComputedStyle(el);
        const entry = {};
        for (const p of styleProps) entry[p] = cs[p];
        style[sel] = entry;
      }

      // 4) 文本度量探针：字体解析变化会改变这个宽度
      const probe = document.createElement('span');
      probe.textContent = '一切正常，1 个智能体在线 · Agent Butler 0123456789';
      probe.style.cssText =
        'position:absolute;visibility:hidden;white-space:nowrap;font-family:var(--butler-body-font);font-size:14px;font-weight:400;letter-spacing:normal;';
      document.body.appendChild(probe);
      const pr = probe.getBoundingClientRect();
      const textMetrics = {
        width: Math.round(pr.width * 100) / 100,
        height: Math.round(pr.height * 100) / 100,
        resolvedFont: getComputedStyle(probe).fontFamily,
      };
      probe.remove();

      return {
        vars,
        geo,
        style,
        textMetrics,
        docHeight: Math.round(document.documentElement.scrollHeight),
        nodeCount: document.querySelectorAll('*').length,
        // 记录是否落在访问口令弹窗上，避免"测了个寂寞"
        sawAccessGate: document.querySelector('.ant-modal') !== null,
        sawDashboard: document.querySelector('.ant-alert') !== null,
        dataTheme: root.dataset.theme,
      };
    },
    { geoSelectors: GEO_SELECTORS, styleProps: STYLE_PROPS },
  );

  snapshot.screenshots = {};
  for (const [suffix, opts] of [
    ['viewport', {}],
    ['full', { fullPage: true }],
  ]) {
    const file = `${OUT}/${LABEL}-${theme}-${suffix}.png`;
    await page.screenshot({ path: file, ...opts });
    snapshot.screenshots[suffix] = file;
  }

  result.themes[theme] = snapshot;
  await ctx.close();
}

// browser.close() 在本机会挂起（应用保持的 WS 连接 + Windows 下 Playwright 收尾），
// 所以不 await：数据已全部在内存里，写完文件后强制退出。
browser.close().catch(() => {});

if (RECORD) {
  writeFileSync(FIXTURES, JSON.stringify({ responses: recorded }, null, 2), 'utf8');
  console.log(`recorded ${Object.keys(recorded).length} API fixtures → ${FIXTURES}`);
}
if (missed.length > 0) {
  console.log(`WARN: ${[...new Set(missed)].length} 个请求无夹具（已按 503 处理）:`);
  [...new Set(missed)].forEach((m) => console.log(`   ${m}`));
}

writeFileSync(`${OUT}/${LABEL}.json`, JSON.stringify(result, null, 2), 'utf8');
for (const theme of ['light', 'dark']) {
  const s = result.themes[theme];
  console.log(
    `[${theme}] --butler-*=${Object.keys(s.vars).filter((k) => k.startsWith('--butler-')).length}` +
      ` --ab-*=${Object.keys(s.vars).filter((k) => k.startsWith('--ab-')).length}` +
      ` 文本宽=${s.textMetrics.width} docHeight=${s.docHeight} 节点=${s.nodeCount}` +
      ` 仪表盘=${s.sawDashboard} 口令弹窗=${s.sawAccessGate}`,
  );
}

process.exit(0);
