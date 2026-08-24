import { z } from "zod";
import { fail, ok, type Result } from "./common.js";
import { isContractVersionSupported, KERNEL_SUPPORTED_CONTRACT_RANGE } from "./errors.js";
import { CAPABILITIES } from "./discovery.js";

/** manifest 中登记的驱动描述：kind 与 drivers.ts 三类驱动接口一一对应。 */
export interface DriverDescriptor {
  kind: "skill" | "memory" | "config";
  id: string;
}

const frameworkIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "frameworkId must be kebab-case (e.g. 'hermes')");

const levelSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

const capabilitySchema = z.enum(CAPABILITIES);

const driverSchema = z.object({
  kind: z.enum(["skill", "memory", "config"]),
  id: z.string().min(1),
});

export const manifestSchema = z.object({
  frameworkId: frameworkIdSchema,
  displayName: z.string().min(1),
  /** 契约版本声明（如 "1.x"），必须在内核支持区间内。 */
  contractVersion: z.string().min(1),
  adapterVersion: z.string().min(1),
  declaredLevel: levelSchema,
  capabilities: z.array(capabilitySchema),
  drivers: z.array(driverSchema),
});

export type Manifest = z.infer<typeof manifestSchema>;

/**
 * 解析并校验适配器 manifest。
 * 结构非法或契约版本不被内核支持，均返回 E001（CONTRACT_VERSION）失败结果。
 */
export function parseManifest(json: unknown): Result<Manifest> {
  const startedAt = Date.now();
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    return fail("E001", `Adapter manifest failed schema validation: ${parsed.error.message}`, {
      userHint: "适配器清单结构不合法，已拒绝加载",
      cause: parsed.error,
      startedAt,
    });
  }
  if (!isContractVersionSupported(parsed.data.contractVersion)) {
    return fail(
      "E001",
      `Adapter manifest declares unsupported contractVersion "${parsed.data.contractVersion}", kernel supports ${
        KERNEL_SUPPORTED_CONTRACT_RANGE.join(", ")
      }`,
      {
        userHint: "适配器契约版本与内核支持范围不兼容，已拒绝加载",
        startedAt,
      },
    );
  }
  return ok(parsed.data, startedAt);
}
