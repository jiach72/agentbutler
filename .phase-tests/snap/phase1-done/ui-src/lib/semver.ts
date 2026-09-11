/**
 * 轻量 SemVer 比较：供版本页排序与“上一个可回滚版本”推导使用。
 * 遵循 semver 优先级规则：主次修订号按数值比较；带 prerelease 低于不带；
 * prerelease 标识逐段比较（数值段小于字母段，段少者小于段多者）。
 */

interface ParsedVersion {
  core: number[];
  pre: string[];
}

function parseVersion(input: string): ParsedVersion | null {
  const text = input.trim().replace(/^v/i, "");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-.]?([\w.]+))?$/.exec(text);
  if (match === null) return null;
  const core = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const pre =
    match[4] === undefined ? [] : match[4].split(".").filter(Boolean);
  return { core, pre };
}

function comparePreSegment(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    const diff = Number(a) - Number(b);
    return diff === 0 ? 0 : diff > 0 ? 1 : -1;
  }
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a === b ? 0 : a > b ? 1 : -1;
}

/** a > b 返回 1，a < b 返回 -1，相等或无法解析返回 0（不可解析按相等处理避免误升）。 */
export function compareVersion(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return 0;
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  const max = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < max; i += 1) {
    const lp = left.pre[i];
    const rp = right.pre[i];
    if (lp === undefined) return -1;
    if (rp === undefined) return 1;
    const diff = comparePreSegment(lp, rp);
    if (diff !== 0) return diff;
  }
  return 0;
}
