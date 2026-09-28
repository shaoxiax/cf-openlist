/**
 * 189（天翼云盘）CAS 播放
 *
 * 把「.cas 占位文件」变成「可播放的直链」。
 *
 * ## 完整链路
 *
 *   ① 取 .cas 文件的下载直链 → fetch 读出 base64 内容 → 解析出 CasMeta
 *   ② 确保根目录下有 TEMP/，并在其中创建 TEMP_<ms>_<rand>/ 子目录
 *   ③ 用 MD5 秒传把真实文件恢复到该子目录（见 restore.ts）
 *   ④ 取恢复出来的文件的下载直链
 *   ⑤ 延时清理临时子目录
 *
 * ## 直链缓存（沿用 139 的 Cache API 方案）
 *
 * 上述链路**串行 4 次往返**，实测 3~13 秒；而播放器会反复请求
 * （起播探测、拖动、多段 Range、重试），每次都重跑整条链路会把
 * CF Workers 的子请求/CPU 配额打爆，表现为偶发 503。
 *
 * 因此这里缓存「恢复后的直链」，TTL 10 分钟（天翼直链有效期约 15 分钟）。
 *
 * ⚠️ 缓存必须用 **Cache API**（`caches.default`）而不是模块级 Map / KV：
 *   - 模块级 Map：CF 会把请求分散到多个 isolate，写进去读不到（实测无效）；
 *   - KV：免费版每日仅 1000 次写，且与主配置共用配额，写满后 `put` 静默失败
 *     （139 项目踩过这个坑，详见其 player.ts 的长注释）。
 *   - Cache API 走 CDN 边缘缓存，不消耗 KV 写配额、写入不需等待、
 *     不会失败，天然按 PoP 分布，正适合「读多写少」的直链加速。
 */

import type { Pan189Client } from "../util"
import {
  encodeCas,
  extAllowed,
  isCasName,
  isVideoName,
  resolveRestoreName,
  decodeCas,
  type CasMeta,
} from "./format"
import {
  createTempSubDir,
  ensureTempDir,
  restoreDirect,
  safeDeleteDir,
  sweepTempFiles,
  CasRestoreError,
} from "./restore"

/** 播放直链结果 */
export interface CasPlayLink {
  url: string
  size: number
  name: string
  headers?: Record<string, string>
  /** 本次使用的临时目录 ID（供驱动缓存复用，省一次列目录往返） */
  tempDirId?: string
  /** 恢复出来的文件 ID（供调试） */
  fileId?: string
}

/** 播放失败的错误（带用户可读信息） */
export class CasPlayError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CasPlayError"
  }
}

interface CasLinkCacheEntry {
  url: string
  size: number
  name: string
  headers?: Record<string, string>
  tempDirId?: string
  fileId?: string
  /** 写入时刻（毫秒） */
  at: number
}

/** 直链缓存 TTL：天翼直链约 15 分钟有效，取 10 分钟留安全余量 */
const CAS_LINK_TTL_MS = 10 * 60 * 1000

/** 一级缓存容量上限（per-isolate） */
const CAS_LINK_CACHE_MAX = 200

/** Cache API 的 URL 前缀 */
const CAS_CACHE_ORIGIN = "https://caslink.internal"

/** 进程内一级缓存 */
const casLinkCache = new Map<string, CasLinkCacheEntry>()

/** 构造 Cache API 的缓存键 */
function cacheKeyOf(clientKey: string, casFileId: string): string {
  return `${CAS_CACHE_ORIGIN}/189cas/${encodeURIComponent(clientKey)}/${encodeURIComponent(casFileId)}`
}

/** 读缓存：内存 → Cache API */
async function cacheGet(
  clientKey: string,
  casFileId: string,
): Promise<CasLinkCacheEntry | null> {
  const now = Date.now()
  const mem = casLinkCache.get(casFileId)
  if (mem && now - mem.at < CAS_LINK_TTL_MS) return mem
  if (mem) casLinkCache.delete(casFileId)

  try {
    const cache = (globalThis as any).caches?.default
    if (!cache) return null
    const resp = await cache.match(cacheKeyOf(clientKey, casFileId))
    if (!resp) return null
    const entry = (await resp.json()) as CasLinkCacheEntry
    if (!entry?.url || now - entry.at >= CAS_LINK_TTL_MS) return null
    if (casLinkCache.size >= CAS_LINK_CACHE_MAX) casLinkCache.clear()
    casLinkCache.set(casFileId, entry)
    return entry
  } catch {
    return null
  }
}

/** 写缓存：内存 + Cache API（不 await，避免拖慢播放） */
function cachePut(clientKey: string, casFileId: string, entry: CasLinkCacheEntry): void {
  if (casLinkCache.size >= CAS_LINK_CACHE_MAX) casLinkCache.clear()
  casLinkCache.set(casFileId, entry)

  try {
    const cache = (globalThis as any).caches?.default
    if (!cache) return
    const resp = new Response(JSON.stringify(entry), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `max-age=${Math.floor(CAS_LINK_TTL_MS / 1000)}`,
      },
    })
    // 故意不 await：缓存写入失败绝不能让播放失败
    void cache.put(cacheKeyOf(clientKey, casFileId), resp).catch(() => {})
  } catch {
    // 忽略
  }
}

/** 判断该文件是否应当走 CAS 播放 */
export function shouldHandleCas(name: string, allowExt?: string): boolean {
  if (!isCasName(name)) return false
  // 白名单过滤基于恢复后的真实文件名
  const real = name.toLowerCase().endsWith(".cas")
    ? name.slice(0, -4)
    : name
  return extAllowed(real, allowExt || "")
}

