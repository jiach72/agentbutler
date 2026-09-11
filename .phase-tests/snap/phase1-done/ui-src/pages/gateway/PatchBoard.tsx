/**
 * 形态补丁区：补丁卡片、参数草稿（antd InputNumber）、漂移检测与应用动作。
 * busy 锁按「动作:实例:补丁」粒度生效，只禁用对应按钮。
 */
import { Alert, Button, Card, Descriptions, Empty, Flex, Input, InputNumber, Tag, Typography } from "antd";
import { StatusBadge } from "../../components/StatusBadge.js";
import { formatRelative } from "../../lib/format.js";
import { PARAM_LABELS, instanceKeyOf, patchBusyKey, schemaHint, statusTone } from "./helpers.js";
import type {
  DriftReport,
  GatewayPatch,
  PatchAction,
  PatchDrafts,
} from "./helpers.js";

interface PatchBoardProps {
  patches: GatewayPatch[];
  drafts: PatchDrafts;
  driftReports: Record<string, DriftReport>;
  watchUnreachable: boolean;
  instanceValue: string;
  patchErrors: Record<string, string>;
  busyKeys: ReadonlySet<string>;
  onInstanceChange: (value: string) => void;
  onUpdateDraft: (patchId: string, param: string, value: number | null) => void;
  onRunAction: (patch: GatewayPatch, action: PatchAction) => void;
}

