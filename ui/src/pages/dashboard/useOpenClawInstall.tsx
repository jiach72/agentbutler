/**
 * OpenClaw 一键安装：确认弹窗（App.useApp().modal）+ 触发/取消安装任务。
 * 弹窗文案与运行环境事实展示与原实现一致。
 */
import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { App } from "antd";
import { postJson } from "../../lib/api.js";
import { isRecord, pickErrorText } from "../../lib/format.js";
import type { OpenClawInstallJobView, OpenClawStatusView } from "./types.js";

interface UseOpenClawInstallOptions {
  status: OpenClawStatusView | null;
  job: OpenClawInstallJobView | null;
  setJob: Dispatch<SetStateAction<OpenClawInstallJobView | null>>;
  /** 安装触发成功后的回调（刷新连接状态以跟进安装进度）。 */
  onStarted: () => void;
}

export function useOpenClawInstall({ status, job, setJob, onStarted }: UseOpenClawInstallOptions) {
  const { message, modal } = App.useApp();
  const [busy, setBusy] = useState(false);

  const install = useCallback(() => {
    const runtime = status?.runtime;
    const target = status?.target;
    modal.confirm({
      title: "确认安装 OpenClaw？",
      width: 560,
      content: (
        <div className="openclaw-install-confirm">
          <p>安装将在 WSL 内执行，不会覆盖已有 OpenClaw 配置；完成后会自动启动 Gateway 并进行健康复验。</p>
          <dl className="kv">
            <div><dt>运行环境</dt><dd>{runtime?.detail ?? "正在探测 WSL"}</dd></div>
            <div><dt>数据目录</dt><dd><code>{target?.dataRoot ?? status?.rootPath ?? "~/.openclaw"}</code></dd></div>
            <div><dt>npm 包目录</dt><dd><code>{target?.npmGlobalRoot ?? "正在解析 npm root -g"}</code></dd></div>
            <div><dt>预计耗时</dt><dd>约 2–10 分钟，取决于网络速度</dd></div>
          </dl>
        </div>
      ),
      okText: "确认安装",
      cancelText: "取消",
      onOk: async () => {
        setBusy(true);
        const result = await postJson("/api/openclaw/install", { confirmed: true }, 10_000);
        setBusy(false);
        if (result.status === 202 || result.ok) {
          if (isRecord(result.data) && "jobId" in result.data) {
            const jobId = String(result.data.jobId);
            setJob((current) => current ?? {
              jobId,
              status: "queued",
              progress: 0,
              currentStep: null,
              steps: [],
              logTail: [],
              error: null,
              startedAt: new Date().toISOString(),
              finishedAt: null,
            });
          }
          message.success("OpenClaw 安装已开始，页面会持续刷新安装状态");
          onStarted();
        } else if (result.status === 409) {
          message.error("OpenClaw 已有安装任务正在执行");
        } else {
          message.error(`OpenClaw 安装没有启动：${pickErrorText(result.data, "请检查 WSL、Node/npm 和网络状态")}`);
        }
      },
    });
  }, [message, modal, onStarted, setJob, status]);

  const cancel = useCallback(async () => {
    if (job === null) return;
    const result = await postJson(`/api/openclaw/install/${encodeURIComponent(job.jobId)}/cancel`, {}, 10_000);
    if (result.ok) {
      message.success("已请求取消安装，当前命令结束后会停止后续步骤");
      onStarted();
    } else {
      message.error("取消请求未成功，请查看安装日志");
    }
  }, [job, message, onStarted]);

  return { busy, install, cancel };
}
