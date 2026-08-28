import { LogPanel } from "./dashboard/LogPanel.js";

export function LogsPage() {
  return (
    <section className="page product-page logs-page">
      <header className="page-heading product-heading">
        <div>
          <span className="product-eyebrow">系统日志</span>
          <h1>日志与修复建议</h1>
          <p className="hint">只读查看 Hermes、网关和管家日志；修复动作会先确认，再显示实时执行进度。</p>
        </div>
      </header>
      <LogPanel embedded />
    </section>
  );
}
