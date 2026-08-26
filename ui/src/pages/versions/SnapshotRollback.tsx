/**
 * 版本页 · 退回上一版本：最近一次可用的升级前快照。
 */
import { formatRelative } from "../../lib/format.js";
import { instanceLabel } from "./helpers.js";
import type { SnapshotView } from "./types.js";

interface SnapshotRollbackProps {
  snapshot: SnapshotView | null;
  onRollback: (snapshot: SnapshotView) => void;
}

export function SnapshotRollback({ snapshot, onRollback }: SnapshotRollbackProps) {
  if (snapshot === null) {
    return (
      <div className="empty-state">
        还没有上一版本恢复点；首次升级前会自动创建。
      </div>
    );
  }
  return (
    <div className="card previous-version-row">
      <div>
        <strong>{instanceLabel(snapshot.instance)}的上一版本</strong>
        <span>
          {snapshot.label ?? "升级前自动保存"} · {formatRelative(snapshot.createdAt)}
        </span>
      </div>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => onRollback(snapshot)}
      >
        退回上一版本
      </button>
    </div>
  );
}
