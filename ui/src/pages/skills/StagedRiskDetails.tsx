import { Alert, Flex, Tag, Typography } from "antd";
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

/** 在用户确认前展示隔离技能的扫描证据；服务端安装前仍会重新检查。 */
export function StagedRiskDetails({ risk, installError }: StagedRiskDetailsProps) {
  const blocked = risk?.status === "blocked";
  const detail = installError ?? risk?.detail ?? "这是外部技能来源。安装前请确认来源可信，服务端写入前会再次检查。";
  return (
    <Flex vertical gap={10}>
      <Alert
        type={blocked ? "error" : "warning"}
        showIcon
        title={blocked ? "已阻止安装：发现需人工审阅的内容" : "初步风险扫描已完成"}
        description={detail}
      />
      {risk !== null && (
        <>
          <EvidenceGroup label="敏感配置或路径" values={risk.sensitivePaths} color="error" />
          <EvidenceGroup label="高风险命令" values={risk.dangerousCommands} color="error" />
          <EvidenceGroup label="外联域名" values={risk.externalDomains} color="processing" />
        </>
      )}
    </Flex>
  );
}
