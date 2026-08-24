import { describe, expect, it } from "vitest";

import { managedUpgradeProgress } from "../../../ui/src/pages/Versions.js";

describe("版本页升级进度", () => {
  it("提交升级后、服务端 Job 尚未返回时立即显示启动进度", () => {
    const progress = managedUpgradeProgress(null, {
      version: "v0.21.0",
      displayVersion: "0.21.0",
    });

    expect(progress).toEqual({
      title: "正在启动升级到 0.21.0",
      detail: "正在提交升级任务并等待管家返回第一步状态，请不要重复点击。",
      indeterminate: true,
      steps: [],
    });
  });
});
