import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PATCH_REGISTRY,
  createPatchManager,
  findPatch,
  isWhitelistedTarget,
  type PatchManager,
} from "../src/patches/index.js";

/* ---------------- fixture：以登记表锚点插值构建“官方原文” ---------------- */

const anchor = (patchId: string, index: number): string =>
  findPatch(patchId)!.transformations[index]!.anchorFind;

const A_INIT_GATE = anchor("wx-send-throttle", 0);
const A_RATE_LIMIT_RESET = anchor("wx-send-throttle", 1);
const A_RETRY_LOOP = anchor("wx-send-throttle", 2);
const A_CAPTION_SEND = anchor("wx-send-throttle", 3);
const A_FINAL_SEND = anchor("wx-send-throttle", 4);
const A_CONNECT = anchor("wx-silent-first-delay", 0);
const A_INIT_AFTER_RATE_LIMIT = anchor("wx-reply-shaping", 0);
const A_SEND_TEXT_CHUNK_DEF = anchor("wx-reply-shaping", 1);
const A_DELIVERY_BLOCK = anchor("wx-reply-shaping", 2);

/** 官方原文骨架：锚点逐字节来自登记表，其余为无关胶水行（模拟 2518 行官方文件）。 */
function officialWeixinPy(): string {
  return [
    "from typing import Any, Dict, List, Optional, Tuple",
    "import asyncio, os, time, uuid",
    "from pathlib import Path",
    "from hermes_constants import get_hermes_home",
    "",
    "",
    "class WeixinAdapter(BasePlatformAdapter):",
    "    MAX_MESSAGE_LENGTH = 2000",
    "",
    "    def __init__(self, extra):",
    "        self._send_chunk_retries = 4",
    A_INIT_GATE,
    "            1,",
    "            int(",
    '                extra.get("rate_limit_circuit_threshold")',
    '                or os.getenv("WEIXIN_RATE_LIMIT_CIRCUIT_THRESHOLD", "1")',
    "            ),",
    "        )",
    "        self._rate_limit_circuit_window_seconds = float(",
    '            extra.get("rate_limit_circuit_window_seconds")',
    '            or os.getenv("WEIXIN_RATE_LIMIT_CIRCUIT_WINDOW_SECONDS", "30.0")',
    "        )",
    A_INIT_AFTER_RATE_LIMIT,
    '        self._dm_policy = "pairing"',
    "",
    "    async def _connect(self):",
    "        self._token_store.restore(self._account_id)",
    A_CONNECT,
    "        _LIVE_ADAPTERS[self._token] = self",
    "",
    A_RATE_LIMIT_RESET,
    "",
    A_SEND_TEXT_CHUNK_DEF,
    "        chat_id: str,",
    "    ) -> None:",
    '        """Send a text chunk."""',
    A_RETRY_LOOP,
    "                resp = await _send_message(",
    "                    self._send_session,",
    "                )",
    "        return",
    "",
    "    async def send(self, chat_id, final_content, context_token=None):",
    "        media_files: List[Tuple[str, bool]] = []",
    "        local_files: List[str] = []",
    "",
    A_DELIVERY_BLOCK,
    "            for idx, chunk in enumerate(chunks):",
    '                client_id = f"hermes-weixin-{uuid.uuid4().hex}"',
    "                await self._send_text_chunk(",
    "                    chat_id=chat_id,",
    "                    chunk=chunk,",
    "                    context_token=context_token,",
    "                    client_id=client_id,",
    "                )",
    "",
    "    async def _send_media(self, chat_id, caption=None, context_token=None):",
    "        last_message_id = None",
    "        if caption:",
    A_CAPTION_SEND,
    "                self._send_session,",
    "                client_id=last_message_id,",
    "            )",
    "",
    A_FINAL_SEND,
    "            self._send_session,",
    "            endpoint=EP_SEND_MESSAGE,",
    "        )",
    "",
  ].join("\n");
}

