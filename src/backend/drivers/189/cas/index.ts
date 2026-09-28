/**
 * 189（天翼云盘）CAS 功能
 *
 * 把 `.cas` 占位文件变成可播放/可下载的真实文件，以及反向生成 `.cas`。
 *
 * 模块划分：
 *   - `format.ts`  CAS 元数据编解码（base64(JSON) → CasMeta）
 *   - `restore.ts` 秒传恢复（initMultiUpload → commitMultiUploadFile）
 *   - `player.ts`  播放链路（秒传恢复 + 取直链 + Cache API 缓存）
 */

export * from "./format"
export * from "./restore"
export * from "./player"
