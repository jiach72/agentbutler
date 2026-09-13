/**
 * 路由元信息契约测试（评审 P1-9）。
 *
 * 侧栏、页头 eyebrow、顶栏页题、移动 Tab 全部从 lib/routeMeta.ts 派生，
 * 因此这份表必须守住三条不变量：
 *   1. 图标全局唯一（重复图标会让侧栏失去形状识别能力，只能靠读字定位）；
 *   2. 路径唯一且能被 routeMetaFor 用前缀匹配命中详情页；
 *   3. 声明进导航的路由都能被 eyebrowFor / groupLabel 解析出分组名。
 */
import { describe, expect, it } from "vitest";
import {
  MOBILE_TAB_PATHS,
  NAV_GROUPS,
  PINNED_ROUTE,
  ROUTES,
  collapsibleGroupKeys,
  eyebrowFor,
  groupLabel,
  navRoutesFor,
  routeMetaFor,
  shortTitleOf,
} from "../src/lib/routeMeta.js";

describe("路由元信息单一事实源", () => {
  it("路径唯一", () => {
    const paths = ROUTES.map((route) => route.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("导航图标全局唯一（含 nav:false 的页面，避免日后转正时撞图）", () => {
    const seen = new Map<unknown, string>();
    const duplicates: string[] = [];
    for (const route of ROUTES) {
      const existing = seen.get(route.icon);
      if (existing !== undefined) duplicates.push(`${existing} 与 ${route.path} 共用同一图标`);
      else seen.set(route.icon, route.path);
    }
    expect(duplicates).toEqual([]);
  });

  it("每个路由的分组都在 NAV_GROUPS 里登记过", () => {
    const keys = new Set(NAV_GROUPS.map((group) => group.key));
    for (const route of ROUTES) expect(keys.has(route.group), route.path).toBe(true);
  });

  it("设置项是底部钉住项，且不参与分组渲染", () => {
    expect(PINNED_ROUTE.path).toBe("/settings");
    expect(navRoutesFor("settings")).toHaveLength(0);
  });

  it("详情页命中父级元信息（/sessions/:id → /sessions）", () => {
    expect(routeMetaFor("/sessions/hermes-main-1")?.path).toBe("/sessions");
    expect(routeMetaFor("/approvals/42")?.path).toBe("/approvals");
    expect(routeMetaFor("/unknown-page")).toBeNull();
  });

  it("eyebrow 取自分组名，导航与页内标签不可能互相矛盾", () => {
    expect(eyebrowFor("/core-files")).toBe(groupLabel("maintain"));
    expect(eyebrowFor("/core-files")).toBe("维护工具");
    expect(eyebrowFor("/cost")).toBe("记录与审批");
    expect(eyebrowFor("/dashboard")).toBe("日常使用");
    expect(eyebrowFor("/settings")).toBe("设置");
    // 未登记路径交由调用方兜底，不返回空串
    expect(eyebrowFor("/nope")).toBeUndefined();
  });

  it("移动 Tab 从同一份表取路径、图标与短标签", () => {
    expect(MOBILE_TAB_PATHS).toEqual(["/dashboard", "/skills", "/gateway", "/settings"]);
    for (const path of MOBILE_TAB_PATHS) {
      const meta = ROUTES.find((route) => route.path === path);
      expect(meta, path).toBeDefined();
      expect(meta!.nav).toBe(true);
    }
    const report = ROUTES.find((route) => route.path === "/report")!;
    expect(shortTitleOf(report)).toBe("周报");
  });

  it("深链进入任意折叠组时只默认展开当前所属组", () => {
    expect(collapsibleGroupKeys("/troubleshoot")).toEqual(["maintain"]);
    expect(collapsibleGroupKeys("/core-files")).toEqual(["maintain"]);
    expect(collapsibleGroupKeys("/setup")).toEqual(["maintain"]);
    expect(collapsibleGroupKeys("/sessions/hermes-main-1")).toEqual(["trust"]);
    expect(collapsibleGroupKeys("/dashboard")).toEqual([]);
    expect(collapsibleGroupKeys("/settings")).toEqual([]);
    expect(collapsibleGroupKeys("/not-a-route")).toEqual([]);
    expect(collapsibleGroupKeys()).toEqual(["trust", "maintain"]);
  });

  it("侧栏可见项收敛到可预期的规模（两个大分组都折叠）", () => {
    const visible = (["console", "maintain"] as const).reduce(
      (total, key) => total + navRoutesFor(key).length,
      2, // 信任层与维护与升级都是折叠分组，各只占一行
    );
    // 评审收敛：侧栏首屏只剩 3 常显 + 2 折叠行 + 底部设置 = 6 行。
    // 系统日志已收进「排查问题」页入口（nav:false），维护组从 5 项减到 4 项。
    expect(visible).toBe(9);
    // 两个大分组都必须可折叠，否则 9+4 项平铺会把底部署推出首屏
    expect(NAV_GROUPS.find((group) => group.key === "trust")?.collapsible).toBe(true);
    expect(NAV_GROUPS.find((group) => group.key === "maintain")?.collapsible).toBe(true);
    // 系统日志不进侧栏，但路由必须保留（排查问题页内有入口）
    const logs = ROUTES.find((route) => route.path === "/logs")!;
    expect(logs.nav).toBe(false);
  });
});
