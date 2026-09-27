/**
 * 排查问题工作台人机工效与向导微交互测试
 */
import React from "react";
import { App as AntApp } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { WizardNav } from "../src/pages/troubleshoot/steps/SymptomStep.js";
import { TriageOverview } from "../src/pages/troubleshoot/steps/TriageOverview.js";

describe("排查问题向导微交互 (WizardNav & TriageOverview)", () => {
  it("WizardNav 在非禁用状态下不展示误导性 Tooltip", () => {
    const htmlNormal = renderToStaticMarkup(
      <AntApp>
        <WizardNav onBack={() => {}} onNext={() => {}} nextDisabled={false} busy={false} />
      </AntApp>
    );

    expect(htmlNormal).toContain("上一步");
    expect(htmlNormal).toContain("下一步");
    // 不应当出现操作进行中或必选项未选的提示
    expect(htmlNormal).not.toContain("正在执行操作，请稍候");
    expect(htmlNormal).not.toContain("请先完成当前步骤的选择");
  });

  it("WizardNav 在禁用态与忙碌态下准确设置按钮 disabled 状态", () => {
    const htmlBusy = renderToStaticMarkup(
      <AntApp>
        <WizardNav onBack={() => {}} onNext={() => {}} nextDisabled={true} busy={true} />
      </AntApp>
    );

    // 两个按钮均处于 disabled 状态
    expect(htmlBusy).toContain("disabled=\"\"");
    expect(htmlBusy).toContain("ant-btn-loading");
  });

  it("TriageOverview 当体检数据为空时提供自愈提示与日志入口", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AntApp>
          <TriageOverview
            triage={null}
            triageBusy={false}
            diagnosis={null}
            recommended={null}
            alternatives={[]}
            jobRunning={false}
            jobDetail=""
            jobProgress={0}
            busy={false}
            onRerun={() => {}}
            onRunAction={() => {}}
            onOpenWizard={() => {}}
          />
        </AntApp>
      </MemoryRouter>
    );

    expect(html).toContain("刚才这轮体检没有读到结果，可能是管家服务暂时不可用或处于启动自愈阶段。");
    expect(html).toContain("再试一次");
    expect(html).toContain("查看系统日志");
  });

  it("TriageOverview 当体检结果全绿时给出零焦虑的确定性结论", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AntApp>
          <TriageOverview
            triage={{
              tone: "ok",
              title: "运行正常",
              rootCause: "未发现异常",
              detail: "所有探针检查项均已通过",
            }}
            triageBusy={false}
            diagnosis={null}
            recommended={null}
            alternatives={[]}
            jobRunning={false}
            jobDetail=""
            jobProgress={0}
            busy={false}
            onRerun={() => {}}
            onRunAction={() => {}}
            onOpenWizard={() => {}}
          />
        </AntApp>
      </MemoryRouter>
    );

    expect(html).toContain("本次检查未发现需要处理的问题");
    expect(html).toContain("当前检查范围内未发现使用受阻。");
    expect(html).toContain("无需处理；使用仍有异常时可以按现象继续排查。");
    expect(html).toContain("按现象仔细查（完整向导）");
    expect(html).toContain("下载诊断报告");
  });
});
