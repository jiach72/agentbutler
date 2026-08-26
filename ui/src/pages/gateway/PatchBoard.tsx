/**
 * 形态补丁区：补丁卡片、参数草稿（antd InputNumber）、漂移检测与应用动作。
 * busy 锁按「动作:实例:补丁」粒度生效，只禁用对应按钮。
 */
import { Input, InputNumber } from "antd";
import { StatusBadge } from "../../components/StatusBadge.js";
import { formatRelative } from "../../lib/format.js";
import { PARAM_LABELS, instanceKeyOf, patchBusyKey, schemaHint, statusTone } from "./helpers.js";
import type {
  DriftReport,
  GatewayPatch,
  PatchAction,
  PatchDrafts,
} from "./helpers.js";

interface PatchBoardProps {
  patches: GatewayPatch[];
  drafts: PatchDrafts;
  driftReports: Record<string, DriftReport>;
  watchUnreachable: boolean;
  instanceValue: string;
  patchErrors: Record<string, string>;
  busyKeys: ReadonlySet<string>;
  onInstanceChange: (value: string) => void;
  onUpdateDraft: (patchId: string, param: string, value: number | null) => void;
  onRunAction: (patch: GatewayPatch, action: PatchAction) => void;
}

export function PatchBoard({
  patches,
  drafts,
  driftReports,
  watchUnreachable,
  instanceValue,
  patchErrors,
  busyKeys,
  onInstanceChange,
  onUpdateDraft,
  onRunAction,
}: PatchBoardProps) {
  const instKey = instanceKeyOf(instanceValue);
  return (
    <>
      <div className="gateway-section-heading">
        <div>
          <h2 className="section-title">消息规则与参数</h2>
          <p className="hint">这里是高级设置；只有登记过的文件才会被修改，升级后可重新匹配。</p>
        </div>
        <label className="gateway-instance-field">
          <span>管家实例（可选）</span>
          <Input
            value={instanceValue}
            onChange={(event) => onInstanceChange(event.target.value)}
            placeholder="留空自动选择正在运行的管家"
          />
        </label>
      </div>

      {patches.length === 0 ? (
        <div className="empty-state">暂时没有可调整的消息规则，请稍后刷新。</div>
      ) : (
        <div className="cards-stack">
          {patches.map((patch) => {
            const report = driftReports[patch.id];
            const missingRequires = (patch.requires ?? []).filter((requiredId) => {
              const required = patches.find((item) => item.id === requiredId);
              return (
                required === undefined ||
                (required.applied === null && (required.observed ?? null) === null)
              );
            });
            const isObserved = (patch.observed ?? null) !== null && patch.applied === null;
            const applyKey = patchBusyKey("apply", patch.id, instKey);
            const reapplyKey = patchBusyKey("reapply", patch.id, instKey);
            const detectKey = patchBusyKey("detect", patch.id, instKey);
            const patchBusy =
              busyKeys.has(applyKey) || busyKeys.has(reapplyKey) || busyKeys.has(detectKey);
            const applyDisabled =
              patchBusy || isObserved || missingRequires.length > 0 || watchUnreachable;
            const detectDisabled = patchBusy || watchUnreachable;
            return (
              <article className="card patch-panel" key={patch.id}>
                <div className="patch-head">
                  <div>
                    <div className="patch-title-row">
                      <h3>{patch.title}</h3>
                      <StatusBadge
                        tone={
                          patch.applied !== null ? "ok" : isObserved ? "warn" : "muted"
                        }
                        label={
                          patch.applied !== null
                            ? "已纳管"
                            : isObserved
                              ? "手工已生效 · 未纳管"
                              : "未应用"
                        }
                      />
                    </div>
                    <p>{patch.description}</p>
                    <code className="patch-target">{patch.target}</code>
                  </div>
                  {patch.requires !== undefined && patch.requires.length > 0 && (
                    <span className="patch-dependency">依赖：{patch.requires.join("、")}</span>
                  )}
                </div>

                <div className="patch-param-grid">
                  {Object.entries(patch.params).map(([name, schema]) => (
                    <label className="patch-param" key={name}>
                      <span>{PARAM_LABELS[name] ?? name}</span>
                      <InputNumber
                        min={schema.min}
                        max={schema.max}
                        precision={schema.integer === true ? 0 : undefined}
                        step={schema.integer === true ? 1 : "any"}
                        value={drafts[patch.id]?.[name] ?? null}
                        disabled={isObserved}
                        onChange={(value) =>
                          onUpdateDraft(patch.id, name, typeof value === "number" ? value : null)
                        }
                      />
                      <small>{isObserved ? "只读 · 从当前源码提取" : schemaHint(schema)}</small>
                    </label>
                  ))}
                </div>

                {patchErrors[patch.id] !== undefined && (
                  <div className="patch-inline-warning">{patchErrors[patch.id]}</div>
                )}

                {patch.applied !== null && (
                  <dl className="patch-applied-meta">
                    <dt>上次应用</dt>
                    <dd>{formatRelative(patch.applied.appliedAt)}</dd>
                    <dt>实际文件</dt>
                    <dd title={patch.applied.targetPath}>{patch.applied.targetPath}</dd>
                  </dl>
                )}
                {isObserved && patch.observed !== undefined && patch.observed !== null && (
                  <>
                    <dl className="patch-applied-meta">
                      <dt>源码识别</dt>
                      <dd>{formatRelative(patch.observed.checkedAt)}</dd>
                      <dt>实际文件</dt>
                      <dd title={patch.observed.targetPath}>{patch.observed.targetPath}</dd>
                    </dl>
                    <div className="patch-inline-warning">
                      当前能力来自 Hermes 源码中的手工实现，Butler
                      只读观察，不会应用或重打覆盖。
                    </div>
                  </>
                )}
                {missingRequires.length > 0 && (
                  <div className="patch-inline-warning">
                    请先应用前置补丁：{missingRequires.join("、")}
                  </div>
                )}
                {report !== undefined && (
                  <div className="drift-result">
                    <StatusBadge {...statusTone(report.status)} />
                    <span>检测于 {formatRelative(report.checkedAt)}</span>
                    {(report.diffs?.length ?? 0) > 0 && <span>{report.diffs!.length} 处差异</span>}
                  </div>
                )}

                <div className="patch-actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={applyDisabled}
                    onClick={() => onRunAction(patch, "apply")}
                  >
                    {busyKeys.has(applyKey) ? "应用中" : "应用这个调整"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={applyDisabled}
                    onClick={() => onRunAction(patch, "reapply")}
                  >
                    {busyKeys.has(reapplyKey) ? "恢复中" : "恢复官方默认"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={detectDisabled}
                    onClick={() => onRunAction(patch, "detect")}
                  >
                    {busyKeys.has(detectKey) ? "检查中" : "检查是否被改过"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
