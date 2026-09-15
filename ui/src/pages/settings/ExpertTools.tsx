import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { App, Button, Flex, Switch, Typography } from "antd";
import { CopyOutlined } from "@ant-design/icons";
import { AdvancedEvidence } from "../../components/AdvancedEvidence.js";
import { loadJson } from "../../lib/api.js";
import { routeMetaFor } from "../../lib/routeMeta.js";
import { settingsToolPaths } from "./categories.js";
import { MemoryProbeConfigCard } from "./MemoryProbeConfigCard.js";

const EXPERIMENTS_KEY = "butler.experiments.enabled";

export function ExpertTools({ children }: { children?: React.ReactNode }) {
  const { message } = App.useApp();
  const [experiments, setExperiments] = useState(false);
  const [instanceCount, setInstanceCount] = useState<number | null>(null);
  useEffect(() => {
    try {
      setExperiments(localStorage.getItem(EXPERIMENTS_KEY) === "1");
    } catch {
      /* optional preference */
    }
    let active = true;
    void loadJson<{ instances: { instanceId: string }[] }>("/api/federation?windowDays=7").then(
      (result) => {
        if (active && result.ok)
          setInstanceCount(new Set(result.data.instances.map((item) => item.instanceId)).size);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  const paths = settingsToolPaths(experiments, instanceCount);
  const links = (items: string[]) => (
    <Flex vertical gap={8}>
      {items.map((path) => {
        const route = routeMetaFor(path);
        if (route === null) return null;
        const Icon = route.icon;
        return (
          <Link
            key={path}
            to={path}
            style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 44 }}
          >
            <Icon aria-hidden="true" />
            {route.title}
          </Link>
        );
      })}
    </Flex>
  );
  return (
    <Flex vertical gap={16}>
      <Flex align="center" justify="space-between" gap={12}>
        <Typography.Text>实验功能</Typography.Text>
        <Switch
          aria-label="实验功能"
          checked={experiments}
          onChange={(checked) => {
            try {
              localStorage.setItem(EXPERIMENTS_KEY, checked ? "1" : "0");
              setExperiments(checked);
            } catch {
              message.error("浏览器无法保存偏好，请允许本地存储后重试。");
            }
          }}
        />
      </Flex>
      <AdvancedEvidence title="记录与报告">{links(paths.reports)}</AdvancedEvidence>
      <AdvancedEvidence title="专家工具 · 诊断与维护">
        {links(paths.expert)}
        <Button
          icon={<CopyOutlined />}
          onClick={() => {
            if (!navigator.clipboard) {
              message.error("浏览器不允许复制，请使用命令 node scripts/doctor.mjs。");
              return;
            }
            void navigator.clipboard
              .writeText("node scripts/doctor.mjs")
              .then(() => message.success("体检命令已复制。"))
              .catch(() => message.error("复制失败，请使用命令 node scripts/doctor.mjs。"));
          }}
        >
          复制安装体检命令
        </Button>
        {children}
        <MemoryProbeConfigCard />
      </AdvancedEvidence>
    </Flex>
  );
}