/** 下载 .cas 文件并返回其原始内容 */
async function fetchCasContent(
  client: Pan189Client,
  casFileId: string,
): Promise<string> {
  const url = await client.getDownloadUrl(casFileId)
  const resp = await fetch(url, { headers: client.getDownloadHeaders() })
  if (!resp.ok) {
    throw new CasPlayError(`读取 .cas 内容失败：HTTP ${resp.status}`)
  }
  return await resp.text()
}

/**
 * 解析 .cas 文件，返回元数据与恢复名。
 * 供驱动的 `cas_preview_name` 使用（列表里显示真实文件名）。
 */
export async function parseCasOfFile(
  client: Pan189Client,
  casFileId: string,
  casName: string,
): Promise<{ meta: CasMeta; restoreName: string }> {
  const content = await fetchCasContent(client, casFileId)
  const meta = decodeCas(content)
  return { meta, restoreName: resolveRestoreName(casName, meta.name) }
}

/**
 * 核心：把 .cas 转成可播放直链。
 *
 * @param client       189 客户端
 * @param rootId       根目录 ID（TEMP 建在这里）
 * @param casFileId    .cas 文件自身的 ID
 * @param casName      .cas 文件名
 * @param allowlist    扩展名白名单
 * @param autoCleanup  是否自动清理临时副本
 * @param tempDirId    已知的 TEMP 目录 ID（可省一次列目录往返）
 * @param clientKey    存储级隔离键（缓存命名空间）
 */
export async function resolveCasPlayLink(opts: {
  client: Pan189Client
  rootId: string
  casFileId: string
  casName: string
  allowlist?: string
  autoCleanup?: boolean
  tempDirId?: string
  clientKey?: string
}): Promise<CasPlayLink> {
  const {
    client,
    rootId,
    casFileId,
    casName,
    allowlist = "",
    autoCleanup = true,
    clientKey = "default",
  } = opts

  // ⓪ 命中缓存直接返回 —— 这是把 3~13 秒降到毫秒级的关键
  const cached = await cacheGet(clientKey, casFileId)
  if (cached) {
    return {
      url: cached.url,
      size: cached.size,
      name: cached.name,
      headers: cached.headers,
      tempDirId: cached.tempDirId,
      fileId: cached.fileId,
    }
  }

  // ① 读 .cas 内容
  const content = await fetchCasContent(client, casFileId)
  const meta = decodeCas(content)
  const restoreName = resolveRestoreName(casName, meta.name)

  if (!extAllowed(restoreName, allowlist)) {
    throw new CasPlayError(
      `CAS 播放跳过：${restoreName} 的扩展名不在白名单内`,
    )
  }
  if (!meta.md5) {
    throw new CasPlayError(
      "CAS 播放失败：该 .cas 未记录 MD5（天翼秒传必需），可能是为 139 生成的",
    )
  }

  // ② 准备临时目录
  let tempRootId = opts.tempDirId
  if (!tempRootId) {
    const ensured = await ensureTempDir(client, rootId)
    tempRootId = ensured.dirId
  }

  // 兜底清扫：清掉历史遗留的 TEMP_* 子目录（>30 分钟）
  void sweepTempFiles(client, tempRootId).catch(() => {})

  // ③ 恢复真实文件到临时子目录
  const tempSubId = await createTempSubDir(client, tempRootId)
  let restoredFileId = ""
  try {
    const restored = await restoreDirect(
      client,
      tempSubId,
      restoreName,
      meta,
      false,
    )
    restoredFileId = restored.fileId
  } catch (e) {
    // 恢复失败：立刻清掉刚建的临时子目录，避免留垃圾
    void safeDeleteDir(client, tempSubId, "TEMP_cleanup")
    throw e
  }

  if (!restoredFileId) {
    void safeDeleteDir(client, tempSubId, "TEMP_cleanup")
    throw new CasPlayError("秒传恢复成功但未拿到文件 ID")
  }

  // ④ 取直链
  let url: string
  try {
    url = await client.getDownloadUrl(restoredFileId)
  } catch (e: any) {
    void safeDeleteDir(client, tempSubId, "TEMP_cleanup")
    throw new CasPlayError(`获取播放直链失败：${e?.message || e}`)
  }

  const entry: CasLinkCacheEntry = {
    url,
    size: meta.size,
    name: restoreName,
    headers: client.getDownloadHeaders(),
    tempDirId: tempRootId,
    fileId: restoredFileId,
    at: Date.now(),
  }
  cachePut(clientKey, casFileId, entry)

  // ⑤ 延时清理临时副本（直链已缓存，副本本身不再需要）
  if (autoCleanup) {
    void safeDeleteDir(client, tempSubId, "TEMP_cleanup")
  }

  return {
    url,
    size: meta.size,
    name: restoreName,
    headers: entry.headers,
    tempDirId: tempRootId,
    fileId: restoredFileId,
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 * 说明：本驱动**不提供** .cas 生成能力（buildCasContent / shouldGenerateCas）
 * ────────────────────────────────────────────────────────────────────────── *
 *
 * CF Workers 搬不动本地大文件，put() 只在写 STRM、小文本、图床缩略图这类
 * 几百字节~几 MB 的场景被调用，而 .cas 占位的意义恰恰在于「大文件」。
 * 生成 .cas 请用独立搬运器 casgen（:5002）。
 */

/** 判断该文件是否为「值得播放」的视频（CASDownloadRestore 关闭时的兜底） */
export { isVideoName }
