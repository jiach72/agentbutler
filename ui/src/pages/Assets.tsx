import { Flex } from "antd";
import { PageHeader } from "../components/PageHeader.js";
import { AssetCenter } from "./skills/AssetCenter.js";

export function AssetsPage() {
  return (
    <section className="assets-page">
      <Flex vertical gap={24}>
        <PageHeader
          title="发现技能"
          description="浏览公开技能项目，查看与本机使用情况相关的安装推荐；已安装技能请前往「智能体与记忆」管理。"
        />
        <AssetCenter />
      </Flex>
    </section>
  );
}
