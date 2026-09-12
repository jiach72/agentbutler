/**
 * 视图状态 ↔ URL 双向同步（规范 03 §3.12）。
 *
 * 「激活项、筛选条件、分页必须同步到 URL。刷新、前进/后退、复制链接都要能还原同一个视图。」
 *
 * 【为什么需要一个 hook】此前全仓只有 SettingsPage(`?tab=`) 与 TroubleshootPage(`?symptom=`)
 * 两处把状态写进 URL，其余列表页的筛选/页签/分页都只活在组件 state 里——
 * 排查到一半刷新就丢条件，也没法把「你看这个」贴给同事（评审 P1-7）。
 *
 * 【约定】URL 是视图状态的唯一真源；组件内部 state 只做草稿。
 * 值等于 fallback 时删除该参数，保持链接干净（与 SettingsPage 旧行为一致）。
 */
import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

export function useUrlState<T extends string | number>(key: string, fallback: T): [T, (next: T) => void] {
  const [searchParams, setSearchParams] = useSearchParams();

  const raw = searchParams.get(key);
  let value: T = fallback;
  if (raw !== null && raw !== "") {
    value =
      typeof fallback === "number"
        ? ((Number.isFinite(Number(raw)) ? Number(raw) : fallback) as T)
        : (raw as T);
  }

  const setValue = useCallback(
    (next: T) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === fallback || next === "") params.delete(key);
          else params.set(key, String(next));
          return params;
        },
        // replace：翻页/切筛选不该把浏览器历史塞满，前进后退仍能回到上一条真实路由。
        { replace: true },
      );
    },
    [key, fallback, setSearchParams],
  );

  return [value, setValue];
}
