import { Link } from "react-router-dom";
import { Button } from "antd";
import { CheckCircleFilled, CloseOutlined, RocketOutlined, SendOutlined, SmileOutlined, ThunderboltOutlined } from "@ant-design/icons";

export interface SetupHeroCardProps {
  onlineInstances: number;
  isBridgeConnected: boolean;
  onDismiss: () => void;
}

export function SetupHeroCard({ onlineInstances, isBridgeConnected, onDismiss }: SetupHeroCardProps) {
  const isAgentOnline = onlineInstances > 0;

  return (
    <section className="animate-entrance rounded-2xl bg-gradient-to-r from-primary/10 via-surface-container-lowest to-tertiary-container/10 p-4 md:p-5 shadow-xs border border-primary/20 relative overflow-hidden bento-card-hover">
      {/* Background ambient glow */}
      <div className="absolute -top-12 -right-12 w-48 h-48 bg-primary/10 rounded-full blur-2xl pointer-events-none" />
      <div className="absolute -bottom-12 -left-12 w-48 h-48 bg-tertiary/10 rounded-full blur-2xl pointer-events-none" />

      <div className="relative z-10 space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded-full bg-primary/15 text-primary text-xs font-semibold flex items-center gap-1">
                <RocketOutlined />
                新手启航向导
              </span>
              <span className="text-xs text-on-surface-variant font-mono">3 分钟点亮专属管家</span>
            </div>
            <h3 className="text-base md:text-lg font-bold text-on-surface tracking-tight flex items-center gap-1.5">
              <span>欢迎来到 Agent Butler</span>
              <SmileOutlined className="text-primary text-base" />
            </h3>
            <p className="text-xs md:text-sm text-on-surface-variant max-w-2xl leading-relaxed">
              完成下面 3 个极简步骤，让您的 Hermes 智能体立刻开始在手机端接听吩咐并自动完成日常任务。
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="p-1.5 rounded-lg text-on-surface-variant/70 hover:text-on-surface hover:bg-surface-container/80 transition-colors cursor-pointer"
            title="收起向导"
            aria-label="收起新手向导"
          >
            <CloseOutlined style={{ fontSize: 13 }} />
          </button>
        </div>

        {/* 3 Steps Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* Step 1 */}
          <div className="p-3.5 rounded-xl bg-surface-container-lowest/90 backdrop-blur-xs border border-outline-variant/15 flex flex-col justify-between space-y-2.5">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-primary font-mono">STEP 01</span>
                {isAgentOnline ? (
                  <span className="inline-flex items-center gap-1 text-xs text-tertiary font-semibold">
                    <CheckCircleFilled />
                    已连接
                  </span>
                ) : (
                  <span className="text-xs text-amber-500 font-semibold">待连接</span>
                )}
              </div>
              <h4 className="text-xs md:text-sm font-semibold text-on-surface">智能体引擎握手</h4>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                {isAgentOnline
                  ? "Hermes 本地实例连接正常，心跳保活就绪。"
                  : "检测到本地 Hermes 尚未连接，先在设置中确认路径。"}
              </p>
            </div>
            <Link
              to="/setup"
              className="h-7 px-3 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-medium inline-flex items-center justify-center transition-colors"
            >
              {isAgentOnline ? "查看链路详情" : "立即配置连接"}
            </Link>
          </div>

          {/* Step 2 */}
          <div className="p-3.5 rounded-xl bg-surface-container-lowest/90 backdrop-blur-xs border border-outline-variant/15 flex flex-col justify-between space-y-2.5">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-primary font-mono">STEP 02</span>
                {isBridgeConnected ? (
                  <span className="inline-flex items-center gap-1 text-xs text-tertiary font-semibold">
                    <CheckCircleFilled />
                    网关就绪
                  </span>
                ) : (
                  <span className="text-xs text-amber-500 font-semibold">待打通</span>
                )}
              </div>
              <h4 className="text-xs md:text-sm font-semibold text-on-surface">连通常用消息通道</h4>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                接入 Telegram、微信、飞书或 Discord，随时在手机端接收管家推送。
              </p>
            </div>
            <Link
              to="/gateway"
              className="h-7 px-3 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-medium inline-flex items-center justify-center gap-1.5 transition-colors"
            >
              <SendOutlined style={{ fontSize: 11 }} />
              <span>选择与测试通道</span>
            </Link>
          </div>

          {/* Step 3 */}
          <div className="p-3.5 rounded-xl bg-surface-container-lowest/90 backdrop-blur-xs border border-outline-variant/15 flex flex-col justify-between space-y-2.5">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-primary font-mono">STEP 03</span>
                <span className="text-xs text-on-surface-variant font-mono">自动化</span>
              </div>
              <h4 className="text-xs md:text-sm font-semibold text-on-surface">开启首个日常习惯</h4>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                设置每日晨报（早 8:30）或健康巡检，让管家主动为您服务。
              </p>
            </div>
            <Link
              to="/tasks"
              className="h-7 px-3 rounded-lg bg-primary/15 hover:bg-primary/25 text-primary text-xs font-medium inline-flex items-center justify-center gap-1.5 transition-colors"
            >
              <ThunderboltOutlined style={{ fontSize: 11 }} />
              <span>添加首个定时任务</span>
            </Link>
          </div>
        </div>

        {/* Footer info */}
        <div className="flex items-center justify-between pt-1 text-xs text-on-surface-variant font-mono">
          <span>提示：完成设置后可在「随手吩咐」随时向智能体发送任务</span>
          <Button type="link" size="small" onClick={onDismiss} className="!p-0 text-xs">
            我已熟练掌握，收起向导
          </Button>
        </div>
      </div>
    </section>
  );
}
