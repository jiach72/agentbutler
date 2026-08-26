/**
 * 版本页 · 当前使用的版本：受管实例卡片栅格。
 */
import { StatusBadge } from "../../components/StatusBadge.js";
import { instanceLabel, instanceRuntimeLabel, instanceStateLabel, stateBadge } from "./helpers.js";
import type { InstanceView } from "./types.js";

interface ManagedInstancesProps {
  instances: InstanceView[];
}

export function ManagedInstances({ instances }: ManagedInstancesProps) {
  if (instances.length === 0) {
    return (
      <div className="empty-state">
        还没有发现可管理的管家。扫描完成后，这里会显示它当前使用的版本。
      </div>
    );
  }
  return (
    <div className="cards-grid">
      {instances.map((instance) => {
        const badge = stateBadge(instance.state);
        return (
          <div className="card version-instance-card" key={instance.instanceId}>
            <div className="version-instance-head">
              <div>
                <span className="version-instance-kicker">受管 Hermes / OpenClaw</span>
                <strong>{instanceLabel(instance.instanceId)}</strong>
              </div>
              <StatusBadge tone={badge.tone} label={badge.label} />
            </div>
            <div className="version-instance-facts">
              <div><span>当前版本</span><strong>{instance.version ?? "版本未知"}</strong></div>
              <div><span>运行位置</span><strong>{instanceRuntimeLabel(instance.runtime)}</strong></div>
              <div><span>内部编号</span><strong title={instance.instanceId}>{instance.instanceId}</strong></div>
              <div><span>当前状态</span><strong>{instanceStateLabel(instance.state)}</strong></div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
