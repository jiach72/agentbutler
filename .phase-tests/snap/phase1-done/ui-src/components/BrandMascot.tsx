/**
 * 品牌角色「管家机器人」—— 规范见 docs/brand/02-视觉识别规范.md §2.6。
 *
 * 亮色主题用品牌线描（robot-line-brand.svg），深色主题用反白版（robot-line-inverse.svg）：
 * 墨线在深色 surface 上对比度不足 2:1，不能靠 CSS filter 反转（黄铜与管家蓝会一起走样）。
 * 切换沿用 Layout.tsx 品牌标志的 is-light / is-dark 双图方案，纯 CSS 控制，不读主题 context。
 *
 * 尺寸：宽度下限 32px（规范 §2.6）；空态建议 72–96px。
 */
const MASCOT_ASPECT = 296 / 240;

export function BrandMascot({ width = 80, className }: { width?: number; className?: string }) {
  const height = Math.round(width * MASCOT_ASPECT);
  return (
    <span
      className={className === undefined ? "brand-mascot" : `brand-mascot ${className}`}
      style={{ width }}
      aria-hidden="true"
    >
      <img
        className="brand-mascot-img is-light"
        src="/brand/mascot/robot-line-brand.svg"
        alt=""
        width={width}
        height={height}
      />
      <img
        className="brand-mascot-img is-dark"
        src="/brand/mascot/robot-line-inverse.svg"
        alt=""
        width={width}
        height={height}
      />
    </span>
  );
}