/** 官方原文的升级版变体：锚点区域不变，仅无关行新增（reapply targetContent 场景）。 */
function upgradedWeixinPy(): string {
  return officialWeixinPy().replace(
    '        self._dm_policy = "pairing"',
    '        self._dm_policy = "pairing"\n        self._upstream_version = "0.21.0"',
  );
}

/** 真实 Hermes 当前形态：三层能力已手工写入，但没有 Butler state.json。 */
function manuallyPatchedWeixinPy(): string {
  let content = officialWeixinPy();
  const throttle = findPatch("wx-send-throttle")!;
  for (const transformation of throttle.transformations) {
    content = content.replace(
      transformation.anchorFind,
      transformation.replacement({ minSendIntervalSec: 30 }),
    );
  }
  content = content.replace(
    A_CONNECT,
    `${A_CONNECT}` +
      "        # Anti-断流：重连/启动后进入 30s 冷却期。\n" +
      "        self._last_send_monotonic = time.monotonic()\n",
  );
  content = content.replace(
    A_INIT_AFTER_RATE_LIMIT,
    `${A_INIT_AFTER_RATE_LIMIT}` +
      "        self._max_attachments_per_reply = max(\n" +
      "            1,\n" +
      "            int(\n" +
      '                extra.get("max_attachments_per_reply")\n' +
      '                or os.getenv("WEIXIN_MAX_ATTACHMENTS_PER_REPLY", "1")\n' +
      "            ),\n" +
      "        )\n",
  );
  content = content.replace(
    A_SEND_TEXT_CHUNK_DEF,
    "    def _dump_oversize_text(self, content: str) -> str:\n" +
      '        path = Path(get_hermes_home()) / "cache" / "weixin_overflow" / "reply.txt"\n' +
      '        path.write_text(content, encoding="utf-8")\n' +
      "        return str(path)\n\n" +
      A_SEND_TEXT_CHUNK_DEF,
  );
  content = content.replace(
    A_DELIVERY_BLOCK,
    "        try:\n" +
      "            attachment_budget = max(1, self._max_attachments_per_reply)\n" +
      "            sent_attachments = 0\n" +
      "            formatted_text = self.format_message(final_content)\n" +
      "            if len(formatted_text) > self.MAX_MESSAGE_LENGTH:\n" +
      "                summary = formatted_text[: self.MAX_MESSAGE_LENGTH - 60].rstrip()\n" +
      "                if sent_attachments < attachment_budget:\n" +
      "                    overflow_path = self._dump_oversize_text(formatted_text)\n" +
      "                    await _deliver_media(overflow_path, is_voice=False)\n" +
      '                chunks = [summary + "\\n\\n…（正文超长，完整内容见附件）"]\n' +
      "            else:\n" +
      "                chunks = [formatted_text]\n",
  );
  return content;
}

/* ---------------------------------- 测试 ---------------------------------- */

