/**
 * 189（天翼云盘）CAS 元数据编解码
 *
 * 与 139 的 `cas/format.ts` 同源：CAS 是「内容寻址占位文件」——
 * 文件本体不存内容，只存一段 base64 编码的 JSON 元数据，描述真实文件的
 * 名字、大小与哈希。播放/恢复时用元数据里的哈希向云盘发起「秒传」，
 * 换取真实文件句柄（零字节传输）。
 *
 * ## 与 139 的差异（重要）
 *
 * 天翼云盘的秒传**只认 MD5 / sliceMd5**（见 `restore.ts` 的
 * `initMultiUpload` 参数），**不需要 SHA256**。而 139 恰恰只认 SHA256。
 *
 * 因此本文件在校验时**以 MD5 为必需字段**，SHA256 仅作为兼容字段保留
 * （部分工具生成的 .cas 会带上，便于跨云盘转运）。
 *
 * 命名约定与 139 完全一致：`<真实文件名>.cas`，例如
 * `movie.mp4` → `movie.mp4.cas`。
 */

export const CAS_EXT = ".cas"

/** CAS 元数据（解码后） */
export interface CasMeta {
  /** 来源供应商标识，189 场景为 "189" 或留空 */
  provider?: string
  /** 真实文件名，如 `movie.mp4` */
  name: string
  /** 真实文件字节数 */
  size: number
  /** 整文件 MD5（十六进制，小写）—— 189 秒传的必需字段 */
  md5?: string
  /** 分片 MD5（天翼的 sliceMd5；大文件秒传必需） */
  sliceMd5?: string
  /** SHA1（115 等盘需要） */
  sha1?: string
  /** 预置 ID（115 等盘需要） */
  preId?: string
  /** SHA256（139 秒传用；189 不需要，兼容保留） */
  sha256?: string
  /** 源文件所在目录 ID（部分工具会写入） */
  parentFileId?: string
  /** CAS 生成时间（秒级字符串） */
  createTime?: string
}

/** CAS JSON 载荷（落盘格式，与 139 / Go 参考实现字段名一致） */
interface CasPayload {
  provider?: string
  name: string
  size: number
  md5?: string
  sliceMd5?: string
  sha1?: string
  preID?: string
  sha256?: string
  parentFileId?: string
  create_time?: string
}

/** 判断文件名是否为 CAS 占位文件 */
export function isCasName(name: string): boolean {
  return String(name || "")
    .toLowerCase()
    .endsWith(CAS_EXT)
}

/** 由真实文件名推导 CAS 文件名 */
export function toCasName(realName: string): string {
  return realName + CAS_EXT
}

/**
 * 由 CAS 文件名推导真实文件名（对齐 Go `casmeta.DeriveRestoreName`）。
 *
 * Go 的实现是**连续剥两层扩展名**，再用元数据里的扩展名替换：
 *   `abc.mp4.cas` → 剥 `.cas` → `abc.mp4` → 剥 `.mp4` → `abc` → + 元数据 ext
 *   `test.cas`    → 剥 `.cas` → `test`    → 剥（无）  → `test` → + 元数据 ext
 *
 * 这里保持一致：优先用「剥两层后的基名 + 元数据扩展名」，
 * 基名为空时回退到元数据里的完整 name。
 */
export function deriveRealName(casName: string, metaName?: string): string {
  const trimmed = String(casName || "").trim()
  if (!trimmed.toLowerCase().endsWith(CAS_EXT)) return trimmed

  // 剥掉 .cas
  let base = trimmed.slice(0, trimmed.length - CAS_EXT.length)
  // 再剥掉一层扩展名（对齐 Go 的两次 TrimSuffix）
  const dot = base.lastIndexOf(".")
  if (dot > 0) base = base.slice(0, dot)

  const metaExt = extOf(metaName || "")
  if (!base) {
    // 退化为 `.cas` 时用元数据里的完整名
    return metaName || base
  }
  return base + metaExt
}

/** 取扩展名（含点，小写）；无扩展名返回空串 */
function extOf(name: string): string {
  const idx = name.lastIndexOf(".")
  if (idx <= 0) return ""
  return name.slice(idx).toLowerCase()
}

/**
 * 解析恢复名（对齐 Go `casmeta.ResolveRestoreName`）：
 * 校验 `.cas` 后缀、非空基名、不含路径分隔符。
 */
export function resolveRestoreName(casName: string, metaName?: string): string {
  if (!isCasName(casName)) {
    throw new Error(`CAS 恢复失败：文件名 "${casName}" 不以 .cas 结尾`)
  }
  const trimmedBase = String(casName || "")
    .trim()
    .slice(0, String(casName).trim().length - CAS_EXT.length)
    .trim()
  if (!trimmedBase) {
    throw new Error(`CAS 恢复失败：.cas 文件名为空`)
  }
  const restoreName = String(deriveRealName(casName, metaName) || "").trim()
  if (!restoreName) {
    throw new Error(`CAS 恢复失败：源文件名为空`)
  }
  if (/[/\\]/.test(restoreName)) {
    throw new Error(`CAS 恢复失败：源文件名 "${restoreName}" 含路径分隔符`)
  }
  return restoreName
}

