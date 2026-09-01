/**
 * 记忆健康卡片：健康分、信号明细、管家建议与自检/备份操作。
 */
import { Button } from "antd";
import type { MemoryHealthView, MemorySelfCheckView } from "./helpers.js";
import { healthTone, signalLabel } from "./helpers.js";

interface MemoryHealthCardProps {
  health: MemoryHealthView | null;
  selfCheck: { busy: boolean; result: MemorySelfCheckView | null };
  onSelfCheck: () => void;
  onBackup: () => void;
  backupBusy: boolean;
}

export function MemoryHealthCard({
  health,
  selfCheck,
  onSelfCheck,
  onBackup,
  backupBusy,
}: MemoryHealthCardProps) {
  if (health === null) {
    return (
      <div className="memory-health is-unknown">
        <div className="memory-health-head">
          <strong>记忆健康</strong>
          <span>管家还没返回健康分析</span>
        </div>
      </div>
    );
  }
  const tone = healthTone(health.score);
  return (
    <div className={`memory-health is-${tone}`}>
      <div className="memory-health-main">
        <div className="memory-health-head">
          <div className="memory-health-score">
            <strong>{Math.round(health.score)}</strong>
            <span>/100</span>
          </div>
          <div className="memory-health-status">
            <strong>记忆健康</strong>
            <span>
              {tone === "good"
                ? "状态很好，不需要动手"
                : tone === "ok"
                  ? "基本正常，可留意建议"
                  : tone === "warn"
                    ? "有需要注意的地方"
                    : "建议尽快处理"}
            </span>
          </div>
        </div>

        {health.suggestions.length > 0 && (
          <div className="memory-suggestions">
            <strong>管家建议</strong>
            {health.suggestions.map((suggestion) => (
              <div className="memory-suggestion" key={suggestion.id}>
                <div>
                  <strong>{suggestion.title}</strong>
                  <span>{suggestion.detail}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="memory-health-actions">
          <Button
            disabled={backupBusy}
            onClick={onBackup}
            title="把记忆库备份到本地，升级或恢复前更安心"
          >
            {backupBusy ? "备份中…" : "记忆备份"}
          </Button>
          <Button
            disabled={selfCheck.busy}
            onClick={onSelfCheck}
            title="写入并召回一条管家测试记忆后自动清理，不会改动你的记忆"
          >
            {selfCheck.busy ? "自检中…" : "立即自检记忆"}
          </Button>
        </div>
      </div>

      <ul className="memory-signals">
        {health.signals.map((signal) => (
          <li key={signal.id} className={`is-${signal.status}`}>
            <i />
            <div>
              <strong>{signalLabel(signal.id, signal.label)}</strong>
              <span>{signal.detail}</span>
            </div>
          </li>
        ))}
      </ul>

      {selfCheck.result !== null && (
        <div className={`memory-selfcheck is-${selfCheck.result.status}`} role="status">
          <strong>
            {selfCheck.result.status === "pass"
              ? "记忆读写正常"
              : selfCheck.result.status === "warn"
                ? "记忆读写基本正常，需要留意"
                : selfCheck.result.status === "skipped"
                  ? "本次自检跳过"
                  : "记忆读写有问题"}
          </strong>
          <span>{selfCheck.result.detail}</span>
        </div>
      )}
    </div>
  );
}