let tmp: string;
let root: string;
let patchesDir: string;
let targetFile: string;
let manager: PatchManager;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "hermes-patches-"));
  root = join(tmp, "root");
  patchesDir = join(tmp, "butler-home", "patches");
  mkdirSync(join(root, "hermes-agent", "gateway", "platforms"), { recursive: true });
  targetFile = join(root, "hermes-agent", "gateway", "platforms", "weixin.py");
  writeFileSync(targetFile, officialWeixinPy());
  manager = createPatchManager({ rootPath: root, patchesDir });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("补丁登记表", () => {
  it("登记三条微信节流补丁，目标均在写入白名单", () => {
    expect(PATCH_REGISTRY.map((p) => p.id)).toEqual([
      "wx-send-throttle",
      "wx-silent-first-delay",
      "wx-reply-shaping",
    ]);
    for (const def of PATCH_REGISTRY) {
      expect(def.target).toBe("hermes-agent/gateway/platforms/weixin.py");
      expect(isWhitelistedTarget(def.target)).toBe(true);
      expect(def.transformations.length).toBeGreaterThan(0);
    }
    expect(isWhitelistedTarget("hermes-agent/gateway/platforms/other.py")).toBe(false);
    expect(isWhitelistedTarget("gateway\\platforms\\..\\..\\weixin.py")).toBe(false);
  });

  it("参数 schema：间隔默认 45 下限 45；静默延迟默认 20；附件预算/拆分阈值默认 1/2000", () => {
    expect(findPatch("wx-send-throttle")!.params["minSendIntervalSec"]).toMatchObject({
      default: 45,
      min: 45,
    });
    expect(findPatch("wx-silent-first-delay")!.params["silentFirstDelaySec"]).toMatchObject({
      default: 20,
    });
    expect(findPatch("wx-reply-shaping")!.params).toMatchObject({
      attachmentBudgetPerMsg: { default: 1, min: 1 },
      splitThresholdChars: { default: 2000 },
    });
  });
});

describe("apply：发送间隔限流", () => {
  it("应用成功：参数注入、方法与三处调用点插入、备份与 state 落盘", async () => {
    const before = readFileSync(targetFile, "utf8");
    const result = await manager.apply("wx-send-throttle", { minSendIntervalSec: 60 });
    expect(result.ok).toBe(true);
    expect(result.data!.status).toBe("applied");

    const patched = readFileSync(targetFile, "utf8");
    // init 注入（extra > env > 补丁默认 60）
    expect(patched).toContain('or os.getenv("WEIXIN_MIN_SEND_INTERVAL_SECONDS", "60")');
    expect(patched).toContain("self._send_throttle_gate = asyncio.Lock()");
    // 方法体插入且位于 _send_text_chunk 定义之前
    expect(patched).toContain("async def _throttle_before_send(self) -> None:");
    // 三处调用点
    expect(patched.split("await self._throttle_before_send()").length - 1).toBe(3);
    // 官方原文备份 = 应用前内容
    expect(readFileSync(join(patchesDir, "wx-send-throttle.orig"), "utf8")).toBe(before);
    // state.json 记录参数与目标路径
    const state = JSON.parse(readFileSync(join(patchesDir, "state.json"), "utf8")) as {
      applied: Record<string, { params: Record<string, number>; targetPath: string }>;
    };
    expect(state.applied["wx-send-throttle"]!.params).toEqual({ minSendIntervalSec: 60 });
    expect(state.applied["wx-send-throttle"]!.targetPath).toBe(targetFile);
  });

  it("幂等：重复 apply 返回 already-applied 且不重复写入", async () => {
    await manager.apply("wx-send-throttle", { minSendIntervalSec: 60 });
    const once = readFileSync(targetFile, "utf8");
    const again = await manager.apply("wx-send-throttle", { minSendIntervalSec: 60 });
    expect(again.data!.status).toBe("already-applied");
    expect(readFileSync(targetFile, "utf8")).toBe(once);
  });

  it("参数硬边界：minSendIntervalSec < 45 拒绝（E002）且不写入、不备份", async () => {
    const before = readFileSync(targetFile, "utf8");
    const result = await manager.apply("wx-send-throttle", { minSendIntervalSec: 30 });
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe("E002");
    expect(result.error!.userHint).toContain("M3 硬边界");
    expect(readFileSync(targetFile, "utf8")).toBe(before); // 未写入
    expect(() => readFileSync(join(patchesDir, "wx-send-throttle.orig"))).toThrow();
  });

  it("未知补丁 id → E002；目标文件缺失 → E203", async () => {
    const unknown = await manager.apply("wx-no-such-patch");
    expect(unknown.ok).toBe(false);
    expect(unknown.error!.code).toBe("E002");

    rmSync(root, { recursive: true, force: true });
    const missing = await manager.apply("wx-send-throttle", { minSendIntervalSec: 60 });
    expect(missing.ok).toBe(false);
    expect(missing.error!.code).toBe("E203");
  });
});

