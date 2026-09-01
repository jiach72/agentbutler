import { useEffect, useState } from "react";
import { Alert, Spin } from "antd";
import { AssetCenter } from "./skills/AssetCenter.js";
import { loadJson } from "../lib/api.js";
import type { SkillsPayload } from "./skills/helpers.js";

const emptySkills: SkillsPayload["skills"] = { mode: "unavailable", driverId: null, total: 0, items: [], directory: { roots: [], fileCount: 0, directoryCount: 0, sizeBytes: 0, truncated: false }, notice: "技能清单暂不可用" };

export function AssetsPage() {
  const [skills, setSkills] = useState<SkillsPayload["skills"]>(emptySkills);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadSkills = async () => { const result = await loadJson<SkillsPayload>("/api/skills", 10_000); if (result.ok) { setSkills(result.data.skills); setError(null); } else setError(result.reason); setLoading(false); };
  useEffect(() => { void loadSkills(); }, []);
  return <section className="page product-page assets-page"><header className="page-heading product-heading"><div><span className="product-eyebrow">技能资产</span><h1>技能使用与来源</h1><p className="hint">查看本机技能的使用记录、公开来源和可安装项目。</p></div></header>{loading ? <Spin description="正在读取技能清单" /> : error ? <Alert type="warning" showIcon title="技能清单暂时不可用" description={error} /> : null}<AssetCenter skills={skills} onSkillsChanged={loadSkills} /></section>;
}
