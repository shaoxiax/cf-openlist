/**
 * 189（天翼云盘）CAS 模块自测
 *
 * 覆盖：文件名推导、元数据编解码、扩展名白名单、恢复名解析、
 *       秒传链路（含 fileDataExists 判定）、临时目录命名与清扫。
 *
 * 运行：npx tsx --test src/backend/drivers/189/cas/cas.test.ts
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  deriveRealName,
  decodeCas,
  encodeCas,
  extAllowed,
  isCasName,
  isVideoName,
  normalizeAllowlist,
  resolveRestoreName,
  toCasName,
} from "./format"
import {
  isCasTempDir,
  makeTempSubDirName,
  restoreDirect,
  restoreFromCas,
  sweepTempFiles,
  CasRestoreError,
} from "./restore"
import { shouldHandleCas } from "./player"

/* ------------------------- 文件名 ------------------------- */

test("isCasName 识别 .cas 后缀（大小写不敏感）", () => {
  assert.equal(isCasName("movie.mp4.cas"), true)
  assert.equal(isCasName("movie.MP4.CAS"), true)
  assert.equal(isCasName("movie.mp4"), false)
  assert.equal(isCasName("cas"), false)
})

test("toCasName 追加 .cas 后缀", () => {
  assert.equal(toCasName("电影.mp4"), "电影.mp4.cas")
})

test("deriveRealName 剥两层扩展名后拼上元数据扩展名", () => {
  // abc.mp4.cas → 剥 .cas → abc.mp4 → 剥 .mp4 → abc → + .mkv
  assert.equal(deriveRealName("abc.mp4.cas", "movie.mkv"), "abc.mkv")
  // test.cas → 剥 .cas → test → 无扩展名可剥 → test + .mkv
  assert.equal(deriveRealName("test.cas", "movie.mkv"), "test.mkv")
})

test("deriveRealName 大小写不敏感的 .cas 后缀", () => {
  assert.equal(deriveRealName("test.CAS", "movie.mkv"), "test.mkv")
})

test("resolveRestoreName 正常路径", () => {
  assert.equal(resolveRestoreName("第10集.mkv.cas", "x.mkv"), "第10集.mkv")
  assert.equal(resolveRestoreName("test.cas", "movie.mkv"), "test.mkv")
})

test("resolveRestoreName 拒绝非法输入", () => {
  assert.throws(() => resolveRestoreName("test.mkv", "a.mkv"), /不以 \.cas 结尾/)
  assert.throws(() => resolveRestoreName(".cas", "a.mkv"), /为空/)
})

test("resolveRestoreName 拒绝 base 名含路径的 .cas", () => {
  // 元数据里的路径前缀会被 extOf 丢弃（与 Go 的 path.Ext 一致），
  // 因此由**文件名本身**携带的路径才是真正的注入风险点
  assert.throws(
    () => resolveRestoreName("dir/test.cas", "dir/movie.mkv"),
    /含路径分隔符/,
  )
})

test("resolveRestoreName 元数据带路径时不泄漏路径（仅取扩展名）", () => {
  // 对齐 Go：DeriveRestoreName 只取 path.Ext，路径前缀被丢弃
  assert.equal(resolveRestoreName("test.cas", "dir/movie.mkv"), "test.mkv")
})

/* ------------------------- 元数据编解码 ------------------------- */

test("encodeCas / decodeCas 往返一致", () => {
  const meta = {
    provider: "189",
    name: "流浪地球2.mp4",
    size: 1234567,
    md5: "d41d8cd98f00b204e9800998ecf8427e",
    sliceMd5: "abcdefabcdefabcdefabcdefabcdefab",
  }
  const encoded = encodeCas(meta)
  const decoded = decodeCas(encoded)

  assert.equal(decoded.name, meta.name)
  assert.equal(decoded.size, meta.size)
  assert.equal(decoded.md5, meta.md5)
  assert.equal(decoded.sliceMd5, meta.sliceMd5)
  assert.equal(decoded.provider, "189")
})

test("decodeCas 兼容缺失 padding 的 base64", () => {
  const meta = { name: "a.mkv", size: 10, md5: "0".repeat(32) }
  const encoded = encodeCas(meta)
  const noPad = encoded.replace(/=+$/, "")
  assert.equal(decodeCas(noPad).name, "a.mkv")
})

