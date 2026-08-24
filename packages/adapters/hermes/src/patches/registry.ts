/**
 * 补丁登记表（Task 12 / Part A）。
 *
 * 真实环境勘察结论（只读，2026-08-20）：
 * - 真实 weixin.py：/home/jiach/.hermes/hermes-agent/gateway/platforms/weixin.py
 *   （100125 字节，2518 行，mtime 2026-08-20 12:51:30 +0800）。
 * - 该文件位于 git 仓库 /home/jiach/.hermes/hermes-agent（main 分支），
 *   用户已有补丁 = 工作区未提交改动（git diff：79 insertions / 10 deletions），
 *   形态为三层节流：
 *   ① 发送间隔限流：__init__ 注入 _min_send_interval_seconds/_last_send_monotonic/
 *      _send_throttle_gate/_max_attachments_per_reply；新增 _throttle_before_send()
 *      （全局门闩 + 单调时钟间隔）；三处出站调用点（_send_text_chunk 重试循环、
 *      媒体 caption _send_message、媒体正文 _api_post）前置节流等待；
 *   ② 静默后首条预等待：connect 成功（_mark_connected）后把 _last_send_monotonic
 *      拨到当前时刻，使重连/启动后的首条消息（startup notification / cron 推送）
 *      先等满一个发送间隔再发（真实补丁冷却 = 完整间隔；本登记按 PRD 参数化为
 *      silentFirstDelaySec，默认 20s，≤ 间隔）；
 *   ③ 附件预算 + 超长文本整形：send() 的投递段重写——附件合并计数、超出预算的
 *      抑制并 warning；超长文本截断为摘要、完整正文落盘（cache/weixin_overflow/）
 *      转附件投递，绝不拆成多条文本（真实补丁用官方常量 self.MAX_MESSAGE_LENGTH=2000
 *      作阈值；本登记按 PRD 参数化为 splitThresholdChars，经
 *      _reply_overflow_threshold 属性注入，extra > env > 补丁默认值）。
 * - 锚点（anchorFind）全部取自官方原文（git HEAD 版本），已在真实官方文件上
 *   逐一验证唯一命中（每锚 count == 1）。
 *
 * 登记拆分：三层节流拆为 3 条登记（间隔限流 / 静默首条预等待 / 附件预算+超长整形），
 * 与真实 diff 的三个语义块一一对应。注意：
 * - 补丁 1 与补丁 3 的 __init__ 注入点使用不同锚（_send_text_gate 行 vs
 *   rate_limit_circuit_open 段末），保证任意应用顺序下锚点互不破坏；
 * - 补丁 2 依赖补丁 1 初始化的属性（requires: ["wx-send-throttle"]）。
 */

/** 单个数值参数的 schema。 */
export interface PatchParamSchema {
  type: "number";
  /** 缺省值（未传参数时使用）。 */
  default: number;
  /** 下界（含）。 */
  min?: number;
  /** 上界（含）。 */
  max?: number;
  /** 仅整数。 */
  integer?: boolean;
}

/** 补丁参数值（登记表内全部为数值参数）。 */
export type PatchParams = Record<string, number>;

/**
 * 一次文本变换：anchorFind 为官方原文锚（多行字符串，须在官方文件中唯一），
 * replacement 以参数生成补丁后文本（含锚原文，保证其他补丁的锚不被破坏）。
 */
export interface PatchTransformation {
  anchorFind: string;
  replacement: (params: PatchParams) => string;
}

/** 一条已登记补丁的静态定义。 */
export interface PatchDefinition {
  id: string;
  title: string;
  description: string;
  /** 目标文件路径（相对实例 rootPath，POSIX 风格；同时构成写入白名单）。 */
  target: string;
  /** 前置补丁 id（应用前须已应用）。 */
  requires?: string[];
  /** 参数 schema（键 → 界限）。 */
  params: Record<string, PatchParamSchema>;
  /**
   * 只读识别器：在没有 Butler state.json 时，从当前源码判断同等语义的手工实现
   * 是否已经存在，并提取源码中可观察到的参数。命中不代表 Butler 已纳管。
   */
  observe?: (content: string) => PatchParams | null;
  transformations: PatchTransformation[];
}

