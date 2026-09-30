/**
 * 笔记查重与智能清理弹窗组（F-3 拆分自 KnowledgePage，JSX 原样搬移）。
 * 扫描/清理逻辑仍在 KnowledgePage，本组件只负责展示与选择。
 */
import { Button, Card, Checkbox, Col, Empty, Flex, Modal, Row, Tag } from "antd";
import { Typography } from "antd";

const { Paragraph, Text } = Typography;
import { ClearOutlined, LoadingOutlined } from "@ant-design/icons";
import { DangerConfirmModal } from "../../../components/DangerConfirmModal.js";
import type { DedupScanResult } from "../KnowledgePage.js";

export interface DedupModalsProps {
  dedupModalOpen: boolean;
  setDedupModalOpen: (open: boolean) => void;
  dedupScanning: boolean;
  dedupCleaning: boolean;
  dedupResult: DedupScanResult | null;
  selectedRemoveIds: string[];
  setSelectedRemoveIds: (value: string[] | ((prev: string[]) => string[])) => void;
  handleRequestDedupClean: () => void;
  dedupConfirmOpen: boolean;
  dedupConfirmIds: string[];
  setDedupConfirmOpen: (open: boolean) => void;
  handleExecuteClean: () => void;
}

export function DedupModals({
  dedupModalOpen,
  setDedupModalOpen,
  dedupScanning,
  dedupCleaning,
  dedupResult,
  selectedRemoveIds,
  setSelectedRemoveIds,
  handleRequestDedupClean,
  dedupConfirmOpen,
  dedupConfirmIds,
  setDedupConfirmOpen,
  handleExecuteClean,
}: DedupModalsProps) {
  return (
    <>
      {/* 11. 笔记查重与智能清理 Modal */}
      <Modal
        title={
          <Flex align="center" gap={8}>
            <ClearOutlined style={{ color: "var(--ant-color-warning)" }} />
            <span>笔记与文档智能查重与清理</span>
          </Flex>
        }
        open={dedupModalOpen}
        onCancel={() => setDedupModalOpen(false)}
        width={760}
        footer={[
          <Button key="close" onClick={() => setDedupModalOpen(false)} disabled={dedupCleaning}>
            取消
          </Button>,
          <Button
            key="clean-selected"
            danger
            disabled={
              dedupScanning ||
              dedupCleaning ||
              !dedupResult ||
              selectedRemoveIds.length === 0
            }
            onClick={handleRequestDedupClean}
          >
            清理所选副本 ({selectedRemoveIds.length})
          </Button>,
        ]}
      >
        {dedupScanning ? (
          <Flex justify="center" align="center" style={{ padding: "40px 0" }} vertical gap={12}>
            <LoadingOutlined style={{ fontSize: 36, color: "var(--ant-color-warning)" }} spin />
            <Text type="secondary">正在全面比对文档 SHA-256 哈希与同名异径副本...</Text>
          </Flex>
        ) : dedupResult ? (
          <Flex vertical gap={16} style={{ marginTop: 8 }}>
            {/* 统计横幅 */}
            <Card
              size="small"
              style={{
                background: "var(--ant-color-fill-quaternary)",
                borderRadius: 8,
                border: "1px solid var(--ant-color-border-secondary)",
              }}
            >
              <Row gutter={16}>
                <Col span={8}>
                  <Text type="secondary" style={{ fontSize: 12 }}>总扫描文档</Text>
                  <div><Text strong style={{ fontSize: 18 }}>{dedupResult.totalDocs} 篇</Text></div>
                </Col>
                <Col span={8}>
                  <Text type="secondary" style={{ fontSize: 12 }}>发现冗余副本</Text>
                  <div>
                    <Text
                      strong
                      style={{
                        fontSize: 18,
                        color: dedupResult.duplicateCount > 0 ? "var(--ant-color-warning)" : "var(--ant-color-success)",
                      }}
                    >
                      {dedupResult.duplicateCount} 篇
                    </Text>
                  </div>
                </Col>
                <Col span={8}>
                  <Text type="secondary" style={{ fontSize: 12 }}>预计释放空间</Text>
                  <div>
                    <Text strong style={{ fontSize: 18, color: "var(--ant-color-primary)" }}>
                      {Math.max(0, Math.round(dedupResult.reclaimableBytes / 1024))} KB
                    </Text>
                  </div>
                </Col>
              </Row>
            </Card>

            {dedupResult.groups.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="太棒了！知识库与笔记库非常整洁，未发现任何重复文档。"
              />
            ) : (
              <>
                <Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
                  只有内容完全一致的副本可清理。文件名相同但内容不同的资料仅供核对，不会自动列入清理。
                </Paragraph>

                <div style={{ maxHeight: 380, overflowY: "auto", paddingRight: 4 }}>
                  <Flex vertical gap={12}>
                    {dedupResult.groups.map((group) => (
                      <Card
                        key={group.key}
                        size="small"
                        title={
                          <Flex justify="space-between" align="center" wrap="wrap" gap={8}>
                            <Flex align="center" gap={8}>
                              <Text strong>{group.name}</Text>
                              <Tag color={group.reason === "exact_content" ? "orange" : "blue"}>
                                {group.reasonLabel}
                              </Tag>
                            </Flex>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              共 {group.items.length} 份副本
                            </Text>
                          </Flex>
                        }
                        style={{ borderRadius: 8 }}
                      >
                        <Flex vertical gap={4} className="divide-y divide-outline-variant/10">
                          {group.items.map((item) => {
                            const isSelected = selectedRemoveIds.includes(item.id);
                            return (
                              <Flex
                                key={item.id}
                                justify="space-between"
                                align="center"
                                style={{
                                  padding: "8px 12px",
                                  background: item.isPrimary
                                    ? "color-mix(in srgb, var(--ab-ok) 8%, transparent)"
                                    : isSelected
                                      ? "color-mix(in srgb, var(--ab-warn) 8%, transparent)"
                                      : "transparent",
                                  borderRadius: 6,
                                  width: "100%",
                                }}
                              >
                                <Flex align="center" gap={10} style={{ overflow: "hidden" }}>
                                  {group.reason === "exact_content" && !item.isPrimary ? (
                                    <Checkbox
                                      aria-label={`选择清理副本 ${item.path}`}
                                      checked={isSelected}
                                      onChange={(e) => {
                                        if (e.target.checked) {
                                          setSelectedRemoveIds((prev) =>
                                            prev.includes(item.id) ? prev : [...prev, item.id],
                                          );
                                        } else {
                                          setSelectedRemoveIds((prev) =>
                                            prev.filter((id) => id !== item.id),
                                          );
                                        }
                                      }}
                                    />
                                  ) : item.isPrimary ? (
                                    <Tag color="success" style={{ margin: 0 }}>
                                      推荐保留
                                    </Tag>
                                  ) : (
                                    <Tag color="default" style={{ margin: 0 }}>
                                      同名待核对
                                    </Tag>
                                  )}
                                  <Flex vertical style={{ minWidth: 0 }}>
                                    <Text ellipsis style={{ maxWidth: 360, fontSize: 13 }} code>
                                      {item.path}
                                    </Text>
                                    <Text type="secondary" style={{ fontSize: 11 }}>
                                      {item.source === "obsidian"
                                        ? "Obsidian 笔记库"
                                        : item.source === "inbox"
                                          ? "微信归纳"
                                          : "收集箱直传"}{" "}
                                      · {Math.max(1, Math.round(item.size / 1024))} KB · 更新于{" "}
                                      {new Date(item.updatedAt).toLocaleString("zh-CN", {
                                        hour12: false,
                                      })}
                                    </Text>
                                  </Flex>
                                </Flex>

                                {group.reason === "exact_content" && !item.isPrimary && (
                                  <Tag color="volcano" style={{ margin: 0 }}>
                                    待清理副本
                                  </Tag>
                                )}
                              </Flex>
                            );
                          })}
                        </Flex>
                      </Card>
                    ))}
                  </Flex>
                </div>
              </>
            )}
          </Flex>
        ) : null}
      </Modal>
      <DangerConfirmModal
        open={dedupConfirmOpen}
        title={`确认清理 ${dedupConfirmIds.length} 个重复副本？`}
        impact={`将从本地磁盘与知识库文档清单中移除 ${dedupConfirmIds.length} 个本次扫描确认的相同内容副本。`}
        reversible="不能通过本页面撤回；请确认已选副本不是唯一资料。推荐保留版本不会被清理。"
        duration="通常数秒，期间知识库服务保持运行。"
        acknowledge="我已核对清理数量与保留版本，并确认删除所选副本"
        confirmLabel="清理所选副本"
        busy={dedupCleaning}
        onCancel={() => setDedupConfirmOpen(false)}
        onConfirm={handleExecuteClean}
      />
    </>
  );
}
