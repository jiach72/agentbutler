/**
 * 阶段快照 / 还原工具（不依赖 git）。
 *
 * 用法：
 *   node snap.mjs save    <label>        把当前 ui/src 存为快照
 *   node snap.mjs load    <label>        还原到某个快照
 *   node snap.mjs install <dir>          用任意目录下的文件树覆盖 ui/src
 *   node snap.mjs list                   列出快照
 *
 * 为什么要它：本仓的 git 对象库有损坏（缺了一个 pack 文件），
 * `git stash` / `git checkout` 这类依赖对象库的操作不可靠。
 * ui/src 很小（约 500KB），整目录快照既快又能提供可靠的 A/B 与回滚能力。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';

const ROOT = 'C:/Users/jiach/Documents/Agent Butler';
const SRC = `${ROOT}/ui/src`;
const SNAPDIR = `${ROOT}/.phase-tests/snap`;

const [cmd, arg] = process.argv.slice(2);

function save(label) {
  const dest = `${SNAPDIR}/${label}/ui-src`;
  rmSync(`${SNAPDIR}/${label}`, { recursive: true, force: true });
  mkdirSync(`${SNAPDIR}/${label}`, { recursive: true });
  cpSync(SRC, dest, { recursive: true });
  console.log(`saved ui/src → ${dest}`);
}

function load(label) {
  const src = `${SNAPDIR}/${label}/ui-src`;
  if (!existsSync(src)) {
    console.error(`快照不存在: ${src}`);
    process.exit(1);
  }
  rmSync(SRC, { recursive: true, force: true });
  cpSync(src, SRC, { recursive: true });
  console.log(`restored ui/src ← ${src}`);
}

function install(dir) {
  const src = `${ROOT}/.phase-tests/${dir}`;
  if (!existsSync(src)) {
    console.error(`目录不存在: ${src}`);
    process.exit(1);
  }
  // install 用于"只替换若干文件"：把 <dir> 下的相对路径逐一覆盖到仓库根。
  let n = 0;
  const walk = (base, rel) => {
    for (const name of readdirSync(`${base}/${rel}`.replace(/\/$/, ''))) {
      const childRel = rel ? `${rel}/${name}` : name;
      const abs = `${base}/${childRel}`;
      if (statSync(abs).isDirectory()) walk(base, childRel);
      else {
        const target = `${ROOT}/${childRel}`;
        mkdirSync(`${ROOT}/${childRel.split('/').slice(0, -1).join('/')}`, { recursive: true });
        cpSync(abs, target);
        console.log(`  installed ${childRel}`);
        n += 1;
      }
    }
  };
  walk(src, '');
  console.log(`installed ${n} file(s) from ${dir}`);
}

function list() {
  if (!existsSync(SNAPDIR)) {
    console.log('(无快照)');
    return;
  }
  for (const d of readdirSync(SNAPDIR)) console.log(d);
}

switch (cmd) {
  case 'save':
    save(arg);
    break;
  case 'load':
    load(arg);
    break;
  case 'install':
    install(arg);
    break;
  case 'list':
    list();
    break;
  default:
    console.error('用法: node snap.mjs save|load|install|list <label|dir>');
    process.exit(1);
}
