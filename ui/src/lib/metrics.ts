export interface DeliveryHistoryDay {
  date: string;
  delivered: number;
  failed: number;
  uncertain: number;
}

export interface DeliveryHistoryView {
  reachable: boolean;
  days: number;
  retentionDays: number;
  items: DeliveryHistoryDay[];
}

export interface InspectionHistoryDay {
  date: string;
  count: number;
  avgDurationMs: number | null;
  errorCount: number;
}

export interface InspectionHistoryView {
  days: number;
  items: InspectionHistoryDay[];
  degraded?: string[];
}