/** 从 Python os.getenv("KEY", "number") 中提取源码默认值。 */
function envNumberFallback(content: string, key: string): number | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(
    new RegExp(
      `os\\.getenv\\(\\s*["']${escapedKey}["']\\s*,\\s*["'](-?\\d+(?:\\.\\d+)?)["']\\s*\\)`,
    ),
  );
  if (match?.[1] === undefined) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/** 从 Python 类常量 `NAME = number` 中提取数值。 */
function pythonNumberConstant(content: string, name: string): number | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(
    new RegExp(`^\\s*${escapedName}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)\\s*$`, "m"),
  );
  if (match?.[1] === undefined) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function observeThrottle(content: string): PatchParams | null {
  const callCount = content.match(/await\s+self\._throttle_before_send\(\)/g)?.length ?? 0;
  if (
    !content.includes("async def _throttle_before_send(self) -> None:") ||
    !content.includes("self._send_throttle_gate = asyncio.Lock()") ||
    !content.includes("self._last_send_monotonic") ||
    callCount < 3
  ) {
    return null;
  }
  const interval = envNumberFallback(content, "WEIXIN_MIN_SEND_INTERVAL_SECONDS");
  return interval === undefined ? null : { minSendIntervalSec: interval };
}

function observeSilentFirstDelay(content: string): PatchParams | null {
  const connectAt = content.indexOf("self._mark_connected()");
  if (connectAt < 0) return null;
  const nearby = content.slice(connectAt, connectAt + 800);
  const interval = envNumberFallback(content, "WEIXIN_MIN_SEND_INTERVAL_SECONDS");

  const parameterized = nearby.match(
    /self\._last_send_monotonic\s*=\s*time\.monotonic\(\)\s*-\s*max\(\s*0(?:\.0)?\s*,\s*self\._min_send_interval_seconds\s*-\s*(-?\d+(?:\.\d+)?)\s*\)/s,
  );
  if (parameterized?.[1] !== undefined) {
    const delay = Number(parameterized[1]);
    return Number.isFinite(delay) ? { silentFirstDelaySec: delay } : null;
  }
  if (/self\._last_send_monotonic\s*=\s*time\.monotonic\(\)\s*(?:#.*)?$/m.test(nearby)) {
    return interval === undefined ? null : { silentFirstDelaySec: interval };
  }
  return null;
}

function observeReplyShaping(content: string): PatchParams | null {
  if (
    !content.includes("self._max_attachments_per_reply") ||
    !content.includes("def _dump_oversize_text(self, content: str) -> str:") ||
    !content.includes("attachment_budget = max(1, self._max_attachments_per_reply)") ||
    !content.includes("overflow_path = self._dump_oversize_text(formatted_text)")
  ) {
    return null;
  }
  const attachmentBudget = envNumberFallback(content, "WEIXIN_MAX_ATTACHMENTS_PER_REPLY");
  let splitThreshold: number | undefined;
  if (content.includes("if len(formatted_text) > self._reply_overflow_threshold:")) {
    splitThreshold = envNumberFallback(content, "WEIXIN_REPLY_OVERFLOW_THRESHOLD");
  } else if (content.includes("if len(formatted_text) > self.MAX_MESSAGE_LENGTH:")) {
    splitThreshold = pythonNumberConstant(content, "MAX_MESSAGE_LENGTH");
  }
  if (attachmentBudget === undefined || splitThreshold === undefined) return null;
  return {
    attachmentBudgetPerMsg: attachmentBudget,
    splitThresholdChars: splitThreshold,
  };
}

/* ------------------------------ 锚点（官方原文） ------------------------------ */
/* 以下锚点均逐字节取自官方 weixin.py（git HEAD），已在真实文件验证唯一。 */

const ANCHOR_INIT_GATE = `\
        self._send_text_gate = asyncio.Lock()
        self._rate_limit_circuit_threshold = max(`;

const ANCHOR_CONNECT = `\
        self._poll_task = asyncio.create_task(self._poll_loop(), name="weixin-poll")
        self._mark_connected()
`;

const ANCHOR_RATE_LIMIT_RESET = `\
    def _reset_rate_limit_circuit(self) -> None:
        self._rate_limit_events.clear()
        self._rate_limit_circuit_until = 0.0
`;

const ANCHOR_SEND_TEXT_CHUNK_DEF = `\
    async def _send_text_chunk(
        self,
        *,
`;

const ANCHOR_RETRY_LOOP = `\
        for attempt in range(self._send_chunk_retries + 1):
            if self._rate_limit_cooldown_remaining() > 0:
                raise self._rate_limit_error()
            try:
`;

const ANCHOR_DELIVERY_BLOCK = `\
        try:
            # Deliver extracted MEDIA: attachments first.
            for media_path, is_voice in media_files:
                try:
                    await _deliver_media(media_path, is_voice)
                except Exception as exc:
                    logger.warning("[%s] media delivery failed for %s: %s", self.name, media_path, exc)

            # Deliver bare local file paths.
            for file_path in local_files:
                try:
                    await _deliver_media(file_path, is_voice=False)
                except Exception as exc:
                    logger.warning("[%s] local file delivery failed for %s: %s", self.name, file_path, exc)

            # Deliver text content.
            chunks = [c for c in self._split_text(self.format_message(final_content)) if c and c.strip()]
`;

const ANCHOR_CAPTION_SEND = `\
            last_message_id = f"hermes-weixin-{uuid.uuid4().hex}"
            await _send_message(
`;

const ANCHOR_FINAL_SEND = `\
        last_message_id = f"hermes-weixin-{uuid.uuid4().hex}"
        await _api_post(
`;

/** 补丁 3 的 __init__ 注入锚（与补丁 1 的 INIT_GATE 错开，避免同点插入互毁锚）。 */
const ANCHOR_INIT_AFTER_RATE_LIMIT = `\
        self._rate_limit_circuit_open_seconds = float(
            extra.get("rate_limit_circuit_open_seconds")
            or os.getenv("WEIXIN_RATE_LIMIT_CIRCUIT_OPEN_SECONDS", "30.0")
        )
        self._rate_limit_circuit_until = 0.0
        self._rate_limit_events: List[float] = []
`;

/* ------------------------------ 生成块（补丁代码） ------------------------------ */

/** 补丁 1：_throttle_before_send 方法体（取自真实补丁，参数不进此块）。 */
const THROTTLE_METHOD = `\
    async def _throttle_before_send(self) -> None:
        """Space out iLink outbound calls so we never trip the platform rate limit.

        Holds an adapter-wide gate so concurrent sends (multiple chats, cron
        pushes, media+text) serialize and keep at least
        \`\`_min_send_interval_seconds\`\` between any two iLink sendmessage calls.
        """
        interval = self._min_send_interval_seconds
        if interval <= 0:
            return
        async with self._send_throttle_gate:
            elapsed = time.monotonic() - self._last_send_monotonic
            if elapsed < interval:
                await asyncio.sleep(interval - elapsed)
            self._last_send_monotonic = time.monotonic()
`;

/** 补丁 3：_dump_oversize_text 方法体（取自真实补丁）。 */
const OVERSIZE_METHOD = `\
    def _dump_oversize_text(self, content: str) -> str:
        """Persist an over-limit reply to a file so it can be delivered as an attachment."""
        cache_dir = Path(get_hermes_home()) / "cache" / "weixin_overflow"
        cache_dir.mkdir(parents=True, exist_ok=True)
        ts = time.strftime("%Y%m%d_%H%M%S")
        path = cache_dir / f"hermes_reply_{ts}.txt"
        path.write_text(content, encoding="utf-8")
        return str(path)
`;

/**
 * 三条补丁登记（形态以真实 git diff 为准；参数化点见各条 description）。
 */
export const PATCH_REGISTRY: readonly PatchDefinition[] = [
  {
    id: "wx-send-throttle",
    title: "微信发送间隔限流（Anti-断流）",
    description:
      "任意两条 iLink 出站消息之间至少间隔 minSendIntervalSec 秒：__init__ 注入" +
      "_min_send_interval_seconds/_last_send_monotonic/_send_throttle_gate，新增全局门闩方法 " +
      "_throttle_before_send()，并在三处出站调用点（文本 chunk 重试循环 / 媒体 caption / " +
      "媒体正文）前置节流等待。参数经 extra > env > 补丁默认值 注入。",
    target: "hermes-agent/gateway/platforms/weixin.py",
    params: {
      minSendIntervalSec: { type: "number", default: 45, min: 45, max: 3600 },
    },
    observe: observeThrottle,
    transformations: [
      {
        anchorFind: ANCHOR_INIT_GATE,
        replacement: (p) =>
          `        self._send_text_gate = asyncio.Lock()\n` +
          `        # ── Anti-断流 (rate-limit avoidance) ─────────────────────────────\n` +
          `        # 全局发送节流：任意两条 iLink 出站消息之间至少间隔该秒数，\n` +
          `        # 从源头避免触发 iLink 频率限制（ret=-2），保证消息不断流。\n` +
          `        self._min_send_interval_seconds = float(\n` +
          `            extra.get("min_send_interval_seconds")\n` +
          `            or os.getenv("WEIXIN_MIN_SEND_INTERVAL_SECONDS", "${p["minSendIntervalSec"]}")\n` +
          `        )\n` +
          `        self._last_send_monotonic = 0.0\n` +
          `        self._send_throttle_gate = asyncio.Lock()\n` +
          `        self._rate_limit_circuit_threshold = max(`,
      },
      {
        anchorFind: ANCHOR_RATE_LIMIT_RESET,
        replacement: () => `${ANCHOR_RATE_LIMIT_RESET}\n${THROTTLE_METHOD}`,
      },
      {
        anchorFind: ANCHOR_RETRY_LOOP,
        replacement: () =>
          `        for attempt in range(self._send_chunk_retries + 1):\n` +
          `            if self._rate_limit_cooldown_remaining() > 0:\n` +
          `                raise self._rate_limit_error()\n` +
          `            await self._throttle_before_send()\n` +
          `            try:\n`,
      },
      {
        anchorFind: ANCHOR_CAPTION_SEND,
        replacement: () =>
          `            last_message_id = f"hermes-weixin-{uuid.uuid4().hex}"\n` +
          `            await self._throttle_before_send()\n` +
          `            await _send_message(\n`,
      },
      {
        anchorFind: ANCHOR_FINAL_SEND,
        replacement: () =>
          `        last_message_id = f"hermes-weixin-{uuid.uuid4().hex}"\n` +
          `        await self._throttle_before_send()\n` +
          `        await _api_post(\n`,
      },
    ],
  },
  {
    id: "wx-silent-first-delay",
    title: "静默期后首条消息预等待（连接冷却）",
    description:
      "connect 成功后把 _last_send_monotonic 回拨，使重连/启动后的首条消息（startup " +
      "notification / cron 推送）先等待 silentFirstDelaySec 秒再发。真实补丁为拨到当前" +
      "时刻（冷却 = 完整发送间隔）；此处按 PRD 参数化为独立延迟（≤ 间隔），依赖补丁 " +
      "wx-send-throttle 初始化的属性。",
    target: "hermes-agent/gateway/platforms/weixin.py",
    requires: ["wx-send-throttle"],
    params: {
      silentFirstDelaySec: { type: "number", default: 20, min: 0, max: 3600 },
    },
    observe: observeSilentFirstDelay,
    transformations: [
      {
        anchorFind: ANCHOR_CONNECT,
        replacement: (p) =>
          `${ANCHOR_CONNECT}` +
          `        # Anti-断流：重连/启动后进入静默冷却期（首条消息先等 ${p["silentFirstDelaySec"]} 秒），\n` +
          `        # 避免刚连上就发消息（如 startup notification / cron 推送）触发 iLink 频率限制。\n` +
          `        self._last_send_monotonic = time.monotonic() - max(\n` +
          `            0.0, self._min_send_interval_seconds - ${p["silentFirstDelaySec"]}\n` +
          `        )\n`,
      },
    ],
  },
  {
    id: "wx-reply-shaping",
    title: "回复整形：附件预算 + 超长文本转附件",
    description:
      "send() 投递段重写：附件（媒体 + 本地文件）合并计数，一次回复最多投递 " +
      "attachmentBudgetPerMsg 个附件，超出预算的抑制并 warning；文本超过 " +
      "splitThresholdChars 字时截断为摘要、完整正文落盘（cache/weixin_overflow/）转附件" +
      "投递（若预算未用完），绝不拆成多条文本。真实补丁阈值固定用官方常量 " +
      "MAX_MESSAGE_LENGTH=2000；此处参数化为 _reply_overflow_threshold 属性" +
      "（extra > env > 补丁默认值），附件预算经 _max_attachments_per_reply 注入。",
    target: "hermes-agent/gateway/platforms/weixin.py",
    params: {
      attachmentBudgetPerMsg: { type: "number", default: 1, min: 1, max: 10, integer: true },
      splitThresholdChars: { type: "number", default: 2000, min: 200, max: 8000, integer: true },
    },
    observe: observeReplyShaping,
    transformations: [
      {
        anchorFind: ANCHOR_INIT_AFTER_RATE_LIMIT,
        replacement: (p) =>
          `${ANCHOR_INIT_AFTER_RATE_LIMIT}` +
          `        # 单次回复的附件预算：默认最多 ${p["attachmentBudgetPerMsg"]} 个附件，防止多附件连发触发限流。\n` +
          `        self._max_attachments_per_reply = max(\n` +
          `            1,\n` +
          `            int(\n` +
          `                extra.get("max_attachments_per_reply")\n` +
          `                or os.getenv("WEIXIN_MAX_ATTACHMENTS_PER_REPLY", "${p["attachmentBudgetPerMsg"]}")\n` +
          `            ),\n` +
          `        )\n` +
          `        # 超长回复整形阈值：超过该长度的回复截断为摘要，完整正文转附件投递。\n` +
          `        self._reply_overflow_threshold = max(\n` +
          `            1,\n` +
          `            int(\n` +
          `                extra.get("reply_overflow_threshold")\n` +
          `                or os.getenv("WEIXIN_REPLY_OVERFLOW_THRESHOLD", "${p["splitThresholdChars"]}")\n` +
          `            ),\n` +
          `        )\n`,
      },
      {
        anchorFind: ANCHOR_SEND_TEXT_CHUNK_DEF,
        replacement: () => `${OVERSIZE_METHOD}\n${ANCHOR_SEND_TEXT_CHUNK_DEF}`,
      },
      {
        anchorFind: ANCHOR_DELIVERY_BLOCK,
        replacement: (p) =>
          `        try:\n` +
          `            # ── 附件整形：一次回复最多发送 ${p["attachmentBudgetPerMsg"]} 个附件（可配），\n` +
          `            #    防止多附件连发叠加触发 iLink 频率限制导致断流。\n` +
          `            attachment_budget = max(1, self._max_attachments_per_reply)\n` +
          `            pending_media: List[Tuple[str, bool]] = [\n` +
          `                *media_files,\n` +
          `                *[(p, False) for p in local_files],\n` +
          `            ]\n` +
          `            sent_attachments = 0\n` +
          `            for media_path, is_voice in pending_media:\n` +
          `                if sent_attachments >= attachment_budget:\n` +
          `                    logger.warning(\n` +
          `                        "[%s] suppressed attachment %s for %s (budget=%d)",\n` +
          `                        self.name, media_path, _safe_id(chat_id), attachment_budget,\n` +
          `                    )\n` +
          `                    continue\n` +
          `                try:\n` +
          `                    await _deliver_media(media_path, is_voice)\n` +
          `                    sent_attachments += 1\n` +
          `                except Exception as exc:\n` +
          `                    logger.warning("[%s] media delivery failed for %s: %s", self.name, media_path, exc)\n` +
          `\n` +
          `            # ── 文本整形：≤阈值时按官方拆分；超长时截断为摘要，\n` +
          `            #    完整内容落盘为附件（若附件预算未用完），绝不拆成多条文本。\n` +
          `            formatted_text = self.format_message(final_content)\n` +
          `            if len(formatted_text) > self._reply_overflow_threshold:\n` +
          `                summary = formatted_text[: self._reply_overflow_threshold - 60].rstrip()\n` +
          `                if sent_attachments < attachment_budget:\n` +
          `                    overflow_path = self._dump_oversize_text(formatted_text)\n` +
          `                    try:\n` +
          `                        await _deliver_media(overflow_path, is_voice=False)\n` +
          `                        sent_attachments += 1\n` +
          `                    except Exception as exc:\n` +
          `                        logger.warning("[%s] oversize-text file delivery failed: %s", self.name, exc)\n` +
          `                chunks = [summary + "\\n\\n…（正文超长，完整内容见附件）"]\n` +
          `            else:\n` +
          `                chunks = [c for c in self._split_text(formatted_text) if c and c.strip()]\n`,
      },
    ],
  },
];

/** 按 id 查找已登记补丁。 */
export function findPatch(id: string): PatchDefinition | undefined {
  return PATCH_REGISTRY.find((patch) => patch.id === id);
}

/**
 * 写入白名单：目标文件相对路径（POSIX 归一化）与某条登记的 target 精确相等才允许写。
 */
export function isWhitelistedTarget(relPath: string): boolean {
  return PATCH_REGISTRY.some((patch) => patch.target === relPath);
}
