/**
 * 访问范围的唯一口径（产品设计评审 2026-09-30 · 问题 2）。
 *
 * 历史问题：顶栏把 publishHost === "0.0.0.0" 映射成「仅本地访问」，首页硬编码
 * 「本地安全: 仅回环保护」，设置页把「0.0.0.0 且无口令」判成通过——审计 D-7 只修了
 * 设置页的一处文案。告诉用户与真实暴露范围相反的结论，是安全产品唯一不能犯的错。
 *
 * 现在顶栏、首页、设置页全部调用 describeAccess()，0.0.0.0 如实说成「所有网络接口」。
 */

export interface AccessBaseline {
  listenHost?: string;
  publishHost?: string;
  loopback?: boolean;
  auth?: boolean;
}

export type AccessTone = "ok" | "warn" | "error" | "unknown";

export interface AccessDescription {
  /** 短结论（顶栏、首页一行）。 */
  title: string;
  tone: AccessTone;
  /** 一句解释（设置页、悬浮提示）。 */
  detail: string;
}

export function describeAccess(baseline: AccessBaseline | null): AccessDescription {
  if (baseline === null) {
    return { title: "正在读取访问方式", tone: "unknown", detail: "尚未读到面板的发布地址。" };
  }
  const auth = baseline.auth === true;
  if (baseline.loopback === true) {
    return {
      title: "仅本机可访问",
      tone: "ok",
      detail: auth ? "面板只发布在本机回环地址，并已设置访问口令。" : "面板只发布在本机回环地址，其他设备无法访问。",
    };
  }
  if (baseline.publishHost === "0.0.0.0") {
    return auth
      ? {
        title: "所有网络接口可访问",
        tone: "warn",
        detail: "面板监听在所有网络接口（0.0.0.0），已用访问口令保护。WSL portproxy 场景下宿主侧可能只转发到本机，实际范围以宿主防火墙为准。",
      }
      : {
        title: "所有网络接口可访问",
        tone: "error",
        detail: "面板监听在所有网络接口（0.0.0.0）且没有设置访问口令：能连到这台机器的任何设备都能操作你的智能体。请设置 BUTLER_ACCESS_TOKEN。WSL portproxy 场景下实际范围以宿主防火墙为准。",
      };
  }
  const host = baseline.publishHost ?? baseline.listenHost ?? "非回环地址";
  return auth
    ? { title: "同一网络可访问", tone: "warn", detail: `面板发布在 ${host}，同一网络的设备可以访问，已用访问口令保护。` }
    : { title: "同一网络可访问", tone: "error", detail: `面板发布在 ${host} 且没有设置访问口令：同一网络的任何人都能操作你的智能体。请设置 BUTLER_ACCESS_TOKEN。` };
}
