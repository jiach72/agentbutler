/**
 * 管家自身升级/回滚的 detached 子进程入口。
 *
 * watch 服务触发升级后由该脚本继续执行：切版本 → 安装构建 → 重启服务 →
 * 健康验收（失败自动回滚），并把进度写回 BUTLER_HOME/self-upgrade/state.json。
 */
import { runSelfUpgradeRunnerFromEnv } from "./self-upgrade.js";

runSelfUpgradeRunnerFromEnv()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error("[butler-self-upgrade] runner failed:", error);
    process.exitCode = 1;
  });
