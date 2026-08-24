/**
 * 追加式审计日志：控制类动作的统一登记入口。
 *
 * 只增不改：本类型不暴露任何 update/delete 能力（底层 store 的 audit 表
 * 也仅提供 append/list），每次 append 同步广播 audit-appended 事件。
 */
import type { EventBus } from "./events.js";
import type { AuditInput, AuditRow, SqliteStore } from "./store.js";

export interface AuditListFilter {
  action?: string;
  target?: string;
  limit?: number;
}

export class AuditLog {
  private store: SqliteStore;
  private bus: EventBus;

  constructor(deps: { store: SqliteStore; bus: EventBus }) {
    this.store = deps.store;
    this.bus = deps.bus;
  }

  /** 追加一条审计记录（不可变），并广播 audit-appended。 */
  append(input: AuditInput): AuditRow {
    const row = this.store.appendAudit(input);
    this.bus.emit("audit-appended", {
      id: row.id,
      actor: row.actor,
      action: row.action,
      target: row.target,
    });
    return row;
  }

  list(filter: AuditListFilter = {}): AuditRow[] {
    return this.store.listAudit(filter);
  }
}