describe("apply：静默后首条预等待（前置依赖）", () => {
  it("前置补丁未应用 → E203 拒绝；应用 wx-send-throttle 后成功且默认延迟 20s", async () => {
    const early = await manager.apply("wx-silent-first-delay", { silentFirstDelaySec: 20 });
    expect(early.ok).toBe(false);
    expect(early.error!.code).toBe("E203");
    expect(readFileSync(targetFile, "utf8")).toBe(officialWeixinPy()); // 未写入

    await manager.apply("wx-send-throttle", { minSendIntervalSec: 60 });
    const result = await manager.apply("wx-silent-first-delay", { silentFirstDelaySec: 20 });
    expect(result.ok).toBe(true);
    const patched = readFileSync(targetFile, "utf8");
    expect(patched).toContain("self._last_send_monotonic = time.monotonic() - max(");
    expect(patched).toContain("0.0, self._min_send_interval_seconds - 20");
  });
});

describe("apply：回复整形（附件预算 + 超长转附件）", () => {
  it("应用成功：预算/阈值参数注入、投递段重写、_dump_oversize_text 插入", async () => {
    const result = await manager.apply("wx-reply-shaping", {
      attachmentBudgetPerMsg: 2,
      splitThresholdChars: 1500,
    });
    expect(result.ok).toBe(true);
    const patched = readFileSync(targetFile, "utf8");
    expect(patched).toContain('or os.getenv("WEIXIN_MAX_ATTACHMENTS_PER_REPLY", "2")');
    expect(patched).toContain('or os.getenv("WEIXIN_REPLY_OVERFLOW_THRESHOLD", "1500")');
    expect(patched).toContain("attachment_budget = max(1, self._max_attachments_per_reply)");
    expect(patched).toContain("def _dump_oversize_text(self, content: str) -> str:");
    expect(patched).toContain('chunks = [summary + "\\n\\n…（正文超长，完整内容见附件）"]');
    // 官方多附件直发循环被替换（旧投递段消失）
    expect(patched).not.toContain("# Deliver extracted MEDIA: attachments first.");
    expect(patched).not.toContain("# Deliver bare local file paths.");
  });

  it("三层补丁任意顺序应用均成功且布局一致（方法顺序 throttle → dump → _send_text_chunk）", async () => {
    // 乱序：3 → 2（先置依赖）→ 1
    expect((await manager.apply("wx-reply-shaping")).ok).toBe(true);
    const early = await manager.apply("wx-silent-first-delay");
    expect(early.ok).toBe(false); // 依赖未满足
    expect((await manager.apply("wx-send-throttle")).ok).toBe(true);
    expect((await manager.apply("wx-silent-first-delay")).ok).toBe(true);

    const patched = readFileSync(targetFile, "utf8");
    const iThrottle = patched.indexOf("async def _throttle_before_send");
    const iDump = patched.indexOf("def _dump_oversize_text");
    const iChunk = patched.indexOf("async def _send_text_chunk(");
    expect(iThrottle).toBeGreaterThan(0);
    expect(iThrottle).toBeLessThan(iDump);
    expect(iDump).toBeLessThan(iChunk);
    // 正序目录独立应用一轮，全部 detect ok
    for (const id of ["wx-send-throttle", "wx-silent-first-delay", "wx-reply-shaping"]) {
      const report = await manager.detect(id);
      expect(report.data!.status).toBe("ok");
    }
  });
});

