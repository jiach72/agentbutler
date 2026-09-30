import { createCore } from "@butler/core";
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillAssetService, inspectSkillBundle } from "../src/skill-assets.js";

describe("技能包静态风险初筛（中等-10）", () => {
  it("包内脚本文件命中高风险命令时整体 blocked，不再只看 SKILL.md", () => {
    const clean = inspectSkillBundle([{ path: "SKILL.md", text: "# demo\n一个完全正常的技能。" }]);
    expect(clean.status).toBe("clear");

    const blocked = inspectSkillBundle([
      { path: "SKILL.md", text: "# demo\n正常说明。" },
      { path: "scripts/setup.sh", text: "#!/bin/sh\nrm -rf ~/target\n" },
    ]);
    expect(blocked.status).toBe("blocked");
    expect(blocked.dangerousCommands.some((item) => item.startsWith("scripts/setup.sh:"))).toBe(true);
  });
});

describe("技能资产服务（使用统计与本机清单）", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  const makeService = (fetch: (input: string | URL, init?: RequestInit) => Promise<Response>) => {
    const home = mkdtempSync(join(tmpdir(), "butler-skill-assets-test-"));
    homes.push(home);
    const core = createCore({ home });
    return { core, service: createSkillAssetService({ core, skills: {} as never, fetch }) };
  };

  it("只统计带时间戳的结构化技能调用，不把注册警告和普通文本当作技能", async () => {
    const { core } = makeService(async () => new Response("{}", { status: 200 }));
    try {
      core.instances.createInstance({
        instanceId: "hermes-main",
        frameworkId: "hermes",
        rootPath: "/tmp/hermes",
        confidence: 1,
      });
      core.instances.beginDiscover("hermes-main");
      core.instances.confirmInstance("hermes-main", "test");
      core.instances.beginNegotiate("hermes-main");
      core.instances.markServing("hermes-main", 2, {
        effectiveLevel: 2,
        capabilities: {},
        anomalies: [],
      });
      const service = createSkillAssetService({
        core,
        skills: {
          status: async () => ({ skills: { items: [{ name: "kanban" }] } }) as never,
        } as never,
        logs: {
          listSources: () => [{ id: "hermes:agent" }] as never,
          readTail: () => ({
            lines: [
              "2026-08-31 16:11:14 WARNING agent.skill_commands: Skill 'kanban' generates slash command '/kanban'; skipping auto-registration.",
              "2026-08-31 16:11:15 INFO docs: install the skill pack and library index before continuing.",
              "skill_name=untrusted status=completed",
              "2026-08-31 16:12:00 INFO agent.tool: skill_name=kanban action=invoke status=completed duration=125ms",
            ],
          }),
        },
        now: () => Date.parse("2026-08-31T16:30:00.000Z"),
      });

      const usage = await service.usage(30);
      expect(usage.skills).toEqual([
        expect.objectContaining({
          name: "kanban",
          calls: 1,
          status: "known",
          avgDurationMs: 125,
        }),
      ]);
      expect(usage.skills.map((item) => item.name)).not.toEqual(
        expect.arrayContaining(["pack", "library", "index", "untrusted"]),
      );
    } finally {
      core.close();
    }
  });

  it("listLocal 忽略以点开头的隐藏/归档目录（如 .archive），并按顶层优先去重", async () => {
    const hermesRoot = join(tmpdir(), `hermes-root-${Date.now()}`);
    mkdirSync(join(hermesRoot, "skills"), { recursive: true });
    const { core, service } = makeService(async () => new Response());
    try {
      const skillsRoot = join(hermesRoot, "skills");
      core.instances.createInstance({
        instanceId: "hermes-main",
        frameworkId: "hermes",
        rootPath: hermesRoot,
        confidence: 1,
      });
      core.instances.beginDiscover("hermes-main");
      core.instances.confirmInstance("hermes-main", "test");
      core.instances.beginNegotiate("hermes-main");
      core.instances.markServing("hermes-main", 2, {
        effectiveLevel: 2,
        capabilities: {},
        anomalies: [],
      });

      // 正常技能 skills/my-skill
      const liveSkill = join(skillsRoot, "my-skill");
      mkdirSync(liveSkill, { recursive: true });
      writeFileSync(join(liveSkill, "SKILL.md"), "---\nname: my-skill\n---\nHello");
      writeFileSync(join(liveSkill, "source.json"), JSON.stringify({ source: "git", commit: "commit-live" }));

      // 归档目录 skills/.archive/my-skill（带旧 commit，必须被忽略）
      const archiveSkill = join(skillsRoot, ".archive", "my-skill");
      mkdirSync(archiveSkill, { recursive: true });
      writeFileSync(join(archiveSkill, "SKILL.md"), "---\nname: my-skill\n---\nOld Hello");
      writeFileSync(join(archiveSkill, "source.json"), JSON.stringify({ source: "git", commit: "commit-old" }));

      // 分类子目录 skills/cat/sub-skill
      const subSkill = join(skillsRoot, "cat", "sub-skill");
      mkdirSync(subSkill, { recursive: true });
      writeFileSync(join(subSkill, "SKILL.md"), "---\nname: sub-skill\n---\nSub");

      const local = await service.listLocal();
      expect(local.items).toHaveLength(2);
      expect(local.items.map((i) => i.name)).toEqual(["my-skill", "sub-skill"]);
      expect(local.items.find((i) => i.name === "my-skill")?.commit).toBe("commit-live");
    } finally {
      core.close();
      rmSync(hermesRoot, { recursive: true, force: true });
    }
  });
});