/**
 * 将元数据编码为 CAS 文件内容。
 * 格式：base64(UTF-8 JSON)
 */
export function encodeCas(meta: CasMeta): string {
  if (!meta.name) throw new Error("CAS 元数据缺少 name")
  const payload: CasPayload = {
    provider: meta.provider || "189",
    name: meta.name,
    size: meta.size,
    md5: meta.md5,
    sliceMd5: meta.sliceMd5 || meta.md5,
    sha1: meta.sha1,
    preID: meta.preId,
    sha256: meta.sha256,
    create_time: String(Math.floor(Date.now() / 1000)),
  }
  return base64EncodeUtf8(JSON.stringify(payload))
}

/**
 * 解析 CAS 文件内容为元数据。
 *
 * 容错处理：部分实现可能省略 padding 或含首尾空白，这里统一修正。
 *
 * ⚠️ 校验规则（对齐 Go `casmeta.Decode`）：name 非空、size ≥ 0、
 * 且 **md5 / sha256 / sha1 至少有一个**。189 秒传实际只需要 md5 + sliceMd5。
 */
export function decodeCas(
  content: string | ArrayBuffer | Uint8Array,
): CasMeta {
  const raw =
    typeof content === "string"
      ? content
      : utf8Decode(
          content instanceof Uint8Array ? content : new Uint8Array(content),
        )

  const trimmed = raw.trim()
  if (!trimmed) throw new Error("CAS 文件为空")

  // 兼容缺失 padding 的 base64
  const padded = trimmed + "=".repeat((4 - (trimmed.length % 4)) % 4)

  let decoded: string
  try {
    decoded = base64DecodeUtf8(padded)
  } catch {
    throw new Error("CAS 内容不是合法的 base64")
  }

  let payload: CasPayload
  try {
    payload = JSON.parse(decoded) as CasPayload
  } catch {
    throw new Error("CAS 内容不是合法的 JSON")
  }

  if (!payload.name || typeof payload.name !== "string") {
    throw new Error("CAS 元数据缺少 name 字段")
  }
  if (typeof payload.size !== "number" || payload.size < 0) {
    throw new Error("CAS 元数据 size 字段非法")
  }
  if (!payload.md5 && !payload.sha256 && !payload.sha1) {
    throw new Error("CAS 元数据缺少任何哈希值")
  }

  return {
    provider: payload.provider,
    name: payload.name,
    size: payload.size,
    md5: payload.md5 ? String(payload.md5).toLowerCase() : undefined,
    sliceMd5: payload.sliceMd5
      ? String(payload.sliceMd5).toLowerCase()
      : payload.md5
        ? String(payload.md5).toLowerCase()
        : undefined,
    sha1: payload.sha1,
    preId: payload.preID,
    sha256: payload.sha256,
    parentFileId: payload.parentFileId,
    createTime: payload.create_time,
  }
}

/**
 * 扩展名白名单校验。
 *
 * @param name 文件名
 * @param allowlist 逗号分隔的扩展名，空串或 `*` 表示全部允许
 */
export function extAllowed(name: string, allowlist: string): boolean {
  const list = normalizeAllowlist(allowlist)
  if (!list || list === "*") return true
  const idx = String(name || "").lastIndexOf(".")
  if (idx < 0) return false
  const ext = name.slice(idx + 1).toLowerCase()
  return list.split(",").includes(ext)
}

/** 规范化白名单字符串 */
export function normalizeAllowlist(allowlist: string): string {
  const parts = (allowlist || "")
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean)
  if (parts.includes("*")) return "*"
  return Array.from(new Set(parts)).join(",")
}

/** 视频扩展名判定（对齐 Go `isVideoName`） */
export function isVideoName(name: string): boolean {
  const ext = extOf(name)
  return [
    ".mp4",
    ".mkv",
    ".avi",
    ".mov",
    ".webm",
    ".flv",
    ".ts",
    ".m2ts",
    ".wmv",
    ".rmvb",
    ".m4v",
    ".mpg",
    ".mpeg",
    ".3gp",
  ].includes(ext)
}

/* ---------------- base64 与 UTF-8 互转 ---------------- */

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes)
}

function utf8Encode(str: string): Uint8Array {
  return new TextEncoder().encode(str)
}

function base64EncodeUtf8(str: string): string {
  const bytes = utf8Encode(str)
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)),
    )
  }
  return btoa(binary)
}

function base64DecodeUtf8(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return utf8Decode(bytes)
}
