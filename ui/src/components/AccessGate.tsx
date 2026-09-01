/**
 * 访问口令闸门：面板监听非本机地址时后端要求口令，任何接口返回 401 都会唤醒这里。
 *
 * 设计约束：
 * - 只在真正被拒绝时出现。监听回环且未配置口令时后端不会返回 401，闸门永不打扰。
 * - 文案说人话：告诉用户口令是什么、去哪找、输错了怎么办，而不是抛一个 "unauthorized"。
 * - 提交后刷新页面，让所有数据源带着新口令重新取数。
 *
 * 视觉完全交给 antd 原生 Modal/Alert/Input：不造自定义卡片皮肤。
 */
import { useEffect, useState } from "react";
import { Alert, Button, Divider, Flex, Input, Modal, Typography } from "antd";
import { setAccessToken, subscribeUnauthorized } from "../lib/accessToken.js";

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

  const localUrl = (() => {
    try {
      const url = new URL(window.location.href);
      url.hostname = "127.0.0.1";
      url.search = "";
      return url.toString();
    } catch {
      return null;
    }
  })();
  const onLocalHost = (() => {
    try {
      const hostname = window.location.hostname.toLowerCase();
      return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    } catch {
      return false;
    }
  })();

  return (
    <Modal
      open
      footer={null}
      closable={false}
      mask={{ closable: false }}
      keyboard={false}
      width={480}
      title="先确认访问方式"
    >
      <Flex vertical gap={16}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          这台管家允许其他设备访问，所以跨设备打开时需要口令。
          如果你就在运行管家的这台电脑上，可以直接用本机地址进入，不用查找任何配置文件。
        </Typography.Paragraph>
        {!onLocalHost && localUrl !== null && (
          <Alert
            type="info"
            showIcon
            message="你正在这台电脑上操作吗？"
            description="改用本机地址，免输入口令。"
            action={
              <Button href={localUrl} target="_self">
                在本机打开
              </Button>
            }
          />
        )}
        <Divider plain>或</Divider>
        <div className="access-gate-field">
          <label htmlFor="access-gate-token">跨设备访问口令</label>
          <Input.Password
            id="access-gate-token"
            value={value}
            autoFocus
            placeholder="粘贴访问口令"
            onChange={(event) => setValue(event.target.value)}
            onPressEnter={submit}
            status={error === null ? undefined : "error"}
            aria-describedby="access-gate-hint"
          />
          {error !== null && (
            <Typography.Text type="danger" role="alert">
              {error}
            </Typography.Text>
          )}
        </div>
        <Button type="primary" block onClick={submit} disabled={value.trim() === ""}>
          输入口令进入
        </Button>
        <Flex vertical gap={4} id="access-gate-hint">
          <Typography.Text strong>只有从其他设备访问时才需要口令</Typography.Text>
          <Typography.Text type="secondary">
            口令由安装时设置；如果由管理员部署，请向管理员索取，不需要自己修改文件。
          </Typography.Text>
        </Flex>
      </Flex>
    </Modal>
  );
}
