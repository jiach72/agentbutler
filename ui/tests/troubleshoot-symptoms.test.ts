/**
 * 排查向导的症状映射与动作排序。
 *
 * 核心约束：现象选择只影响排序，绝不隐藏动作。
 * 用户选错现象，看到的证据和可用动作仍然完整——否则向导就变成了过滤黑洞。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SYMPTOM,
  SYMPTOMS,
  findSymptom,
  rankActions,
  recommendAction,
  type SymptomId,
} from "../src/pages/troubleshoot/symptoms.js";

interface Action {
  id: string;
  available: boolean;
  risk: "low" | "medium" | "high";
}

const action = (id: string, available = true, risk: Action["risk"] = "low"): Action => ({
  id,
  available,
  risk,
});

describe("症状选项", () => {
  it("每个现象都有一句大白话和优先动作说明", () => {
    expect(SYMPTOMS.length).toBeGreaterThan(3);
    for (const symptom of SYMPTOMS) {
      expect(symptom.label.length).toBeGreaterThan(0);
      expect(symptom.hint.length).toBeGreaterThan(0);
    }
  });

  it("「说不上来」不预设任何偏好，交给风险排序", () => {
    expect(findSymptom("not-sure").preferredActions).toEqual([]);
    expect(DEFAULT_SYMPTOM).toBe("not-sure");
  });

  it("未知 id 退回「说不上来」，不会崩", () => {
    expect(findSymptom("nope" as SymptomId).id).toBe("not-sure");
  });
});

describe("rankActions 排序", () => {
  it("可用动作永远排在不可用动作之前", () => {
    const ranked = rankActions(
      [action("restart-instance", false, "high"), action("refresh-probe", true, "low")],
      "not-sure",
    );
    expect(ranked[0]!.id).toBe("refresh-probe");
    expect(ranked[1]!.id).toBe("restart-instance");
  });

  it("「它不回我消息了」把重连消息通道排到最前", () => {
    const ranked = rankActions(
      [
        action("restart-instance", true, "high"),
        action("refresh-probe", true, "low"),
        action("reconnect-channel", true, "medium"),
      ],
      "no-reply",
    );
    expect(ranked[0]!.id).toBe("reconnect-channel");
  });

  it("「变慢了」优先调整节流参数", () => {
    const ranked = rankActions(
      [action("restart-instance", true, "high"), action("apply-throttle-patch", true, "medium")],
      "slow",
    );
    expect(ranked[0]!.id).toBe("apply-throttle-patch");
  });

  it("没有偏好时按风险从低到高", () => {
    const ranked = rankActions(
      [action("restart-instance", true, "high"), action("refresh-probe", true, "low")],
      "not-sure",
    );
    expect(ranked.map((item) => item.id)).toEqual(["refresh-probe", "restart-instance"]);
  });

  it("排序不改数量：选择现象不会把动作藏起来", () => {
    const all = [
      action("refresh-probe", true, "low"),
      action("reconnect-channel", true, "medium"),
      action("restart-instance", true, "high"),
      action("rebuild-memory-index", false, "low"),
    ];
    for (const symptom of SYMPTOMS) {
      const ranked = rankActions(all, symptom.id);
      expect(ranked).toHaveLength(all.length);
      expect(new Set(ranked.map((item) => item.id))).toEqual(new Set(all.map((item) => item.id)));
    }
  });

  it("未列入偏好的动作排在列入偏好的动作之后", () => {
    const ranked = rankActions(
      [action("rebuild-memory-index", true, "low"), action("reconnect-channel", true, "medium")],
      "no-reply",
    );
    // reconnect-channel 在 no-reply 偏好里，rebuild 不在
    expect(ranked[0]!.id).toBe("reconnect-channel");
  });
});

describe("recommendAction 推荐项", () => {
  it("推荐第一个可用动作", () => {
    const recommended = recommendAction(
      [action("restart-instance", false, "high"), action("refresh-probe", true, "low")],
      "not-sure",
    );
    expect(recommended?.id).toBe("refresh-probe");
  });

  it("全部不可用时返回 null，由调用方给出说明", () => {
    expect(recommendAction([action("restart-instance", false, "high")], "not-sure")).toBeNull();
  });
});
