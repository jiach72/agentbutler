const names = [
  "BUTLER_HERMES_BRIDGE_URL",
  "BUTLER_HERMES_INSTANCE_ID",
  "BUTLER_HERMES_ROOT",
  "BUTLER_HERMES_BRIDGE_TOKEN_FILE",
  "BUTLER_MESSAGE_PROJECTION_DB",
];
for (const n of names) {
  const v = process.env[n];
  console.log(n, "=", v === undefined ? "undefined" : JSON.stringify(v.slice(0, 48)));
}
const ok = names.every((n) => typeof process.env[n] === "string" && process.env[n].trim() !== "");
console.log("configured:", ok);
console.log("mode flag:", process.env.BUTLER_ENABLE_HERMES_MESSAGE_RUNTIME);
// 直接 import 容器内 dist 的 runtime 工厂试启动（与主进程同路径）。
const mod = await import("/app/dist/message/runtime.js");
try {
  const runtime = await mod.createHermesMessageRuntime({ env: process.env });
  await runtime.start();
  console.log("runtime start: OK, channelControl =", runtime.channelControl !== undefined);
  await runtime.stop();
} catch (error) {
  console.log("runtime start FAILED:", error instanceof Error ? error.message : String(error));
}
process.exit(0);
