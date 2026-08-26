/**
 * 进化页左栏：高级运行设置（antd Form）、预检清单、运行/补齐动作与结论框。
 */
import { useMemo } from "react";
import { Form, Input, InputNumber } from "antd";
import type { FormInstance } from "antd";
import { AdvancedDetails } from "../../components/AdvancedDetails.js";
import {
  type BusyKind,
  checkTone,
  HOLDOUT_RULES,
  PENDING_CHECKS,
  type PreflightOutcome,
} from "./helpers.js";

interface PreflightPanelProps {
  form: FormInstance;
  preflight: PreflightOutcome | null;
  busy: BusyKind;
  watchReachable: boolean | undefined;
  onRunPreflight: () => void;
  onExpandDataset: () => void;
}

export function PreflightPanel({
  form,
  preflight,
  busy,
  watchReachable,
  onRunPreflight,
  onExpandDataset,
}: PreflightPanelProps) {
  const checks = preflight?.checks ?? PENDING_CHECKS;
  const failedChecks = useMemo(() => checks.filter((check) => check.status === "fail"), [checks]);

  const datasetPath = Form.useWatch("datasetPath", form) ?? "";
  const seedExamples = Form.useWatch("seedExamples", form) ?? "";
  const canExpand =
    preflight?.nextAction?.kind === "expand-dataset" &&
    (datasetPath.trim() !== "" || seedExamples.trim() !== "");

  const preflightState = useMemo(() => {
    if (busy === "preflight" || busy === "expand") return "检查中";
    if (preflight === null) return "待运行";
    return preflight.allowRun ? "已通过" : "已拒绝";
  }, [busy, preflight]);

  return (
    <section className="evolution-column evolution-preflight">
      <div className="evolution-section-head">
        <div>
          <span className="evolution-kicker">开始之前</span>
          <h2>先检查，再运行</h2>
        </div>
        <span
          className={`evolution-state ${preflight?.allowRun ? "is-pass" : failedChecks.length > 0 ? "is-fail" : "is-pending"}`}
        >
          {preflightState}
        </span>
      </div>

      <AdvancedDetails
        summary={
          <span>
            <strong>高级运行设置</strong>
            <small>运行依赖、模型连接和测试样本位置；普通用户通常不需要填</small>
          </span>
        }
      >
        <div className="evolution-form-grid">
          <Form.Item name="dependencies" label="运行依赖（高级）">
            <Input />
          </Form.Item>
          <Form.Item name="endpoint" label="模型连接地址">
            <Input placeholder="例如：https://你的模型地址/v1" />
          </Form.Item>
          <Form.Item name="holdoutCount" label="测试样本数量" rules={HOLDOUT_RULES}>
            <InputNumber min={0} step={1} precision={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="instanceId" label="管家实例（可选）">
            <Input placeholder="留空自动选择正在运行的实例" />
          </Form.Item>
          <Form.Item name="datasetPath" label="测试样本位置（可选）">
            <Input placeholder="例如：/home/你的账户/hermes/eval/test.jsonl" />
          </Form.Item>
        </div>
      </AdvancedDetails>

      <ol className="evolution-checks">
        {checks.map((check, index) => (
          <li
            className={checkTone(check.status)}
            key={check.id}
            style={{ animationDelay: `${index * 55}ms` }}
          >
            <span className="evolution-check-dot" aria-hidden="true" />
            <div>
              <strong>{check.label}</strong>
              <p>{check.detail}</p>
              {check.action !== undefined && <em>{check.action}</em>}
            </div>
            <span className="evolution-check-status">
              {check.status === "pass" ? "通过" : check.status === "fail" ? "失败" : "待检"}
            </span>
          </li>
        ))}
      </ol>

      <div className="evolution-primary-action">
        <button
          type="button"
          onClick={onRunPreflight}
          disabled={busy !== null || watchReachable === false}
        >
          {busy === "preflight" ? "正在检查…" : "开始检查"}
        </button>
        <span>全部通过后管家会先备份，再允许外部改进。</span>
      </div>

      {preflight !== null && !preflight.allowRun && (
        <div className="evolution-decision is-rejected">
          <div className="evolution-decision-label">拒绝运行</div>
          <h3>{failedChecks[0]?.detail ?? "检查未通过"}</h3>
          <p>{failedChecks[0]?.action ?? "按提示处理好后重新检查。"}</p>
          {preflight.nextAction?.kind === "expand-dataset" && (
            <div className="evolution-expander">
              <Form.Item
                name="seedExamples"
                label="没有数据集路径时，粘贴 JSON 数组或 JSONL 种子样本"
              >
                <Input.TextArea
                  rows={4}
                  placeholder={'{"prompt":"示例问题","expected":"期望答案"}'}
                />
              </Form.Item>
              <button
                type="button"
                onClick={onExpandDataset}
                disabled={busy !== null || !canExpand}
              >
                {busy === "expand"
                  ? "补齐并重新检查…"
                  : `补齐到 ${preflight.nextAction.targetCount} 条并重检`}
              </button>
            </div>
          )}
        </div>
      )}

      {preflight?.allowRun === true && (
        <div className="evolution-decision is-ready">
          <div className="evolution-decision-label">检查通过，可以开始改进</div>
          <h3>已做好备份；改进结果确认后才会采用</h3>
          <p>管家已准备好运行环境。改进完成后，在右侧提交结果确认；确认更好才会写入。</p>
        </div>
      )}
    </section>
  );
}
