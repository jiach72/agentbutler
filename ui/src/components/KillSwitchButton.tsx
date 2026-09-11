/**
 * 全站顶栏常驻「紧急暂停」（Trust Layer M1.3）：
 * - 任意页面 ≤2 次点击触达（点击 → 确认卡 → engage）；
 * - 确认卡展示影响范围（停止全部实例、拒绝重连与升级）；
 * - engage 后进入暂停态（红色实心 + 已暂停时长），再次点击确认后恢复；
 * - 状态每 10 秒轮询，watch 离线时按钮进入「不可用」态而非假装安全。
 */
import { ExclamationCircleFilled, PauseCircleOutlined, PlayCircleOutlined } from "@ant-design/icons";
import { App, Button, Modal, Tooltip, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import { loadJson, postJson } from "../lib/api.js";
import { usePolling } from "../hooks/usePolling.js";

interface KillSwitchState {
  engaged: boolean;
  engagedAt: string | null;
  stoppedInstanceIds: string[];
  snapshotTaken: boolean;
  snapshotId: number | null;
  releasedAt: string | null;
  restoredFromLog: boolean;
}

function engagedSinceLabel(engagedAt: string | null): string {
  if (engagedAt === null) return "";
  const started = Date.parse(engagedAt);
  if (Number.isNaN(started)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - started) / 60_000));
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/** 从 PostResult.data 提取服务端错误文案（{ error } / { detail }），兜底为通用文案。 */
function postErrorText(result: { status: number; data: unknown }, fallback: string): string {
  if (result.data !== null && typeof result.data === "object") {
    const record = result.data as Record<string, unknown>;
    if (typeof record["detail"] === "string" && record["detail"] !== "") return record["detail"];
    if (typeof record["error"] === "string" && record["error"] !== "") {
      if (record["error"] === "killswitch-already-engaged") return "已处于暂停状态";
      if (record["error"] === "killswitch-not-engaged") return "当前不在暂停状态";
      if (record["error"] === "watch-unreachable") return "控制通道离线，请检查 Watch 服务";
      return record["error"];
    }
  }
  return result.status === 0 ? "网络连接失败，请检查管家服务是否在运行" : fallback;
}

export interface KillSwitchButtonProps {
  /**
   * default = 顶栏按钮（文字 + 图标）；
   * tab = 移动端底部 Tab 形态（仅图标 + 短标签，撑满格）。
   */
  variant?: "default" | "tab";
}

export function KillSwitchButton({ variant = "default" }: KillSwitchButtonProps = {}) {
  const { message } = App.useApp();
  const [state, setState] = useState<KillSwitchState | null>(null);
  const [reachable, setReachable] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void loadJson<KillSwitchState>("/api/killswitch", 6_000).then((result) => {
      if (result.ok) {
        setState(result.data);
        setReachable(true);
      } else {
        setReachable(false);
      }
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  usePolling(refresh, 10_000);

  const engage = () => {
    if (busy) return;
    Modal.confirm({
      title: "确认紧急暂停全部 agent？",
      icon: <ExclamationCircleFilled style={{ color: "#d4380d" }} />,
      content: (
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          将立即停止全部 agent 实例，并拒绝新的连接与升级任务；
          暂停前会自动创建一份全量备份。恢复需再次确认。
        </Typography.Paragraph>
      ),
      okText: "立即暂停",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        setBusy(true);
        const result = await postJson("/api/killswitch/engage", { trigger: "panel", actor: "panel" }, 70_000);
        setBusy(false);
        if (result.ok) {
          message.success("已进入全局暂停");
        } else if (result.status === 409) {
          message.info("已处于暂停状态");
        } else {
          message.error(postErrorText(result, "急停失败，请检查控制通道"));
        }
        refresh();
      },
    });
  };

  const release = () => {
    if (busy) return;
    Modal.confirm({
      title: "恢复全部 agent？",
      content: (
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          将按暂停时记录的实例清单逐个重启（共 {state?.stoppedInstanceIds.length ?? 0} 个）。
          暂停期间积压的会话由各 agent 自行续跑。
        </Typography.Paragraph>
      ),
      okText: "恢复运行",
      cancelText: "保持暂停",
      onOk: async () => {
        setBusy(true);
        const result = await postJson("/api/killswitch/release", { actor: "panel" }, 70_000);
        setBusy(false);
        if (result.ok) {
          message.success("已解除暂停，实例正在恢复");
        } else if (result.status === 409) {
          message.info("当前不在暂停状态");
        } else {
          message.error(postErrorText(result, "恢复失败，请检查控制通道"));
        }
        refresh();
      },
    });
  };

  if (!reachable) {
    return variant === "tab" ? (
      <button type="button" className="mobile-tab-trigger" disabled aria-label="急停不可用">
        <span className="mobile-tab-icon" aria-hidden="true">
          <PauseCircleOutlined />
        </span>
        <span className="mobile-tab-label">不可用</span>
      </button>
    ) : (
      <Tooltip title="控制通道离线，急停暂不可用">
        <Button type="text" size="small" disabled icon={<PauseCircleOutlined />}>
          急停不可用
        </Button>
      </Tooltip>
    );
  }
  if (state === null) {
    return variant === "tab" ? (
      <button type="button" className="mobile-tab-trigger" aria-label="读取急停状态">
        <span className="mobile-tab-icon" aria-hidden="true">
          <PauseCircleOutlined />
        </span>
        <span className="mobile-tab-label">急停</span>
      </button>
    ) : (
      <Button type="text" size="small" loading icon={<PauseCircleOutlined />} aria-label="读取急停状态">
        急停
      </Button>
    );
  }
  if (state.engaged) {
    const since = engagedSinceLabel(state.engagedAt);
    return variant === "tab" ? (
      <button
        type="button"
        className="mobile-tab-trigger is-engaged"
        onClick={release}
        aria-label={`已暂停${since === "" ? "" : ` ${since}`}，点按恢复`}
      >
        <span className="mobile-tab-icon" aria-hidden="true">
          <PlayCircleOutlined />
        </span>
        <span className="mobile-tab-label">恢复</span>
      </button>
    ) : (
      <Tooltip title={`已暂停 ${since} · 点按恢复`}>
        <Button
          type="primary"
          danger
          size="small"
          icon={<PlayCircleOutlined />}
          onClick={release}
          loading={busy}
        >
          已暂停{since !== "" ? ` · ${since}` : ""} · 恢复
        </Button>
      </Tooltip>
    );
  }
  return variant === "tab" ? (
    <button
      type="button"
      className="mobile-tab-trigger"
      onClick={engage}
      aria-label="紧急暂停全部 agent"
    >
      <span className="mobile-tab-icon" aria-hidden="true">
        <PauseCircleOutlined />
      </span>
      <span className="mobile-tab-label">急停</span>
    </button>
  ) : (
    <Tooltip title="紧急暂停全部 agent 实例">
      <Button
        type="default"
        danger
        size="small"
        icon={<PauseCircleOutlined />}
        onClick={engage}
        loading={busy}
        aria-label="紧急暂停全部 agent"
      >
        紧急暂停
      </Button>
    </Tooltip>
  );
}
