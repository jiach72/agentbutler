/**
 * 访问口令闸门：当前部署配置了访问口令，任何接口返回 401 都会唤醒这里。
 *
 * 设计约束：
 * - 只在真正被拒绝时出现。未配置口令的纯本机部署不会返回 401，闸门永不打扰。
 * - 文案与部署方式解耦：只说「当前部署需要访问口令」，不承诺「本机免口令」——
 *   免口令与否是服务端按监听地址判定的（本机便利通道），客户端不该替它做承诺。
 * - 真实表单提交（Enter 可用），口令只存 sessionStorage，整页刷新让所有数据源
 *   带着新口令重新取数。
 *
 * 视觉完全交给 antd 原生 Modal/Input：不造自定义卡片皮肤。
 */
import { useEffect, useState } from "react";
import { Alert, Button, Flex, Input, Modal, Typography } from "antd";
import { setAccessToken, subscribeUnauthorized } from "../lib/accessToken.js";

const { Text } = Typography;

export function AccessGate() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => subscribeUnauthorized(() => {
    setOpen(true);
    setError(null);
  }), []);

  if (!open) return null;

  const submit = () => {
    const token = value.trim();
    if (token === "") {
      setError("请先填写访问口令");
      return;
    }
    setAccessToken(token);
    setError(null);
    // 整页刷新是最可靠的重新取数方式：所有请求都会带上新口令。
    window.location.reload();
  };

  return (
    <Modal
      open
      footer={null}
      closable={false}
      mask={{ closable: false }}
      keyboard={false}
      width={480}
      title="需要访问口令"
    >
      <Flex vertical gap={16}>
        <Alert
          type="info"
          showIcon
          message="当前部署需要访问口令"
          description="口令在部署时设置（BUTLER_ACCESS_TOKEN）。输入后即可进入；口令只保存在本浏览器会话中，关闭标签页后需要重新输入。"
        />
        <form
          className="access-gate-field"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label htmlFor="access-gate-token">访问口令</label>
          <Input.Password
            id="access-gate-token"
            value={value}
            autoFocus
            placeholder="粘贴访问口令"
            autoComplete="current-password"
            onChange={(event) => setValue(event.target.value)}
            status={error === null ? undefined : "error"}
            aria-describedby="access-gate-hint"
          />
          {error !== null && (
            <Text type="danger" role="alert">
              {error}
            </Text>
          )}
          <Button type="primary" block htmlType="submit" disabled={value.trim() === ""}>
            输入口令进入
          </Button>
        </form>
        <Flex vertical gap={4} id="access-gate-hint">
          <Text strong>口令去哪里找</Text>
          <Text type="secondary">
            部署目录 <Text code>.env</Text> 里的 <Text code>BUTLER_ACCESS_TOKEN</Text>；
            如果由管理员部署，请向管理员索取，不需要自己修改文件。
          </Text>
        </Flex>
      </Flex>
    </Modal>
  );
}
