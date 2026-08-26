/**
 * 进化页主编排：预检 → 真实评估（需确认弹窗）→ 安全门禁 → 结论。
 * 表单统一 antd Form 实例；10 秒轮询走 usePolling；连接指示用 ConnectionChip。
 */
import { useCallback, useEffect, useState } from "react";
import { App, Form, Steps } from "antd";
import { ConnectionChip } from "../../components/ConnectionChip.js";
import { DangerConfirmModal } from "../../components/DangerConfirmModal.js";
import { fetchJson, postJson } from "../../lib/api.js";
import { isRecord } from "../../lib/format.js";
import { usePolling } from "../../hooks/usePolling.js";
import {
  type BusyKind,
  type EvolutionFormValues,
  type EvolutionPayload,
  type EvaluationOutcome,
  type ExpandOutcome,
  type GateOutcome,
  parseSeedExamples,
  type PreflightOutcome,
  responseError,
  stepsCurrent,
} from "./helpers.js";
import { GateDecisionPanel } from "./GateDecisionPanel.js";
import { LedgerTable } from "./LedgerTable.js";
import { PreflightPanel } from "./PreflightPanel.js";

const INITIAL_FORM_VALUES = {
  dependencies: "dspy, gepa, optuna",
  endpoint: "",
  holdoutCount: 2,
  datasetPath: "",
  instanceId: "",
  seedExamples: "",
  baselineMetric: null,
  candidateMetric: null,
  significant: false,
  rootCause: "",
  fixes: "",
};

