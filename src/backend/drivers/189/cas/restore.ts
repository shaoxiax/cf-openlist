/**
 * 189（天翼云盘）CAS 秒传恢复
 *
 * 核心思路：CAS 元数据里存着真实文件的 MD5 / sliceMd5，
 * 用它向天翼云盘发起「秒传」，云端若已有该内容（`fileDataExists=1`），
 * 则**零字节传输**直接把文件恢复出来。
 *
 * ## 完整链路（对齐 Go 参考实现 `189pc/cas_restore.go`）
 *
 *   ① `GET /person/initMultiUpload`
 *        参数：parentFolderId / fileName / fileSize / fileMd5 / sliceMd5
 *        返回：uploadFileId + `fileDataExists`
 *        ⚠️ 若 `fileDataExists !== 1` ⇒ 云端没有这份内容 ⇒ **秒传失败**
 *   ② `GET /person/commitMultiUploadFile`
 *        参数：uploadFileId / opertype / isLog
 *        ⚠️ `opertype`：`3` = 覆盖，`1` = 不覆盖（对齐 Go 的 IF(overwrite,"3","1")）
 *   ③ 提交成功后文件即出现在目标目录
 *
 * ## 为什么要用 `upload.cloud.189.cn` 而非 `cloud.189.cn/api/open`
 *
 * 旧的 `/api/open/file/createFile.action` 走 open 网关，**不认 MD5 秒传**；
 * 秒传能力只挂在加密上传网关 `upload.cloud.189.cn` 上（见 util.ts 的
 * `uploadRequest`：AES-128-ECB 加密参数 + HMAC-SHA1 签名 + RSA 加密会话密钥）。
 *
 * ## 临时目录与清理
 *
 * 播放场景不能污染用户目录，因此恢复出来的副本放在根目录下的 `TEMP/` 里，
 * 子目录名形如 `TEMP_<毫秒>_<随机5位>`。清理策略：
 *   - 播放结束后**延时删除**子目录（`safeDelete`，失败不抛错）；
 *   - 兜底**惰性清扫**：进入播放链路时顺带清掉过期的 TEMP_* 子目录；
 *   - `cas_auto_cleanup=false` 时不自动删，便于排查。
 */

import type { Pan189Client } from "../util"
import { CasMeta, decodeCas, extAllowed, resolveRestoreName } from "./format"

/** 秒传恢复结果 */
export interface RestoreResult {
  /** 恢复出来的文件 ID */
  fileId: string
  /** 恢复出来的文件名 */
  fileName: string
  /** 是否秒传命中（云端已有内容） */
  rapid: boolean
}

/** 秒传恢复失败（带用户可读信息） */
export class CasRestoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CasRestoreError"
  }
}

/** 临时目录名（与 Go 参考实现一致） */
export const CAS_TEMP_DIR_NAME = "TEMP"

/** 临时子目录名前缀 */
const CAS_TEMP_SUBDIR_PREFIX = "TEMP_"

/** sliceMd5 的分片大小：天翼固定 10MB（与 util.ts 的 createMultiUpload 对齐） */
const SLICE_SIZE = 10 * 1024 * 1024

/** 判断名字是否为 CAS 临时子目录 */
export function isCasTempDir(name: string): boolean {
  return String(name || "").startsWith(CAS_TEMP_SUBDIR_PREFIX)
}

/** 生成一个临时子目录名：`TEMP_<毫秒>_<随机5位>` */
export function makeTempSubDirName(): string {
  const ms = Date.now()
  const rand = Math.random().toString(36).slice(2, 7)
  return `${CAS_TEMP_SUBDIR_PREFIX}${ms}_${rand}`
}

/**
 * 秒传恢复一个文件到指定目录（**不经过临时目录**，直接落到目标目录）。
 *
 * 对齐 Go `restoreCASDirect`。
 *
 * @param client  189 API 客户端
 * @param parentId 目标目录 ID
 * @param name    恢复出来的文件名
 * @param meta    CAS 元数据（需含 md5 / sliceMd5 / size）
 * @param overwrite 同名冲突时是否覆盖（Go: opertype 3=覆盖 / 1=不覆盖）
 */
export async function restoreDirect(
  client: Pan189Client,
  parentId: string,
  name: string,
  meta: CasMeta,
  overwrite = false,
): Promise<RestoreResult> {
  const md5 = String(meta.md5 || "").toLowerCase()
  if (md5.length !== 32) {
    throw new CasRestoreError(
      `CAS 恢复失败：该 .cas 文件未记录合法的 MD5（长度 ${md5.length}，应为 32），无法秒传`,
    )
  }
  const sliceMd5 = String(meta.sliceMd5 || meta.md5 || "").toLowerCase()

  // ① 申请秒传会话：带上 MD5，云端据此判断是否已有该内容
  const init = await client.initRapidUpload({
    parentFolderId: parentId,
    fileName: name,
    fileSize: meta.size,
    fileMd5: md5,
    sliceMd5,
    sliceSize: SLICE_SIZE,
  })

  // ⚠️ 这一步是整个功能成立与否的分水岭：云端没有这份内容就彻底失败
  if (!init.fileDataExists) {
    throw new CasRestoreError(
      "秒传未命中：云端不存在该文件内容（可能源文件已被删除，或该 .cas 来自其他云盘）",
    )
  }

  // ② 提交，文件即可见
  const committed = await client.commitRapidUpload(
    init.uploadFileId,
    overwrite ? "3" : "1",
  )

  return {
    fileId: String(committed.fileId || ""),
    fileName: String(committed.fileName || name),
    rapid: true,
  }
}

