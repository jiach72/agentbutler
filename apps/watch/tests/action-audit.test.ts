/**
 * 行为审计解析规则测试。
 *
 * 重点覆盖 B1「误报修复」的反向风险：把误报修掉的同时不能把真阳性一起干掉
 * （漏报）。B1 落地时全仓零用例，回归全靠肉眼，故这里把客户原句（误报方向）
 * 与常见真阳性句式（检出方向）成对钉住。
 */
import { describe, expect, it } from "vitest";
import { parseActionLine } from "../src/action-audit.js";

/** 客户日志里的真实误报行：不是删除动作，却含 "removed on … old path"。 */
const COMPAT_WARNING_LINE =
  "2026-09-10 12:29:20,710 WARNING hermes_cli.plugin_compat: hermes plugin compat: " +
  "`tools.browser_tool.warm_agent_browser_npx_cache` moved to " +
  "`tools.browser_tool_install.warm_agent_browser_npx_cache`. The old path is kept only " +
  "for external plugins and is removed on 2026-09-14; update your import.";

describe("行为审计：文件删除解析（真阳性方向）", () => {
  it("中文「名词 + 冒号」句式：捕获组不能停在「文件」上", () => {
    // 修复前：规则 1 缺可选连接词，捕获组拿到「文件」（冒号不在字符类里）→
    // PATH_LIKE_TARGET 判定不像路径 → 整行丢弃（漏报）。
    const parsed = parseActionLine("删除文件：/tmp/a.txt");
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("file-delete");
    expect(parsed?.severity).toBe("high");
    expect(parsed?.target).toBe("/tmp/a.txt");
  });

  it("中文「名词 + 空格」句式 + Windows 盘符路径", () => {
    const parsed = parseActionLine("已删除文件 C:\\Users\\jiach\\a.log");
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("file-delete");
    expect(parsed?.severity).toBe("high");
    expect(parsed?.target).toBe("C:\\Users\\jiach\\a.log");
  });

  it("英文 deleted file + Windows 路径", () => {
    const parsed = parseActionLine("deleted file C:\\temp\\x.log");
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("file-delete");
    expect(parsed?.target).toBe("C:\\temp\\x.log");
  });

  it("英文 file deleted + POSIX 路径（修复前后都应正常）", () => {
    const parsed = parseActionLine("file deleted /home/user/data.db");
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("file-delete");
    expect(parsed?.severity).toBe("high");
    expect(parsed?.target).toBe("/home/user/data.db");
  });

  it("removed + 绝对路径（无连接词）", () => {
    const parsed = parseActionLine("removed /var/log/agentbutler/old.log");
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("file-delete");
    expect(parsed?.target).toBe("/var/log/agentbutler/old.log");
  });
});

describe("行为审计：误报方向（B1 不能回退）", () => {
  it("客户原句（兼容告警）不判为高危删除", () => {
    expect(parseActionLine(COMPAT_WARNING_LINE)).toBeNull();
  });

  it("「删除文件：on」这类无路径结尾仍判为无动作", () => {
    // 捕获组会拿到「on」，不是路径 → 跳过，不猜测。
    expect(parseActionLine("删除文件：on 2026-09-14 的旧缓存")).toBeNull();
  });

  it("「removed on <日期>」不判为高危删除", () => {
    expect(parseActionLine("The legacy cache is removed on 2026-09-14 by the cleanup job")).toBeNull();
  });

  it("过短行直接跳过（长度守卫，避免把噪声当动作）", () => {
    expect(parseActionLine("rm /a")).toBeNull();
  });
});

describe("行为审计：其他规则不受影响", () => {
  it("文件写入：Windows 盘符路径同样可捕获", () => {
    const parsed = parseActionLine("写入文件 C:\\Users\\jiach\\notes.txt");
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("file-write");
    expect(parsed?.target).toBe("C:\\Users\\jiach\\notes.txt");
  });

  it("危险 shell 仍判高危", () => {
    const parsed = parseActionLine("执行命令: rm -rf /tmp/cache");
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("shell-exec");
    expect(parsed?.severity).toBe("high");
  });

  it("外发消息仍判高危", () => {
    const parsed = parseActionLine("发送消息到 ops-channel");
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("message-send");
    expect(parsed?.severity).toBe("high");
  });
});
