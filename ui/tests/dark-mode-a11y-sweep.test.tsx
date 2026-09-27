import { describe, it, expect, beforeEach } from "vitest";
import {
  paletteFor,
  themeConfigFor,
  applyThemeCssBridge,
  darkPalette,
  isThemeMode,
} from "../src/theme/tokens.js";

describe("全站暗色模式与全链路无障碍深度复测 (Dark Mode & A11y Deep Sweep)", () => {
  const mockStyle = new Map<string, string>();
  const mockDoc = {
    documentElement: {
      dataset: {} as Record<string, string>,
      style: {
        colorScheme: "",
        setProperty(name: string, value: string) {
          mockStyle.set(name, value);
        },
        getPropertyValue(name: string) {
          return mockStyle.get(name) || "";
        },
      },
    },
  };

  beforeEach(() => {
    mockStyle.clear();
    mockDoc.documentElement.dataset = {};
    mockDoc.documentElement.style.colorScheme = "";
    ((globalThis as unknown) as { document: unknown }).document = mockDoc;
  });

  it("darkPalette 与 lightPalette 语义色盘结构完备且对比度合规", () => {
    const dark = paletteFor("dark");
    const light = paletteFor("light");

    expect(isThemeMode("dark")).toBe(true);
    expect(isThemeMode("light")).toBe(true);

    // 暗色基底必须深邃非全黑
    expect(dark.canvas).toBe("#0B0F17");
    expect(dark.surface).toBe("#121824");
    expect(dark.surface2).toBe("#1A2234");
    // 亮色基底纯净磨砂
    expect(light.canvas).toBe("#FAF8FE");
    expect(light.surface).toBe("#FFFFFF");

    // 前景文字层级
    expect(dark.text).toBe("#F1F5F9");
    expect(dark.text2).toBe("#94A3B8");
    expect(light.text).toBe("#1A1B1F");
    expect(light.text2).toBe("#414753");

    // 交互蓝
    expect(dark.primary).toBeDefined();
    expect(light.primary).toBe("#0071E3");

    // 信号色
    expect(dark.ok).toBeDefined();
    expect(dark.warn).toBeDefined();
    expect(dark.error).toBeDefined();
    expect(dark.focusRing).toContain("rgb");
  });

  it("applyThemeCssBridge('dark') 精确注入全量核心与兼容别名变量", () => {
    applyThemeCssBridge("dark");

    const root = mockDoc.documentElement;
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");

    // 核心语义色
    expect(root.style.getPropertyValue("--ab-canvas")).toBe(darkPalette.canvas);
    expect(root.style.getPropertyValue("--ab-surface")).toBe(darkPalette.surface);
    expect(root.style.getPropertyValue("--ab-surface-2")).toBe(darkPalette.surface2);
    expect(root.style.getPropertyValue("--ab-text")).toBe(darkPalette.text);
    expect(root.style.getPropertyValue("--ab-text-2")).toBe(darkPalette.text2);
    expect(root.style.getPropertyValue("--ab-border")).toBe(darkPalette.border);
    expect(root.style.getPropertyValue("--ab-primary")).toBe(darkPalette.primary);
    expect(root.style.getPropertyValue("--ab-ok")).toBe(darkPalette.ok);
    expect(root.style.getPropertyValue("--ab-warn")).toBe(darkPalette.warn);
    expect(root.style.getPropertyValue("--ab-error")).toBe(darkPalette.error);

    // 巡检 R18 重点防御别名（防暗黑模式黑字穿透与历史变量失效）
    expect(root.style.getPropertyValue("--ab-text-1")).toBe(darkPalette.text);
    expect(root.style.getPropertyValue("--ab-surface-soft")).toBe(darkPalette.surface2);
    expect(root.style.getPropertyValue("--ab-success")).toBe(darkPalette.ok);
    expect(root.style.getPropertyValue("--ab-warning")).toBe(darkPalette.warn);
    expect(root.style.getPropertyValue("--ab-brass")).toBe(darkPalette.brand);

    // 结构与圆角变量
    expect(root.style.getPropertyValue("--ab-radius-sm")).toBe("6px");
    expect(root.style.getPropertyValue("--ab-radius-md")).toBe("8px");
    expect(root.style.getPropertyValue("--ab-radius-lg")).toBe("12px");
    expect(root.style.getPropertyValue("--ab-font-mono")).toContain("monospace");
    expect(root.style.getPropertyValue("--ab-focus")).toBe(darkPalette.focusRing);
  });

  it("themeConfigFor('dark') 锁死容器背景、描边与文本以防 Antd 算法派生失真", () => {
    const config = themeConfigFor("dark");

    expect(config.token?.colorBgLayout).toBe(darkPalette.canvas);
    expect(config.token?.colorBgContainer).toBe(darkPalette.surface);
    expect(config.token?.colorBgElevated).toBe(darkPalette.surface2);
    expect(config.token?.colorText).toBe(darkPalette.text);
    expect(config.token?.colorTextSecondary).toBe(darkPalette.text2);
    expect(config.token?.colorBorder).toBe(darkPalette.borderControl);
    expect(config.token?.colorBorderSecondary).toBe(darkPalette.border);
    expect(config.token?.controlHeight).toBe(32);
  });
});