export function PatchBoard({
  patches,
  drafts,
  driftReports,
  watchUnreachable,
  instanceValue,
  patchErrors,
  busyKeys,
  onInstanceChange,
  onUpdateDraft,
  onRunAction,
}: PatchBoardProps) {
  const instKey = instanceKeyOf(instanceValue);
  return (
    <Flex vertical gap={12}>
      <Flex wrap="wrap" justify="space-between" align="flex-end" gap={16}>
        <div>
          <Typography.Title level={4} component="h2" style={{ marginBottom: 4 }}>
            消息规则与参数
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            这里是高级设置；只有登记过的文件才会被修改，升级后可重新匹配。
          </Typography.Paragraph>
        </div>
        <Flex vertical gap={4}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            管家实例（可选）
          </Typography.Text>
          <Input
            value={instanceValue}
            onChange={(event) => onInstanceChange(event.target.value)}
            placeholder="留空自动选择正在运行的管家"
            style={{ width: 240 }}
          />
        </Flex>
      </Flex>

      {patches.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="暂时没有可调整的消息规则，请稍后刷新。"
        />
      ) : (
        <Flex vertical gap={16}>
          {patches.map((patch) => {
            const report = driftReports[patch.id];
            const missingRequires = (patch.requires ?? []).filter((requiredId) => {
              const required = patches.find((item) => item.id === requiredId);
              return (
                required === undefined ||
                (required.applied === null && (required.observed ?? null) === null)
              );
            });
            const isObserved = (patch.observed ?? null) !== null && patch.applied === null;
            const applyKey = patchBusyKey("apply", patch.id, instKey);
            const reapplyKey = patchBusyKey("reapply", patch.id, instKey);
            const detectKey = patchBusyKey("detect", patch.id, instKey);
            const patchBusy =
              busyKeys.has(applyKey) || busyKeys.has(reapplyKey) || busyKeys.has(detectKey);
            const applyDisabled =
              patchBusy || isObserved || missingRequires.length > 0 || watchUnreachable;
            const detectDisabled = patchBusy || watchUnreachable;
            return (
              <Card size="small" key={patch.id}>
                <Flex vertical gap={12}>
                  <Flex wrap="wrap" justify="space-between" align="flex-start" gap={12}>
                    <div style={{ minWidth: 0 }}>
                      <Flex wrap="wrap" align="center" gap={8}>
                        <Typography.Title level={5} component="h3" style={{ marginBottom: 0 }}>
                          {patch.title}
                        </Typography.Title>
                        <StatusBadge
                          tone={
                            patch.applied !== null ? "ok" : isObserved ? "warn" : "muted"
                          }
                          label={
                            patch.applied !== null
                              ? "已纳管"
                              : isObserved
                                ? "手工已生效 · 未纳管"
                                : "未应用"
                          }
                        />
                      </Flex>
                      <Typography.Paragraph type="secondary" style={{ marginBottom: 4 }}>
                        {patch.description}
                      </Typography.Paragraph>
                      <Typography.Text code style={{ fontSize: 12 }}>
                        {patch.target}
                      </Typography.Text>
                    </div>
                    {patch.requires !== undefined && patch.requires.length > 0 && (
                      <Tag>依赖：{patch.requires.join("、")}</Tag>
                    )}
                  </Flex>

                  <Flex wrap="wrap" gap={16}>
                    {Object.entries(patch.params).map(([name, schema]) => (
                      <Flex vertical gap={4} key={name}>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {PARAM_LABELS[name] ?? name}
                        </Typography.Text>
                        <InputNumber
                          min={schema.min}
                          max={schema.max}
                          precision={schema.integer === true ? 0 : undefined}
                          step={schema.integer === true ? 1 : "any"}
                          value={drafts[patch.id]?.[name] ?? null}
                          disabled={isObserved}
                          onChange={(value) =>
                            onUpdateDraft(patch.id, name, typeof value === "number" ? value : null)
                          }
                        />
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {isObserved ? "只读 · 从当前源码提取" : schemaHint(schema)}
                        </Typography.Text>
                      </Flex>
                    ))}
                  </Flex>

                  {patchErrors[patch.id] !== undefined && (
                    <Alert type="warning" title={patchErrors[patch.id]} />
                  )}

                  {patch.applied !== null && (
                    <Descriptions size="small" column={1}>
                      <Descriptions.Item label="上次应用">
                        {formatRelative(patch.applied.appliedAt)}
                      </Descriptions.Item>
                      <Descriptions.Item label="实际文件">
                        <Typography.Text title={patch.applied.targetPath}>
                          {patch.applied.targetPath}
                        </Typography.Text>
                      </Descriptions.Item>
                    </Descriptions>
                  )}
                  {isObserved && patch.observed !== undefined && patch.observed !== null && (
                    <>
                      <Descriptions size="small" column={1}>
                        <Descriptions.Item label="源码识别">
                          {formatRelative(patch.observed.checkedAt)}
                        </Descriptions.Item>
                        <Descriptions.Item label="实际文件">
                          <Typography.Text title={patch.observed.targetPath}>
                            {patch.observed.targetPath}
                          </Typography.Text>
                        </Descriptions.Item>
                      </Descriptions>
                      <Alert
                        type="warning"
                        title="当前能力来自 Hermes 源码中的手工实现，Butler 只读观察，不会应用或重打覆盖。"
                      />
                    </>
                  )}
                  {missingRequires.length > 0 && (
                    <Alert type="warning" title={`请先应用前置补丁：${missingRequires.join("、")}`} />
                  )}
                  {report !== undefined && (
                    <Flex wrap="wrap" align="center" gap={8}>
                      <StatusBadge {...statusTone(report.status)} />
                      <Typography.Text type="secondary">
                        检测于 {formatRelative(report.checkedAt)}
                      </Typography.Text>
                      {(report.diffs?.length ?? 0) > 0 && (
                        <Typography.Text type="secondary">
                          {report.diffs!.length} 处差异
                        </Typography.Text>
                      )}
                    </Flex>
                  )}

                  <Flex wrap="wrap" gap={8}>
                    <Button
                      type="primary"
                      disabled={applyDisabled}
                      loading={busyKeys.has(applyKey)}
                      onClick={() => onRunAction(patch, "apply")}
                    >
                      应用这个调整
                    </Button>
                    <Button
                      disabled={applyDisabled}
                      loading={busyKeys.has(reapplyKey)}
                      onClick={() => onRunAction(patch, "reapply")}
                    >
                      恢复官方默认
                    </Button>
                    <Button
                      disabled={detectDisabled}
                      loading={busyKeys.has(detectKey)}
                      onClick={() => onRunAction(patch, "detect")}
                    >
                      检查是否被改过
                    </Button>
                  </Flex>
                </Flex>
              </Card>
            );
          })}
        </Flex>
      )}
    </Flex>
  );
}