/**
 * 解析 .cas 内容并秒传恢复到指定目录。
 *
 * @param casContent .cas 文件的原始内容（base64 文本）
 * @param casName    .cas 文件名（用于推导恢复名）
 */
export async function restoreFromCas(
  client: Pan189Client,
  parentId: string,
  casContent: string | Uint8Array,
  casName: string,
  allowlist: string,
  overwrite = false,
): Promise<{ result: RestoreResult; meta: CasMeta; restoreName: string }> {
  const meta = decodeCas(casContent)
  const restoreName = resolveRestoreName(casName, meta.name)

  if (!extAllowed(restoreName, allowlist)) {
    throw new CasRestoreError(
      `CAS 恢复跳过：扩展名不在白名单内（${restoreName}）`,
    )
  }
  if (!meta.md5) {
    throw new CasRestoreError(
      "CAS 恢复失败：该 .cas 未记录 MD5，天翼云盘秒传必须提供 MD5（可能是为 139 生成的 .cas）",
    )
  }

  const result = await restoreDirect(
    client,
    parentId,
    restoreName,
    meta,
    overwrite,
  )
  return { result, meta, restoreName }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 临时目录管理
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * 确保根目录下存在 `TEMP/`，返回其目录 ID。
 *
 * 先列根目录找（顺带把根目录内容带回，供调用方复用），找不到则创建。
 */
export async function ensureTempDir(
  client: Pan189Client,
  rootId: string,
): Promise<{ dirId: string; created: boolean }> {
  const { folders } = await client.getFiles(rootId)
  const existed = folders.find((f) => f.name === CAS_TEMP_DIR_NAME)
  if (existed) {
    return { dirId: String(existed.id), created: false }
  }
  await client.mkdir(rootId, CAS_TEMP_DIR_NAME)
  // 创建后需重新查一次拿 ID（createFolder 不返回 ID）
  const again = await client.getFiles(rootId)
  const created = again.folders.find((f) => f.name === CAS_TEMP_DIR_NAME)
  if (!created) {
    throw new CasRestoreError("创建 TEMP 目录后未能取到其 ID")
  }
  return { dirId: String(created.id), created: true }
}

/** 在给定父目录下创建一个临时子目录，返回其 ID */
export async function createTempSubDir(
  client: Pan189Client,
  parentId: string,
): Promise<string> {
  const name = makeTempSubDirName()
  await client.mkdir(parentId, name)
  const { folders } = await client.getFiles(parentId)
  const created = folders.find((f) => f.name === name)
  if (!created) {
    throw new CasRestoreError(`创建临时子目录 ${name} 后未能取到其 ID`)
  }
  return String(created.id)
}

/**
 * 安全删除一个目录（失败只记录，不抛错）。
 *
 * 播放链路末尾的清理必须在 `waitUntil` 里执行，此时响应早已返回，
 * 任何抛出的错误都无人接收，反而会污染日志。
 */
export async function safeDeleteDir(
  client: Pan189Client,
  dirId: string,
  dirName: string,
): Promise<void> {
  try {
    await client.remove(dirId, true, dirName)
  } catch (e: any) {
    console.warn(`[189] 清理临时目录 ${dirName} 失败:`, e?.message || e)
  }
}

/**
 * 清扫过期的 `TEMP_*` 子目录（惰性兜底）。
 *
 * 播放结束的延时删除可能因为 Worker 被回收而没跑成，这里在每次进入
 * 播放链路时顺带清一次，避免 TEMP 无限膨胀。
 *
 * @param minAgeMs 只清理「创建/修改时间早于 now-minAgeMs」的目录，
 *                 避免误删正在播放的副本
 */
export async function sweepTempFiles(
  client: Pan189Client,
  tempDirId: string,
  minAgeMs = 30 * 60 * 1000,
): Promise<number> {
  let removed = 0
  try {
    const { folders } = await client.getFiles(tempDirId)
    const now = Date.now()
    for (const f of folders) {
      if (!isCasTempDir(f.name)) continue
      const ts = Date.parse(f.lastOpTime || "")
      if (!isNaN(ts) && now - ts < minAgeMs) continue
      try {
        await client.remove(String(f.id), true, f.name)
        removed++
      } catch {
        // 单个失败不影响其余
      }
    }
  } catch (e: any) {
    console.warn(`[189] 清扫 TEMP 目录失败:`, e?.message || e)
  }
  return removed
}

/**
 * 解码 .cas 内容但**不做恢复**，仅用于预览场景读取真实文件名。
 *
 * 供 `CASPreviewName` 使用：列表/详情里希望把 `第10集.mkv.cas`
 * 显示成 `第10集.mkv`，只需要读元数据，不需要恢复文件。
 */
export function previewNameOf(
  casContent: string | Uint8Array,
  casName: string,
): string {
  const meta = decodeCas(casContent)
  return resolveRestoreName(casName, meta.name)
}
