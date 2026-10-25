/**
 * 把单文件移动端页面读进来，注入两个启动常量；另外负责读立绘。
 *
 * 页面之所以放独立 .html 而不是塞进 JS 模板字符串：省掉满屏的反引号和 ${} 转义，
 * 编辑器也能正常高亮。对外仍然是一个文件。
 */
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, extname, isAbsolute, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE_PATH = join(HERE, 'page.html')
const ART_DIR = join(HERE, 'art')
// 插件就在仓库里，`lib/` 的上一级即项目根——正文里写相对路径（如 dsh-image-gen/a.png）时按它找。
const PROJECT_ROOT = join(HERE, '..')

let template = null

export function renderPage({ defaultMode = 'minimal', needsToken = false, build = '', maxUpload = 0 } = {}) {
  if (template === null) template = readFileSync(PAGE_PATH, 'utf8')
  return template
    // 三种显示模式都认（单帧/聊天/完整）；不认识的值一律回落单帧——回落要卡在这一处，
    // 各处自己挑认哪几个，迟早出现「存得进去、刷新就变回去」的对不上。
    .replace('__DEFAULT_MODE__', ['chat', 'full'].includes(defaultMode) ? defaultMode : 'minimal')
    .replace('__NEEDS_TOKEN__', needsToken ? 'true' : 'false')
    // 立绘地址带上构建指纹（页面自己拼 ?v=__BUILD__），换了图浏览器就不会一直
    // 拿缓存里那张。只留字母数字，别让它有机会往 HTML 里塞东西。
    .replace('__BUILD__', String(build).replace(/[^a-zA-Z0-9]/g, ''))
    // 上传的体积上限由服务端注入，页面里不再写第二份。两处各写一个数迟早会不一致，
    // 而那时候的表现是「页面让你传，服务端拒绝」——最难查的那种不一致。
    .replace('__MAX_UPLOAD__', String(Number(maxUpload) > 0 ? Math.floor(maxUpload) : 0))
}

/**
 * 这条通道能发的类型。
 *
 * 原来只认 `.webp`。放开到 png，是因为正文里写的图往往就是 png，而这条通道还被
 * 「裸文件名」那种写法用着（见 page.html 的 `imageSrc`）。
 * **svg 一律不发**：SVG 里可以带 `<script>`，同源发出去等于给了它一段执行环境。
 * 类型由扩展名决定，同时也决定放不放行——别的后缀一概不发。
 */
const ART_TYPES = {
  '.webp': 'image/webp',
  '.png': 'image/png',
}

/** 文件名长这样：work-3-typing.webp / shot-1.png。 */
const ART_NAME = /^[a-z0-9-]+\.(webp|png)$/

/**
 * 「执行面板上有没有立绘」——没有就返回 null。
 *
 * 这是**给以后留的位置**，现在目录里没有图，所以恒为 null、界面上一像素都不占。
 * 要启用：把一张角色图命名成 `mascot.webp`（或 .png）丢进 `lib/art/`，重启 DSH。
 * 页面会把它摆在「正在执行」的气泡左边，宽度 96px；不想用了把文件删掉即可。
 *
 * 只用固定名字而不是扫描目录：这条路要稳定、可预测，不该因为目录里多了一个
 * 备用图就换一张脸。
 */
const MASCOT_CANDIDATES = ['mascot.webp', 'mascot.png']
export function artFileName() {
  for (const name of MASCOT_CANDIDATES) {
    try {
      if (statSync(join(ART_DIR, name)).isFile()) return name
    } catch {
      // 没有就试下一个
    }
  }
  return null
}

/**
 * 读一张按名字引用的图，读不到返回 null，读到了返回 `{ buf, type }`。
 *
 * 名字用白名单卡死形状——不能只靠调用方过滤。这是唯一一处把请求里的字符串
 * 拼进文件路径的地方，`../` 这类穿越必须在这里就堵死。
 */
export function readArt(name) {
  if (typeof name !== 'string' || !ART_NAME.test(name)) return null
  const type = ART_TYPES[name.slice(name.lastIndexOf('.')).toLowerCase()]
  if (!type) return null
  try {
    return { buf: readFileSync(join(ART_DIR, name)), type }
  } catch {
    return null
  }
}

/** 这条通道只发图片：扩展名决定 Content-Type，也决定放不放行。别的类型一概不发。 */
const IMAGE_TYPES = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
}

const IMAGE_MAX = 20 * 1024 * 1024

/**
 * 读正文里直接写了一张图的位置时要发的那张图（`![](dsh-image-gen/a.png)` 这种）。
 *
 * 和立绘不一样，这条路上**没有文件名白名单**——正文里写的可以是电脑上任何一张图。
 * 卡的是两点：**只发图片类型**（不然这条通道就成了读文件的口子），以及**体积**。
 * 路径原样按系统解析；相对路径先试项目根、再试 lib/art，都没有就当读不到。
 *
 * 2026-09-28 之前这里只认"把图拷进 lib/art 并写裸名字"一种写法，正文里写全路径就成了
 * 破图标——用户第三次为此来问，这是那时的放宽。
 *
 * `extraRoots`（2026-09-28 追加）是「额外候选根」，由调用方给——服务那边传的是**当前已
 * 注册的工作区目录**。理由：正文里的相对路径相对的是**那段对话的工作目录**，而它可能
 * 是别的项目（实测出图那段对话在 I:\DSH\dsh-jev-ultrafast，正文写 `scratch/x.png`），
 * 插件只按自己的两个根找就会 404，手机上正是那张破图。这里只放宽"在哪找"：
 * 能发什么、发多大、要不要令牌，全都没动。相对写法里带 `..` 一律拒绝——要跨目录，
 * 正文里写绝对路径，那本来就是支持的写法。
 */
export function readImage(raw, extraRoots = []) {
  if (typeof raw !== 'string') return null
  const p = raw.trim()
  if (!p || p.length > 4096 || p.includes('\0')) return null
  const type = IMAGE_TYPES[extname(p).toLowerCase()]
  if (!type) return null
  const abs = isAbsolute(p)
  const roots = Array.isArray(extraRoots) ? extraRoots : []
  if (!abs && p.split(/[\\/]/).includes('..')) return null
  const candidates = abs
    ? [p]
    : [p, join(PROJECT_ROOT, p), join(ART_DIR, p), ...roots.filter((r) => typeof r === 'string' && r).map((r) => join(r, p))]
  for (const file of candidates) {
    try {
      if (statSync(file).size > IMAGE_MAX) continue
      return { buf: readFileSync(file), type }
    } catch {
      // 这个位置没有，试下一个。
    }
  }
  return null
}

const SW_PATH = join(HERE, 'sw.js')

let sw = null

/**
 * 读 service worker 的源码，读不到返回 null。
 *
 * 和 page.html 一样，启动时读一次进内存。**改了它要重启 DSH**——理由和 page.html
 * 完全相同：服务器手里那份是启动时读的，不重启就还是旧的。
 */
export function readSw() {
  if (sw === null) {
    try {
      sw = readFileSync(SW_PATH, 'utf8')
    } catch {
      sw = ''
    }
  }
  return sw || null
}
