import { Link } from "react-router-dom";
import { PlusOutlined } from "@ant-design/icons";
import type { AttentionItem } from "@butler/contract";
import type { deriveTaskPreview } from "./taskPreview.js";

export function AttentionList({ attention }: { attention: AttentionItem[] }) {
  return attention.length === 0 ? (
    <div className="health-empty-card ab-rise">
      <span className="health-empty-icon" aria-hidden="true">✓</span>
      <div>
        <strong>系统运行良好</strong>
        <p className="health-empty-desc">当前所有关键服务与链路均无待确认告警或阻塞项，智能体在后台静默守护。</p>
        <div className="health-empty-actions">
          <Link to="/gateway" className="health-empty-link">前往消息工作台</Link>
          <span className="health-empty-sep">·</span>
          <Link to="/tasks" className="health-empty-link">查看定时调度</Link>
        </div>
      </div>
    </div>
  ) : (
    <>
      <ul className="health-attention ab-stagger">
        {attention.slice(0, 5).map((item, idx) => (
          <li key={item.id} data-severity={item.severity} style={{ ["--ab-stagger-i" as string]: idx }}>
            <div><strong>{item.title}</strong><p>{item.impact}</p></div>
            <Link to={item.actionHref}>{item.actionLabel}</Link>
          </li>
        ))}
      </ul>
      {attention.length > 5 && <details className="health-more">
        <summary>另有 {attention.length - 5} 项待确认</summary>
        {attention.slice(5).map((item) => <p key={item.id}><Link to={item.actionHref}>{item.title}：{item.actionLabel}</Link></p>)}
      </details>}
    </>
  );
}

export function taskTime(iso: string | null): string {
  return iso === null || !Number.isFinite(Date.parse(iso)) ? "时间待确认"
    : new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function TaskPreview({ tasks, wall = false }: { tasks: ReturnType<typeof deriveTaskPreview>; wall?: boolean }) {
  return (
    <section className="health-tasks" aria-labelledby="health-tasks-title">
      <div className="health-section-heading"><h2 id="health-tasks-title">{wall ? "未来 24 小时任务" : "下一条定时任务"}</h2><Link to="/tasks">查看任务</Link></div>
      {(!wall || !tasks.running || tasks.upcoming.length === 0) && <p className="health-task-title">{tasks.label}</p>}
      {!wall && tasks.next && tasks.running && <p><time dateTime={tasks.next.nextRunAt ?? undefined}>{taskTime(tasks.next.nextRunAt)}</time></p>}
      {!wall && tasks.known && <p className="health-task-stats">今日执行 {tasks.todayRunCount} 次 · 失败任务 {tasks.failedTaskCount} 个</p>}
      {!tasks.known && <p className="health-muted">尚未获得任务列表，无法确认下次执行时间。</p>}
      {tasks.known && !tasks.running && <p className="health-muted">请检查任务调度状态，再核对执行时间。</p>}
      {!wall && tasks.known && (!tasks.next || !tasks.running) && tasks.upcoming.length === 0 && (
        <div className="health-task-empty-action ab-rise">
          <Link to="/tasks" className="health-task-add-btn">
            <PlusOutlined /> 创建第一个定时任务
          </Link>
        </div>
      )}
      {wall && tasks.running && <ul className="health-task-list">
        {tasks.upcoming.slice(0, 5).map((task) => <li key={task.id}><span>{task.name}</span><time dateTime={task.nextRunAt!}>{taskTime(task.nextRunAt)}</time></li>)}
      </ul>}
      {wall && tasks.known && tasks.running && tasks.upcoming.length === 0 && <p className="health-muted">未来 24 小时暂无已确认的任务安排。</p>}
      {wall && tasks.upcoming.length > 5 && <Link to="/tasks">查看另外 {tasks.upcoming.length - 5} 条任务</Link>}
    </section>
  );
}
