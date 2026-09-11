import { Alert, Flex, Tag, Typography } from "antd";
import { SafetyCertificateOutlined } from "@ant-design/icons";
import type { StagedSkillRisk } from "./marketplace.js";

const { Text } = Typography;

interface StagedRiskDetailsProps {
  risk: StagedSkillRisk | null;
  installError?: string | null;
}

function EvidenceGroup({ label, values, color }: { label: string; values: string[]; color: "error" | "warning" | "processing" }) {
  if (values.length === 0) return null;
  return (
    <Flex vertical gap={4}>
      <Text strong>{label}</Text>
      <Flex gap={4} wrap>
        {values.map((value) => <Tag color={color} key={value}>{value}</Tag>)}
      </Flex>
    </Flex>
  );
}

/**
 * 安装确认弹窗的安全检查结果：
 * 通过时只给一句安心话 + 需要留意的提示（可折叠），不展示「隔离区/暂存」等内部概念；
 * 被阻止时把原因用用户语言列清楚。服务端写入前仍会重新检查。
 */
export function StagedRiskDetails({ risk, installError }: StagedRiskDetailsProps) {
  const blocked = risk?.status === "blocked";
  if (installError != null && installError !== "") {
    return (
      <Alert
        type="error"
        showIcon
        title="安装没有完成"
        description={installError}
      />
    );
  }
  if (risk === null) {
    return (
      <Alert
        type="warning"
        showIcon
        title="安全检查未完成"
        description="没有拿到这次下载的安全检查结果，为稳妥起见请重新点击安装再确认。"
      />
    );
  }
  if (blocked) {
    return (
      <Flex vertical gap={10}>
        <Alert
          type="error"
          showIcon
          title="安全检查未通过，已停止安装"
          description="这个技能包包含以下内容，安装会被拒绝。如果你了解并信任来源，可以先到来源页面人工确认。"
        />
        <EvidenceGroup label="包含敏感配置或路径" values={risk.sensitivePaths} color="error" />
        <EvidenceGroup label="包含高风险命令" values={risk.dangerousCommands} color="error" />
        <EvidenceGroup label="引用的外部网址" values={risk.externalDomains} color="processing" />
      </Flex>
    );
  }
  const domainCount = risk.externalDomains.length;
  return (
    <Flex vertical gap={10}>
      <Flex gap={10} align="flex-start">
        <SafetyCertificateOutlined style={{ color: "var(--ab-ok)", fontSize: 26, flexShrink: 0 }} />
        <Flex vertical gap={2}>
          <Text strong>安全检查通过</Text>
          <Text type="secondary">未发现高风险命令或敏感路径，可以安装。安装前会自动备份现有技能。</Text>
        </Flex>
      </Flex>
      <Text type="secondary" style={{ fontSize: 12 }}>
        检查方式是对技能内容的自动扫描，不能完全代替人工判断。
      </Text>
      {domainCount > 0 && (
        <Flex vertical gap={4}>
          <Text type="secondary">{`这个技能引用了 ${domainCount} 个外部网址，使用相关功能时会访问它们：`}</Text>
          <Flex gap={4} wrap>
            {risk.externalDomains.slice(0, 8).map((domain) => <Tag key={domain}>{domain}</Tag>)}
            {domainCount > 8 && <Tag>{`还有 ${domainCount - 8} 个`}</Tag>}
          </Flex>
        </Flex>
      )}
    </Flex>
  );
}
