import { Flex } from "antd";
import { PageHeader } from "../components/PageHeader.js";
import { AssetCenter } from "./skills/AssetCenter.js";

export function AssetsPage() {
  return (
    <section className="assets-page">
      <Flex vertical gap={24}>
        <PageHeader
          eyebrow="技能资产"
          title="GitHub 技能管理"
          description="发现 GitHub 上的公开技能项目，查看推荐并一键安装到本机；本地技能库请前往「智能体与记忆」。"
        />
        <AssetCenter />
      </Flex>
    </section>
  );
}
