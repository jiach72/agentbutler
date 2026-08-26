/**
 * 目录兜底统计块：技能服务不可达时按本机文件展示规模。
 */
import type { DirectoryInventory } from "./helpers.js";
import { formatBytes, formatNumber } from "../../lib/format.js";

export function DirectoryFallback({ directory }: { directory: DirectoryInventory }) {
  return (
    <div className="skills-fallback">
      <div>
        <strong>{formatNumber(directory.fileCount)}</strong>
        <span>文件</span>
      </div>
      <div>
        <strong>{formatNumber(directory.directoryCount)}</strong>
        <span>文件夹</span>
      </div>
      <div>
        <strong>{formatBytes(directory.sizeBytes)}</strong>
        <span>占用空间</span>
      </div>
      <p title={directory.roots.join(" · ")}>
        {directory.truncated
          ? "只显示了部分文件，详细位置见提示。"
          : "已按本机文件统计，未修改任何内容。"}
      </p>
    </div>
  );
}
