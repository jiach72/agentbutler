import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-antd": ["antd", "@ant-design/icons"],
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
