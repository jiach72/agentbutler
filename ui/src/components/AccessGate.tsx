/**
 * 访问口令闸门：面板监听非本机地址时后端要求口令，任何接口返回 401 都会唤醒这里。
 *
 * 设计约束：
 * - 只在真正被拒绝时出现。监听回环且未配置口令时后端不会返回 401，闸门永不打扰。
 * - 文案说人话：告诉用户口令是什么、去哪找、输错了怎么办，而不是抛一个 "unauthorized"。
 * - 提交后刷新页面，让所有数据源带着新口令重新取数。
 */
import { useEffect, useState } from "react";
import { Button, Input, Modal } from "antd";
import { ArrowRightOutlined, HomeOutlined, LockOutlined } from "@ant-design/icons";
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
    <Modal open footer={null} closable={false} maskClosable={false} keyboard={false} width={480} className="access-gate-modal">
      <div className="access-gate-card">
        <span className="access-gate-mark" aria-hidden="true">
          <LockOutlined />
        </span>
        <h2 id="access-gate-title">先确认访问方式</h2>
        <p className="access-gate-lead">
          这台管家允许其他设备访问，所以跨设备打开时需要口令。
          如果你就在运行管家的这台电脑上，可以直接用本机地址进入，不用查找任何配置文件。
        </p>
        {!onLocalHost && localUrl !== null && (
          <div className="access-gate-local">
            <div>
              <strong>你正在这台电脑上操作吗？</strong>
              <span>改用本机地址，免输入口令。</span>
            </div>
            <Button
              type="default"
              icon={<HomeOutlined />}
              href={localUrl}
              target="_self"
            >
              在本机打开
            </Button>
          </div>
        )}
        <div className="access-gate-divider" aria-hidden="true"><span>或</span></div>
        <label className="access-gate-label" htmlFor="access-gate-token">
          跨设备访问口令
        </label>
        <Input.Password
          id="access-gate-token"
          value={value}
          autoFocus
          size="large"
          placeholder="粘贴访问口令"
          onChange={(event) => setValue(event.target.value)}
          onPressEnter={submit}
          status={error === null ? undefined : "error"}
          aria-describedby="access-gate-hint"
        />
        {error !== null && (
          <p className="access-gate-error" role="alert">
            {error}
          </p>
        )}
        <Button type="primary" size="large" block icon={<ArrowRightOutlined />} onClick={submit} disabled={value.trim() === ""}>
          输入口令进入
        </Button>
        <div className="access-gate-hint" id="access-gate-hint">
          <strong>只有从其他设备访问时才需要口令</strong>
          <span>
            口令由安装时设置；如果由管理员部署，请向管理员索取，不需要自己修改文件。
          </span>
        </div>
      </div>
    </Modal>
  );
}
