import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // 显式钉死：sourcemap 不随上游默认漂移（生产产物泄露源码的前科高危项），
    // 目标 es2022 对齐 Node≥22/现代浏览器的基线。
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      output: {
        // antd 的几十个 rc-* 内部依赖默认全部落在入口 chunk（2MB+）；按包名
        // 归入 vendor 分组改善缓存与首屏解析。@ant-design/charts 保持懒加载，
        // 不能归入 vendor-antd（否则会变成首屏急加载）。
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          const segments = id.split("node_modules/");
          const tail = segments[segments.length - 1] ?? "";
          const pkg = tail.startsWith("@")
            ? tail.split("/").slice(0, 2).join("/")
            : (tail.split("/")[0] ?? "");
          if (["react", "react-dom", "react-router", "react-router-dom", "scheduler"].includes(pkg)) {
            return "vendor-react";
          }
          if (
            pkg === "antd" ||
            pkg.startsWith("rc-") ||
            // 只显式收编 icons（首屏急用）；其余 @ant-design/*（charts/plots 及
            // 其拖带的 @antv/g2）必须留给懒加载图表 chunk，不能变成首屏急加载。
            pkg === "@ant-design/icons"
          ) {
            return "vendor-antd";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    // 开发期代理：/api 与 /ws 转发给本地 butler-web 服务
    proxy: {
      "/api": process.env["BUTLER_WEB_URL"] ?? "http://127.0.0.1:7531",
      "/ws": {
        target: (process.env["BUTLER_WEB_URL"] ?? "http://127.0.0.1:7531").replace(/^http/, "ws"),
        ws: true,
      },
    },
  },
});