describe("漂移检测 detect", () => {
  it("未应用 → not-applied；应用后 → ok", async () => {
    const before = await manager.detect("wx-send-throttle");
    expect(before.data!.status).toBe("not-applied");

    await manager.apply("wx-send-throttle", { minSendIntervalSec: 60 });
    const after = await manager.detect("wx-send-throttle");
    expect(after.data!.status).toBe("ok");
    expect(after.data!.params).toEqual({ minSendIntervalSec: 60 });
    expect(typeof after.data!.appliedAt).toBe("string");
  });

  it("无 state + 真实手工源码 → observed，并提取 30/30/1/2000 且不纳管", async () => {
    const manual = manuallyPatchedWeixinPy();
    writeFileSync(targetFile, manual);

    const expected = {
      "wx-send-throttle": { minSendIntervalSec: 30 },
      "wx-silent-first-delay": { silentFirstDelaySec: 30 },
      "wx-reply-shaping": { attachmentBudgetPerMsg: 1, splitThresholdChars: 2000 },
    };
    for (const [patchId, params] of Object.entries(expected)) {
      const report = await manager.detect(patchId);
      expect(report.ok).toBe(true);
      expect(report.data).toMatchObject({ patchId, status: "observed", params });
      expect(report.data!.appliedAt).toBeUndefined();
    }

    expect(readFileSync(targetFile, "utf8")).toBe(manual);
    expect(existsSync(join(patchesDir, "state.json"))).toBe(false);
  });

  it("无 state + 参数化首条延迟公式 → observed 提取独立延迟而非发送间隔", async () => {
    let content = officialWeixinPy();
    for (const transformation of findPatch("wx-send-throttle")!.transformations) {
      content = content.replace(
        transformation.anchorFind,
        transformation.replacement({ minSendIntervalSec: 60 }),
      );
    }
    const silent = findPatch("wx-silent-first-delay")!;
    content = content.replace(
      silent.transformations[0]!.anchorFind,
      silent.transformations[0]!.replacement({ silentFirstDelaySec: 20 }),
    );
    writeFileSync(targetFile, content);

    const report = await manager.detect("wx-silent-first-delay");
    expect(report.data).toMatchObject({
      status: "observed",
      params: { silentFirstDelaySec: 20 },
    });
  });

  it("目标文件补丁块被外部改动 → drifted（region-unrecognized）；apply 拒绝写入", async () => {
    await manager.apply("wx-send-throttle", { minSendIntervalSec: 60 });
    // 改动补丁块内部（节流初值行）：replacement 不再完整在位
    writeFileSync(
      targetFile,
      readFileSync(targetFile, "utf8").replace(
        "self._last_send_monotonic = 0.0",
        "self._last_send_monotonic = 1.0",
      ),
    );
    const report = await manager.detect("wx-send-throttle");
    expect(report.data!.status).toBe("drifted");
    expect(report.data!.diffs.length).toBeGreaterThan(0);
    const reapplyRaw = await manager.apply("wx-send-throttle", { minSendIntervalSec: 60 });
    expect(reapplyRaw.ok).toBe(false);
    expect(reapplyRaw.error!.code).toBe("E203");
  });

  it("目标文件被还原为官方原文 → drifted（piece-missing，锚回到原位）", async () => {
    await manager.apply("wx-send-throttle", { minSendIntervalSec: 60 });
    writeFileSync(targetFile, officialWeixinPy());
    const report = await manager.detect("wx-send-throttle");
    expect(report.data!.status).toBe("drifted");
    const diff = report.data!.diffs.find((d) => d.reason === "piece-missing");
    expect(diff).toBeDefined();
    expect(diff!.anchorIndex).toBeGreaterThanOrEqual(0);
    expect(diff!.context.length).toBeGreaterThan(0);
    expect(diff!.context.some((line) => line.includes("asyncio.Lock()"))).toBe(true);
  });

  it("目标缺失 → missing-target；备份缺失 → missing-backup", async () => {
    await manager.apply("wx-send-throttle", { minSendIntervalSec: 60 });
    rmSync(targetFile);
    expect((await manager.detect("wx-send-throttle")).data!.status).toBe("missing-target");

    writeFileSync(targetFile, officialWeixinPy());
    rmSync(join(patchesDir, "wx-send-throttle.orig"));
    expect((await manager.detect("wx-send-throttle")).data!.status).toBe("missing-backup");
  });
});

