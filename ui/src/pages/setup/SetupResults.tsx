/**
 * 分层结果块：成功绿块在前、失败红块在后，失败项可携带修复动作按钮。
 * 替代向导中平铺的 Alert 堆叠；配色只引用主题变量（setup.css）。
 */
import { Button, Flex, Typography } from "antd";
import { CheckCircleOutlined, CloseCircleOutlined } from "@ant-design/icons";
import "./setup.css";

const { Text } = Typography;

export interface SetupResultItem {
  key: string;
  tone: "ok" | "fail";
  title: string;
  detail?: string;
  action?: { label: string; onClick: () => void };
}

export function SetupResults({ items }: { items: SetupResultItem[] }) {
  const okItems = items.filter((item) => item.tone === "ok");
  const failItems = items.filter((item) => item.tone === "fail");
  if (okItems.length === 0 && failItems.length === 0) return null;
  return (
    <Flex vertical gap={8} role="list">
      {[...okItems, ...failItems].map((item) => (
        <Flex
          key={item.key}
          role="listitem"
          align="flex-start"
          gap={10}
          className={`setup-result ${item.tone === "ok" ? "is-ok" : "is-fail"}`}
        >
          {item.tone === "ok" ? (
            <CheckCircleOutlined className="setup-result-icon" aria-hidden="true" />
          ) : (
            <CloseCircleOutlined className="setup-result-icon" aria-hidden="true" />
          )}
          <Flex vertical gap={2} style={{ minWidth: 0, flex: 1 }}>
            <Text strong>{item.title}</Text>
            {item.detail !== undefined && (
              <Text type="secondary" style={{ fontSize: 12 }}>{item.detail}</Text>
            )}
          </Flex>
          {item.action !== undefined && (
            <Button size="small" onClick={item.action.onClick} style={{ flexShrink: 0 }}>
              {item.action.label}
            </Button>
          )}
        </Flex>
      ))}
    </Flex>
  );
}
