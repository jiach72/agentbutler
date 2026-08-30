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
import { LockOutlined } from "@ant-design/icons";
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

  return (
    <Modal open footer={null} closable={false} maskClosable={false} keyboard={false} width={480} className="access-gate-modal">
      <div className="access-gate-card">
        <span className="access-gate-mark" aria-hidden="true">
          <LockOutlined />
        </span>
        <h2 id="access-gate-title">需要访问口令</h2>
        <p className="access-gate-lead">
          这台管家设置成了允许其他设备访问，所以进入面板需要口令。
          口令是为了防止同一网络里的其他人操作你的 AI。
        </p>
        <label className="access-gate-label" htmlFor="access-gate-token">
          访问口令
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
        <Button type="primary" size="large" block onClick={submit} disabled={value.trim() === ""}>
          进入管家
        </Button>
        <div className="access-gate-hint" id="access-gate-hint">
          <strong>口令在哪里找？</strong>
          <span>
            在管家安装目录的 <code>.env</code> 文件里，<code>BUTLER_ACCESS_TOKEN=</code> 后面那串字符就是。
          </span>
          <span>如果你就是这台电脑的主人，也可以把 <code>.env</code> 里的这行删掉并重启管家，之后只有本机可以访问，不再需要口令。</span>
        </div>
      </div>
    </Modal>
  );
}