describe("reapply：参数变更与升级场景", () => {
  it("按新参数从备份重打：文件含新值、备份保持官方原文、state 更新", async () => {
    await manager.apply("wx-send-throttle", { minSendIntervalSec: 60 });
    const result = await manager.reapply("wx-send-throttle", { minSendIntervalSec: 90 });
    expect(result.ok).toBe(true);
    expect(result.data!.status).toBe("applied");
    const patched = readFileSync(targetFile, "utf8");
    expect(patched).toContain('"WEIXIN_MIN_SEND_INTERVAL_SECONDS", "90"');
    expect(patched).not.toContain('"WEIXIN_MIN_SEND_INTERVAL_SECONDS", "60"');
    expect(readFileSync(join(patchesDir, "wx-send-throttle.orig"), "utf8")).toBe(
      officialWeixinPy(),
    );
    const state = JSON.parse(readFileSync(join(patchesDir, "state.json"), "utf8")) as {
      applied: Record<string, { params: Record<string, number> }>;
    };
    expect(state.applied["wx-send-throttle"]!.params).toEqual({ minSendIntervalSec: 90 });
    expect((await manager.detect("wx-send-throttle")).data!.status).toBe("ok");
  });

  it("升级场景 targetContent：新官方原文成为新备份基线并在其上重打", async () => {
    await manager.apply("wx-send-throttle", { minSendIntervalSec: 60 });
    const upgraded = upgradedWeixinPy();
    const result = await manager.reapply(
      "wx-send-throttle",
      { minSendIntervalSec: 75 },
      {
        targetContent: upgraded,
      },
    );
    expect(result.ok).toBe(true);
    const patched = readFileSync(targetFile, "utf8");
    expect(patched).toContain('self._upstream_version = "0.21.0"');
    expect(patched).toContain('"WEIXIN_MIN_SEND_INTERVAL_SECONDS", "75"');
    // 新官方原文落为 .orig 基线
    expect(readFileSync(join(patchesDir, "wx-send-throttle.orig"), "utf8")).toBe(upgraded);
    expect((await manager.detect("wx-send-throttle")).data!.status).toBe("ok");
  });

  it("未应用的补丁 reapply 等价首次应用", async () => {
    const result = await manager.reapply("wx-reply-shaping", { attachmentBudgetPerMsg: 3 });
    expect(result.data!.status).toBe("applied");
    expect(readFileSync(targetFile, "utf8")).toContain(
      'or os.getenv("WEIXIN_MAX_ATTACHMENTS_PER_REPLY", "3")',
    );
  });
});

describe("可注入 fs（内存文件系统）", () => {
  it("注入 readFile/writeFile 即可脱离磁盘完成 apply/detect", async () => {
    const files = new Map<string, string>([
      ["/root/hermes-agent/gateway/platforms/weixin.py", officialWeixinPy()],
    ]);
    const memoryManager = createPatchManager({
      rootPath: "/root",
      patchesDir: "/home/patches",
      readFile: async (path) => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return content;
      },
      writeFile: async (path, content) => {
        files.set(path, content);
      },
    });
    const applied = await memoryManager.apply("wx-send-throttle", { minSendIntervalSec: 45 });
    expect(applied.ok).toBe(true);
    expect(files.get("/root/hermes-agent/gateway/platforms/weixin.py")).toContain(
      '"WEIXIN_MIN_SEND_INTERVAL_SECONDS", "45"',
    );
    expect(files.has("/home/patches/wx-send-throttle.orig")).toBe(true);
    expect(files.has("/home/patches/state.json")).toBe(true);
    expect((await memoryManager.detect("wx-send-throttle")).data!.status).toBe("ok");
  });
});
