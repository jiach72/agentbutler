/**
 * 安全基线黄条：/api/security-baseline 的 warnings 非空时常显黄色提示条，
 * 明示 V1 面板未启用鉴权、仅回环监听等风险项（拉取失败时不渲染）。
 */
import { useEffect, useState } from "react";
import { fetchJson } from "../lib/api.js";

interface SecurityBaselinePayload {
  listenHost: string;
  auth: boolean;
  warnings: string[];
}

export function SecurityNotice() {
  const [baseline, setBaseline] = useState<SecurityBaselinePayload | null>(null);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      const data = await fetchJson<SecurityBaselinePayload>("/api/security-baseline");
      if (!stopped && data !== null) setBaseline(data);
    };
    void load();
    return () => {
      stopped = true;
    };
  }, []);

  if (baseline === null || baseline.warnings.length === 0) return null;

  return (
    <div className="banner banner-warn" role="status">
      ⚠ 安全提示：{baseline.warnings.join("；")}
    </div>
  );
}