test("decodeCas 校验失败场景", () => {
  assert.throws(() => decodeCas(""), /为空/)
  assert.throws(() => decodeCas("!!!not-base64!!!"), /base64|JSON/)
  // 缺 name
  const noName = Buffer.from(JSON.stringify({ size: 1, md5: "a" })).toString(
    "base64",
  )
  assert.throws(() => decodeCas(noName), /name/)
  // 缺任何哈希
  const noHash = Buffer.from(
    JSON.stringify({ name: "a.mkv", size: 1 }),
  ).toString("base64")
  assert.throws(() => decodeCas(noHash), /哈希/)
})

test("decodeCas 在 sliceMd5 缺省时回落为 md5", () => {
  const content = Buffer.from(
    JSON.stringify({ name: "a.mkv", size: 5, md5: "b".repeat(32) }),
  ).toString("base64")
  const meta = decodeCas(content)
  assert.equal(meta.sliceMd5, "b".repeat(32))
})

test("decodeCas 归一化 md5 为小写", () => {
  const content = Buffer.from(
    JSON.stringify({ name: "a.mkv", size: 5, md5: "A".repeat(32) }),
  ).toString("base64")
  assert.equal(decodeCas(content).md5, "a".repeat(32))
})

/* ------------------------- 白名单 ------------------------- */

test("normalizeAllowlist 归一化与去重", () => {
  assert.equal(normalizeAllowlist("MP4, mkv ;.avi"), "mp4,mkv,avi")
  assert.equal(normalizeAllowlist("mp4,mp4,mp4"), "mp4")
  assert.equal(normalizeAllowlist("mp4,*"), "*")
  assert.equal(normalizeAllowlist(""), "")
})

test("extAllowed 白名单判定", () => {
  assert.equal(extAllowed("a.mkv", ""), true, "空表示全部允许")
  assert.equal(extAllowed("a.mkv", "*"), true)
  assert.equal(extAllowed("a.mkv", "mp4,mkv"), true)
  assert.equal(extAllowed("a.mkv", "mp4,avi"), false)
  assert.equal(extAllowed("noext", "mp4"), false)
})

test("isVideoName 识别常见视频扩展名", () => {
  assert.equal(isVideoName("a.mkv"), true)
  assert.equal(isVideoName("a.MP4"), true)
  assert.equal(isVideoName("a.zip"), false)
})

/* ------------------------- 播放判定 ------------------------- */

test("shouldHandleCas：仅 .cas 且白名单内为真", () => {
  assert.equal(shouldHandleCas("a.mp4.cas", ""), true)
  assert.equal(shouldHandleCas("a.mp4.cas", "mp4"), true)
  assert.equal(shouldHandleCas("a.mp4.cas", "zip"), false)
  assert.equal(shouldHandleCas("a.mp4", ""), false)
})

/* ------------------------- 秒传链路 ------------------------- */

/** 构造一个最小可用的假客户端 */
function fakeClient(opts: {
  fileDataExists?: boolean
  initShouldThrow?: boolean
  folders?: Array<{ id: string; name: string; lastOpTime?: string }>
  files?: Array<{ id: string; name: string }>
} = {}) {
  const calls: string[] = []
  return {
    calls,
    getRootId: () => "-11",
    getDownloadHeaders: () => ({ "User-Agent": "test" }),
    initRapidUpload: async (p: any) => {
      calls.push(`init:${p.fileName}:${p.fileMd5}`)
      if (opts.initShouldThrow) throw new Error("init failed")
      return {
        uploadFileId: "ufid-1",
        fileDataExists: opts.fileDataExists !== false,
      }
    },
    commitRapidUpload: async (id: string, opertype: string) => {
      calls.push(`commit:${id}:${opertype}`)
      return { fileId: "new-file-1", fileName: "restored.mkv" }
    },
    mkdir: async (parent: string, name: string) => {
      calls.push(`mkdir:${parent}:${name}`)
    },
    remove: async (id: string, isDir: boolean, name: string) => {
      calls.push(`remove:${id}:${isDir}:${name}`)
    },
    getFiles: async (_id: string) => ({
      files: opts.files || [],
      folders: opts.folders || [],
    }),
    getDownloadUrl: async (_id: string) => "https://dl.example/x",
  } as any
}

