/**
 * 会话的「最近一次对话时间」索引。
 *
 * 为什么要自己做：手机上排序要按**最近一次对话**排，而不是创建时间——
 * 一个三天前建的会话如果刚刚还在跑，就应该排在最前面。但 DSH 的
 * `SessionHeader` 里只有 `createdAt`，**没有** updatedAt / lastActivityAt
 * 这类字段（扒过 `dsh-session` 的 .ts，确认没有）。
 *
 * 真相在文件系统上：每次往会话里写事件，`session.*.jsonl.zstd` 的 mtime
 * 都会刷新。所以「最后一次对话是什么时候」≈「日志文件最后一次被写是什么时候」。
 * 用 mtime 有三个好处：零成本（一次 stat，不用解压任何东西）、跨重启依然准确
 * （不依赖插件在线时见过的东西）、跑着的会话天然排最前（它一直在被写）。
 *
 * 结构：`~/.dsh/sessions/<工作区 slug>/<会话 id>/session.*.jsonl.zstd`。
 * 一次 refresh 扫两层目录 + 每个会话一次 stat；整台机器几百个会话也就
 * 几百次 stat，微秒级。加 5 秒 TTL——导航刷新来得很密，没必要每次都扫。
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const TTL_MS = 5000

export function createActivityIndex() {
  let map = null
  let at = 0

  function refresh() {
    map = new Map()
    const root = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
    let slugs
    try {
      slugs = readdirSync(root, { withFileTypes: true })
    } catch {
      // 目录还不存在（新装、或 DSH_HOME 没配）——空索引，排序退回 createdAt。
      at = Date.now()
      return
    }
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue
      const wsDir = join(root, slug.name)
      let entries
      try {
        entries = readdirSync(wsDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue
        const sDir = join(wsDir, ent.name)
        let files
        try {
          files = readdirSync(sDir)
        } catch {
          continue
        }
        let newest = 0
        for (const f of files) {
          if (!f.startsWith('session.') || !f.endsWith('.jsonl.zstd')) continue
          try {
            const m = statSync(join(sDir, f)).mtimeMs
            if (m > newest) newest = m
          } catch {
            // 单个文件 stat 失败（正在被写、权限抖动）——别的帧/别的文件还有机会。
          }
        }
        if (newest) map.set(ent.name, newest)
      }
    }
    at = Date.now()
  }

  function ensure() {
    if (!map || Date.now() - at > TTL_MS) refresh()
  }

  return {
    /**
     * 某个会话最近一次被写是什么时候（ms）。
     * 没扫到（没有日志文件、或还没落过盘）返回 0 —— 调用方应退回 createdAt。
     */
    at(id) {
      ensure()
      return map?.get(String(id)) ?? 0
    },
    /** 强制重扫。测试用；正常路径靠 TTL。 */
    refresh,
  }
}
