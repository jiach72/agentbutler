import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // 开发期代理：/api 与 /ws 转发给本地 butler-web 服务
    proxy: {
      "/api": "http://127.0.0.1:7531",
      "/ws": { target: "ws://127.0.0.1:7531", ws: true },
    },
  },
});