test("restoreDirect 秒传命中后提交（opertype=1 不覆盖）", async () => {
  const client = fakeClient()
  const result = await restoreDirect(
    client,
    "parent-1",
    "restored.mkv",
    { name: "restored.mkv", size: 100, md5: "a".repeat(32) },
  )
  assert.equal(result.fileId, "new-file-1")
  assert.equal(result.rapid, true)
  assert.deepEqual(client.calls, [
    `init:restored.mkv:${"a".repeat(32)}`,
    "commit:ufid-1:1",
  ])
})

test("restoreDirect overwrite=true 时 opertype=3", async () => {
  const client = fakeClient()
  await restoreDirect(
    client,
    "parent-1",
    "r.mkv",
    { name: "r.mkv", size: 1, md5: "b".repeat(32) },
    true,
  )
  assert.ok(client.calls.includes("commit:ufid-1:3"))
})

test("restoreDirect 云端无该内容时抛错（秒传未命中）", async () => {
  const client = fakeClient({ fileDataExists: false })
  await assert.rejects(
    () =>
      restoreDirect(client, "p", "r.mkv", {
        name: "r.mkv",
        size: 1,
        md5: "c".repeat(32),
      }),
    /秒传未命中/,
  )
})

test("restoreDirect 缺少合法 MD5 时抛错", async () => {
  const client = fakeClient()
  await assert.rejects(
    () =>
      restoreDirect(client, "p", "r.mkv", {
        name: "r.mkv",
        size: 1,
        md5: "short",
      }),
    /未记录合法的 MD5/,
  )
})

test("restoreFromCas 校验扩展名白名单", async () => {
  const client = fakeClient()
  const content = encodeCas({
    name: "movie.mkv",
    size: 100,
    md5: "d".repeat(32),
  })
  await assert.rejects(
    () => restoreFromCas(client, "p", content, "test.mkv.cas", "zip"),
    /不在白名单/,
  )
})

test("restoreFromCas 缺少 MD5 时提示是 139 的 .cas", async () => {
  const client = fakeClient()
  // 只有 sha256（139 风格）
  const content = Buffer.from(
    JSON.stringify({
      name: "movie.mkv",
      size: 100,
      sha256: "e".repeat(64),
    }),
  ).toString("base64")
  await assert.rejects(
    () => restoreFromCas(client, "p", content, "test.mkv.cas", ""),
    /139/,
  )
})

test("restoreFromCas 正常恢复返回元数据与恢复名", async () => {
  const client = fakeClient()
  const content = encodeCas({
    name: "movie.mkv",
    size: 100,
    md5: "f".repeat(32),
  })
  const { result, meta, restoreName } = await restoreFromCas(
    client,
    "p",
    content,
    "第10集.mp4.cas",
    "",
  )
  assert.equal(restoreName, "第10集.mkv")
  assert.equal(meta.size, 100)
  assert.equal(result.rapid, true)
})

/* ------------------------- 临时目录 ------------------------- */

test("makeTempSubDirName 带 TEMP_ 前缀且唯一", () => {
  const a = makeTempSubDirName()
  const b = makeTempSubDirName()
  assert.ok(isCasTempDir(a))
  assert.ok(isCasTempDir(b))
  assert.notEqual(a, b)
})

test("isCasTempDir 只认 TEMP_ 前缀", () => {
  assert.equal(isCasTempDir("TEMP_123_abc"), true)
  assert.equal(isCasTempDir("TEMP"), false)
  assert.equal(isCasTempDir("电影"), false)
})

test("sweepTempFiles 只清理过期且带前缀的目录", async () => {
  const now = Date.now()
  const old = new Date(now - 60 * 60 * 1000).toISOString()
  const fresh = new Date(now - 1000).toISOString()
  const client = fakeClient({
    folders: [
      { id: "1", name: "TEMP_old_aaaaa", lastOpTime: old },
      { id: "2", name: "TEMP_fresh_bbbbb", lastOpTime: fresh },
      { id: "3", name: "普通目录", lastOpTime: old },
    ],
  })
  const removed = await sweepTempFiles(client, "temp-root", 30 * 60 * 1000)
  assert.equal(removed, 1)
  assert.ok(client.calls.includes("remove:1:true:TEMP_old_aaaaa"))
  assert.ok(!client.calls.some((c: string) => c.startsWith("remove:2:")))
  assert.ok(!client.calls.some((c: string) => c.startsWith("remove:3:")))
})

test("CasRestoreError 是 Error 的子类并带正确 name", () => {
  const e = new CasRestoreError("x")
  assert.ok(e instanceof Error)
  assert.equal(e.name, "CasRestoreError")
})