export function EvolutionPage() {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [data, setData] = useState<EvolutionPayload | null>(null);
  const [preflight, setPreflight] = useState<PreflightOutcome | null>(null);
  const [gate, setGate] = useState<GateOutcome | null>(null);
  const [evaluation, setEvaluation] = useState<EvaluationOutcome | null>(null);
  const [busy, setBusy] = useState<BusyKind>(null);
  const [evaluateConfirmOpen, setEvaluateConfirmOpen] = useState(false);

  const refresh = useCallback(async () => {
    const payload = await fetchJson<EvolutionPayload>("/api/evolution");
    if (payload === null) return;
    setData(payload);
    // 只在字段为空时填默认值，不覆盖用户输入。
    const endpointValue = form.getFieldValue("endpoint");
    if (endpointValue === undefined || endpointValue === null || endpointValue === "") {
      form.setFieldValue("endpoint", payload.defaultEndpoint);
    }
    const dependenciesValue = form.getFieldValue("dependencies");
    if (dependenciesValue === undefined || dependenciesValue === null || dependenciesValue === "") {
      form.setFieldValue("dependencies", payload.defaultDependencies.join(", "));
    }
  }, [form]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  usePolling(refresh, 10_000);

  const minHoldout = data?.minHoldoutCount ?? 10;

  const runPreflight = async () => {
    try {
      // 只校验预检相关字段，避免右侧手填指标的规则拦住重新预检。
      await form.validateFields([
        "dependencies",
        "endpoint",
        "holdoutCount",
        "datasetPath",
        "instanceId",
        "seedExamples",
      ]);
    } catch {
      return;
    }
    setBusy("preflight");
    setGate(null);
    setEvaluation(null);
    const values = form.getFieldsValue() as EvolutionFormValues;
    const body: Record<string, unknown> = {
      holdoutCount: values.holdoutCount ?? 0,
      dependencies: String(values.dependencies ?? "")
        .split(/[,，\s]+/)
        .map((item) => item.trim())
        .filter(Boolean),
      endpoint: String(values.endpoint ?? "").trim(),
      config: { source: "butler-ui", gateMode: "v1-external-engine" },
    };
    if (String(values.datasetPath ?? "").trim() !== "") body["datasetPath"] = String(values.datasetPath).trim();
    if (String(values.instanceId ?? "").trim() !== "") body["instanceId"] = String(values.instanceId).trim();
    const result = await postJson("/api/evolution/preflight", body, 20_000);
    setBusy(null);
    if (!result.ok || !isRecord(result.data)) {
      message.error(`预检失败：${responseError(result.data)}`);
      return;
    }
    const outcome = result.data as unknown as PreflightOutcome;
    setPreflight(outcome);
    if (outcome.allowRun) {
      message.success("检查与运行前备份均通过。管家已允许外部改进引擎开始运行。");
    } else {
      message.warning("检查未通过；按提示处理好后可以重新检查。");
    }
    await refresh();
  };

  const expandDataset = async () => {
    if (preflight === null) return;
    const seedsParsed = parseSeedExamples(String(form.getFieldValue("seedExamples") ?? ""));
    if (!seedsParsed.ok) {
      message.error(seedsParsed.error);
      return;
    }
    const datasetPath = String(form.getFieldValue("datasetPath") ?? "").trim();
    if (datasetPath === "" && seedsParsed.values.length === 0) {
      message.error("请填写测试样本位置，或粘贴至少一条示例问题与期望答案。");
      return;
    }
    const holdoutCount = Number(form.getFieldValue("holdoutCount") ?? 0);
    setBusy("expand");
    const body: Record<string, unknown> = {
      holdoutCount,
      targetCount: minHoldout,
    };
    if (datasetPath !== "") body["datasetPath"] = datasetPath;
    if (seedsParsed.values.length > 0) body["seedExamples"] = seedsParsed.values;
    const result = await postJson(
      `/api/evolution/runs/${encodeURIComponent(preflight.runId)}/expand`,
      body,
      20_000,
    );
    setBusy(null);
    if (!result.ok || !isRecord(result.data)) {
      message.error(`补齐测试样本失败：${responseError(result.data)}`);
      return;
    }
    const outcome = result.data as unknown as ExpandOutcome;
    setPreflight(outcome.recheck);
    form.setFieldsValue({ holdoutCount: outcome.afterCount, datasetPath: outcome.datasetPath });
    if (outcome.recheck.allowRun) {
      message.success(`已生成 ${outcome.syntheticCount} 条最小合成样本并自动重检。合成样本仅用于打通门槛，正式运行前仍需人工审阅质量。`);
    } else {
      message.warning(`已生成 ${outcome.syntheticCount} 条最小合成样本并自动重检。合成样本仅用于打通门槛，正式运行前仍需人工审阅质量。`);
    }
    await refresh();
  };

  const submitGate = async () => {
    if (preflight === null) return;
    let metrics: { baselineMetric: number; candidateMetric: number };
    try {
      metrics = (await form.validateFields(["baselineMetric", "candidateMetric"])) as {
        baselineMetric: number;
        candidateMetric: number;
      };
    } catch {
      return;
    }
    setBusy("gate");
    const result = await postJson(
      `/api/evolution/runs/${encodeURIComponent(preflight.runId)}/result`,
      {
        baselineMetric: metrics.baselineMetric,
        candidateMetric: metrics.candidateMetric,
        significant: Boolean(form.getFieldValue("significant")),
        rootCause: String(form.getFieldValue("rootCause") ?? "").trim(),
        fixes: String(form.getFieldValue("fixes") ?? "")
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean),
      },
      20_000,
    );
    setBusy(null);
    if (!result.ok || !isRecord(result.data)) {
      message.error(`确认结果失败：${responseError(result.data)}`);
      return;
    }
    const outcome = result.data as unknown as GateOutcome;
    setGate(outcome);
    if (outcome.status === "accepted") {
      message.info("手填指标已记录，但不会授权写入；正式采用必须通过服务端受信评估入口。");
    } else {
      message.warning("改进结果未获采用资格，当前版本保持不变；结论已记录。");
    }
    await refresh();
  };

  /** 危险操作：最长约一分钟的真实模型评估，先经 DangerConfirmModal 确认再发起。 */
  const evaluateExternally = async () => {
    if (preflight === null || !preflight.allowRun) return;
    setBusy("evaluate");
    const result = await postJson(`/api/evolution/runs/${encodeURIComponent(preflight.runId)}/evaluate`, {}, 70_000);
    setBusy(null);
    if (!result.ok || !isRecord(result.data)) {
      message.error(`真实评估未完成：${responseError(result.data)}`);
      return;
    }
    const outcome = result.data as unknown as EvaluationOutcome;
    setEvaluation(outcome);
    setGate(outcome);
    if (outcome.status === "accepted") {
      message.success("真实评估显示候选版本有显著提升，但仍需通过受信提升入口才能正式采用。");
    } else if (outcome.status === "rejected-regression") {
      message.error("真实评估发现质量下降，当前版本已保留。");
    } else {
      message.warning("真实评估完成，没有发现足够的显著提升。");
    }
    await refresh();
  };

  const gateReady = preflight?.allowRun === true && gate === null;

  return (
    <section className="page evolution-page">
      <header className="evolution-header">
        <div>
          <span className="evolution-eyebrow">自我进化安全锁</span>
          <h1>给 AI 的自我改进装上安全锁</h1>
          <p>让 AI 自己变聪明之前，先检查、备份、记录结果；正式采用只接受服务端受信评估。</p>
        </div>
        <ConnectionChip
          reachable={data?.watchReachable}
          connectingText="正在连接管家"
          offlineText="管家服务暂时连不上"
        />
      </header>

      <div className="evolution-workspace">
        <Form
          form={form}
          component={false}
          initialValues={INITIAL_FORM_VALUES}
        >
          <PreflightPanel
            form={form}
            preflight={preflight}
            busy={busy}
            watchReachable={data?.watchReachable}
            onRunPreflight={() => void runPreflight()}
            onExpandDataset={() => void expandDataset()}
          />

          <section className="evolution-column evolution-ledger">
            <div className="evolution-section-head">
              <div>
                <span className="evolution-kicker">运行后</span>
                <h2>改进记录</h2>
              </div>
              <button type="button" className="evolution-refresh" onClick={() => void refresh()}>
                刷新
              </button>
            </div>

            <Steps
              size="small"
              current={stepsCurrent(preflight?.allowRun === true, evaluation, gate)}
              items={[
                { title: "基线" },
                { title: "预检" },
                { title: "外部评估" },
                { title: "安全门禁" },
                { title: "结论" },
              ]}
            />

            <GateDecisionPanel
              form={form}
              gateReady={gateReady}
              gate={gate}
              evaluation={evaluation}
              busy={busy}
              onStartEvaluate={() => setEvaluateConfirmOpen(true)}
              onSubmitGate={() => void submitGate()}
            />

            <LedgerTable ledger={data?.ledger ?? []} />
          </section>
        </Form>
      </div>

      <DangerConfirmModal
        open={evaluateConfirmOpen}
        title="开始外部评估？"
        confirmLabel="开始评估"
        busy={busy === "evaluate"}
        onCancel={() => {
          if (busy === null) setEvaluateConfirmOpen(false);
        }}
        onConfirm={() => {
          setEvaluateConfirmOpen(false);
          void evaluateExternally();
        }}
        impact={
          <>
            <p>这次会真实调用一次模型评估，预计要花一分钟左右才能出结果。</p>
            <p>期间请不要关掉页面；评估会消耗一次真实的模型调用。</p>
          </>
        }
      >
        <p>管家会用当前配置的评估器跑一遍测试样本，用真实指标决定是否允许采用候选版本。</p>
      </DangerConfirmModal>
    </section>
  );
}
