/**
 * DSH 极简移动端遥控器 —— 插件端入口。
 *
 * 设计上的三个「不」：
 *   - 不代理 DSH 桌面界面（那是 dsh-pocket 的做法），手机只拿两样东西：
 *     用户发出的指令 + Agent 的最终回复。
 *   - 不监听 waterfall 事件。只订阅纯 emit 事件，避免误吞 agent 的默认行为。
 *   - 不 import 任何 @deepseek-ai/* 的运行时值，只有一个例外：@deepseek-ai/schemastery。
 *     它只用来声明 Config（见下面 export const Config）——DSH 0.1.7 起，只有把字段标成
 *     volatile，改它才不需要重载插件，而声明 schema 绕不开 schemastery。它由宿主提供
 *     （写进 peerDependencies、不进 dependencies，免得出现第二份副本）。
 *     其余照旧：事件契约已经用 .d.ts 核实，消息对象自己造（MessageId 的 brand 在运行时
 *     是恒等函数、不做校验），插件加载期几乎没有外部依赖，也没有 cordis 双副本的坑。
 *
 * 事件契约（DSH 0.1.5-rc.2 实测）：
 *   session/event(session, event)  event = { type, seq, time, data }
 *     ├─ turn/start        data { turn }
 *     ├─ user/message      data UserMessage（source.kind === 'user' 才是人发的）
 *     ├─ assistant/message data { turn, step, message, stream, usage? }
 *     └─ turn/end          data { turn, reason: { kind } }
 *   agent/status({ agent, status })  status ∈ 'idle' | 'running'
 */
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'

import z from '@deepseek-ai/schemastery'

import { createStore } from './store.js'
import { artFileName } from './page.js'
import { createTurnTracker, visibleText, stepSelfTalk, looksLikeToolMarkup } from './events.js'
import { replayHistory, lastReply } from './history.js'
import { createTrajectoryTracker, replayTrajectory, capTrajectory } from './trajectory.js'

/**
 * Agent 模式（内置四档）的中文词条。**照抄 PC 的词条表**（dsh-client-ui-agent-preset
 * 里的 presetStandardName / presetStandardDescription 等八个键），一个字不改。
 * 自建模式不进这张表——PC 的政策原话是「不翻译用户自造的名字」。
 */
const AGENT_MODE_COPY = {
  standard: ['标准模式', '处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。'],
  ptc: ['PTC 模式', '包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。'],
  minimal: ['极简模式', 'Agent 仅使用终端工具完成任务，适合测试和对比其基础表现。'],
  cordis: ['创造模式', '用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。'],
}
import { readTailEvents, findSessionLog } from './log-tail.js'
import {
  parseSlashLine, describeCommands, commandRow, commandPatch,
  invalidCommandMessage, unknownCommandMessage,
} from './commands.js'
import { createMiniServer, miniControl, sendJson, readBody } from './server.js'
import { createMirror } from './mirror.js'
import { sendExternalNotification } from './notify.js'
import { reachableAddresses, resolveBindAddresses, isLocalRequest } from './net.js'
import { buildPairing, tunnelUrlFor, tunnelProbeVerdict } from './pairing.js'
import { ensureCloudflared } from './cloudflared.js'
import { startTunnel, startNamedTunnel, TUNNEL_HINT } from './tunnel.js'
import { provision as provisionNamedTunnel, normalizeHostname, describeProvisionError, listZones, verifyToken } from './cloudflare.js'
import { listWorkspaces, listSessionsOf, createSessionIn, createWorkspaceAt, allSessionIdsOf } from './tree.js'
import { createTitleCache } from './title-cache.js'
import { createSessionMetaCache } from './session-meta-cache.js'
import { createSubagentCache } from './subagent-cache.js'
import { listRoots, listDirectory, makeDirectory } from './browse.js'
import { listPresets, setPreset, available as presetsAvailable } from './permissions.js'
import { buildId } from './build.js'

export const name = 'dsh-remote-lite'
// `sessionController` 是 DSH 的宿主会话业务接口（`@deepseek-ai/dsh-api-session-controller`
// 挂上 Context 的那个），手机端要改每个会话的模型和思考强度就得靠它。
//
// **这一行单独加是有意的**：注入清单里写错名字不会报错，它会安静地让整个插件不加载——
// 那就不是一行功能坏了，是整个遥控器起不来。所以先只加这行、重启，确认插件还活着，
// 再往上加功能。真出问题也一眼知道是哪儿。
export const inject = ['agents', 'sessionController']

/** 公网隧道起不来时重试几次——向 Cloudflare 注册会偶发超时，实测大约一半概率。 */
const TUNNEL_ATTEMPTS = 3

/**
 * 手机上最多同时挂着几个「传了但还没发出去」的文件。
 *
 * 传完到按下发送之间，那张小票得留在内存里。要是用户传了却不发，这些引用就会一直
 * 挂着。20 是个宽松的上限——同时挂二十个待发文件不现实，而超了就淘汰最早的。
 */
const MAX_PENDING_UPLOADS = 20

/**
 * 这份代码的构建指纹，加载时算一次。
 * 用来回答「现在应答我的进程，跑的是不是我改的这份代码」——重启期间旧进程还在
 * 应答，「以为在验新代码其实在验旧的」已经踩过两次。
 */
const BUILD = buildId()

const DEFAULTS = {
  port: 3090,
  /**
   * 'auto' = 自动挑出内网地址监听，本机也留着（配对页要在电脑上打得开）。
   * 这样手机在家连 Wi-Fi 就能用，而 WSL 之类的虚拟网卡不开门。
   * 也可以填 '127.0.0.1'（只有本机）或具体某个 IP。
   */
  bindAddress: 'auto',
  /**
   * 公网访问：用 cloudflared 隧道，让手机在出门时也能连进来。
   *
   * 默认关。开了等于把这个服务挂到公网上——虽然有密码和限速挡着，但那是用户
   * 自己的安全边界，该由他自己决定，不能替他默认打开。
   *
   * 只有两条路：局域网和它。局域网那条一直都在，这条解决「出门怎么连」。
   */
  tunnel: {
    enabled: false,
    /**
     * 走哪条出口：
     *   'quick' —— 免账号的快速隧道（trycloudflare），地址**每次重启都换**；
     *   'named' —— 固定隧道：用户自己的域名 + Cloudflare 账号，地址钉死不变。
     *
     * 默认仍是 quick：固定隧道要用户先去 Cloudflare 建一个 API Token，
     * 不能替他默认选一条「先得注册账号」的路。
     */
    mode: 'quick',
    /** 留空 = 自动找（系统 PATH → dsh-pocket 下过的那份 → 自己下载） */
    cloudflaredPath: '',
    /** 固定隧道：要暴露的完整域名，例如 dsh.example.com */
    hostname: '',
    /** 固定隧道：Cloudflare Account ID。留空 = 用 API Token 能看见的账号（只有一个时才自动用） */
    accountId: '',
    /** 固定隧道：Cloudflare API Token（建隧道、写 ingress、建 DNS 都用它） */
    apiToken: '',
    /** 固定隧道：自动建出来/复用到的隧道 id，落盘之后重启就不用再走 API */
    tunnelId: '',
    /** 固定隧道：运行令牌（cloudflared 用的那个，权限只到这一条隧道） */
    tunnelToken: '',
  },
  token: '', // 留空 = 首次启动自动生成 32 位 hex 并落盘
  maxHistory: 50,
  defaultMode: 'minimal',
  notify: {
    enabled: false,
    channel: 'none', // none | bark | ntfy | telegram
    barkUrl: '',
    ntfyUrl: 'https://ntfy.sh',
    ntfyTopic: '',
    telegramBotToken: '',
    telegramChatId: '',
    onlyWhenBackground: true,
    maxLength: 200,
    sound: 'default',
  },
}

/**
 * 给 schema 标上 volatile（"改了不用重载"）。
 *
 * 为什么要绕这一层判断：`.volatile()` 是 schemastery **3.18.3** 才加的方法，3.18.1／3.18.2
 * 都没有。DSH 0.1.5 声明的依赖范围是 `^3.18.2`，是可以落到没有它的那一版上的——那种环境下
 * 直接写 `.volatile()` 会在**加载插件的那一刻**抛异常，整个插件起不来，手机上什么都没有。
 * 这个插件一贯的做法是"少了哪样就关掉哪一块，不整个倒下"，所以这里降级处理：没有这个方法
 * 就原样返回，插件照常可用，只是少了"改配置不用重载"这一条（`liveConfig` 那边也会因此
 * 认不出 volatile 字段，读到的就是普通值，行为与从前一致）。
 */
export function markVolatile(schema) {
  return typeof schema?.volatile === 'function' ? schema.volatile() : schema
}

/**
 * 插件设置的标准声明（DSH 0.1.7 起的做法）。宿主拿它校验 profile 补丁给我们的 config，
 * 设置页那条编辑通道也按它生成表单——**只有标了 volatile 的字段才会出现在那张表单里**。
 *
 * **为什么一个 .default() 都没有**：schema 里的默认值会被 Loader 落进 config，而我们的
 * 合并顺序是 `DEFAULTS < settings.json < config`——那样一来 schema 默认值就会盖住用户存在
 * settings.json 里的值。留空即 undefined，deepMerge 会跳过 undefined，内置默认值照旧只在
 * 下面 DEFAULTS 写一处。
 *
 * **为什么只有两个字段标 .volatile()**：标了就是承诺「改它不用重载插件」，而承诺得在代码里
 * 兑现——这类字段必须用的时候现读（见 liveConfig）。端口和绑定地址要重新监听、隧道要重建、
 * 口令的真相在 token 文件和手机页面的改密入口，这些改完确实要重建插件，就不标：DSH 会替我们
 * 重载，那才是实话。宁可少标，不能乱标。
 */
export const Config = z.object({
  port: z.number().description('手机上打开的那个端口。改了要重载插件（得重新监听）。'),
  bindAddress: z.string().description("监听哪个地址：'auto'、'127.0.0.1' 或具体某个 IP。改了要重载插件。"),
  tunnel: z.object({
    enabled: z.boolean(),
    mode: z.string().description("'quick' = 免账号的快速隧道（地址每次重启都换）；'named' = 固定域名隧道（自己的域名 + Cloudflare 账号）。改了要重载插件。"),
    cloudflaredPath: z.string(),
    hostname: z.string().description('固定隧道要用的域名，例如 dsh.example.com。改了要重载插件。'),
    accountId: z.string().description('Cloudflare Account ID。留空 = 用 API Token 能看见的账号。'),
    apiToken: z.string().role('secret').description('Cloudflare API Token（Cloudflare Tunnel:编辑 + DNS:编辑 + 区域:读取）。'),
    tunnelId: z.string().description('自动建出来的隧道 id，由插件自己写，不用手填。'),
    tunnelToken: z.string().role('secret').description('隧道运行令牌，由插件自己写（或者你从后台粘进来）。'),
  }).description('公网隧道（cloudflared）：快速隧道或固定域名隧道。改了要重载插件。'),
  token: z.string().role('secret')
    .description('访问口令。留空 = 首次启动自动生成；改口令用手机页面上的改密入口，改完要重载插件。'),
  maxHistory: z.number().description('手机端每个会话保留多少条历史。改了要重载插件。'),
  defaultMode: markVolatile(z.string())
    .description("手机打开时默认进哪个模式：'minimal' 或 'chat'。改了立即生效，不用重载。"),
  notify: markVolatile(z.object({
    enabled: z.boolean(),
    channel: z.string(),
    barkUrl: z.string(),
    ntfyUrl: z.string(),
    ntfyTopic: z.string(),
    telegramBotToken: z.string().role('secret'),
    telegramChatId: z.string(),
    onlyWhenBackground: z.boolean(),
    maxLength: z.number(),
    sound: z.string(),
  })).description('外部推送（Bark / ntfy / Telegram）。改了立即生效，不用重载。'),
})

function deepMerge(base, ...overrides) {
  const out = { ...base }
  for (const patch of overrides) {
    if (!patch || typeof patch !== 'object') continue
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      out[key] = value && typeof value === 'object' && !Array.isArray(value)
        ? deepMerge(out[key] ?? {}, value)
        : value
    }
  }
  return out
}

function dataDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const current = join(home, 'dsh-remote-lite')
  const previous = join(home, 'dsh-mini' + '-remote-lite')
  // 沿用旧数据目录：用户已经配对好的设置、隧道令牌、历史缓存都在里面，
  // 换个目录名就把它们全丢了。
  try {
    if (!existsSync(current) && existsSync(previous)) return previous
  } catch {
    // 判断失败就按新目录走
  }
  return current
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 首次启动生成一个 32 位 hex 的 token 并落盘，之后一直复用。 */
function loadOrCreateToken(dir, configured) {
  if (configured) return configured
  const file = join(dir, 'token')
  const existing = (() => {
    try { return readFileSync(file, 'utf8').trim() } catch { return '' }
  })()
  if (existing) return existing
  const token = randomBytes(16).toString('hex')
  writeFileSync(file, token, { mode: 0o600 })
  return token
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/**
 * 造一条用户消息。等价于 @deepseek-ai/dsh-llm 的 createUserMessage：
 *   createMessage = deepFreeze(structuredClone({ ...input, id: brandString(randomUUID()) }))
 * 而 MessageId 的 brand 在运行时不做任何校验（见 dsh-llm/lib/types/brand.d.ts）。
 *
 * `files` 是手机传上来的附件引用（`FileAttachmentRef`，原样来自 DSH 的附件服务，
 * 绝不自己构造——那个结构里有文件名消毒和引用校验，手搓会在校验上失败）。
 * 消息的 content 是块数组，附件就是其中一种块（`{type:'file', attachment}`）；
 * DSH 在发请求前会自动把它换成一段带路径的提示文字，模型靠自己的文件工具去读。
 */
function userMessage(text, files = []) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      ...files.map((attachment) => ({ type: 'file', attachment })),
    ],
    source: { kind: 'user' },
  })
}

/**
 * 把标了 volatile 的配置字段接到 settings 上：读的时候现取，不在加载时抄一份。
 *
 * 为什么必须现取：DSH 对 volatile 字段的处理是「就地提交、不重建插件」——它只把新值写进那个
 * 引用里，再 emit 一次 loader/volatile-update。要是我们加载时抄了一份，就地更新就永远看不见，
 * 那这个声明比不声明更糟：DSH 不再重载我们，而我们手里还是旧值。
 *
 * 取值仍沿用原来的合并顺序：config 里显式写了就用 config（undefined 算没写），没写就用
 * settings.json / 内置默认值那一路（`localBase` 那一份，不能拿合并了 config 的那份，
 * 否则会把 volatile 的引用对象自己也当成"本地值"）。
 */
function liveConfig(settings, config, localBase) {
  for (const [key, ref] of Object.entries(config ?? {})) {
    if (!Config.dict?.[key]?.meta?.volatile) continue
    if (!ref || typeof ref.get !== 'function') continue
    let local = localBase?.[key]
    Object.defineProperty(settings, key, {
      enumerable: true,
      configurable: true,
      get: () => (ref.get() === undefined ? local : ref.get()),
      set: (value) => { local = value },
    })
  }
}

export function apply(ctx, config = {}) {
  const dir = dataDir()
  mkdirSync(dir, { recursive: true })

  const settingsFile = join(dir, 'settings.json')
  const stored = readJson(settingsFile)
  // 两份来源分清楚：`local` 是"我们这份"（内置默认 + settings.json），`settings` 再叠上
  // profile 补丁给的 config。volatile 字段要拿 `local` 当兜底，所以基线单独留一份。
  const local = deepMerge(DEFAULTS, stored ?? {})
  const settings = deepMerge(local, config)
  // 标了 volatile 的字段改成"读的时候现取"（见 liveConfig）：这类字段改了不用重载插件。
  liveConfig(settings, config, local)

  // 首次启动把默认配置落一份出来，用户才有东西可以改。
  if (stored === null) {
    // 0o600：这个文件里现在可能有 Cloudflare API Token 和隧道运行令牌，
    // 不该让同机器上的其他用户读走（Windows 上 mode 不起作用，那是平台的事）。
    writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
  }
  const token = loadOrCreateToken(dir, settings.token)
  const store = createStore({ file: join(dir, 'state.json'), maxHistory: settings.maxHistory })
  /**
   * 会话标题的落盘缓存（见 lib/title-cache.js）。
   *
   * 放在插件自己的数据目录里，和 token / settings.json / state.json 并排——
   * 那是这个插件唯一的"自己的地方"，DSH 升级、插件重装都不动它。
   * 为什么值得单独落一份：读一条标题要加载整份会话日志（本机 1.4 GB / 1419 个文件），
   * 而这件事**每重启一次就得重付一遍**——标题却是定下来基本不变的东西。
   */
  const titles = createTitleCache({ file: join(dir, 'titles.json') })
  const sessionMeta = createSessionMetaCache({ file: join(dir, 'session-meta.json') })
  const subagentCache = createSubagentCache({ file: join(dir, 'subagents.json') })
  const tracker = createTurnTracker()
  /**
   * 执行轨迹的累计器（「完整」模式要的过程区）。
   *
   * **和上面的 tracker 是两个人**：上面那个只认「用户说的话」和「最终回答」，轨迹那个
   * 认的是思考、工具调用、工具结果。分开的理由是它们服务的是**两种模式**——聊天模式的
   * 回答区里一个字的过程都不该有（2026-09-22 用户亲自否掉的），而完整模式要的就是过程。
   * 两条路共用的是同一批原始事件，不是同一份产出。
   */
  const trajectory = createTrajectoryTracker()
  // 队列的真相在 agent 的收件箱里，store 拿不到 ctx，所以给它一个回调去问。
  // 不缓存、每次取快照现读：没有第二份状态，也就不会和电脑上不一致。
  store.setQueueSource(queuedOf)

  /**
   * 输出一律走 console。
   *
   * 原因一：真机上 cordis logger 的 info 不会出现在 stdout（只进它自己的 buffer /
   * 宿主侧通道），而「手机打开下面这条网址」这种话必须让用户当场看见。dsh-pocket、
   * dsh-cost-meter 也都是直接 console 打。
   *
   * 原因二（坑，别再踩）：真机上 `(ctx.logger?.warn ?? console.warn)(m)` 这种
   * 「先把方法取出来再裸调」的写法会抛 "this is not a function"——cordis 的 logger
   * 是 createCallable 造的可调用对象，warn 内部要 `this()` 把自己再当函数调一次，
   * this 一丢就崩。真要用 ctx.logger，必须保住接收者：`const l = ctx.logger;
   * l.warn(m)`。
   */
  const log = {
    info: (m) => console.log(`[dsh-remote-lite] ${m}`),
    warn: (m) => console.warn(`[dsh-remote-lite] ${m}`),
  }

  /** @type {Awaited<ReturnType<typeof createMiniServer>> | null} */
  let server = null

  /**
   * 服务起不来时的原因；null = 没出错。
   *
   * 有这个字段是为了把「还在启动」和「起不来了」分开说。原来两种情况都回一句
   * 「手机服务还在启动，过几秒刷新一下」——但失败之后那个 server 永远不会建好，
   * 用户会一直刷新，而且提示里没有半个字告诉他出了什么事。
   */
  let serverError = null

  /**
   * 手机传上来的文件：小票 id → DSH 的附件引用。
   *
   * 为什么中间要绕一张小票，而不是把附件 id 直接给手机：桌面端也是这么做的。
   * DSH 那边的原话是「一个线端调用者绝不能引用它没上传过的附件」——客户端能报什么
   * 就得由服务端说了算，否则改一个字符串就能让模型去读电脑上任意一个已有附件。
   * 表只在内存里，重启就清空，这也正合适。
   */
  const uploads = new Map()

  /** DSH 的附件服务；纯 headless 组合里没有它，所以是可选的。 */
  let attachments = null

  /**
   * DSH 的斜杠指令账本（`ctx.commands`）。同样是可选的：DSH 明说无界面的组合
   * 不提供这个面（headless / ACP 自动化），所以拿不到时就如实说「这台电脑上的
   * DSH 没提供指令」，而不是给手机一个空名单。
   */
  let commandService = null

  /**
   * DSH 的技能账本（`ctx.skills`）。同样按可选服务处理。
   *
   * 和指令的区别在于**谁执行**：斜杠指令由宿主直接执行、不产生模型消息；技能则是
   * 「把一段说明书塞进提示词，让模型照着做」。所以手机上要做的是**列出来、让用户挑**，
   * 然后把技能正文作为提示词的一部分发出去 —— 不新增任何模型侧协议，也就不新增延迟。
   *
   * 只列 `userInvocable` 的：那是 DSH 自己给「面向人的目录」定的开关，
   * 不认它就会把只给模型看的技能也摆到用户面前。
   */
  let skillService = null
  ctx.inject(['skills'], (skillCtx) => {
    skillService = skillCtx.skills
    console.log('[dsh-remote-lite] 技能服务已就绪：手机上可以选择技能')
  })

  /**
   * 手机端要的那份技能清单。
   *
   * 只取名字和描述 —— 正文可能有几十 KB，手机输入框的候选列表用不上，
   * 也绝不该为了一次「点开菜单」就把它们全传过去。正文按需拉（见 getSkill）。
   *
   * `list()` 是**异步**的（要跑一遍发现流程：扫目录、问各个 provider），所以这里
   * 也必须是 async —— 第一版漏了 await，拿回来的是 Promise，`.filter` 直接炸成
   * `all.filter is not a function`。
   */
  async function listSkills(cwd) {
    if (!skillService || typeof skillService.list !== 'function') {
      return { ok: false, reason: 'unavailable', skills: [] }
    }
    try {
      const all = (await skillService.list(cwd ? { cwd } : {})) ?? []
      const skills = all
        .filter((s) => s && s.name && s.invocation?.userInvocable !== false)
        .map((s) => ({
          name: s.name,
          description: s.description ?? '',
          whenToUse: s.whenToUse ?? '',
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
      return { ok: true, skills }
    } catch (err) {
      return { ok: false, reason: String(err?.message ?? err), skills: [] }
    }
  }

  /**
   * 取一份技能正文，供手机把它拼进提示词。
   *
   * `get()` 返回的是完整定义，正文在 `body` 上。拿不到就回 `null`，
   * 让调用方决定说什么 —— 不能静默当成空技能发出去，那会变成一条没有指令的
   * 空泛提示，模型只能瞎猜。
   */
  async function getSkill(name) {
    if (!skillService || typeof skillService.get !== 'function') return null
    const wanted = String(name ?? '').trim()
    if (!wanted) return null
    try {
      const def = await skillService.get(wanted)
      if (!def) return null
      return {
        name: def.name,
        description: def.description ?? '',
        body: String(def.body ?? '').trim(),
      }
    } catch {
      return null
    }
  }

  /**
   * 正在流出来的那一段。
   *
   * 手机上有一条硬要求：**显示的必须是最终回答，不能是中间步骤的旁白**
   * （2026-09-21 用户实机报的「回答过来的是思考过程」）。麻烦在于流式阶段拿不到
   * 完整内容，没法提前判断这一步最后会不会调工具——而模型调工具前几乎都会先写
   * 一句旁白。等工具调用出现时才知道它是旁白，那时候它已经流到屏幕上了。
   *
   * 前两版都试图用启发式绕开这一点（先是「连续流 1.2 秒」，后是「至少 40 个字」），
   * 结果都是同一个毛病：判据要到末尾才出现，启发式只能在边界上赌，赌赢了看不见流式、
   * 赌输了旁白闪一下。现在的做法见 STREAMING_ENABLED —— 不赌了，等这一步收尾再确认。
   */

  /**
   * 流式**开着**，但加了「事后确认」这道闸。
   *
   * 历史：2026-09-22 原用户裁决「流式的效果不好，先不做流式了吧，改回一次性把最终回答
   * 抛出来，过程中的自言自语、执行语句就不要在手机端出现了」。关掉的直接原因是旁白泄漏——
   * 模型在发起工具调用前会先写「我先看看这个文件」，流式一开头就把它推出去，
   * 等工具调用出现再撤回，用户看到的就是「闪现又消失」。当时的补丁是长度门槛
   * 加「出现工具调用就撤回」，按原作者的话是「勉强压着」。
   *
   * 现在改成**事后确认再推**，从根上消除闪现：
   *
   *   1. 文字照常开始流，但**先攒着不显示**（缓存在 `streaming.text`）。
   *   2. 一旦出现 `tool-call-delta`，这一步就是中间步骤 —— 直接丢弃缓存，全程零闪烁。
   *   3. 直到这一步**收尾（`end`）仍没有工具调用**，才确认它是最终回答；
   *      此时先把已攒下的整段补齐（立即露出来），然后才进入逐帧推送。
   *
   * 代价是首字延迟：要等这一步写完才能看到第一个字。这是「不闪烁」换来的，
   * 也是原用户真正在意的东西。相比之下，长度门槛那种启发式永远可能在边界上失手。
   */
  const STREAMING_ENABLED = true

  /**
   * 往外推的节奏。
   *
   * 模型一秒能吐几十个分片，原样转发会把 SSE 打爆，手机也会跟着抖。150 毫秒大约
   * 每秒 7 帧，肉眼已经是连续的，而推送量降到十分之一以下。
   */
  const STREAM_PUSH_MS = 150

  /** @type {{ text: string, shown: boolean, timer: NodeJS.Timeout | null }} */
  const streaming = { text: '', shown: false, timer: null }
  let lastLivePush = 0
  /** 只报一次「事件送到了」，用来把「订阅没生效」和「后面某一步坏了」分开。 */
  let sawStreamEvent = false

  /** 正在流的那一段收工：停表、清干净、通知手机。 */
  function stopStreaming(sessionId) {
    if (streaming.timer) {
      clearTimeout(streaming.timer)
      streaming.timer = null
    }
    streaming.text = ''
    streaming.shown = false
    store.setLive(sessionId, '')
    server?.broadcast('state', store.snapshot())
  }

  /**
   * 丢掉当前这段缓存，**但不碰屏幕上已经显示的内容**。
   *
   * 和 stopStreaming 的区别就是这一点：事后确认模式下，被判为中间步骤的那一步
   * 从头到尾没露过脸，所以只需要把内存里的字清掉。而 stopStreaming 会把
   * `store.setLive('')` 推下去——如果这时屏幕上正显示着**上一步**的最终回答，
   * 那一下刷新会把那段擦掉，用户看到的就是「回答突然消失」。
   */
  function discardStreaming() {
    if (streaming.timer) {
      clearTimeout(streaming.timer)
      streaming.timer = null
    }
    streaming.text = ''
    streaming.shown = false
  }

  /** 公网隧道；null = 没开。 */
  let tunnel = null
  /** 用户是不是**希望**隧道开着——用来区分「我们自己关的」和「它自己断了」。 */
  let tunnelWanted = false
  let tunnelStarting = false
  let tunnelError = null
  /**
   * 固定隧道的 DNS 那一步结果：`'ok'` / `'manual'`（要用户自己去后台加一条 CNAME）/ null。
   *
   * 为什么要单独记：DNS 是**软失败**（见 lib/cloudflare.js 的 ensureDns）——隧道本身
   * 已经起来了，只是域名还指不过来。这种半成功状态必须如实说，否则用户会看着
   * 「已连接」的绿灯，然后在手机上打开一个 404。
   */
  let namedDns = null

  /** 现在用的是哪条公网出口。 */
  function tunnelMode() {
    return settings.tunnel?.mode === 'named' ? 'named' : 'quick'
  }
  /**
   * 公网隧道到底通不通。
   *
   * **cloudflared 打印出网址 ≠ 隧道能用。** 2026-09-22 实测遇到：进程好好活着，但它到
   * Cloudflare 边缘的连接已经断了（一条 ESTABLISHED 都没有），Cloudflare 那边没人应答，
   * 手机打开就是 Error 1033——而插件只认「网址打印出来了」，面板上照样写着「已开启」。
   * 用户就是照着一个写着「已开启」的面板去扫码的。
   *
   * 原来的代码只在 cloudflared **退出**时报错（见下面的 onExit）。它不退出，就永远发现不了。
   * 所以补一道：网址有了之后隔一会儿真去打一次，只有打得到才算通。
   *
   * `null` = 还不知道（刚起来，还没公布出去）。连不上两次才判死——第一次很可能是太早。
   */
  let tunnelHealthy = null
  let tunnelProbeTimer = null
  let tunnelProbeFails = 0
  const TUNNEL_PROBE_MS = 30000
  const TUNNEL_PROBE_TIMEOUT_MS = 8000
  const TUNNEL_PROBE_FAILS = 2

  /** 手机当前该看哪个会话：用户绑定的优先，没绑过才退回最近活跃的。 */
  function targetSessionId() {
    // 绑定了就认绑定，不再看「谁最近活跃」——否则你在电脑上另开一个会话，
    // 手机上的内容就被悄悄换掉了。绑定的会话如果真的没了，
    // 发指令时会明确提示「这个会话已经结束了」。
    if (store.state.boundSessionId) return store.state.boundSessionId
    const recent = store.mostRecentSession()
    if (recent) return recent.id
    // 还没从事件流里见过任何会话（插件是热加载进来的，或者会话早就开着了），
    // 就退回问 agent 注册表要一个——否则手机会莫名其妙地「没有可遥控的会话」。
    const live = ctx.agents.list().filter((a) => a.session?.header?.origin !== 'subagent')
    return live[0]?.session?.id ?? null
  }

  function broadcastStatus() {
    const id = targetSessionId()
    const running = id ? (store.sessions.get(id)?.running ?? false) : false
    server?.broadcast('status', { running })
  }

  // ------------------------------------------------------------------
  // 公网访问（cloudflared 快速隧道）
  // ------------------------------------------------------------------
  /**
   * 当前公网域名，没开隧道时 null。只给限速分桶用（见 lib/server.js 的 clientKey）。
   *
   * 固定隧道要**从配置里取**域名，不能从 `tunnel.url` 里现解：那条 url 是我们自己拼的
   * `https://<hostname>`，解出来一样，但万一哪天拼法变了，限速分桶会悄悄退化成
   * 「所有请求都算 127.0.0.1」——那种退化不报错，只是任何人错 5 次密码就把你自己锁在门外。
   */
  function tunnelHost() {
    if (!tunnel) return null
    if (tunnelMode() === 'named') {
      const host = String(settings.tunnel?.hostname ?? '').trim().toLowerCase()
      if (host) return host
    }
    try {
      return new URL(tunnel.url).hostname
    } catch {
      return null
    }
  }

  /** 把 settings 里隧道相关的状态回写，用户在设置页点了开关要能持久化。 */
  function persistSettings() {
    try {
      // 和首次落盘同一条规矩：这个文件里有 API Token / 隧道令牌 / 口令，
      // 0o600 是它该有的权限。
      writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
    } catch (err) {
      log.warn(`配置写不进去：${err?.message ?? err}`)
    }
  }

  /**
   * 开公网访问。两条出口共用一个入口：先备好 cloudflared，再按当前模式分岔。
   *
   * 分岔放在**备好二进制之后**：两条路都要那个可执行文件，而它可能要下载 50MB。
   * 用户第一次开固定隧道时不该先等一次下载、再因为配置写错白等第二次。
   */
  async function bringTunnelUp() {
    if (tunnel || tunnelStarting || !server) return
    const mode = tunnelMode()
    tunnelStarting = true
    tunnelError = null
    tunnelWanted = true
    try {
      const found = await ensureCloudflared({
        configuredPath: settings.tunnel?.cloudflaredPath,
        dataDir: dir,
        log,
      })
      if (!found.path) {
        tunnelError = found.error
        log.warn(`公网访问没起来：${found.error}`)
        return
      }
      if (found.source === 'downloaded') log.info('cloudflared 准备好了。')

      if (mode === 'named') await openNamedTunnel(found.path)
      else await openQuickTunnel(found.path)
    } catch (err) {
      tunnelError = err?.message ?? String(err)
      log.warn(`公网访问没起来：${tunnelError}`)
    } finally {
      tunnelStarting = false
    }
  }

  /** 快速隧道：等它打印出那个 trycloudflare 网址，然后开始探活。 */
  async function openQuickTunnel(binPath) {
    // 实测向 api.trycloudflare.com 注册会偶发超时（大约一半的概率），
    // cloudflared 碰到就直接退出码 1 结束。这是对方网络的问题，不是配置错了，
    // 所以重试几次——否则用户会以为是自己哪里没弄对。
    let lastError = null
    for (let attempt = 1; attempt <= TUNNEL_ATTEMPTS; attempt += 1) {
      try {
        const handle = await startTunnel({ binPath, port: server.port, log })
        tunnel = handle
        log.info(`公网访问已开：${handle.url}`)
        log.info('这个地址每次重启 DSH 都会换一个，换了之后到设置页重新扫一下码。')
        // 拿到网址只是「它说它开了」，从这里开始盯它是不是真的通。
        startTunnelProbe(handle.url)
        handle.onExit((code) => {
          stopTunnelProbe()
          if (tunnel !== handle) return
          tunnel = null
          tunnelHealthy = null
          // 我们自己关的不算故障
          if (!tunnelWanted) return
          tunnelError = `隧道断了（cloudflared 退出码 ${code}），公网那边暂时连不上。\n\n${TUNNEL_HINT}`
          log.warn(tunnelError)
        })
        return
      } catch (err) {
        lastError = err
        if (attempt < TUNNEL_ATTEMPTS) {
          log.warn(`第 ${attempt} 次没起来，再试一次…`)
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
      }
    }
    tunnelError = `${TUNNEL_ATTEMPTS} 次都没起来。${lastError?.message ?? lastError}\n\n${TUNNEL_HINT}`
    log.warn(`公网访问没起来：${tunnelError}`)
  }

  /**
   * 固定隧道：先保证手上有一个运行令牌（没有就现场用 API Token 建一条），再连。
   *
   * 这里有个刻意的顺序：**建隧道（API）和跑隧道（cloudflared）分成两段**。
   * 前者失败是配置问题（令牌权限、域名不在账号下、DNS 冲突），报错要精确到哪一步；
   * 后者失败是网络问题，重试有意义。混在一起重试只会让「权限不对」也白等 3 次。
   */
  async function openNamedTunnel(binPath) {
    const cfg = settings.tunnel ?? {}
    const host = String(cfg.hostname ?? '').trim().toLowerCase()
    if (!host) {
      tunnelError = '固定隧道还差一个域名：到「设置 → 手机遥控 → 固定域名」里填上你自己的域名再开。'
      log.warn(tunnelError)
      return
    }

    let runToken = String(cfg.tunnelToken ?? '').trim()
    if (!runToken) {
      const apiToken = String(cfg.apiToken ?? '').trim()
      if (!apiToken) {
        tunnelError = '固定隧道还没配好：要么填 Cloudflare API Token（插件自动建隧道和 DNS），'
          + '要么把后台建好的隧道令牌直接粘进来。'
        log.warn(tunnelError)
        return
      }
      log.info('固定隧道：正在用 API Token 创建/复用隧道、写 ingress 和 DNS…')
      let got
      try {
        got = await provisionNamedTunnel({ apiToken, accountId: cfg.accountId, hostname: host, port: server.port, log })
      } catch (err) {
        // 这一步的错误是「下一步去改什么」，不是「再试一次」——所以不重试、直接说清楚。
        tunnelError = `固定隧道没配成：${describeProvisionError(err)}`
        log.warn(tunnelError)
        return
      }
      runToken = got.tunnelToken
      namedDns = got.dns?.ok ? 'ok' : 'manual'
      settings.tunnel = {
        ...settings.tunnel,
        accountId: got.accountId,
        tunnelId: got.tunnelId,
        tunnelToken: runToken,
      }
      persistSettings()
      log.info(`固定隧道已就绪：https://${host} → 隧道 ${got.tunnelId}（区域 ${got.zone}，DNS ${got.dns?.action}）`)
      if (!got.dns?.ok) {
        log.warn(`DNS 没自动配好（${got.dns?.error ?? '未知原因'}）。`
          + `去 Cloudflare 后台手动加一条 CNAME：${host} → ${got.dns?.cname}（代理开着），加完就能用。`)
      }
    }

    let lastError = null
    for (let attempt = 1; attempt <= TUNNEL_ATTEMPTS; attempt += 1) {
      try {
        const handle = await startNamedTunnel({ binPath, token: runToken, hostname: host, log })
        tunnel = handle
        log.info(`固定隧道已开：${handle.url}`)
        // 和快速隧道同一条判据：**它说连上了不算，打得到才算**。
        startTunnelProbe(handle.url)
        handle.onExit((code) => {
          stopTunnelProbe()
          if (tunnel !== handle) return
          tunnel = null
          tunnelHealthy = null
          if (!tunnelWanted) return
          tunnelError = `固定隧道断了（cloudflared 退出码 ${code}）。`
            + '令牌没变的话它一般会自己重连；一直断就回设置页重新保存一次，或者检查电脑上的代理/VPN。'
          log.warn(tunnelError)
        })
        return
      } catch (err) {
        lastError = err
        if (attempt < TUNNEL_ATTEMPTS) {
          log.warn(`第 ${attempt} 次没连上固定隧道，再试一次…`)
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
      }
    }
    tunnelError = `${TUNNEL_ATTEMPTS} 次都没连上固定隧道。${lastError?.message ?? lastError}`
    log.warn(tunnelError)
  }

  function bringTunnelDown() {
    tunnelWanted = false
    stopTunnelProbe()
    tunnelHealthy = null
    tunnel?.stop()
    tunnel = null
    tunnelError = null
    // DNS 那一步的结果只对「当前这条固定隧道」有意义，关掉就一起清掉——
    // 留着它会让下次换成快速隧道时，面板上还挂着一句「DNS 要手动加」的旧话。
    namedDns = null
  }

  function stopTunnelProbe() {
    if (tunnelProbeTimer) clearInterval(tunnelProbeTimer)
    tunnelProbeTimer = null
    tunnelProbeFails = 0
  }

  /**
   * 盯着隧道是不是真的通。
   *
   * 打的是自己那个版本接口：它够轻，而且**只有整条路都活着才会有 200**——
   * 从本机出去、经 Cloudflare、再回到本机的手机服务。任何一段断了都拿不到 200。
   */
  function startTunnelProbe(url) {
    stopTunnelProbe()
    tunnelHealthy = null
    const probe = async () => {
      try {
        const res = await fetch(`${url}/mini/api/version?token=${encodeURIComponent(token)}`, {
          signal: AbortSignal.timeout(TUNNEL_PROBE_TIMEOUT_MS),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        tunnelProbeFails = 0
        tunnelHealthy = true
        tunnelError = null
      } catch (err) {
        const code = err?.cause?.code ?? err?.code ?? ''
        // **域名解析不出来 ≠ 隧道坏了。**
        // 2026-09-22 实测：cloudflared 连着 3 条边缘连接、域名在 1.1.1.1 / 8.8.8.8 / 223.5.5.5
        // 上都解析得出、强制指到真实 IP 打过去是 200——可本机路由器（192.168.1.1）就是查不到
        // *.trycloudflare.com。这种时候**绝对不能判死**：手机在外面走的是运营商的 DNS，
        // 很可能好好的，把网址收回去反而让用户连地址都看不到。
        if (tunnelProbeVerdict(code) === 'dns') {
          tunnelError = '隧道本身是通的，但这台电脑解析不了这个域名。\n\n'
            + '多半是代理或路由器的问题。先试试关掉代理；还不行就在手机上换成流量，'
            + '或者把电脑的 DNS 改成 1.1.1.1。'
          log.warn(tunnelError)
          return
        }
        tunnelProbeFails += 1
        if (tunnelProbeFails < TUNNEL_PROBE_FAILS) return
        tunnelHealthy = false
        tunnelError = '公网隧道还开着，但已经连不上了：'
          + `${code || err?.message || err}。手机打开会看到 Cloudflare 的 Error 1033。\n\n${TUNNEL_HINT}`
        log.warn(tunnelError)
        // 判死之后就别再打了：结果不会变，白跑网络。
        stopTunnelProbe()
      }
    }
    tunnelProbeTimer = setInterval(probe, TUNNEL_PROBE_MS)
    // 这个定时器不该拖着进程不让它退出。
    if (tunnelProbeTimer.unref) tunnelProbeTimer.unref()
    probe()
  }

  function maybeNotify(text) {
    const notify = settings.notify
    if (!notify?.enabled) return
    // 手机页面正开着就靠页面自己的提示音，不用再发系统推送，免得响两次。
    if (notify.onlyWhenBackground !== false && store.isForeground()) return
    sendExternalNotification(notify, text).then((result) => {
      if (!result.ok && result.error !== 'disabled') {
        log.warn(`外部推送失败：${result.error}`)
      }
    })
  }

  // ------------------------------------------------------------------
  // 手机发来的指令 → 注入 DSH
  // ------------------------------------------------------------------

  /**
   * 手机发来的指令，我们自己已经记过一笔；它注入之后还会以 `user/message` 事件的
   * 形式回来一趟，事件流那一路会**再记一笔**——聊天模式里就成了同一条显示两次。
   *
   * 用消息 id 精确认出来，不靠「时间差不多、文字一样」这种猜法。
   */
  const injectedIds = new Set()
  const INJECTED_KEEP = 50

  function rememberInjected(id) {
    if (!id) return
    injectedIds.add(id)
    // Set 是插入序，超了就从最早的开始丢。手机发指令是人手速度，这点量足够了。
    while (injectedIds.size > INJECTED_KEEP) {
      injectedIds.delete(injectedIds.values().next().value)
    }
  }

  /**
   * 排队中的指令——真相在 agent 的收件箱里，这里只负责翻译成人话。
   *
   * `agent.inbox.nextTurn` 是「等着各自开一轮」的那些（`followup()` 排进去的），
   * `nextStep` 是「插到下一步」的那些（steering，手机端目前不产生，但电脑上可能有）。
   * 两个都列出来，手机上看到的队列才和电脑上一致。
   */
  function queuedOf(sessionId) {
    const agent = ctx.agents.get(sessionId)
    if (!agent?.inbox) return []
    const rows = []
    for (const [placement, list] of [['next-turn', agent.inbox.nextTurn], ['next-step', agent.inbox.nextStep]]) {
      for (const m of list ?? []) {
        rows.push({ id: m.id, text: visibleText(m.content), placement })
      }
    }
    return rows
  }

  /**
   * 把一个"睡着"的会话叫醒，拿回它的活动实例。
   *
   * **睡着不等于结束。** 用户 2026-09-28 实机踩到：手机上切到没在跑的会话，
   * 一发指令就被回「这个会话已经结束了」——可那个会话好端端躺在硬盘上。
   * 一个工作区常有上百个会话，真正"活着"的只有三两个（2026-09-25 查过：147 个里 3 个），
   * 而手机能选的偏偏是全部。所以这条路不是边角，是主路：**不修的话，手机只能发给
   * 那两三个正跑着的会话，其余全被这句错话挡回来。**
   *
   * DSH 自己给的就是 `sessionController.resolveAgent`，注释原话
   * 「Resolve **or resume** one ordinary Session」。它返回 `{agent}` 或 `{error}`，
   * 而 error 里区分三件事，**必须分开报**：
   *   - `session/not-found`：真没了（会话不存在），该让用户另选一个；
   *   - `session/agent-busy` / `session/writer-held`：正忙、或被写锁占着，等一会儿能成；
   *   - 其他（服务缺席、抛错）：叫不醒，如别说成"没了"。
   * 把"暂时叫不醒"也说成"已经结束了"，就是把用户支去重选一个其实还在的会话。
   */
  async function wakeSession(sessionId) {
    const controller = ctx.get('sessionController')
    if (typeof controller?.resolveAgent !== 'function') return { agent: null, reason: 'unavailable' }
    try {
      const res = await controller.resolveAgent(sessionId)
      if (res && res.agent) return { agent: res.agent, reason: null }
      return { agent: null, reason: (res && res.error && res.error.code) || 'unknown' }
    } catch (err) {
      return { agent: null, reason: 'threw', message: err && err.message ? err.message : String(err) }
    }
  }

  /** 叫不醒时该跟用户说的那句话（三种情况分开说）。 */
  function wakeFailureText(reason) {
    if (reason === 'session/not-found') return '这个会话已经不在了，请在手机上重新选一个会话。'
    if (reason === 'session/agent-busy' || reason === 'session/writer-held') {
      return '这个会话现在被电脑那边占着，等一会儿再发。'
    }
    return '这个会话现在叫不醒（电脑那边没答应），等一会儿再试。'
  }

  /**
   * 「繁忙时的发送行为」当前是哪个值——**发送那一刻现读，不缓存**。
   *
   * 为什么现读：这个值是**电脑端和手机端共用**的（就是 PC「设置 → 通用」里那一条），
   * 用户在电脑上改了我们这边不一定知道。发送是低频动作，读一次 describe() 不值几个钱，
   * 而缓存一份就会有「设置改了但发送还用老值」这种最难查的不一致。
   *
   * 读不到一律当 `queue`（排队）——那是 DSH 自己的默认值，也是最保守的那个：
   * 宁可多等一轮，也不要莫名其妙打断正在跑的一轮。
   */
  function busyEnterMode() {
    try {
      const settings = invServices.settings ?? ctx.get('settings')
      const doc = (settings?.describe?.() || []).find((d) => String(d?.ns ?? '') === 'ui-conversation')
      const value = doc?.value && typeof doc.value === 'object' ? doc.value : {}
      return value.busyEnter === 'steer' ? 'steer' : 'queue'
    } catch (err) {
      return 'queue'
    }
  }

  async function onInstruction(text, uploadIds) {
    const sessionId = targetSessionId()
    if (!sessionId) {
      return { ok: false, error: '电脑上还没有可遥控的会话，请先在 DSH 里开一个。' }
    }
    // 睡着的会话先叫醒（见 wakeSession）。**只有真没了才让用户另选一个。**
    let agent = ctx.agents.get(sessionId)
    if (!agent) {
      const woke = await wakeSession(sessionId)
      agent = woke.agent
      if (!agent) {
        console.log('[dsh-remote-lite] 手机上发指令：这个会话叫不醒（' + sessionId + '，原因 ' + woke.reason + '）')
        return { ok: false, error: wakeFailureText(woke.reason) }
      }
      console.log('[dsh-remote-lite] 手机上发指令：这个会话原本在睡着，已经把它叫起来了（' + sessionId + '）')
    }

    // 先把小票换成真正的附件引用。认不出来的小票会被丢掉——宁可当没传过，
    // 也不能让手机报什么就信什么。
    const files = takeUploads(uploadIds)
    if (!text && !files.length) {
      return { ok: false, error: '指令为空' }
    }

    /**
     * 跑着的时候**不再拒绝**，改成「排队」或「插话」——按设置里那一条走。
     *
     * 原来这里有一条 `agent.status === 'running'` 的挡板，回一句「上一个任务还在跑，
     * 等它完成再发」。那条挡板是多余的，而且**比 DSH 自己还严**：`followup()` 的
     * 语义本来就是「排队一个后续轮次并唤醒驱动」（dsh-agent 的类型注释原话：
     * "Queue an ordinary follow-up turn and wake the driver"），跑着的时候照样收，
     * 排进 inbox.nextTurn，等当前这一轮结束再跑。DSH 桌面端同一时刻就能接着排。
     *
     * **2026-10-06 补上真正的「插话」。** 原来这里只会 `followup()`——那是**永远排队**。
     * 手机设置里那条「繁忙时的发送行为」当时只做了开关、没接上线，所以选了插话也照样排队
     * （用户实机发现：「插话发送似乎没实现，依然是排队发生」）。
     *
     * 现在按设置分岔，两条都是 DSH 自己的接口（`dsh-agent` 的类型注释原文）：
     *   · `followup(message)` —— "Queue an ordinary follow-up turn and wake the driver"，
     *     进 inbox.nextTurn，等这一轮跑完；
     *   · `steer(message)` —— "Submit steering for the nearest step"，进 inbox.nextStep，
     *     跑着的驱动**在下一个步骤边界**就取走它（一个工具调用就是一个步骤，所以是秒级）。
     *
     * 两处刻意的保守：
     *   ① 只有**真在跑**（queued）才插话。不跑的时候没什么可插的，走正常发送；
     *   ② 老版本 DSH 上 `agent.steer` 可能不存在（它是后加的），所以要探一下类型——
     *      没有就退回排队，不能让一条指令发不出去。
     * PC 源码那边还留了一句定心的话："Direct `steer` is intentionally best-effort:
     * AgentLoop turns a closed-window submission into the next waking Queue item."
     * ——**最坏情况它会自己退回排队**，不会丢。
     */
    const queued = agent.status === 'running'
    const steered = queued && busyEnterMode() === 'steer' && typeof agent.steer === 'function'

    const message = userMessage(text, files)
    // 必须在 followup 之前登记。
    // 消息是**原样**进 agent 收件箱的（dsh-agent-loop 的 send() 直接把它 splice 进
    // inbox，不克隆、不换 id），所以事件回来时带的还是这个 id，认得出。
    // 但事件什么时候回来不确定——驱动是异步 kick 起来的（wakeDriver 返回 Promise）。
    // 先登记，就不必去赌这个时序。
    //
    // **排队的那条不登记。** 登记是为了「等它跑起来时别记两遍」，而排队的那条
    // 现在**还不该在手机上出现**——用户 2026-09-22 实机提的：排队的指令会立刻
    // 显示成一条「像已经发出去」的气泡，其实还在队列里等着。
    // 不登记、也不记账，等它真轮到时 session/event 那条路会把它补进 history，
    // 正好记一次、也只在那时候出现。
    if (!queued) rememberInjected(message.id)
    try {
      // 跑着的时候按设置分岔：插话进 nextStep（下一个步骤边界就取走），
      // 排队进 nextTurn（等这一轮跑完）。两条都是 DSH 自己的接口，见上面那段注释。
      if (steered) agent.steer(message)
      else agent.followup(message)
    } catch (err) {
      return { ok: false, error: `注入失败：${err?.message ?? err}` }
    }
    // 手机上回显的那条：附件也得看得见。不然发完一条「只有文件、没写文字」的指令，
    // 气泡是空的，用户会以为没发出去。
    const shown = files.length
      ? `${text}${text ? '\n' : ''}📎 ${files.map((f) => f.name).join('、')}`
      : text
    if (!queued) store.pushUser({ text: shown, sessionId, id: message.id })
    if (!store.state.boundSessionId) store.bind(sessionId)
    store.setRunning(sessionId, true)
    broadcastStatus()
    // 排队的那条也要推快照：队列列表是从 agent 收件箱读的，不推手机上就看不到
    // 它排在哪儿。区别只在于**不往 history 里记**，所以它不会长成一条气泡。
    server?.broadcast('state', store.snapshot())
    // queued / steered 只是给界面上那句提示用的：
    //   queued  —— 现在就在跑，所以这条得等下一轮；
    //   steered —— 现在就在跑，但这条会在**下一个步骤边界**被取走（通常几秒）。
    // 两个不会同时为真。
    return { ok: true, sessionId, queued: queued && !steered, steered }
  }

  /**
   * 把一条还在排队的指令撤回来。
   *
   * `agent.inbox.remove()` 返回的是「它当时是否还在队列里」——**不能不看这个返回值**：
   * 手机上那条队列是几百毫秒前推过去的，这中间它完全可能已经轮到自己、开始跑了。
   * 那种情况下它已经不在收件箱里，remove 返回 false，界面必须如实说「它已经开跑了」，
   * 而不是假装撤掉了。
   */
  function onUnqueue(id) {
    const sessionId = targetSessionId()
    if (!sessionId) return { ok: false, error: '电脑上还没有可遥控的会话。' }
    const agent = ctx.agents.get(sessionId)
    // 睡着的会话没有收件箱，排着的东西也跟着没了。**不能照旧说"这个会话已经结束了"**
    // ——它会醒，而且手机上还挂着它（2026-09-28 用户就是被这句误导过）。
    if (!agent) return { ok: false, error: '这个会话睡下了，队列里排着的也跟着没了——重新发一条吧。' }
    if (!id) return { ok: false, error: '没说要撤哪一条。' }
    let removed = false
    try {
      removed = agent.inbox.remove(id) === true
    } catch (err) {
      return { ok: false, error: `撤不回来：${err?.message ?? err}` }
    }
    if (!removed) {
      // 没撤成也要把最新队列推一遍：手机上那份是上一次推送时的样子，这条已经开跑了，
      // 界面得跟着纠正，不能一直挂着一条其实早就不在队列里的东西。
      server?.broadcast('state', store.snapshot())
      return { ok: false, error: '这条已经轮到自己开始跑了，撤不回来了。' }
    }
    server?.broadcast('state', store.snapshot())
    return { ok: true, sessionId }
  }

  /**
   * 停掉正在跑的那一轮。
   *
   * 和 DSH 自己的停止按钮**完全一致**——照抄 dsh-api-session-controller 里
   * commands.cancel 的写法：`agent.cancel({ kind: 'user' }, { keepInbox: true })`。
   * 那个 keepInbox 是照抄的重点：中止当前这一轮，但**收件箱里还没跑的东西留着**。
   * 不加的话，你在电脑上排好的下一条会被手机这一下悄悄吃掉，而且是无声的。
   *
   * cancel() 是「递个请求」，不是「等它停」：它立刻返回，真正停下要等驱动收敛，
   * 到那时候 agent/status 才翻成 idle、turn/end 才带着 aborted 出来。
   * 所以返回的 ok 只表示请求递进去了，界面上得等状态翻——不能按完就当停好了。
   *
   * 停下来之后**不会**推出什么「回答」：中止的那一轮通常卡在工具调用里，
   * events.js 那边本来就不会把它当回答（见 isIntermediateStep）。推空的。
   */
  function onStop() {
    const sessionId = targetSessionId()
    if (!sessionId) return { ok: false, error: '电脑上还没有可遥控的会话。' }
    const agent = ctx.agents.get(sessionId)
    // 会话睡着 = 没有一轮在跑，本来就没有可停的东西。照旧说"已经结束了"会让人以为
    // 得重选会话（2026-09-28 用户被这句误导过）。
    if (!agent) return { ok: false, error: '这个会话现在没在跑，不用停。' }
    // 子 Agent 不归手机管：导航栏里不显示它们，手机上也不该能停它们。
    // DSH 自己那条路也是这么挡的（hasApiSessionSubagentOwner）。
    if (agent.session?.header?.origin === 'subagent') {
      return { ok: false, error: '这是个子 Agent，手机上停不了它。' }
    }
    try {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    } catch (err) {
      return { ok: false, error: `停不下来：${err?.message ?? err}` }
    }
    return { ok: true, sessionId }
  }

  // 最近见过的工具调用：调用编号 → 一行能读的命令。
  //
  // **为什么要留这份**：审批请求（`approval/request`）只带工具名和一个调用编号，
  // 参数不在里面；而手机上要敢点「同意」，得先看见到底要跑什么。参数原本就在会话
  // 事件 `tool/call` 的 `arguments` 里（模型原样产出的 JSON），顺手记一份即可。
  // **只留最近 40 条**：够审批用，长会话也不会越攒越多。
  const toolCalls = new Map()
  const TOOL_CALL_KEEP = 40

  /**
   * 把模型原样产出的那段参数 JSON 变成卡上能读的一行。
   *
   * 只做「取字段 + 限长」，不做美化：命令就该原样给人看，他才敢拍板。
   * 常见字段按优先级取；都取不到就把短字段摊成几行；再不行给原文——
   * 宁可难看，不能"看不到"。
   */
  function commandPreview(rawArgs) {
    if (typeof rawArgs !== 'string' || !rawArgs.trim()) return ''
    let args = null
    try {
      args = JSON.parse(rawArgs)
    } catch (err) {
      return rawArgs.trim().slice(0, 1200)
    }
    if (!args || typeof args !== 'object') return rawArgs.trim().slice(0, 1200)
    for (const key of ['command', 'cmd', 'script', 'code', 'pattern', 'file_path', 'path', 'url']) {
      const v = args[key]
      if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 1200)
    }
    const lines = []
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === 'string' && v.length <= 200) lines.push(k + ': ' + v)
      else if (typeof v === 'number' || typeof v === 'boolean') lines.push(k + ': ' + String(v))
      if (lines.length >= 6) break
    }
    return lines.length ? lines.join('\n').slice(0, 1200) : rawArgs.trim().slice(0, 1200)
  }
  // ------------------------------------------------------------------
  // 事件订阅：只取「最后一帧」
  // ------------------------------------------------------------------
  /**
   * 上下文窗口用量：分母按会话记着，分子每步现算。
   *
   * 分母来自 `request/context`——DSH 每次发请求前报一份当前路由的信息，里面有
   * contextWindow。分子来自 `assistant/message` 的 usage。**三块计数互不重叠**：
   * `inputTokens` 只是没走缓存的那部分，缓存读、缓存写各算各的，
   * 「billed input = 三者之和」（dsh-llm 的 TokenUsage 注释原话）。少加一块，
   * 量出来的用量就偏小，而且越长的一轮偏得越多。
   *
   * 为什么不用 dsh-token-meter 的 contextPressure 投影：2026-09-28 实测它在这一组合里
   * 拿不到——接口通、不报错、投影里就是没有那三个数，手机上的用量一直空着（直接问
   * /mini/api/state，整个状态里连一个 token/window 字段都没有）。事件是同一份事实的一手
   * 来源，不依赖任何可选服务。
   */
  const contextWindows = new Map()

  function usageInputTokens(usage) {
    const n = (v) => (typeof v === 'number' && v > 0 ? v : 0)
    return n(usage.inputTokens) + n(usage.cacheReadTokens) + n(usage.cacheWriteTokens)
  }

  /**
   * 这个会话的窗口有多大（分母）。
   *
   * **两条来源，第二条是必须的。** `request/context` 那条事件只在**路由变了**的时候
   * 才写一次（见 dsh-agent-loop 的追加条件：和日志里上一条 request/context 不一样才写）。
   * 实测本机三个会话，从几十步到两千多步，`request/context` 都**只有一条**，就在会话
   * 第一次发请求那一刻；而 `request/header` 有两百多条。插件要是晚一步起来——重启过、
   * 或者是早就开着的会话——那一条早进日志了，光等事件永远等不到，分母一直缺，
   * 手机上就永远空着（2026-09-28 用户报的正是这个）。
   *
   * 所以第二条走 `session.requestContext()`：DSH 自己把日志里最后那条 request/context
   * 折叠在会话对象上，重启之后照样在（agent-loop 判断「要不要再写一条」用的就是它，
   * 正因为它在，那条事件才不会每次重启都重写一遍）。拿到就顺手记进 map，
   * 后面每一步都省一次折叠。
   */
  function contextWindowOf(session, sessionId) {
    const known = contextWindows.get(sessionId)
    if (typeof known === 'number' && known > 0) return known
    const folded = typeof session?.requestContext === 'function' ? session.requestContext() : undefined
    const win = folded?.contextWindow
    if (typeof win !== 'number' || !(win > 0)) return undefined
    contextWindows.set(sessionId, win)
    return win
  }

  /**
   * 喂一口执行轨迹，并把这一批的变化推给**正在看这个会话、而且要「完整」模式**的手机。
   *
   * 三个决定，都有理由：
   *   ① **落在 store 的内存缓冲里**，不落盘（体积是回答正文的 90.7 倍，落盘那份是每
   *      500 毫秒重写整份 JSON；理由见 lib/store.js 的 trajectoryBySession）。
   *   ② **只推当前绑定的那个会话**（和 reply 那条同一个口径）：手机遥控的是这一个，
   *      别的会话在想什么跟它无关；那些会话照旧攒在缓冲里，切过去时用接口拉一份。
   *   ③ **推的是增量帧**，不是整份快照（见 lib/server.js 的 broadcastTrajectory）。
   */
  function feedTrajectory(sessionId, event) {
    const change = trajectory.feed(sessionId, event)
    if (!change) return
    const frame = store.applyTrajectory(sessionId, change)
    if (!frame) return
    // 真条目落盘了：活片段的使命结束（它只是「还没落定」的影子，见 feedTrajectoryLive）。
    if (change.entries.length || change.state) resetLiveThink(sessionId)
    if (sessionId !== targetSessionId()) return
    server?.broadcastTrajectory({ sessionId, ...frame })
  }

  /**
   * 轨迹的活片段（2026-10-04 用户解禁「流式不做」，仅完整模式消费，别的模式零影响）：
   * 模型正在想的那一句，从 `agent/assistant-stream` 的 reasoning-delta 里顺出来。
   *
   * 边界三条：
   *   ① **只吃思考**（reasoning-delta）；回答正文（text-delta）一概不用——回答照旧等
   *      落定才显示，「流式不做」那条裁决只对轨迹的思考片段解禁；
   *   ② **只推当前绑定的那个会话**，子 Agent 的流不过来（和轨迹增量帧同一个口径）；
   *   ③ **落盘即清、打断即清**：真条目一到就让位。它是进程本地的，不重放——手机刷新
   *      后没了就没了，等下一步的片段接着来，不补假的。
   *
   * 节流：模型一秒能吐几十个字，250 毫秒一发、尾随必发；第一段立刻发——
   * 「有没有动静」这件事最要紧的就是第一眼。
   */
  const liveThink = new Map()
  const LIVE_THINK_MS = 250

  /** 「当前这一段」的尾句：压成一行、限 160 字——给人瞄一眼的，不是给人读的。 */
  function liveThinkDetail(text) {
    const paragraphs = String(text).split(/\r?\n[\t ]*\r?\n/)
    const last = paragraphs[paragraphs.length - 1].replace(/\s+/g, ' ').trim()
    return last.length > 160 ? `${last.slice(0, 159)}…` : last
  }

  function resetLiveThink(sessionId) {
    const slot = liveThink.get(sessionId)
    if (!slot) return
    if (slot.timer) clearTimeout(slot.timer)
    liveThink.delete(sessionId)
    // 只在真露过字之后才喊「清空」——不然每来一次工具调用都白发一帧。
    if (slot.sent) server?.broadcastTrajectoryLive({ sessionId, detail: '' })
  }

  function feedTrajectoryLive(sessionId, frame) {
    if (sessionId !== targetSessionId()) return
    if (!frame || frame.type !== 'chunk') { resetLiveThink(sessionId); return }
    const chunk = frame.chunk ?? {}
    if (chunk.type === 'reasoning-delta' && chunk.text) {
      let slot = liveThink.get(sessionId)
      if (!slot) {
        slot = { text: '', sent: false, at: 0, timer: null }
        liveThink.set(sessionId, slot)
      }
      slot.text += chunk.text
      const detail = liveThinkDetail(slot.text)
      const flush = () => {
        slot.timer = null
        slot.at = Date.now()
        slot.sent = true
        server?.broadcastTrajectoryLive({ sessionId, detail })
      }
      if (!slot.sent || Date.now() - slot.at >= LIVE_THINK_MS) {
        if (slot.timer) { clearTimeout(slot.timer); slot.timer = null }
        flush()
      } else if (!slot.timer) {
        slot.timer = setTimeout(flush, LIVE_THINK_MS - (Date.now() - slot.at))
        if (slot.timer.unref) slot.timer.unref()
      }
      return
    }
    // 出现工具调用 = 这一步走到工具了，思考片段到此为止；text-delta 是回答正文，一概不用。
    if (chunk.type === 'tool-call-delta') resetLiveThink(sessionId)
  }

  ctx.on('session/event', (session, event) => {
    // 子 agent 的会话不进手机——用户遥控的是自己的主会话，不是它派出去的小弟。
    if (session.header?.origin === 'subagent') return
    const sessionId = session.id

    // 执行轨迹：**在所有早退之前**喂一口。下面 `tool/call` 那条分支取完命令原文就 return
    // 了（审批卡要用），而工具调用正是轨迹的主干——放在这一句之前，它才不会漏掉。
    feedTrajectory(sessionId, event)

    // 手机正在看的这个会话：顺手让它的完整历史保持新鲜（一分钟最多重读一次）。
    // 只对「当前绑定的那一个」做——手机上没在看的会话，读了也没人看，白花 CPU。
    if (sessionId === targetSessionId()) ensureHistory(sessionId)

    // 命令原文：记下这次要跑的是什么，审批卡上要显示。**不进日志**——正文是用户自己的东西。
    if (event.type === 'tool/call') {
      const data = event.data ?? {}
      if (data.callId) {
        toolCalls.set(String(data.callId), commandPreview(data.arguments))
        while (toolCalls.size > TOOL_CALL_KEEP) toolCalls.delete(toolCalls.keys().next().value)
      }
      return
    }

    // 会话标题（可选事件，拿到就用，拿不到就用 id 前 8 位兜底）
    if (event.type === 'session/title') {
      const title = event.data?.title ?? event.data?.text
      if (typeof title === 'string' && title.trim()) {
        store.touchSession(sessionId, { title: title.trim() })
        // 同时盖掉落盘那份里的旧说法。**不能只等下次展开工作区时才写**：
        // 那时如果插件已经重启过（内存清零），手机上看到的就是盘上那个旧值了。
        titles.set(sessionId, title.trim())
      }
      return
    }

    // 这个会话现在用的是哪个模型、哪一档思考强度。
    //
    // **来源就是这儿**：DSH 每次发请求前都会广播一份 header，里面带着
    // `config: { provider, model, reasoningEffort? }`——和 DSH 接口定义里那个
    // `ModelSelection` 是同一个形状（见 tasks/todo.md 第 32 轮的侦察结论）。
    // 所以读当前值不用另找接口，跟着事件走就行。
    //
    // 记下来给手机端显示用（2026-09-25 用户要求：手机上要能改每个会话的模型和强度）。
    // 改完之后 DSH 会再发一份新的 header，这里跟着刷新，两边不会走散。
    if (event.type === 'request/header') {
      const cfg = event.data?.header?.config
      if (cfg && typeof cfg.model === 'string') {
        store.touchSession(sessionId, {
          provider: typeof cfg.provider === 'string' ? cfg.provider : null,
          model: cfg.model,
          // 这一项可能是空的：那表示「用 provider 自己的默认」，不是出错
          reasoningEffort: typeof cfg.reasoningEffort === 'string' ? cfg.reasoningEffort : null,
        })
      }
      return
    }

    // 斜杠指令：它**不是一轮对话**，上面那个提取器不认它（会走到 `if (!action) return`
    // 直接丢掉），所以得在这儿单独接住。
    //
    // 为什么值得单独一条路：指令不产生模型消息（DSH 的契约），所以它既不该长成用户
    // 气泡，也不该被单帧模式当成「最新回复」。它是第三种东西——手机上画成一条紧凑的
    // 「指令」行，和电脑端画在正文里是同一个意思。
    //
    // 开始（command/run）和收尾（command/done）靠 commandId 配对。配对逻辑和
    // 「重放硬盘日志」那条路共用 lib/commands.js 里的映射，两边不会走散。
    if (event.type === 'command/run' || event.type === 'command/done') {
      // 手机还没绑会话时，谁先有动静就绑谁（和下面那条同一套口径）。
      if (!store.state.boundSessionId) store.bind(sessionId)
      if (sessionId !== targetSessionId()) return
      if (event.type === 'command/run') {
        const row = commandRow(event)
        if (row) store.pushCommand({ ...row, sessionId })
      } else {
        const patch = commandPatch(event)
        if (patch) store.settleCommand({ sessionId, ...patch })
      }
      store.touchSession(sessionId)
      server?.broadcast('state', store.snapshot())
      return
    }

    /**
     * 一轮跑完，台词就作废。
     *
     * 不广播也安全：这一轮结束必然跟着一条回复或一条状态推送，手机自己会重画；
     * 而页面那边还认着「这句我念过了」（比 at），所以旧的残留不会诈尸。
     */
    if (event.type === 'turn/end' && sessionId === targetSessionId()) {
      store.setThought(sessionId, null)
    }

    // 上下文窗口用量：分母跟着 request/context 记，分子每步现量（见 usageInputTokens）。
    // 缺任一半就什么都不写——宁可空着，也不编一个数出来。
    if (event.type === 'request/context') {
      const win = event.data?.contextWindow
      if (typeof win === 'number' && win > 0) contextWindows.set(sessionId, win)
    }
    if (event.type === 'assistant/message' && event.data?.usage) {
      const used = usageInputTokens(event.data.usage)
      // 分母从 `contextWindowOf` 拿：事件里那份优先，事件没赶上就问会话自己折叠的那份
      // （理由见那个函数）。
      const win = contextWindowOf(session, sessionId)
      if (used > 0 && win > 0) {
        store.touchSession(sessionId, { context: { used, window: win } })
        // 只有手机正在看的那个会话值得推一遍；别的会话照样记着，等它被切过来时
        // /mini/api/state 会给最新的一份。
        if (sessionId === targetSessionId()) server?.broadcast('state', store.snapshot())
      }
    }

    const action = tracker.feed(sessionId, event)
    if (!action) {
      /**
       * 到这里还不是「指令」也不是「回答」，但可能是别的会话都不管的第三种东西：
       * 中间步骤的自言自语（鲸鱼娘的台词）。
       *
       * **必须在这儿接，不能等到下面。** 下面第一件事就是 `if (sessionId !==
       * targetSessionId()) return`——那是给「会震动手机的内容」定的规矩，而台词也一样：
       * 别的会话在想什么，跟手机正遥控的这个会话无关。
       *
       * 它取的是中间步骤的旁白或思考首行，**不落盘、不进历史**，所以回答区的口径
       * （latest/history）一个字都不会因此改变——2026-09-22 用户否掉的是「过程的文字
       * 跑进回答区」，不是「她说了句话」。
       */
      if (event.type === 'assistant/message') {
        if (sessionId !== targetSessionId()) return
        const talk = stepSelfTalk(event.data?.message?.content)
        // 没话可说时**什么都不做**：留着上一句，比让气泡闪一下空要好。
        if (!talk) return
        store.setThought(sessionId, { text: talk.text, at: event.time ?? Date.now() })
        store.touchSession(sessionId)
        server?.broadcast('state', store.snapshot())
      }
      return
    }
    store.touchSession(sessionId)

    // 手机还没绑会话时，谁先有动静就绑谁。
    if (!store.state.boundSessionId) store.bind(sessionId)

    // 下面只处理手机正在遥控的那个会话。别的会话（比如你在电脑上另开的）
    // 既不该震手机，也不该顶掉单帧模式显示的内容——实时推送和刷新后拿到的
    // 状态必须是同一套口径，否则刷新一下就看到别人的结果了。
    if (sessionId !== targetSessionId()) return

    if (action.kind === 'notice') {
      // 子智能体完工的通知。记进聊天记录，**但不震动、不弹通知**——它是「你派出去的
      // 那件事有结果了」，和「模型答了你一句」不是同一件事。可它确实是这个会话里
      // 发生的一件事，聊天记录里不能缺（原来就是被 user/message 那道过滤一起挡掉的）。
      store.pushNotice({
        text: action.text,
        summary: action.summary,
        senderSessionId: action.senderSessionId,
        sessionId,
        turn: action.turn,
        timestamp: event.time,
      })
      server?.broadcast('state', store.snapshot())
      return
    }

    if (action.kind === 'user') {
      // 手机自己发的那条：onInstruction 里已经记过一笔了，这里跳过。
      // 不跳的话聊天模式里同一条指令会显示两次（用户实机报过）。
      if (action.id && injectedIds.has(action.id)) {
        injectedIds.delete(action.id)
        // **但不能直接 return**：这条事件的意思是「它轮到、开始跑了」，
        // 队列里少了一条。不推这一下，手机上那块「排队中」就会一直挂着
        // 一条其实已经在跑的东西。（内容那一笔确实已经在 onInstruction 里记过了，
        // 所以只推快照、不重复记。）
        server?.broadcast('state', store.snapshot())
        return
      }
      // 电脑上自己敲的指令也记一笔，聊天模式才完整。
      // 带上 id：那条也可能是**排队**排进去的，手机上要靠它对上号、标出「排队中」。
      // 时间戳用事件自己的 `time`：硬盘重放出来的那份也是这个 `time`，两边同钟，
      // 合成时才认得出「这条记录里已经有了」，不会接成两条（见 store.pushUser）。
      store.pushUser({ text: action.text, sessionId, id: action.id, turn: action.turn, timestamp: event.time })
      server?.broadcast('state', store.snapshot())
      return
    }

    // action.kind === 'reply'
    store.pushReply({
      text: action.text, sessionId, reason: action.reason, interrupted: action.interrupted,
      turn: action.turn,
      // 同上：和硬盘那份用同一个钟（事件的 `time`），否则同一条回复会显示两遍。
      timestamp: event.time,
    })
    server?.broadcast('reply', {
      text: action.text,
      sessionId,
      reason: action.reason,
      // 这是「你按停的那半句」，不是完整回答。手机要标出来，别让人以为是模型答崩了。
      interrupted: action.interrupted === true,
      timestamp: Date.now(),
    })
    maybeNotify(action.text)
  })

  ctx.on('agent/status', ({ agent, status }) => {
    const sessionId = agent?.session?.id
    if (!sessionId) return
    if (agent.session.header?.origin === 'subagent') {
      const parent = agent.session.header?.parentSession
      if (parent) {
        subagentCache.delete(parent)
        store.setSubagentRunning(parent, sessionId, status === 'running')
        server?.invalidateSubagents?.(parent)
        server?.broadcast('state', store.snapshot())
      }
      return
    }
    store.setRunning(sessionId, status === 'running')
    server?.invalidateNavigation?.()
    server?.broadcast('navigation-refresh', { reason: 'session-status', sessionId })
    broadcastStatus()
  })

  /**
   * 模型每吐一小段，DSH 就发一帧。这是**唯一**能拿到增量文本的地方。
   *
   * 别的路都不行：`session/event` 是落盘之后才发的（等它到，整段已经写完了），
   * 消息账本里那条 assistant/message 也是收尾时才写。所以「流式」只能挂在这儿。
   *
   * 两个已知的限制，都绕不开，只能自己兜着：
   * ① 它是**进程本地**的，不重放。手机中途刷新就接不上了——所以流出来的那段
   *    自己在 store 里留一份，塞进快照，任何一条广播都能把它补回去。
   * ② 它不带 sessionId，得从 agent 上拿。和 session/event 同一套过滤口径：
   *    子 Agent 的流不往手机上推。
   */
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const session = agent?.session
    const sessionId = session?.id
    if (!sessionId) return
    if (session.header?.origin === 'subagent') return

    // 轨迹的活片段：完整模式要「正在想的片段一点点顺出来」（2026-10-04 用户解禁，
    // 只解禁这一处）。它跑在下面那道闸门**之前**：这里吃的是 reasoning-delta，
    // text-delta 走下面那条流式路径，两者互不相干。
    feedTrajectoryLive(sessionId, frame)

    // 兜底开关：关掉时这里直接掉头，手机上只认落定的那条回答，中途一个字都不推。
    // 现在的策略（事后确认）见 STREAMING_ENABLED 的注释。
    if (!STREAMING_ENABLED) return

    // 只报一次：这条日志回答的是「事件到底有没有送到插件」。一条都没有，就说明
    // 问题在订阅那一层，不用再往下查。
    if (!sawStreamEvent) {
      sawStreamEvent = true
      log.info('流式：收到第一个增量事件了')
    }

    if (frame?.type === 'start') {
      streaming.text = ''
      streaming.shown = false
      if (streaming.timer) clearTimeout(streaming.timer)
      streaming.timer = null
      return
    }

    if (frame?.type === 'chunk') {
      const chunk = frame.chunk
      if (chunk?.type === 'tool-call-delta') {
        // 出现工具调用 = 这一步是中间步骤，刚才攒下的那句是旁白。
        // 因为还一个字都没露过（事后确认模式），这里只是丢掉缓存，用户什么都看不到。
        if (streaming.text.length) {
          log.info(`流式：这一步是中间步骤，丢弃旁白（${streaming.text.length} 字，未展示）`)
        }
        discardStreaming()
        return
      }
      if (chunk?.type !== 'text-delta' || !chunk.text) return
      streaming.text += chunk.text
      // 确认过是最终回答之后，才逐帧往外推。
      if (!streaming.shown) return
      store.setLive(sessionId, streaming.text)
      // 限流：模型一秒能吐几十个分片，原样转发会把 SSE 打爆。
      const now = Date.now()
      if (now - lastLivePush < STREAM_PUSH_MS) return
      lastLivePush = now
      server?.broadcast('state', store.snapshot())
      return
    }

    // frame.type === 'end'
    //
    // 这一步收尾了。如果全程没出现过工具调用，它**就是**最终回答，此时才把攒下的
    // 整段一次性补齐、并转入逐帧推送；否则什么都不做（缓存早被 tool-call-delta 丢掉）。
    if (frame?.type === 'end') {
      const text = streaming.text
      const isAnswer = text.trim() !== '' && !looksLikeToolMarkup(text)
      if (isAnswer) {
        streaming.shown = true
        store.setLive(sessionId, text)
        server?.broadcast('state', store.snapshot())
        log.info(`流式：确认为最终回答，补齐 ${text.length} 字`)
      } else if (text.length) {
        log.info(`流式：这一步不是最终回答，丢弃 ${text.length} 字`)
      }
      // 注意：这里**不**清空 streaming.text —— 落盘的 assistant/message 会随
      // session/event 到达并替换掉 latest，重复调用 stopStreaming 反而会把
      // 已经露出来的内容闪掉。
      if (streaming.timer) {
        clearTimeout(streaming.timer)
        streaming.timer = null
      }
      return
    }

    // 走到这儿说明帧的形状和我们以为的不一样。把前 200 字打出来——比起猜，
    // 看一眼真实的东西更快。
    log.warn(`流式：不认识的帧 ${String(JSON.stringify(frame)).slice(0, 200)}`)
  })

  // 会话一建出来就登记，这样手机上的会话选择器不用等到有活动才出现。
  ctx.on('agent/created', ({ agent }) => {
    const sessionId = agent?.session?.id
    if (!sessionId) return
    if (agent.session.header?.origin === 'subagent') {
      const parent = agent.session.header?.parentSession
      if (parent) {
        subagentCache.delete(parent)
        store.setSubagentRunning(parent, sessionId, agent.status === 'running')
        server?.invalidateSubagents?.(parent)
        server?.broadcast('state', store.snapshot())
      }
      return
    }
    sessionMeta.upsert({ header: agent.session.header, live: true, persisted: false })
    store.touchSession(sessionId, {
      running: agent.status === 'running',
    })
    server?.invalidateNavigation?.()
    server?.broadcast('navigation-refresh', { reason: 'session-created' })
    server?.broadcast('state', store.snapshot())
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.id
    if (!sessionId) return
    if (agent.session.header?.origin === 'subagent') {
      const parent = agent.session.header?.parentSession
      if (parent) {
        subagentCache.delete(parent)
        store.setSubagentRunning(parent, sessionId, false)
        server?.invalidateSubagents?.(parent)
        server?.broadcast('state', store.snapshot())
      }
      return
    }
    sessionMeta.upsert({ header: agent.session.header, live: false, persisted: true })
    store.forgetSession(sessionId)
    // 轨迹那个累计器也清掉（它有自己的一份 per-session 状态）。
    trajectory.forget(sessionId)
    server?.invalidateNavigation?.()
    server?.broadcast('navigation-refresh', { reason: 'session-disposed' })
    server?.broadcast('state', store.snapshot())
  })

  // ------------------------------------------------------------------
  // 左侧导航栏要用的两个服务
  // ------------------------------------------------------------------
  // 同样走 ctx.inject，不写进 inject 数组：这两个服务只在 web 组合里有，写进去
  // 的话 headless 组合下服务永远不来，这个插件就一直挂着不激活——启动失败那个
  // 坑刚踩过一次，不再踩第二次。服务没到位时导航栏退回「只知道当前会话」。
  //
  // 拿到的时机可能晚于建服务，所以存进一个可变的持有对象，让服务端每次请求
  // 现读，而不是建服务时读一次快照。
  const treeServices = { registry: null, query: null }
  ctx.inject(['sessionQuery', 'workspaceRegistry'], (treeCtx) => {
    treeServices.registry = treeCtx.workspaceRegistry
    treeServices.query = treeCtx.sessionQuery
    // 这行日志是有用的：服务到底有没有到位，只能在这里确定地看到。
    // 「配置和源码里都有」不等于「运行时真的提供了」，前者是推断，后者才是事实。
    console.log('[dsh-remote-lite] 会话树已就绪：workspaceRegistry='
      + Boolean(treeServices.registry) + ' sessionQuery=' + Boolean(treeServices.query))
  })

  // ------------------------------------------------------------------
  // 归档会话 / 删除工作区（2026-10-25）
  //
  // **DSH 里没有「物理删除一个会话」这个动作**：`dsh-session` 的 store 只负责建和读，
  // 桌面端侧栏那个「删除对话」调的其实是 `workspaceController.archiveSession` ——
  // 把它从工作区列表里移走、停掉它正在跑的活，之后还能在「已归档」里恢复。
  // 手机端照同一条口径走，不自创一种更难恢复的删除语义：真删会话日志会绕过 SQLite
  // 那份索引，DSH 那边马上就是「查得到、读不出」的坏状态。
  //
  // 「整个文件夹」是两层：`archiveWorkspace` 只归档它下面的全部会话（可恢复）；
  // `deleteWorkspace` 调 DSH 自己的 `WorkspaceController.delete`，把工作区注册本身删掉。
  // 两个动作在界面上必须分开写清楚，别让一个词背两种后果。
  // ------------------------------------------------------------------
  let workspaceCtl = null
  ctx.inject(['workspaceController'], (ctlCtx) => {
    workspaceCtl = ctlCtx.workspaceController
    console.log('[dsh-remote-lite] 工作区控制器已就绪：手机端可归档会话 / 删除工作区')
  })

  /** 现在的控制器。注入是异步的，用的时候再取一次，别在加载期抄一份。 */
  function workspaceController() {
    const ctl = workspaceCtl ?? ctx.get('workspaceController')
    return ctl && typeof ctl.archiveSession === 'function' ? ctl : null
  }

  /**
   * 归档一个会话。
   *
   * `stopActivity` 默认 true：DSH 遇到「这个会话还在跑」时默认拒绝归档，
   * 而手机用户按下去的意思是「别要它了」——先停掉再归档才符合这个意思。
   */
  async function archiveOneSession(sessionId, stopActivity) {
    const id = String(sessionId ?? '').trim()
    if (!id) return { ok: false, error: '缺少 sessionId' }
    const ctl = workspaceController()
    if (!ctl) return { ok: false, error: '宿主没有提供归档能力（workspaceController 不可用）' }
    try {
      await ctl.archiveSession({ sessionId: id, stopActivity: stopActivity !== false })
      return { ok: true, sessionId: id }
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) }
    }
  }

  /**
   * 归档一个工作区下的**全部**会话。
   *
   * 一条一条来，不并行：每一条都可能触发停止动作（停当前轮、停子智能体、停后台任务），
   * 并行发出去等于同时掐好几摊，日志也读不清。慢一点没关系——这是「整个文件夹」，
   * 用户本来就在等一个批量动作。
   */
  async function archiveWholeWorkspace(workspaceId) {
    const wid = String(workspaceId ?? '').trim()
    if (!wid) return { ok: false, error: '缺少 workspaceId' }
    let ids
    try {
      ids = await allSessionIdsOf({
        registry: treeServices.registry, query: treeServices.query, workspaceId: wid, meta: sessionMeta,
      })
    } catch (err) {
      return { ok: false, error: `读会话列表失败：${err?.message ?? err}` }
    }
    if (ids === null) return { ok: false, error: '没有这个工作区' }
    if (!ids.length) return { ok: true, archived: [], failed: [] }
    const archived = []
    const failed = []
    for (const id of ids) {
      const r = await archiveOneSession(id, true)
      if (r.ok) archived.push(id)
      else failed.push({ sessionId: id, error: r.error })
    }
    return { ok: failed.length === 0, archived, failed }
  }

  /**
   * 删除一个工作区注册（DSH 自己的动作）。
   *
   * `archiveSessions` 为 true 时先把里面的会话归档一遍——不然那些会话会**留在一个
   * 已经不存在的工作区里**，界面上既看不到也点不着，等于半删状态。
   * 磁盘上的会话日志 DSH 不会替你删，这一点界面上写清楚了。
   */
  async function removeWorkspace(workspaceId, archiveSessions) {
    const wid = String(workspaceId ?? '').trim()
    if (!wid) return { ok: false, error: '缺少 workspaceId' }
    const ctl = workspaceController()
    if (!ctl || typeof ctl.delete !== 'function') {
      return { ok: false, error: '宿主没有提供删除工作区的能力' }
    }
    let archived = []
    if (archiveSessions !== false) {
      const batch = await archiveWholeWorkspace(wid)
      if (!batch.ok) {
        // 归档没走完就别接着删：宁可留一个完整的工作区，也不要留一个删了一半的。
        return { ok: false, error: batch.error ?? '部分会话归档失败，已中止删除', failed: batch.failed ?? [] }
      }
      archived = batch.archived ?? []
    }
    try {
      await ctl.delete({ workspaceId: wid })
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) }
    }
    return { ok: true, archived }
  }

  /**
   * 归档之后的收尾：手机那一栏要重画，绑定的会话要是被归档了得解绑。
   *
   * 解绑走 `bind(null)`：`targetSessionId` 本来就有「没绑定就用最近活跃那个」的退路，
   * 所以解绑不会把手机变成一块空白，只是换一个默认对象。
   */
  function afterArchive(archivedIds) {
    const ids = (archivedIds ?? []).filter(Boolean)
    if (!ids.length) return
    const bound = store.snapshot().boundSessionId
    if (bound && ids.includes(bound)) store.bind(null)
    server?.broadcast('navigation-refresh', {})
    server?.broadcast('state', store.snapshot())
  }

  /**
   * **永久删除一个会话**（2026-10-25 用户要求：归档不够，垃圾会堆）。
   *
   * DSH 自己没有这个动作——`dsh-session` 的 store 只增不删，也没有 prune/retention。
   * 所以这里按它自己的分层来做，四步，顺序不能换：
   *
   *   1. **先归档**（stopActivity）——停掉正在跑的活，并让它在 DSH 那边变成「已归档」。
   *      这样即使后面删文件失败，状态也是干净的、可解释的；反过来先删文件的话，
   *      会留下一个「文件没了但 DSH 还以为它在跑」的幽灵。
   *   2. **找日志目录**：`findSessionLog` 扫 `~/.dsh/sessions/<工作区 slug>/<会话 id>/`。
   *      拿到的文件路径上一级就是目录。
   *   3. **删目录**前先验一道：目录名必须**逐字等于**会话 id。这是唯一一处按 id 拼路径
   *      再递归删除的地方，形状不对（哪怕只是看着像）就拒绝——宁可删不掉。
   *   4. **让各处忘掉它**：导航那份元数据缓存里的一条必须丢掉（它是冷启动的真相，
   *      留着就会在重启后凭空多出点不开的条目）；再拉一次 `listSessions()` ——
   *      它读的是**持久化层现扫盘**，不是那份 SQLite 索引，所以删完文件导航立刻就对。
   *      搜索用的索引会晚一步自愈（它只在搜索那条路和启动时跟持久化对账），
   *      这期间搜索可能还搜得到这条，但打不开它——不是坏档，别去直接写它的库。
   */
  const DELETABLE_ID = /^session-[A-Za-z0-9._-]+$/
  async function hardDeleteSession(sessionId) {
    const id = String(sessionId ?? '').trim()
    if (!DELETABLE_ID.test(id)) return { ok: false, error: '会话 id 形状不对，拒绝删除' }

    const archived = await archiveOneSession(id, true)
    if (!archived.ok) return archived

    let logFile = null
    try {
      logFile = findSessionLog(id)
    } catch (err) {
      return { ok: false, error: `定位日志失败：${err?.message ?? err}` }
    }
    if (!logFile) {
      // 归档成功了但文件找不到：可能本来就只剩索引里一条。当作已删，别报错吓人。
      sessionMeta.forget?.(id)
      try { await treeServices.query?.listSessions?.() } catch {}
      return { ok: true, sessionId: id, files: false }
    }

    const dir = dirname(logFile)
    if (basename(dir) !== id) {
      return { ok: false, error: `日志目录名与会话 id 不一致，拒绝删除（${basename(dir)}）` }
    }
    // Windows 上有个现实问题：归档只是「不再往里写」，持久化服务手里的句柄可能还没放，
    // 这时删目录会 EBUSY/EPERM。等一拍重试一次——放句柄通常就在几百毫秒内。
    // 两次都不行就如实报错：**删不掉比删一半好**，至少用户知道它还在。
    let removeError = null
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      removeError = err
      await new Promise((resolve) => setTimeout(resolve, 400))
      try {
        rmSync(dir, { recursive: true, force: true })
        removeError = null
      } catch (err2) {
        removeError = err2
      }
    }
    if (removeError) {
      return { ok: false, error: `删文件失败（可能还被占用）：${removeError?.message ?? removeError}` }
    }

    sessionMeta.forget?.(id)
    // 触发一次索引对账。失败不影响删除本身——文件已经没了，下次对账还会再来一次。
    try { await treeServices.query?.listSessions?.() } catch {}
    return { ok: true, sessionId: id, files: true }
  }

  // ------------------------------------------------------------------
  // 点开一个会话，就把它**完整的历史**读出来（2026-09-25 用户要求）
  //
  // 为什么不能只靠手里那份记录：手机能点开全部会话（一个工作区常有上百条），
  // 而插件手里那份只有「它在场时看见过的事件」——重启前跑过的、在电脑上开的，
  // 点进去是空的。用户要的是：点开就该看到它之前的每一轮。
  //
  // 数据来源是 DSH 自己的会话记录（`sessionQuery.readSession`）。它有个很好的性质：
  // **会话活着就从内存给（不读盘），睡着才去读它的日志**，而且日志是完整的
  // （多帧 zstd 由 DSH 自己解）。所以对正在跑的那个会话，这条路几乎不要钱。
  //
  // 读出来的是原始事件，用 lib/history.js 重放成聊天记录——**和实时那条路
  // 共用同一个提取器**，两条路对「哪条才算最终回答」的判断不会走散。
  // ------------------------------------------------------------------

  /** sessionId -> { at, entries, latest }。只活在内存里，不落盘（理由见 store.setReplaySource）。 */
  const historyCache = new Map()
  /** 正在读的那些：用户连点几下也只读一遍。 */
  const historyPending = new Set()
  /** 多久重读一次。会话跑着的时候历史会变长，一分钟够跟上；睡着的不变，重读也只是白读一次。 */
  const HISTORY_TTL_MS = 60000

  /**
   * 手机端读历史的**上限**（2026-09-25 用户要求：读历史要有上限）。
   *
   * 三层**都跟会话总量无关**：
   *   - 窗口：只读日志末尾这么多**压缩**字节；
   *   - 事件：窗口里最多留多少条事件（再向前对齐到一条 user 消息，让重放从一轮的开头起）；
   *   - 条目：重放成聊天记录后，最多给手机多少条（≈ 轮数 × 2）。
   */
  // 窗口按「本机最坏的那条日志」实测选的（26MB / 2.2 万事件）：16MB 窗口 → 约 1.2 万事件、
  // 197 条聊天记录、472ms、堆峰 ~400MB；4MB 窗口只有 29 条（太少）。日志比窗口小就是全读。
  // 事件上限只作极端兜底。
  //
  // **这条有上限的路现在是日常路**，理由见 ensureHistory：内核那条整份读要先把全部会话
  // 列两遍，1MB 的日志也要 1.7–3.6 秒。原来那两条「子会话超过 20 个 / 日志超过 8MB 才
  // 走这里」的红线（以及为它们服务的 tree.js sessionScale）随之删掉——触发它们的那条
  // 整份读已经只剩「盘上还没有日志的会话」这一种情况了，那时它给的是内存里现成的那份，
  // 不会去做 v3→v4 迁移，所以 2026-09-25 那次 OOM 的路已经走不通。
  const HISTORY_TAIL_WINDOW_BYTES = 16 * 1024 * 1024
  const HISTORY_TAIL_MAX_EVENTS = 20000
  const HISTORY_MAX_ENTRIES = 200

  /**
   * 去 DSH 的会话记录里读一次，重放成聊天记录。读不出来返回 null。
   *
   * **只在盘上找不到这个会话的日志时才用**（会话刚建、还没落盘；或者是子 agent 的会话，
   * 那种要读出来才知道该不该显示）。这时内核给的是内存里现成的那份，不读盘、不迁移，
   * 正好免费。盘上有日志时请走 readTailHistory——理由是实测数字，见 ensureHistory。
   */
  async function readHistory(sessionId) {
    const q = treeServices.query
    if (typeof q?.readSession !== 'function') return null
    try {
      const snap = await q.readSession(sessionId)
      // 子 agent 的会话不进手机——和实时那条路同一条口径（见 session/event 里那句）。
      if (snap?.session?.origin === 'subagent') return null
      const events = Array.isArray(snap?.events) ? snap.events : []
      const entries = replayHistory(events)
      const capped = capEntries(entries)
      // 轨迹和聊天记录是**同一批事件的两面**，顺手一起重放出来；不这样就得为它再读一遍盘。
      const traj = capTrajectory(replayTrajectory(events))
      return {
        entries: capped.entries,
        latest: lastReply(capped.entries, sessionId),
        truncated: capped.dropped > 0,
        // 说「最近一段」而不是「最近 200 条」：这条记录读完之后，store 还会把
        // 「刚发生、还没落进日志」的那一两条实时记录接在后面（见 mergeHistory），
        // 于是手机上真看到的条数可能比这里多一两条。数字对不上就是假话，
        // 所以这里只声称**读取的上限**，不声称列表长度。
        note: capped.dropped > 0 ? `只显示最近一段（读取上限：${HISTORY_MAX_ENTRIES} 条）` : null,
        // 轨迹在**插件这一层就按自己的上限截好**再进缓存：不截的话，20 个会话的缓存会
        // 各压着几兆（见 lib/store.js 的 setReplaySource 那段说明）。
        trajectory: traj.turns,
        trajectoryDropped: traj.dropped,
      }
    } catch (err) {
      // 老日志格式对不上、文件坏了，都会走到这儿。退回「手里那份」，**不编**。
      console.log('[dsh-remote-lite] 这个会话的完整记录没读出来（' + sessionId + '）：'
        + (err?.message ?? err))
      return null
    }
  }

  /** 聊天记录条数上限：从**尾部**留（手机上看的是最近发生的事）。 */
  function capEntries(entries) {
    if (!Array.isArray(entries) || entries.length <= HISTORY_MAX_ENTRIES) {
      return { entries, dropped: 0 }
    }
    return { entries: entries.slice(-HISTORY_MAX_ENTRIES), dropped: entries.length - HISTORY_MAX_ENTRIES }
  }

  /**
   * 有上限的读法：只解日志**尾部**的若干 zstd 帧，自己重放（见 lib/log-tail.js）。
   *
   * 日志比窗口小就是整份都读到（`tail.whole`），所以小会话走这里也不会少看东西。
   * 拿不到就返回 null：由调用方如实说「没读到」，**不编内容**。
   */
  function readTailHistory(sessionId) {
    let tail
    try {
      tail = readTailEvents(sessionId, {
        windowBytes: HISTORY_TAIL_WINDOW_BYTES,
        maxEvents: HISTORY_TAIL_MAX_EVENTS,
      })
    } catch (err) {
      log.warn(`尾部读失败 ${sessionId}：${err?.message ?? err}`)
      return null
    }
    if (!tail) return null
    const entries = replayHistory(tail.events)
    const capped = capEntries(entries)
    if (!capped.entries.length) return null
    const traj = capTrajectory(replayTrajectory(tail.events))
    const windowMb = (HISTORY_TAIL_WINDOW_BYTES / 1048576).toFixed(0)
    // 「不是全部」有两处会砍：readTailEvents 那层（窗口 / 事件上限）和这里 capEntries 那层
    // （聊天记录条数上限）。**两层都要算进去**——小会话的窗口盖得住整份日志，唯一会砍它的
    // 就是条数上限，漏了这一层就会「少给了内容却不说」，用户会以为这个会话就这么点。
    const truncated = tail.truncated || capped.dropped > 0
    return {
      entries: capped.entries,
      latest: lastReply(capped.entries, sessionId),
      truncated,
      // 这话得分开说：① 窗口只够日志的尾部——那是「这个会话很大」；② 窗口盖住了整份，
      // 只是条数到了上限——那跟大小无关，不能也对用户说「很大」。
      note: truncated
        ? (tail.whole
          ? `只显示最近一段（读取上限：${HISTORY_MAX_ENTRIES} 条）`
          : `这个会话很大，只显示最近一段（读取上限：${HISTORY_MAX_ENTRIES} 条 / ${windowMb}MB 窗口）`)
        : null,
      // 轨迹那一份的「不是全部」由 store 自己说（它知道轨迹的上限），这里只把
      // 「被砍了多少条」交出去——读取窗口那一层的截断在上面 note 里已经说过一次了。
      trajectory: traj.turns,
      trajectoryDropped: traj.dropped,
    }
  }

  /**
   * 确保某个会话的完整历史就位。
   *
   * 不 await：这是个补数据的后台动作。刚切过去时界面先显示手里那份（或「正在读」），
   * 读完广播一份新快照，手机上那一串自然就补全了。
   */
  async function ensureHistory(sessionId) {
    if (!sessionId || historyPending.has(sessionId)) return
    // 服务没到位（headless 组合）就没得读。**不能装作在读**——那会让手机上一直
    // 显示「正在读取这个会话的记录…」，而其实谁也没去读。
    if (typeof treeServices.query?.readSession !== 'function') return
    const hit = historyCache.get(sessionId)
    if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return

    // 先占坑：手机显示「正在读」靠的就是这个标记，**必须同步到位**——
    // 同步部分走完之前不能让快照说「读完了」，否则刚绑定那一下会显示成空会话。
    historyPending.add(sessionId)

    // 盘上有日志就自己读那个窗口，不请内核那条「整份读」。2026-09-28 在本机实测
    // （1432 份会话日志的副本上跑的，见提交信息）：内核那条每读一个会话都要先把
    // **全部会话列两遍**——`corpus.load` 里一遍、v3→v4 迁移前又一遍，每遍 0.8–1.2 秒
    // ——再解整份日志、逐条克隆。1MB 的会话也要 1.7–3.6 秒；**贵的不是日志，是那两遍枚举**。
    // 自己读同一个会话：1MB 约 0.17 秒、5MB 约 0.24 秒，跟日志大小成正比、跟会话总数无关。
    // 手机点一个没选中的会话等的就是这一段，所以这条是日常路。
    //
    // 只有「盘上找不到日志」才回退内核那条：那会儿是刚建、还没落盘的会话，它给的是
    // 内存里现成的那份，不读盘、也不做迁移，正好免费。会话活着（跑着）时内核那条也不贵，
    // 但不为它分叉——大日志的活会话本来就一直走窗口读，行为是一致的；窗口读拿到的是
    // 日志尾部，刚发生、还没落盘的条目由 store 的 mergeHistory 按时间戳接在后面。
    let got = null
    try {
      if (findSessionLog(sessionId)) {
        got = readTailHistory(sessionId)
      } else {
        got = await readHistory(sessionId)
      }
    } finally {
      // 读不出来也记一笔（空结果），免得每次点进来都去读一遍坏文件。
      if (historyCache.size >= 20) historyCache.clear()
      historyCache.set(sessionId, {
        at: Date.now(),
        entries: got?.entries ?? null,
        latest: got?.latest ?? null,
        truncated: got?.truncated === true,
        note: got?.note ?? null,
        trajectory: got?.trajectory ?? null,
        trajectoryDropped: got?.trajectoryDropped ?? 0,
      })
      historyPending.delete(sessionId)
      server?.broadcast('state', store.snapshot())
    }
  }

  // store 取「完整历史」的地方（它拿不到 ctx，所以由插件注入一个回调）。
  store.setReplaySource((sessionId) => {
    const hit = historyCache.get(sessionId)
    if (hit) {
      return {
        entries: hit.entries,
        latest: hit.latest,
        pending: false,
        // 「这不是全部」要和内容一起给出去：手机得说清楚，不能让人以为
        // 这个会话只有这么点内容（读历史有上限，见 HISTORY_MAX_* 那组常量）。
        truncated: hit.truncated === true,
        note: hit.note ?? null,
        // 同一份记录里重放出来的执行轨迹（「完整」模式要的过程区）。
        // store 会把它和内存里那份合成一张表，见 store.trajectoryOf。
        trajectory: hit.trajectory ?? null,
        trajectoryDropped: hit.trajectoryDropped ?? 0,
      }
    }
    if (historyPending.has(sessionId)) return { entries: null, latest: null, pending: true }
    return null
  })

  // ------------------------------------------------------------------
  // 子智能体（2026-10-03 用户要求：把电脑端「子智能体」搬到手机）
  //
  // 和会话树同一套拿法：走 ctx.inject，服务不在就退回「没这个能力」。**不写进
  // `inject` 数组**——写进去，headless 组合下这个服务永远不来，插件就整个不加载了
  // （这个坑上面刚踩过，见 inject 那行的注释）。
  //
  // 三条路都**在进程内直接调 DSH 的服务**，不经过任何 HTTP / WebSocket：
  //   `subagents`           子代理编排服务（列表、停止、继续）
  //   `sessionProjections`  投影注册表（耗时、用量）
  //   `sessions`            会话存储（不读日志就能拿到 Session 对象）
  //
  // 插件和它们同在一个进程里，这是它比桌面前端占便宜的地方：桌面前端只能隔着
  // 一条 WebSocket 问，而那条线上只开了 `prompt` / `interruptByParent` 两个口子；
  // 列表和运行记录它反而拿不到，得靠投影另推一份。
  // ------------------------------------------------------------------
  const subagentServices = { runtime: null, projections: null, sessions: null }
  ctx.inject(['subagents'], (subCtx) => {
    subagentServices.runtime = subCtx.subagents ?? null
    // 和会话树那句同一个道理：配置里有不等于运行时真的提供了，这一句是唯一的事实来源。
    console.log('[dsh-remote-lite] 子智能体服务已就绪：' + Boolean(subagentServices.runtime))
  })
  ctx.inject(['sessionProjections'], (projCtx) => {
    subagentServices.projections = projCtx.sessionProjections ?? null
  })
  ctx.inject(['sessions'], (sessCtx) => {
    subagentServices.sessions = sessCtx.sessions ?? null
  })

  /**
   * DSH 那几个失败代号 → 一句人话。说不上来的照原样带出去，**不吞也不编**。
   *
   * 代号取自 dsh-subagent 的 `SubagentError.code`。头三句是手机上真点得到的三种：
   * 父会话不在线、同时跑的数量满了、这道子智能体接不了话。
   */
  const SUBAGENT_FAILURES = {
    PARENT_UNAVAILABLE: '它在的那个会话不在线了，这条发不过去。',
    ACTIVATION_LIMIT_REACHED: '同时能跑的子智能体已经到上限了，等一个跑完再试。',
    NOT_RESUMABLE: '这道子智能体没有对话可以接，只能看它跑过什么。',
    UNAUTHORIZED: '这道子智能体不在当前会话名下。',
    DRAINING: '它正在收尾，这会儿不接受新消息。',
    ACTIVATION_CLOSING: '它正在停下，等停稳了再试。',
    CONTINUATION_UNAVAILABLE: '这台电脑上的 DSH 没开「继续子智能体对话」这条路。',
    PERSISTENCE_UNAVAILABLE: '这台电脑上的 DSH 没开会话记录，接不了话。',
    CANCELLED: '这条请求已经取消了。',
  }
  function subagentFailure(err, what) {
    const code = err?.code
    if (typeof code === 'string' && SUBAGENT_FAILURES[code]) return SUBAGENT_FAILURES[code]
    return `${what}：${err?.message ?? err}`
  }

  /**
   * 每一行要的那两个数：耗时、用量。
   *
   * 都从 DSH 自己的投影里读（`subagentTiming` / `tokenUsage`），**不自己拿事件累加**——
   * 自己算出来的数和电脑上那一栏对不上，用户一眼就看得出来。读不到就给 null，
   * 页面上显示「—」：给 0 会被读成「真的一次都没跑过」，那是另一句话。
   *
   * 会话对象从 `sessions.get` 拿：内存里现成的，**不读日志**。老早跑完、进程里
   * 已经不在的那些拿不到——那就如实空着，不为数字好看去读它整份日志。
   */
  function subagentMetrics(childId) {
    const session = subagentServices.sessions?.get?.(childId)
    const projections = subagentServices.projections
    if (!session || typeof projections?.snapshot !== 'function') {
      return { tokens: null, durationMs: null, lastTurnCompleted: null }
    }
    let values
    try {
      values = projections.snapshot(session, ['subagentTiming', 'tokenUsage'])?.values
    } catch (err) {
      return { tokens: null, durationMs: null, lastTurnCompleted: null }
    }
    let durationMs = null
    // 「最近跑完的那一轮是正常收尾的」——页面上拿它区分绿点（真的干完了）和灰点（
    // 没在跑，但不知道最后是怎么结束的）。读不到就给 null，别猜成「成功」。
    let lastTurnCompleted = null
    const timing = values?.subagentTiming
    if (timing) {
      // 跑完的轮次累加在 settledMs；还开着的那一轮按投影记的切面算，**不用 Date.now()**
      // ——那会读出一个投影没盖到的时间，和电脑上对不上。
      const settled = Number(timing.settledMs) || 0
      const active = timing.active
        ? Math.max(0, (Number(timing.active.through) || 0) - (Number(timing.active.since) || 0))
        : 0
      durationMs = settled + active
      if (typeof timing.lastTurnCompleted === 'boolean') lastTurnCompleted = timing.lastTurnCompleted
    }
    let tokens = null
    const usage = values?.tokenUsage
    if (usage) {
      // 四个桶互不重叠（dsh-token-meter 的注释：思考 token 已算在 output 里，不再加一次）。
      tokens = (Number(usage.uncachedInputTokens) || 0) + (Number(usage.outputTokens) || 0)
        + (Number(usage.cacheReadTokens) || 0) + (Number(usage.cacheWriteTokens) || 0)
    }
    return { tokens, durationMs, lastTurnCompleted }
  }

  /**
   * 当前绑定会话派出的子智能体清单（含后代，按目录顺序）。
   *
   * `listDescendants` 读的是父会话自己的目录**事实**，不加载也不唤醒任何子代理——
   * 所以列一下很便宜，也不会把睡着的子代理弄醒。
   */
  const subagentMetricInflight = new Map()

  async function fillSubagentMetrics(parentSessionId, rows) {
    if (subagentMetricInflight.has(parentSessionId)) return
    const task = (async () => {
      for (const row of rows) {
        if (!row || row.diagnostic) continue
        const metrics = subagentMetrics(row.id)
        server?.broadcast('subagent-metrics', {
          parentSessionId,
          childId: row.id,
          ...metrics,
        })
      }
    })().finally(() => subagentMetricInflight.delete(parentSessionId))
    subagentMetricInflight.set(parentSessionId, task)
  }

  async function readSubagentRows(parentSessionId) {
    const runtime = subagentServices.runtime
    if (!parentSessionId) return { ok: false, error: '手机上还没有绑定会话。' }
    if (typeof runtime?.listDescendants !== 'function') {
      return { ok: false, error: '这台电脑上的 DSH 没提供子智能体。' }
    }
    let rows
    try {
      rows = await runtime.listDescendants(parentSessionId)
    } catch (err) {
      return { ok: false, error: subagentFailure(err, '读不到子智能体') }
    }
    const out = []
    for (const row of rows ?? []) {
      if (!row) continue
      // 有一支目录读不动时，DSH 拿一行「诊断」顶上来（corrupt / unsupported / unavailable）。
      // 如实转达，别当空的吞掉——吞了的表现是「明明有子智能体，却一个都不显示」。
      if (row.kind === 'diagnostic') {
        out.push({ id: String(row.id), diagnostic: String(row.reason ?? 'unavailable') })
        continue
      }
      const metrics = { tokens: null, durationMs: null, lastTurnCompleted: null }
      out.push({
        id: String(row.id),
        parentId: String(row.parentId ?? ''),
        depth: Number(row.depth) || 1,
        // 只有「可续接」谈得上继续聊；两个值之外的都按一次性处理——未知模式不许接话。
        mode: row.mode === 'continuable' ? 'continuable' : 'one-shot',
        label: typeof row.label === 'string' ? row.label : '',
        running: row.activity === 'running',
        tokens: metrics.tokens,
        durationMs: metrics.durationMs,
        lastTurnCompleted: metrics.lastTurnCompleted,
      })
    }
    return { ok: true, subagents: out, boundSessionId: parentSessionId }
  }

  async function listSubagents(parentSessionId, { includeMetrics = true, scheduleMetrics = false } = {}) {
    if (!parentSessionId) return readSubagentRows(parentSessionId)
    const cached = !includeMetrics ? subagentCache.get(parentSessionId) : null
    const rows = cached
      ? { ok: true, subagents: cached, boundSessionId: parentSessionId }
      : await readSubagentRows(parentSessionId)
    if (!rows.ok) return rows
    if (includeMetrics) {
      rows.subagents = rows.subagents.map((row) => row.diagnostic
        ? row
        : { ...row, ...subagentMetrics(row.id) })
    }
    if (!cached) subagentCache.set(parentSessionId, rows.subagents)
    if (scheduleMetrics && !includeMetrics) {
      setTimeout(() => { fillSubagentMetrics(parentSessionId, rows.subagents) }, 0).unref?.()
    }
    return rows
  }

  /**
   * 某个子智能体**自己的运行过程**。
   *
   * 数据来源和主会话**完全同一条**：`sessionQuery.readSession(childId)` 拿原始事件，
   * `replayHistory` 重放成聊天记录（和实时那条路共用同一个提取器）。电脑端「点进去
   * 看它跑了什么」看的也是它自己的会话记录，两边因此长得一样——各写一套迟早会走散。
   *
   * 地址是手机传上来的，**不能拿它当权限**：先确认它真的挂在当前绑定会话名下。
   */
  async function subagentTranscript(childId, parentSessionId) {
    if (!childId) return { ok: false, error: '没说要读哪一道子智能体。' }
    const listed = await listSubagents(parentSessionId, { includeMetrics: false, scheduleMetrics: false })
    if (!listed.ok) return listed
    const row = listed.subagents.find((s) => s.id === childId)
    if (!row) return { ok: false, error: '这道子智能体不在当前会话名下。' }
    const q = treeServices.query
    if (typeof q?.readSession !== 'function') {
      return { ok: false, error: '这台电脑上的 DSH 没提供读取会话记录的能力。' }
    }
    let snap
    try {
      snap = await q.readSession(childId)
    } catch (err) {
      return { ok: false, error: subagentFailure(err, '读不到它的记录') }
    }
    const events = Array.isArray(snap?.events) ? snap.events : []
    if (!events.length) {
      // 一次性子智能体跑完、记录已被回收时就是这里。**如实说没有记录**，不拿
      // 「读不到」冒充「它没干过活」——这两件事对用户含义不同。
      return {
        ok: true, mode: row.mode, running: row.running,
        entries: [], reclaimed: true, truncated: false, note: null,
      }
    }
    const capped = capEntries(replayHistory(events))
    return {
      ok: true,
      mode: row.mode,
      running: row.running,
      entries: capped.entries,
      reclaimed: false,
      truncated: capped.dropped > 0,
      note: capped.dropped > 0 ? `只显示最近一段（读取上限：${HISTORY_MAX_ENTRIES} 条）` : null,
    }
  }

  /**
   * 停：只停**当前这一轮**，不销毁这道子智能体（排队里的消息、它的后代都留着）。
   *
   * 权限走「人」这条：`interruptByParent(childId, parentSessionId, mode)` 拿这三个当凭据，
   * 它**不做父 Agent 在线检查**——这正是「父会话不在线，也能停下正在跑的它」的原因。
   * 一次性的没有可停的轮次，这里就挡掉，不往 DSH 递。
   */
  async function stopSubagent(childId, parentSessionId, mode) {
    const runtime = subagentServices.runtime
    if (!childId) return { ok: false, error: '没说要停哪一道子智能体。' }
    if (!parentSessionId) return { ok: false, error: '手机上还没有绑定会话。' }
    if (mode !== 'continuable') {
      return { ok: false, error: '这是一次性子智能体，跑完就结束，没有可停的轮次。' }
    }
    if (typeof runtime?.interruptByParent !== 'function') {
      return { ok: false, error: '这台电脑上的 DSH 没提供停止子智能体的能力。' }
    }
    try {
      await runtime.interruptByParent(childId, parentSessionId, 'continuable')
    } catch (err) {
      return { ok: false, error: subagentFailure(err, '停不下来') }
    }
    // 和主会话那条同一个口径：递进去不等于停稳，界面上得等它的状态翻过来。
    return { ok: true }
  }

  /**
   * 继续：往这道子智能体里递一句**人**的话。
   *
   * `prompt` 把这条记成 `source.kind === 'user'`（带 rpcId），也就是「你在它旁边说了
   * 一句」，而不是「别的 agent 转达的」。delivery 选 queue（排到它当前这轮之后）——
   * 和手机自己对主会话的做法一致：主会话正在跑时，手机上发的指令也是排队，不打断。
   *
   * requestId 是这条消息的身份，**每次都得新铸一个**：复用同一个会被判成重复投递。
   */
  async function askSubagent(childId, parentSessionId, mode, text) {
    const runtime = subagentServices.runtime
    if (!childId) return { ok: false, error: '没说要跟哪一道子智能体说话。' }
    if (!parentSessionId) return { ok: false, error: '手机上还没有绑定会话。' }
    if (!text) return { ok: false, error: '话是空的。' }
    if (mode !== 'continuable') {
      return { ok: false, error: '这是一次性子智能体，跑完就结束了，接不了话。' }
    }
    if (typeof runtime?.prompt !== 'function') {
      return { ok: false, error: '这台电脑上的 DSH 没提供继续子智能体对话的能力。' }
    }
    let requestId
    try {
      requestId = randomUUID()
    } catch (err) {
      // 兜底：uuid 拿不到也不该让这句话发不出去。
      requestId = 'mini-' + Date.now() + '-' + randomBytes(8).toString('hex')
    }
    try {
      const receipt = await runtime.prompt({
        requestId,
        parentSessionId,
        childSessionId: childId,
        mode: 'continuable',
        delivery: 'queue',
        content: [{ type: 'text', text }],
      })
      return { ok: true, messageId: receipt?.messageId ? String(receipt.messageId) : null }
    } catch (err) {
      return { ok: false, error: subagentFailure(err, '这句话没送出去') }
    }
  }

  // ------------------------------------------------------------------
  // 手机上答题：把电脑这边的提问推到手机，等它答，再把答案交还给电脑。
  //
  // 三条要点，都是踩过或想清楚了才这么写的：
  //
  // ① **必须 `{ prepend: true }`**。这条链是「遇到第一个愿意接的人就停」，而电脑上的
  //    浏览器（经由 `dsh-api-remotes`）本来就接这个提问——排在它后面就永远轮不到我。
  //    实测过：不带 prepend 时，挂根上、挂到 Agent 范围内，**两处都收不到**。
  //
  // ② **不接就让路**（`next()`）。手机没连着、问的不是手机上绑着的那个会话、
  //    提问是空的——任何一种情况都原样让给浏览器，电脑那边照常弹窗，行为不变。
  //    **插队不是为了抢，是为了有得选。**
  //
  // ③ **手机没了就把问题还回去**。用户选的是「一直等，不还回电脑」，但那不等于
  //    「手机都关了他还等」——那种情况下电脑会永远卡住、而且没人提醒他。所以判据
  //    不是倒计时，是「手机还在不在」。
  // ------------------------------------------------------------------

  // **注意这个监听器不是 async，这是刻意的，不是漏写。**
  //
  // 顾问指出的关键一条（对照 DSH 自己那个转发给远端的监听器，写法完全一致）：
  // **「接不接」必须在同步的那一瞬间定下来，异步只用来产答案。**
  // 它的形状是：同步判断 → 不接就同步 `return next()` → 接就同步 `return 一个将来会有答案的东西`。
  //
  // 我上一版是先 `await` 拿到服务、再判断、再 `return next()`——**让路的动作发生在异步之后**，
  // 交不回派发的那个链条，于是表现为"完全没接管"，而且一句错都不报。
  //
  // 另外一条同样是顾问点出来的：**异步函数抛的错，同步的 try/catch 抓不到**（它是被拒绝的
  // Promise，不是抛出的异常）。所以我之前说"日志里没报错"，**根本不能证明没出错**。
  ctx.on('user-questions/request', function (request, next) {
    const agentId = request?.agent?.id ?? null
    const bound = store.snapshot().boundSessionId
    const questions = Array.isArray(request?.questions) ? request.questions : []
    // ——— 同步阶段：只做"接不接"的判断，绝不 await ———
    // 能力从 `miniControl` 这个固定取用点拿（服务启动时主动放进去的），
    // **不再经过 createMiniServer 的回执**——实测那个回执兑现出来是 undefined。
    const phoneReady = typeof miniControl.hasPhone === 'function' ? miniControl.hasPhone() : false
    /**
     * **让路的每一种情况都留一行。**
     *
     * 2026-09-27 用户报「电脑上弹出了选项，手机上什么都没有」。当时这条链上只有
     * 「答好了」和「出错」两句日志——正好把**让路**这半边全留白了，于是只能靠猜：
     * 是手机没连、还是问的不是手机上绑的那个会话，日志里看不出来。
     * **不记题目正文**——那是用户自己的话。
     */
    if (!agentId || agentId !== bound || questions.length === 0) {
      console.log(`[dsh-remote-lite] 提问让路：问的=${agentId ?? '无'}，手机绑的=${bound ?? '无'}，题目数=${questions.length}`)
      return next()
    }
    if (!phoneReady) {
      console.log('[dsh-remote-lite] 提问让路：手机此刻接不上（页面没开、锁屏或断网），交给电脑')
      return next()
    }
    if (typeof miniControl.askPhone !== 'function') {
      console.log('[dsh-remote-lite] 提问让路：拿不到 askPhone（手机服务还没起来），交给电脑')
      return next()
    }
    // ——— 同步交出"将来会有答案"的东西；下面的等待都在这里，不再有同步判断 ———
    console.log(`[dsh-remote-lite] 提问推给手机：${questions.length} 题，等它答`)
    return miniControl.askPhone(questions, agentId).then((answer) => {
      // 手机中途没了：把问题还给电脑，那边照常弹窗——不会两头都答不上。
      // 这一句日志是「手机上答了、电脑上没动静」那类现象唯一能落下来的痕迹：
      // 有它才知道手机那份答案没接上（断线、或者答晚了一步），而不是插件没在跑。
      if (!answer) {
        console.log('[dsh-remote-lite] 手机上没答成（连接断了、或者答晚了），这题还给电脑')
        return next()
      }
      console.log('[dsh-remote-lite] 手机上答好了，交给电脑')
      return answer
    }).catch((err) => {
      // 我这边出任何问题都不能把提问吞掉，一律让回电脑。
      console.log('[dsh-remote-lite] 接管提问出错，让回电脑：' + String(err))
      return next()
    })
  }, { prepend: true })
  // ------------------------------------------------------------------
  // 命令确认（审批）也推到手机上
  // ------------------------------------------------------------------
  // 形状照抄上面那条提问链，**连同它踩过的坑一起抄**：
  // ①监听器不能写成 async——「接不接」必须在同步那一瞬间定下来，异步只用来产答案；
  //   写成先 await 再判断，会让路的动作交不回派发的链条，表现是"完全没接管、且不报错"。
  // ②让路的每一种情况都留一行日志，否则下次报"手机上什么都没有"又只能靠猜。
  // ③**不记正文**：只记工具名，命令原文是用户自己的东西。
  // ④出错一律 next()，绝不把命令确认吞掉。
  ctx.on('approval/request', function (request, next) {
    const agentId = request?.agent?.id ?? null
    const bound = store.snapshot().boundSessionId
    const toolName = request?.toolName ?? '某个工具'
    // 这次到底要跑什么：审批请求只带调用编号，参数在会话事件里记着的那份。
    const command = request?.callId ? (toolCalls.get(String(request.callId)) ?? '') : ''
    const phoneReady = typeof miniControl.hasPhone === 'function' ? miniControl.hasPhone() : false
    const view = {
      toolName: typeof toolName === 'string' && toolName ? toolName : '某个工具',
      reason: typeof request?.reason === 'string' ? request.reason : '',
      command: typeof command === 'string' ? command : '',
    }
    if (!agentId || agentId !== bound) {
      console.log(`[dsh-remote-lite] 审批让路：批的=${agentId ?? '无'}，手机绑的=${bound ?? '无'}`)
      return next()
    }
    if (!phoneReady) {
      console.log('[dsh-remote-lite] 审批让路：手机此刻接不上（页面没开、锁屏或断网），交给电脑')
      return next()
    }
    if (typeof miniControl.askApproval !== 'function') {
      console.log('[dsh-remote-lite] 审批让路：拿不到 askApproval（手机服务还没起来），交给电脑')
      return next()
    }
    console.log(`[dsh-remote-lite] 审批推给手机：${toolName}，等它拍板`)
    return miniControl.askApproval(request, agentId, command).then((outcome) => {
      if (!outcome) {
        console.log('[dsh-remote-lite] 手机上没拍成（连接断了、或者拍晚了），这条还给电脑')
        return next()
      }
      console.log('[dsh-remote-lite] 手机上拍板了：' + outcome)
      return outcome
    }).catch((err) => {
      console.log('[dsh-remote-lite] 接管审批出错，让回电脑：' + String(err))
      return next()
    })
  }, { prepend: true })

  // ------------------------------------------------------------------
  // 手机端「新建会话」要用的服务
  // ------------------------------------------------------------------
  // **单独 inject，绝不能并进上面那个数组**：`ctx.inject` 是「等齐了才回调」，
  // 把一个可能不来的服务并进去，连工作区列表都会一起没了——本来只是少个按钮，
  // 结果整个导航栏都空掉。分开就互不牵连。
  //
  // 拿到的是 `sessionController`（`@deepseek-ai/dsh-api-session-controller` 注册的名字），
  // 就是网页端新建会话走的那条路。它的 `create({ workspaceId })` 内部会拼好会话、
  // 装模型、挂 preset，最后交给 `ctx.agents.create()`。
  //
  // 这行日志是运行时事实的唯一来源：服务到底来没来、`create` 是不是函数，
  // 「配置里挂了」只是推断，这里打出来的才算数。
  const canCreate = { controller: null }
  ctx.inject(['sessionController'], (createCtx) => {
    canCreate.controller = createCtx.sessionController
    console.log('[dsh-remote-lite] 新建会话已就绪：sessionController='
      + Boolean(canCreate.controller) + ' create=' + typeof canCreate.controller?.create)
  })

  // Agent 模式注册表（2026-10-04 用户要求：新建会话时手机上也要能选模式，PC 一直
  // 可以）。**单独 inject**（理由同上：缺一个服务不该连别的都没了）。没有它的时候
  // 手机直接建 DSH 的默认模式，如实说「没有可选的」——不摆一个没得选的选择题。
  const canPresets = { registry: null }
  ctx.inject(['agentPresets'], (presetsCtx) => {
    canPresets.registry = presetsCtx.agentPresets
    console.log('[dsh-remote-lite] Agent 模式清单已就绪：agentPresets=' + Boolean(canPresets.registry))
  })

  // 插件管理服务（手机端「插件」页面用）。
  const pluginServices = { manager: null }
  // DSH 版本号问到一次就记着（版本不会中途变），省得每 30 秒问一趟。
  let cachedDshVersion = ''
  ctx.inject(['pluginManager'], (pCtx) => {
    pluginServices.manager = pCtx.pluginManager
    console.log('[dsh-remote-lite] 插件管理服务已就绪：pluginManager=' + Boolean(pluginServices.manager))
  })

  /**
   * 「内置插件」要用的两样东西（2026-10-04 用户指出：内置插件只显示 6 个是不对的）。
   *
   * DSH 的理念是「一切皆插件、无特权核心」——一整套系统是几百个插件模块拼起来的，
   * 所以「内置插件」的真相不在 npm 包清单里（那是「插件市场」的粒度），
   * 而在 **Cordis Loader 的实时条目表**里。PC 的「设置 → 内置插件」页读的正是它，
   * 分成两块：全局插件（系统与所有会话共用）+ 会话插件（按 Agent 预设组合而成）。
   *
   * 两样都走 ctx.inject（软注入）：拿不到就只少这一块，不整个倒下。
   * `pluginPackages` 只提供显示用的本地化标题/说明，没有它照样能列出来（退成模块名）。
   */
  const invServices = { loader: null, packages: null, settings: null }
  ctx.inject(['loader'], (lCtx) => {
    invServices.loader = lCtx.loader
    console.log('[dsh-remote-lite] Cordis Loader 已就绪（内置插件清单要用）：loader='
      + Boolean(invServices.loader))
  })
  ctx.inject(['pluginPackages'], (pkCtx) => {
    invServices.packages = pkCtx.pluginPackages
    console.log('[dsh-remote-lite] 插件包元数据已就绪：pluginPackages='
      + Boolean(invServices.packages))
  })
  // 设置文档：问「官方插件里注册了设置卡片的那几个，这台部署是不是提供了」。
  ctx.inject(['settings'], (sCtx) => {
    invServices.settings = sCtx.settings
    console.log('[dsh-remote-lite] 设置文档已就绪（官方插件卡片要用）：settings='
      + Boolean(invServices.settings))
  })

  /**
   * 官方插件里「注册了一张设置卡片」的那几个。
   *
   * **为什么只能列在这里**：这几张卡片是**浏览器端**的插件在运行时注册进 Plugins 页的
   * `plugins.item` 插槽的（dsh-client-ui-plugin-manager 读的是 `ctx.slots`），
   * 宿主进程看不见浏览器里的插槽注册表——没有哪条宿主接口能问出来。
   * 所以包 identity、卡片 id、开关注册所用的命名空间、中文文案，
   * 只能照 DSH 0.2.0-rc.2 的客户端源码抄一份（4 个包各注册一张卡）：
   *
   *   dsh-client-ui-settings-shell        id=shell       等 bash-sandbox / pwsh-sandbox
   *   dsh-client-ui-settings-agent-loop   id=agent-loop  等 agent-loop
   *   dsh-client-ui-settings-subagent     id=subagent    等 subagent / subagent-model-selection-settings
   *   dsh-client-ui-settings-web-search   id=web-search  等 web-search-deepseek
   *
   * 文案逐字取自那几个包 `lib/client.js` 里自己的 zh 词典（不自己编）。
   *
   * **出现条件照 DSH 同一条规矩**：宿主的设置文档里 served 了它那几个命名空间才出现
   * （DSH 那边是 `configForms.whileServed(namespaces, …)`）——所以「这台部署没有终端设置」
   * 时，手机上也不会凭空多出一张终端卡。DSH 以后再加官方卡片，这张表要跟着补。
   */
  const OFFICIAL_CARDS = [
    { id: 'shell', namespaces: ['bash-sandbox', 'pwsh-sandbox'], title: '终端',
      description: '限制每条命令最多能跑多久、最多输出多少内容。' },
    { id: 'agent-loop', namespaces: ['agent-loop'], title: 'Agent 循环',
      description: '控制 Agent 派发工具调用的方式。' },
    { id: 'subagent', namespaces: ['subagent', 'subagent-model-selection-settings'], title: '子智能体',
      description: '设置子智能体的递归层级、数量和模型。' },
    { id: 'web-search', namespaces: ['web-search-deepseek'], title: '网页搜索',
      description: '设置 DeepSeek 的搜索提供方。' },
  ]

  // ------------------------------------------------------------------
  // 手机上传文件要用的附件服务
  // ------------------------------------------------------------------
  // 同样走 ctx.inject、不写进 inject 数组（理由同上）。没有它的时候上传按钮会
  // 如实说「这台电脑传不了文件」，而不是让用户点了没反应。
  ctx.inject(['attachments'], (attachCtx) => {
    attachments = attachCtx.attachments
    console.log('[dsh-remote-lite] 附件服务已就绪：可以接收手机上传的文件')
  })

  // ------------------------------------------------------------------
  // 斜杠指令账本
  // ------------------------------------------------------------------
  // 走 ctx.inject、不写进 inject 数组（理由同上）。**指令列表不属于这个插件**：
  // 它是 DSH 的账本，别的插件往里注册。手机只是多了一个「能发起指令的界面」——
  // 所以这里不认识任何一条具体指令，也就不会有「手机上少了一条」的问题。
  ctx.inject(['commands'], (cmdCtx) => {
    commandService = cmdCtx.commands
    console.log('[dsh-remote-lite] 指令服务已就绪：手机上可以执行斜杠指令')
  })

  /**
   * 手机要的那份指令名单。
   *
   * 三种「拿不到」要分开说，因为下一步动作完全不同：没绑会话 / 会话没在跑 /
   * 这台电脑没有指令服务。合成一句「取不到指令」，用户不知道该去做什么。
   */
  function onCommands() {
    const sessionId = targetSessionId()
    if (!sessionId) return { ok: false, error: '电脑上还没有可遥控的会话。' }
    const agent = ctx.agents.get(sessionId)
    if (!agent) {
      return { ok: false, error: '这个会话现在没在跑，指令要先让它跑起来（发一句话）。' }
    }
    if (agent.session?.header?.origin === 'subagent') {
      return { ok: false, error: '这是个子 Agent，手机上用不了它的指令。' }
    }
    if (!commandService) return { ok: false, error: '这台电脑上的 DSH 没提供指令。' }
    try {
      return { ok: true, commands: describeCommands(commandService.list(agent)) }
    } catch (err) {
      return { ok: false, error: `取指令列表失败：${err?.message ?? err}` }
    }
  }

  /**
   * 执行一条斜杠指令。
   *
   * **照抄 DSH 自己的语义，不自己发明**：指令行以 `/` 开头、名字是小写字母打头，
   * 名字后面原样的一段归指令自己解释（我们连那个分隔空格都不动）。满足形状、
   * 又确实注册过的，才交给 `execute`；其余一律**拒绝并说明**，绝不退回去当普通消息
   * 发给模型——那正是「打错的指令白跑一轮模型」的来源。
   *
   * 这里**不等它跑完**（`execute` 要到处理器结束才 resolve）：指令的进度和结果是通过
   * 会话事件（command/run、command/done）推到手机上的，和电脑端同一份账。
   * 等它跑完会让这条 HTTP 请求一直挂着——像 /compact 这种要跑十几秒的指令，
   * 手机上就成了「点了没反应」。
   *
   * 附件**这一版递不进去**：`execute` 要的是 DSH 自己那套上传小票，而手机上传走的是
   * 另一套存储，两者不通（2026-09-25 查证）。所以这里一个附件都不传——输入框里那些
   * 附件会原样留着，跟下一条普通消息一起发出去，不会丢。
   */
  async function onCommand(line) {
    const sessionId = targetSessionId()
    if (!sessionId) return { ok: false, error: '电脑上还没有可遥控的会话。' }
    const agent = ctx.agents.get(sessionId)
    if (!agent) {
      return { ok: false, error: '这个会话现在没在跑，指令要先让它跑起来（发一句话）。' }
    }
    if (agent.session?.header?.origin === 'subagent') {
      return { ok: false, error: '这是个子 Agent，手机上用不了它的指令。' }
    }
    if (!commandService) return { ok: false, error: '这台电脑上的 DSH 没提供指令。' }

    const parsed = parseSlashLine(line)
    if (!parsed) return { ok: false, error: invalidCommandMessage() }
    if (!commandService.find(agent, parsed.name)) {
      return { ok: false, error: unknownCommandMessage(parsed.name) }
    }

    // 不等：结果走事件流。但仍要接住异常，否则会变成没人处理的 Promise 拒绝，
    // 在这台机器上表现为进程级的告警，而手机上什么也看不到。
    const signal = new AbortController().signal
    Promise.resolve(commandService.execute(agent, line, [], signal)).catch((err) => {
      log.warn(`指令 /${parsed.name} 执行异常：${err?.message ?? err}`)
    })
    return { ok: true }
  }

  /**
   * 把手机传来的字节交给 DSH 存，换一张小票回来。
   *
   * 为什么不自己存到某个目录、再在指令文字里写一行路径：DSH 的消息结构里本来就有
   * 附件这种块，它会在发请求前自动把附件换成一段带路径的提示给模型读。文件名消毒、
   * 内容寻址、只读副本、引用校验全是它的事。自己拼路径等于把这些统统绕过去，还要
   * 自己管清理、自己保证不把文件塞进工作区。
   *
   * `data` 是请求流本身（Node 的 IncomingMessage 就是异步可迭代的字节流），DSH 那边
   * 是边收边落盘，不在内存里攒整份。
   */
  async function onUpload({ data, name }) {
    if (!attachments) throw new Error('这台电脑上的 DSH 没装附件服务')
    const ref = await attachments.saveFileStream({ data, ...(name ? { name } : {}) })
    const uploadId = randomUUID()
    uploads.set(uploadId, ref)
    // 别让它无限涨：手机传完却一直不发指令的话，这些引用就一直挂着。
    // 按插入顺序淘汰最早的——手机上同时挂着二十个待发文件不现实。
    if (uploads.size > MAX_PENDING_UPLOADS) {
      uploads.delete(uploads.keys().next().value)
    }
    return { uploadId, name: ref.name, bytes: ref.bytes }
  }

  /** 把小票换成附件引用。认不出来的小票直接丢掉，不猜。 */
  function takeUploads(uploadIds) {
    const refs = []
    for (const id of Array.isArray(uploadIds) ? uploadIds : []) {
      const ref = uploads.get(id)
      if (ref) {
        refs.push(ref)
        uploads.delete(id) // 用掉就作废，同一条不能发两次
      }
    }
    return refs
  }

  // 插件自己在事件流里见过的标题——内存里就有，不用去读日志。
  function knownTitles() {
    const map = new Map()
    for (const s of store.snapshot().sessions ?? []) {
      if (s.title) map.set(s.id, s.title)
    }
    return map
  }

  // 权限档位。跟建会话一样**单独一条 inject**：这个服务依赖 ctx.shell 和
  // ctx.approval，headless 组合里根本不存在。要是跟别的服务挤在同一条 inject 里，
  // 它不到场会把那条 inject 上的其它服务一起拖住——本项目在 tree 那三件套上
  // 踩过这个坑，上面有注释。
  const presets = { service: null }
  ctx.inject(['permissionPresets'], (permCtx) => {
    presets.service = permCtx.permissionPresets
    console.log('[dsh-remote-lite] 权限档位已就绪：'
      + (presetsAvailable(presets.service) ? presets.service.names.join(' / ') : '拿不到'))
  })

  // 审批通道。同款做法：**单独一条 inject**，因为它也可能不到场（headless 组合里就没有）。
  // 到场了，手机才有机会接住命令确认；不到场就什么都不做，电脑端原来的弹窗照旧。
  const approvals = { service: null }
  ctx.inject(['approval'], (approvalCtx) => {
    approvals.service = approvalCtx.approval ?? null
    console.log('[dsh-remote-lite] 审批通道已就绪：'
      + (approvals.service ? '拿得到' : '拿不到'))
  })

  /**
   * 按 id 取会话对象。
   *
   * `PermissionPresetService` 的读和写都收**会话对象**而不是 id
   * （`current(session)` / `set(session, name)`），所以得先拿 agent 再取它的 session。
   * 拿不到就回 null——手机那边会显示「暂时读不到」，而不是整页崩掉。
   */
  function sessionFor(sessionId) {
    if (!sessionId) return null
    try {
      return ctx.agents?.get(sessionId)?.session ?? null
    } catch (err) {
      return null
    }
  }

  /**
   * 取一份「本地化文案」里的中文。
   *
   * 形状是 LocalizedText：一个字符串，或 `{ en, 'zh-CN', … }` 这种按语言分份的对象。
   * 插件的标题和说明都是这个形状——不挑语言直接读，官方插件在手机上就全是英文。
   * 没有中文退英文，再没有就取第一个非空串；都没有返回空串（调用方自己决定怎么兜）。
   */
  function localizedText(v) {
    if (typeof v === 'string') return v
    if (!v || typeof v !== 'object') return ''
    for (const k of ['zh-CN', 'zh-Hans', 'zh', 'en']) {
      if (typeof v[k] === 'string' && v[k]) return v[k]
    }
    for (const val of Object.values(v)) if (typeof val === 'string' && val) return val
    return ''
  }

  /**
   * Loader 条目的 Fiber 状态码 → 词。照 dsh-host-plugin-inventory 里那张表：
   * 0 待定 / 1 加载中 / 2 运行中 / 3 失败 / 4 已销毁（报 null）/ 5 卸载中。
   */
  const FIBER_PHASE = ['pending', 'loading', 'active', 'failed', null, 'unloading']

  /**
   * 一个 Agent 模式（预设）拿给用户看的名字与说明。
   *
   * 政策照 PC：**声明里自带名字的（自建模式）用它自己的**，没名字的（内置那几档）
   * 才落 AGENT_MODE_COPY；认不出又没名字的落 null——如实，不瞎起名。
   *
   * 抽出来是因为两处要用：手机上「选模式」的清单，以及插件页「会话插件」按预设分组。
   * （2026-10-05 实测抓到：分组那儿漏了这一步，页面上露出 standard / ptc / cordis
   * 这种英文代号——组合清单里的 name 是预设声明的原名，不是给用户看的名字。）
   */
  function presetCopyOf(p) {
    const copy = AGENT_MODE_COPY[p?.id]
    const hasName = typeof p?.name === 'string' && p.name
    const hasDesc = typeof p?.description === 'string' && p.description
    return {
      id: p?.id,
      name: hasName ? p.name : (copy ? copy[0] : null),
      description: hasDesc ? p.description : (copy ? copy[1] : null),
      broken: typeof p?.broken === 'string' ? p.broken : null,
    }
  }

  const nav = {
    listWorkspaces: (runningIds, force, includeEmpty) =>
      listWorkspaces({ registry: treeServices.registry, query: treeServices.query, runningIds, force, includeEmpty, meta: sessionMeta }),
    listSessionsOf: (workspaceId, limit, force, onTitle) =>
      listSessionsOf({
        registry: treeServices.registry,
        query: treeServices.query,
        agents: ctx.agents,
        knownTitles: knownTitles(),
        persisted: titles,
        workspaceId,
        limit,
        force,
        onTitle,
        meta: sessionMeta,
      }),
    // 建会话：先用 inject 拿到的那个，拿不到就现读一次——`ctx.get` 对没写进 inject
    // 的服务名是**返回 undefined**（不是抛错），所以这么写是安全的。
    createSession: (workspaceId, agentPreset) =>
      createSessionIn({
        controller: canCreate.controller ?? ctx.get('sessionController'),
        registry: treeServices.registry,
        workspaceId,
        agentPreset,
      }),
    // 归档与删除（2026-10-25）。三件不同的事，名字上不许混：
    //   archiveSession   —— 一个会话，移出列表、可恢复
    //   archiveWorkspace —— 一个文件夹下的全部会话，同样可恢复
    //   deleteWorkspace  —— 工作区注册本身，DSH 原生动作，不可恢复（会话日志仍在磁盘）
    archiveSession: (sessionId, stopActivity) => archiveOneSession(sessionId, stopActivity),
    archiveWorkspace: (workspaceId) => archiveWholeWorkspace(workspaceId),
    deleteWorkspace: (workspaceId, archiveSessions) => removeWorkspace(workspaceId, archiveSessions),
    // 永久删除：先归档再删日志目录（见 hardDeleteSession 的四步）。不可恢复。
    deleteSessionForever: (sessionId) => hardDeleteSession(sessionId),
    // 执行面板上有没有立绘。没有返回 null，界面就不会留位置（见 page.js 的 artFileName）。
    artFileName,
    afterArchive,
    // Agent 模式清单（2026-10-04）：手机新建会话时挑模式用。坏档也如实给（broken），
    // 拿不到能力就说 unavailable——不摆一个没得选的选择题。默认哪一档由
    // registry 的 defaultId 说（那是 DSH 自己的默认，不猜）。
    //
    // 名字照抄 PC 的词条表（见 AGENT_MODE_COPY，用户 2026-10-04 点名「模式选择应该
    // 为中文」）。政策也照 PC：**声明里自带名字的（自建模式）用它自己的**，没名字的
    // （内置档）才落词条表；认不出又没名字的才落 id——如实，不瞎起名。
    agentPresets: async () => {
      const svc = canPresets.registry ?? ctx.get('agentPresets')
      if (!svc || typeof svc.list !== 'function') return { ok: false, reason: 'unavailable' }
      try {
        const list = await svc.list()
        return {
          ok: true,
          defaultId: typeof svc.defaultId === 'string' ? svc.defaultId : null,
          presets: (Array.isArray(list) ? list : []).map(presetCopyOf),
        }
      } catch (err) {
        return { ok: false, reason: 'failed', error: String(err?.message ?? err) }
      }
    },
    // 技能清单与正文（2026-10-25）：手机输入框打 `@` 时列出来，
    // 选中后把正文拼进提示词。**只走本地服务调用，不引入任何新的模型侧协议**，
    // 所以对延迟的影响就是一次内存查询。
    listSkills: () => listSkills(),
    getSkill: (name) => getSkill(name),
    // 「这一刻到底能不能建会话」。给 /mini/api/version 用：那是个不用动手、
    // 一条命令就能问的运行时事实，比翻日志快。和 createSession 同一条判据，
    // 免得出现「探测说能、真按了却不行」。
    canCreateSession: () =>
      typeof (canCreate.controller ?? ctx.get('sessionController'))?.create === 'function',
    // 登记工作区。`workspaceRegistry` 就是上面那三个服务里的 registry，
    // 已经注入到位了，不用再开一条依赖。
    createWorkspace: (path) =>
      createWorkspaceAt({ registry: treeServices.registry, path }),
    // 权限档位。作用域就是传进来的那个会话——手机只绑一个会话，所以
    // 「当前会话」和「绑定会话」是同一件事，不用另外记状态。
    permissions: (sessionId) =>
      listPresets({ service: presets.service, session: sessionFor(sessionId) }),
    setPermission: (sessionId, name) =>
      setPreset({ service: presets.service, session: sessionFor(sessionId), name }),

    // 子智能体（2026-10-03）。四条都取**当前绑定会话**那一份，和上面 send / stop
    // 同一套口径：手机上遥控的是你正看着的那个会话，不该牵动你在电脑上另开的那个。
    subagents: (sessionId, options) => listSubagents(sessionId, options),

    /**
     * 插件清单（手机端「插件」页面用，2026-10-04）。
     *
     * 字段照 DSH 的 `BundleInfo`（pluginManager 的契约，逐字段对过）：
     *   name / version / installed / optional / enabled / description
     *   meta: { title?, description? } —— **本地化文案**，中文说明在这一份里；
     *   error: { code, diagnostic? } —— 出问题的那一笔。
     *
     * 两处不照抄会难看：① 只取 `description`（包的英文说明），
     * PC 上那句中文「启用团队协作、团队工具……」来自 `meta.description`，得优先用它；
     * ② `error` 是个对象，直接递出去页面上会显示 `[object Object]`。
     */
    /**
     * 正在跑的这只 DSH 是哪个版本（设置页底部那行用，2026-10-04）。
     *
     * **为什么不读文件**：早先这里去翻 `node_modules/@deepseek-ai/dsh/package.json`，
     * 两个毛病都踩了——① 那是「命令行那份 dsh」的版本，未必等于正在跑的这只 Host
     * （实测桌面端跑的是 0.2.0-rc.2，而命令行那份写着 0.2.0-rc.1）；
     * ② 桌面端的工作目录里压根没有那个文件，于是手机上一直显示 `unknown`。
     *
     * 改问正在跑的这只 Host：它自己报的运行时版本才作数。问到一次就记住。
     */
    dshVersion: async () => {
      if (cachedDshVersion) return cachedDshVersion
      const mgr = pluginServices.manager ?? ctx.get('pluginManager')
      try {
        // 这个接口本意是列「版本豁免」，但它捎带把运行时版本报出来了
        // ——宿主唯一一处直接说「我是哪个版本」的地方。
        const got = await mgr?.listVersionExemptions?.()
        if (typeof got?.runtimeVersion === 'string' && got.runtimeVersion) {
          cachedDshVersion = got.runtimeVersion
          return cachedDshVersion
        }
      } catch (err) {
        // 问不到就往下一步退，不把设置页那行弄崩。
      }
      try {
        // 退一步：核心包自己的版本就是 DSH 的版本（整个仓库一起发版）。
        const bundles = await mgr?.listBundles?.()
        const base = (bundles || []).find((b) => b?.name === '@deepseek-ai/dsh-base')
        if (typeof base?.version === 'string' && base.version) {
          cachedDshVersion = base.version
          return cachedDshVersion
        }
      } catch (err) {
        // 都没有就如实说不知道（页面据此整行不显示，不拿 unknown 糊一行）。
      }
      return 'unknown'
    },

    pluginList: async () => {
      const mgr = pluginServices.manager ?? ctx.get('pluginManager')
      if (!mgr) return { ok: false, reason: 'unavailable' }
      try {
        const bundles = await mgr.listBundles()
        return {
          ok: true,
          bundles: (bundles || []).map((b) => ({
            name: b?.name ?? '',
            // 显示名优先用本地化标题（官方插件在 PC 上显示的是「智能体团队」而不是包名），
            // 没有就退回包名——第三方插件多半没有标题。
            title: localizedText(b?.meta?.title) || b?.name || '',
            description: localizedText(b?.meta?.description) || b?.description || '',
            version: typeof b?.version === 'string' ? b.version : '',
            installed: b?.installed === true,
            optional: b?.optional === true,
            enabled: b?.enabled !== false,
            // 出问题的那一笔：有原话就说原话，没有就报错误码。没它就别硬编。
            problem: b?.error ? (b.error.diagnostic || b.error.code || '有问题') : '',
          })),
        }
      } catch (err) {
        return { ok: false, reason: String(err?.message || err) }
      }
    },

    /**
     * 内置插件清单（手机端「插件 → 已安装 → 内置」用，2026-10-04 补）。
     *
     * **为什么不是 listBundles**：那是 npm 包的粒度（十几个），答不了「内置插件有多少」。
     * DSH 是「一切皆插件、无特权核心」，一整套系统由几百个插件模块拼成，真相在
     * Cordis Loader 的实时条目表里。PC 的「设置 → 内置插件」页就是读这里，分两块：
     *   全局插件 = Loader 自己的条目（系统与所有会话共用）；
     *   会话插件 = 各 Agent 预设的组合行（预设挂载后才在会话里跑）。
     *
     * 读取逻辑照 `dsh-host-plugin-inventory`（那是只读投影，我们直接读同几个源：
     * loader.entries() / agentPresets.compositionInventory() / pluginPackages.metaOf()），
     * 因为它在宿主服务目录里查不到，只能按它的实现来。
     */
    pluginInventory: async () => {
      const loader = invServices.loader ?? ctx.get('loader')
      if (!loader || typeof loader.entries !== 'function') {
        return { ok: false, reason: 'unavailable' }
      }
      const packages = invServices.packages ?? ctx.get('pluginPackages')
      // 显示用的本地化元数据。取不到就是没有——退成模块名，不影响列出来。
      const metaOf = (moduleName, base) => {
        if (!packages || typeof packages.metaOf !== 'function' || base === undefined) return null
        try {
          return packages.metaOf(moduleName, base) ?? null
        } catch (err) {
          return null
        }
      }
      /**
       * 模块名压成短名。照 PC 的「内置插件」面板（dsh-client-ui-settings-plugin-inventory
       * 里那个 moduleShortName）：`@deepseek-ai/dsh-tool-fs` → `tool-fs`。
       * 手机上不压的话每一行都是 `@deepseek-ai/dsh-xxx`，一屏放不下几个。
       */
      const shortName = (name) => String(name ?? '')
        .replace(/^@[^/]+\//, '')
        .replace(/^cordis:/, '')
        .replace(/^cordis-plugin-/, '')
        .replace(/^dsh-(?:host-|client-)?/, '')
      /**
       * 显示名。PC 的规矩：`meta.title` 是本地化对象就取文案，否则把那一份
       * （字符串标题，或干脆是模块名）压成短名。没有标题就退到模块名的短名。
       */
      const titleOf = (meta, moduleName) => {
        const t = meta?.title
        if (t && typeof t === 'object') return localizedText(t) || shortName(moduleName)
        return shortName(t || moduleName)
      }
      const rowOf = (moduleName, base, extra) => {
        const meta = metaOf(moduleName, base)
        return {
          entryId: extra.entryId,
          moduleName,
          title: titleOf(meta, moduleName),
          description: localizedText(meta?.description),
          enabled: extra.enabled,
          // 预设组合行可能是 'conditional'（带 !!js 条件、要挂载后才定得下来）。
          conditional: extra.conditional === true,
          condition: extra.condition,
          phase: extra.phase,
        }
      }

      const entries = []
      try {
        for (const entry of loader.entries()) {
          // 分组只是树上的容器，不是插件（PC 的内置插件页同样跳过它们）。
          if (entry?.options?.group) continue
          const moduleName = String(entry?.options?.name ?? '')
          entries.push(rowOf(moduleName, entry?.parent?.tree?.ctx?.baseUrl, {
            entryId: String(entry?.id ?? ''),
            enabled: entry?.disabled !== true,
            condition: '',
            phase: entry?.fiber === undefined ? null : (FIBER_PHASE[entry.fiber.state] ?? null),
          }))
        }
      } catch (err) {
        return { ok: false, reason: '读 Loader 条目失败：' + String(err?.message || err) }
      }

      // 会话插件：预设的组合行。拿不到就空着——那说明这个部署没挂预设名册，
      // 不是「一个都没有」，所以页面那一块整块不画。
      const presets = []
      try {
        const registry = canPresets.registry ?? ctx.get('agentPresets')
        // 组合清单里的 `name` 是预设自己声明的**原名**（内置那几档就是 standard / ptc
        // 这种代号），不是给用户看的。给用户看的名字在名册那边——走和「选模式」同一套
        // 政策取（见 presetCopyOf）。名册读不到就退到原名，不硬编一张对照表。
        const shownName = new Map()
        try {
          const roster = await registry?.list?.()
          for (const p of Array.isArray(roster) ? roster : []) {
            const copy = presetCopyOf(p)
            if (copy.id !== undefined && copy.name) shownName.set(String(copy.id), copy.name)
          }
        } catch (err) {
          // 名册问不到不影响列出组合（只是名字会退回代号）。
        }
        const list = await registry?.compositionInventory?.()
        for (const one of list || []) {
          const id = String(one?.id ?? '')
          presets.push({
            id,
            name: shownName.get(id) || localizedText(one?.name) || id,
            isDefault: one?.isDefault === true,
            broken: one?.broken ? String(one.broken) : '',
            rows: (one?.rows || []).map((r) => rowOf(String(r?.moduleName ?? ''), ctx.baseUrl, {
              entryId: r?.entryId === null || r?.entryId === undefined ? '' : String(r.entryId),
              enabled: r?.enabled === true,
              conditional: r?.enabled === 'conditional',
              condition: r?.condition ? String(r.condition) : '',
              phase: r?.fiberState === undefined ? null : (FIBER_PHASE[r.fiberState] ?? null),
            })),
          })
        }
      } catch (err) {
        // 预设读不动不该把全局那一半也拖没：两块各报各的。
        console.log('[dsh-remote-lite] 预设组合读不到（内置插件的会话那一块会空着）：'
          + String(err?.message || err))
      }

      return { ok: true, entries, presets, hasRoster: canPresets.registry !== null }
    },

    /**
     * 官方插件里那几张「设置卡片」（2026-10-04 用户确认：官方就是这 8 个，手机上也要看得到）。
     *
     * 官方那一栏其实是两样东西拼的，PC 上也是：
     *   ① 可开关的官方插件**包**（optional && 未装）——走 pluginList，4 个；
     *   ② 注册了设置卡片的官方插件——就是这里，4 个（终端 / Agent 循环 / 子智能体 / 网页搜索）。
     * 两张合起来正好是 PC 上那 8 个。
     *
     * 判据照 DSH：宿主的设置文档 served 了卡片那几个命名空间才出现。问不到设置文档时
     * **整块不出现**（宁可少画，不凭空多画）——这和 DSH 自己「不 served 就不注册」一致。
     */
    officialPlugins: async () => {
      const settings = invServices.settings ?? ctx.get('settings')
      if (!settings || typeof settings.describe !== 'function') return { ok: true, cards: [] }
      let served = null
      try {
        served = new Set((settings.describe() || []).map((d) => String(d?.ns ?? '')))
      } catch (err) {
        return { ok: false, reason: String(err?.message || err) }
      }
      return {
        ok: true,
        cards: OFFICIAL_CARDS
          .filter((c) => c.namespaces.some((n) => served.has(n)))
          .map((c) => ({ kind: 'card', id: c.id, title: c.title, description: c.description })),
      }
    },
    /**
     * 「繁忙时的发送行为」（2026-10-05 用户要求搬进手机设置）。
     *
     * **这是什么**：智能体正在跑的时候，你在手机上进的那句话到底怎么交给它——
     *   排队发送（queue）：排到队尾，等当前这一轮跑完再跑；
     *   插话发送（steer）：直接插进去，它当场看到并调整方向。
     *
     * **PC 上是同一个东西**：设置 → 通用里的「繁忙时的发送行为」。
     * 真相在 `dsh-client-ui-conversation` 里：
     *   命名空间 ui-conversation、字段 busyEnter、取值 queue|steer、默认 queue。
     *   它的注释原话是「Busy-Enter preference shared by the composer bar inject face
     *   and its Settings row: one live store … backed by the Host user-settings document」。
     *
     * **两端共用一个值**（用户 2026-10-05 拍板「都 ok」）：宿主只有一份用户设置文档，
     * 手机上改它，电脑上也是这个值。这样才不会出现「手机上选了插话、电脑上还是排队」。
     *
     * **拿不到就整条不显示**，不摆一个假的开关——和插件页那套「宁可少画」同一口径。
     */
    busyEnterSetting: async () => {
      const settings = invServices.settings ?? ctx.get('settings')
      if (!settings || typeof settings.describe !== 'function') return { ok: false, reason: 'unavailable' }
      let doc = null
      try {
        doc = (settings.describe() || []).find((d) => String(d?.ns ?? '') === 'ui-conversation') ?? null
      } catch (err) {
        return { ok: false, reason: String(err?.message || err) }
      }
      // 这个命名空间得真的被 served 才有得改——没有它就没有这一条。
      if (!doc) return { ok: false, reason: 'unavailable' }
      const value = doc?.value && typeof doc.value === 'object' ? doc.value : {}
      const current = value.busyEnter === 'steer' ? 'steer' : 'queue'
      return {
        ok: true,
        current,
        // 带上 revision：写的时候要它做乐观锁，免得和电脑上同时改打架。
        revision: typeof doc.revision === 'number' ? doc.revision : undefined,
      }
    },

    /**
     * 改「繁忙时的发送行为」。值只有两个，别的一律拒绝——**不替用户猜一个**。
     *
     * 走 `settings.update(ns, patch, revision)`（官方契约里的「把一个 entry 的可编辑
     * 字段合并进去」）。带 revision 是有意的：万一电脑上刚改过，这次写入会被挡下来
     * 而不是把对方的改动盖掉——那种覆盖用户看不见，最难查。
     */
    setBusyEnter: async (next) => {
      if (next !== 'queue' && next !== 'steer') {
        return { ok: false, reason: 'invalid' }
      }
      const settings = invServices.settings ?? ctx.get('settings')
      if (!settings || typeof settings.update !== 'function') return { ok: false, reason: 'unavailable' }
      let revision
      try {
        const doc = (settings.describe() || []).find((d) => String(d?.ns ?? '') === 'ui-conversation')
        if (!doc) return { ok: false, reason: 'unavailable' }
        revision = typeof doc.revision === 'number' ? doc.revision : undefined
      } catch (err) {
        return { ok: false, reason: String(err?.message || err) }
      }
      try {
        await settings.update('ui-conversation', { busyEnter: next }, revision)
      } catch (err) {
        return { ok: false, reason: String(err?.message || err) }
      }
      return { ok: true, current: next }
    },

    /**
     * 「进阶设置（电脑端界面）」的当前状态。
     *
     * `available` 和 `enabled` 是**两件事**，界面要分开说：
     *   available=false —— 这台机器上就没有这个能力（没拿到 DSH_WEB_URL），整条不显示；
     *   available=true、enabled=false —— 有能力，但用户没开（默认就是这个）。
     */
    mirrorSetting: () => ({
      ok: true,
      // `available` 问的是**此刻**能不能用（上游地址解析得出来），不是「建没建出这个对象」——
      // webServer 就绪得晚，插件刚加载那一刻问不到端口，那时候要如实说不可用。
      available: mirror.available(),
      enabled: store.state.mirrorEnabled === true,
    }),

    /**
     * 开/关「进阶设置」。**这是权限开关，不是普通偏好**——见 store 里那段说明。
     *
     * 只认布尔值，别的一律拒绝（和 busyEnter 同一条口径：不替用户猜一个）。
     * 关掉时不做任何「清理」：那条路由是每请求现读开关的，关掉就等于不存在了，
     * 不需要再去撤销什么。
     */
    setMirror: (enabled) => {
      if (typeof enabled !== 'boolean') return { ok: false, reason: 'invalid' }
      if (!mirror.available()) return { ok: false, reason: 'unavailable' }
      const value = store.setMirrorEnabled(enabled)
      log.info?.(value ? '手机开了「进阶设置」：现在可以打开电脑端界面。' : '手机关掉了「进阶设置」。')
      return { ok: true, enabled: value }
    },

    subagentTranscript: (childId, sessionId) => subagentTranscript(childId, sessionId),
    stopSubagent: (childId, sessionId, mode) => stopSubagent(childId, sessionId, mode),
    askSubagent: (childId, sessionId, mode, text) => askSubagent(childId, sessionId, mode, text),

    // 模型与思考强度（2026-09-25 用户要求：手机上要能改每个会话的模型和强度）。
    // `canCreate.controller` 就是 `ctx.sessionController`——和上面 createSession 同一个东西。
    //
    // 有个区别要记牢：**目录是全局的，选中的那个是会话级的**。所以列清单只要问一次，
    // 「现在用哪个」得按会话问。`ModelSelection` 就是 `{ provider, model, reasoningEffort? }`，
    // 强度不是单独一项设置，它是模型选择的一部分——这也是为什么两个按钮要一起改。
    //
    // 拿不到能力时如实说 `unavailable`，让手机整块不显示。**不假装只有一种模型可选**：
    // 那会让用户以为自己的模型被换掉了。
    modelCatalog: async () => {
      const controller = canCreate.controller ?? ctx.get('sessionController')
      if (typeof controller?.modelCatalog !== 'function') return { ok: false, reason: 'unavailable' }
      return { ok: true, catalog: await controller.modelCatalog() }
    },
    selectModel: async (sessionId, selection) => {
      const controller = canCreate.controller ?? ctx.get('sessionController')
      if (typeof controller?.selectModel !== 'function') return { ok: false, reason: 'unavailable' }
      const value = await controller.selectModel({ sessionId, ...selection })
      return { ok: true, selected: value?.selected ?? null }
    },
    // 某个会话**现在到底用哪个模型**。
    //
    // 为什么非得问 DSH、不能自己记：插件只在会话跑起来时才从事件里看到模型
    // （request/header），没在插件眼皮底下跑过的会话——比如重启之前用过的那些——
    // 手里就是空的。上一版给空值兜了一个「目录默认值」，结果把一个不知道的会话
    // 显示成上次选过的那个模型：看着像对的，其实是编的。**宁可说不知道，也不编。**
    //
    // 两条路，**第二条是必须的**：
    //   ① 会话正活着 → 它的 `requestHeader()` 直接给结果，走内存，最快。
    //   ② 会话睡在硬盘上 → 去它的日志里翻最后那条 request/header 事件。
    //
    // ② 不是备胎，是主路。手机上能挑的是**全部**会话（这个工作区里就有上百个），
    // 而「活着的」通常只有开着的两三个——只走 ① 的话，用户切到绝大多数会话都只能
    // 看到「还没问到」。查证过：147 个会话里只有 3 个是活的。
    //
    // 用 `sessionQuery.listEvents`：它的说明是「列出原始日志事件」，并且注明
    // **优先取活着的、没有就读硬盘**——两件事一个方法全包，不用我自己分支。
    // 用量不再需要主动去问：它跟着事件自己更新（见 usageInputTokens）。

    sessionModel: async (sessionId) => {
      if (!sessionId) return { ok: false, reason: 'no-id' }
      const shape = (cfg) => ({
        provider: typeof cfg.provider === 'string' ? cfg.provider : null,
        model: cfg.model,
        reasoningEffort: typeof cfg.reasoningEffort === 'string' ? cfg.reasoningEffort : null,
      })

      // ① 活着的会话：内存里就有
      const sessions = ctx.get('sessions')
      const live = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
      const liveCfg = live && typeof live.requestHeader === 'function' ? live.requestHeader()?.config : null
      if (liveCfg && typeof liveCfg.model === 'string') return { ok: true, model: shape(liveCfg) }

      // ② 睡着的会话：读硬盘上的日志，从后往前找最后那条 request/header。
      //
      // **必须用 `readSession`，不能用 `listEvents`。** 后者给的是**元数据**
      // （sessionId / seq / type / time / surface），**没有 `data`**——而配置恰恰在
      // `data` 里。这个已经试过一次，读出来是空的，白跑一轮。`readSession` 给的是
      // 完整的原始事件，`data.header.config` 就在里面。
      //
      // 读整个日志是贵的，而手机每 15 秒会来问一次，所以缓存 60 秒：桌面那边改了模型，
      // 最迟一分钟内在手机上出现。手机自己改的那次走另一条路（那条接口会把新值直接
      // 写进会话记录），不受这个缓存影响。
      const cache = treeServices.modelCache || (treeServices.modelCache = new Map())
      const hit = cache.get(sessionId)
      if (hit && Date.now() - hit.at < 60000) return hit.value

      const q = treeServices.query
      let value
      if (typeof q?.readSession !== 'function') {
        value = { ok: false, reason: 'unavailable' }
      } else {
        try {
          const snap = await q.readSession(sessionId)
          const events = Array.isArray(snap?.events) ? snap.events : []
          value = { ok: false, reason: 'no-header' }
          for (let i = events.length - 1; i >= 0; i--) {
            const e = events[i]
            if (!e || e.type !== 'request/header') continue
            const cfg = e.data?.header?.config
            if (cfg && typeof cfg.model === 'string') { value = { ok: true, model: shape(cfg) }; break }
          }
        } catch (err) {
          value = { ok: false, reason: 'read-failed', error: String(err && err.message ? err.message : err) }
        }
      }
      if (cache.size > 50) cache.clear()
      cache.set(sessionId, { at: Date.now(), value })
      return value
    },

    /**
     * 某个会话「上下文用了多少」——**只在内存里那份缺分母时**才用得上的兜底。
     *
     * 正常情况不用走到这儿：会话跑起来时每一步的 usage 都会把 {used, window} 记进
     * store（见上面 usageInputTokens / contextWindowOf），手机读到的是最鲜活的一份。
     * 这条路是给「插件晚一步起来」的会话准备的：窗口那条事件一个会话只写一次
     * （理由见 contextWindowOf），插件没赶上就永远等不到，内存里于是永远缺分母。
     * 而日志里两半都齐——最后一条 `request/context` 是分母，最后一次
     * `assistant/message` 的 usage 是分子，都是 DSH 自己记下的事实，不是我们估的。
     *
     * 读整份日志是贵的，所以和 sessionModel 一样缓存 60 秒。**只在内存里没有时才问**，
     * 所以会话一跑起来（store 有了值）就再也不会读盘。
     *
     * 两半缺任一个都返回 null：宁可空着，也不拿别的数凑。
     */
    sessionContext: async (sessionId) => {
      if (!sessionId) return null
      const cache = treeServices.contextCache || (treeServices.contextCache = new Map())
      const hit = cache.get(sessionId)
      if (hit && Date.now() - hit.at < 60000) return hit.value

      const q = treeServices.query
      let value = null
      if (typeof q?.readSession === 'function') {
        try {
          const snap = await q.readSession(sessionId)
          const events = Array.isArray(snap?.events) ? snap.events : []
          // 一遍扫到底、各自留最后一条：窗口在日志开头（那时才写），用量在末尾，
          // 从后往前找反而要白走几千条。两个数都是「最近一次」才算数。
          let window = 0
          let used = 0
          for (const e of events) {
            if (!e) continue
            if (e.type === 'request/context') {
              const w = e.data?.contextWindow
              if (typeof w === 'number' && w > 0) window = w
            } else if (e.type === 'assistant/message' && e.data?.usage) {
              const u = usageInputTokens(e.data.usage)
              if (u > 0) used = u
            }
          }
          if (used > 0 && window > 0) value = { used, window }
        } catch {
          // 读不出来就当没有——手机上少一个数，好过报一个错。
          value = null
        }
      }
      if (cache.size > 50) cache.clear()
      cache.set(sessionId, { at: Date.now(), value })
      return value
    },
  }

  // ------------------------------------------------------------------
  // 「进阶设置」：电脑端界面的镜像（2026-10-06）
  //
  // 手机上那张遥控页是**专门为手机做的**，所以电脑上那些插件贡献的设置页它进不去。
  // 这一块是退路：**要改那些设置时，把电脑端界面整个搬过来看**——不迁移页面、
  // 不逐个适配、同一份界面。原委和认证怎么走，都写在 lib/mirror.js 开头。
  //
  // **地址从 webServer 服务问，不从环境变量猜。** 这一条是实测撞出来的：
  // 第一版读 `process.env.DSH_WEB_URL`，结果 `available=false`——那个变量是
  // **命令行工具那一侧**才有的（DSH 给子进程注入的），**宿主进程里根本没有**。
  // 宿主自己报地址的地方就是 webServer（它有 `port` 和 `host`），而且**两端都成立**：
  // 桌面端它指向那个只绑回环的界面，`dsh web` 那边它就是界面本身。
  //
  // 而且**必须惰性**：boot 期各插件并行加载，apply 这一刻 webServer 常常还没 provide。
  // 所以端口在下面那个 `ctx.inject(['webServer'])` 回调里才填上，
  // 在那之前镜像会如实说自己「还没法用」，界面那一行也就不显示。
  // ------------------------------------------------------------------
  let mirrorAppPort = null

  function mirrorUpstream() {
    // webServer 到位了就用它——**回环字面量写在这里**：上游必须是本机那一个，
    // 而 webServer 的 host 可能是 0.0.0.0（那是「绑哪张网卡」，不是「连哪个地址」）。
    //
    // 没有 webServer 就没有可镜像的界面（纯 headless 组合），如实回 null，
    // 界面那一行不显示。**这里刻意不留 `DSH_WEB_URL` 的退路**：实测那个变量只在
    // 命令行工具那一侧存在，宿主里没有；而且留着它会让测试在开发机上意外指到
    // 用户真实运行的界面上——测试不该有这种机会。
    if (typeof mirrorAppPort === 'number' && mirrorAppPort > 0) {
      return `http://127.0.0.1:${mirrorAppPort}`
    }
    return null
  }

  const mirror = createMirror({
    upstream: mirrorUpstream,
    /**
     * 取「带官方令牌的地址」。**惰性求值**：这一刻 connection 服务可能还没 provide，
     * 但转发是真发生请求时才问，那时候它一定在。
     */
    tokenUrl: () => {
      const connection = ctx.get('connection')
      if (!connection || typeof connection.authenticatedUrl !== 'function') return null
      const base = mirrorUpstream()
      if (!base) return null
      try {
        return connection.authenticatedUrl(`${base}/`)
      } catch (err) {
        log.warn?.('取电脑端界面的访问凭据失败：' + (err?.message ?? err))
        return null
      }
    },
    log: (msg) => log.warn?.('[镜像] ' + msg),
  })

  log.info?.('「进阶设置（电脑端界面）」已就绪，默认关；等 webServer 报出端口后可用。')

  // ------------------------------------------------------------------
  // 起服务
  // ------------------------------------------------------------------
  ctx.effect(() => {
    let closed = false
    createMiniServer({
      store,
      config: settings,
      token,
      bindAddresses: resolveBindAddresses(settings.bindAddress),
      tunnelHost,
      log,
      // 镜像那一路：实例 + **每个请求现读的开关**（关着时那条路由根本不存在）。
      // 上游地址没解析出来时也当关着——宁可回 404（查无此路），也不要回一个
      // 「有这条路但它坏了」的 502：前者是实话，后者会让用户以为功能坏了。
      mirror,
      mirrorEnabled: () => store.state.mirrorEnabled === true && mirror.available(),
      onInstruction,
      onCommands,
      // 技能：list 只要名字和描述，get 按需取正文（见 nav.listSkills / nav.getSkill）。
      onSkills: { list: () => listSkills(), get: (name) => getSkill(name) },
      onCommand,
      onUpload,
      onStop,
      onUnqueue,
      // 手机点开会话（或刷新页面）时，把那条会话的完整历史读出来。
      onSessionOpened: (sessionId) => ensureHistory(sessionId),
      tree: nav,      // 正文里写相对路径的图（`![](scratch/a.png)`）相对的是**那段对话的工作目录**，
      // 而不一定是插件根。所以把当前已注册工作区的目录一并递过去当额外候选根。
      // `treeServices.registry` 就是 DSH 的 workspaceRegistry（注入见上面那段），
      // 服务这边拿不到 ctx，只能由插件给——传函数不传快照，理由和 treeServices 一样：
      // 服务每次请求现读，工作区是随时会变的。
      imageRoots: () => (treeServices.registry?.list?.() ?? []).map((w) => w?.path),
      // 目录浏览自己读盘（理由见 lib/browse.js 开头：DSH 的目录选择器在
      // 「Windows + 只绑回环」时会判成 native，那套动词是直接拒绝的，
      // 会在电脑屏幕上弹框——而用户正在外面用手机）。
      browse: { listRoots, listDirectory, makeDirectory },
      build: BUILD,
    })
      .then((instance) => {
        if (closed) {
          instance.close()
          return
        }
        server = instance
        serverError = null
        for (const f of instance.failed) {
          log.warn(`地址 ${f.address} 没绑上，已跳过：${f.message}`)
        }
        const usable = reachableAddresses().filter((a) => instance.addresses.includes(a.address))
        if (usable.length) {
          console.log(`[dsh-remote-lite] 构建指纹 ${BUILD}`)
          log.info('已启动。手机打开下面任意一条（或到 DSH 设置 → 手机遥控 扫码）：')
          for (const a of usable) {
            log.info(`  ${a.label}  http://${a.address}:${instance.port}/mini?token=${token}`)
          }
        } else {
          log.info(`已启动，但只绑上了本机：http://127.0.0.1:${instance.port}/mini?token=${token}`)
          log.warn('没找到手机能连上的地址——检查 Wi-Fi／网线。')
        }
        // 服务起来了才谈得上开隧道：cloudflared 要指向这个端口
        if (settings.tunnel?.enabled) bringTunnelUp()
        // 重启前手机在看哪个会话，就先把它的完整历史补上——用户打开手机时
        // 该看到的是那个会话的全貌，而不是「重启之后才发生的事」。
        ensureHistory(store.snapshot().boundSessionId)
      })
      .catch((err) => {
        // 记下来。设置页那边要拿它把「还在启动」和「起不来了」分开说——
        // 只写日志的话，用户看到的永远是那句「过几秒刷新一下」。
        serverError = err?.message ?? String(err)
        log.warn(`启动失败：${serverError}`)
      })

    return () => {
      closed = true
      bringTunnelDown()
      server?.close()
      server = null
    }
  })

  // ------------------------------------------------------------------
  // DSH 设置页的「手机遥控」标签从这里取数据
  // ------------------------------------------------------------------
  // 用 ctx.inject 而不是 ctx.effect + 直接读 ctx.webServer，两个理由：
  //   1. cordis 的 ctx 代理对「没写进 inject 的服务名」是**抛错**
  //      （cannot get property "webServer" without inject），不是给 undefined，
  //      所以「不注入、拿不到就降级」这条路走不通；
  //   2. boot 期各插件是并行加载的，apply 这一刻 webServer 常常还没 provide，
  //      ctx.get('webServer') 只会拿到 undefined 而且永不重试（dsh-config-manager
  //      现在就在 boot 时打这条 warn）。
  // ctx.inject 会在 webServer 就绪后回调；纯 headless 组合里它永远不来，这个子
  // fiber 就一直不激活——不报错，也不影响手机端自己那个 3090 服务。
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    if (typeof webServer?.register !== 'function') {
      log.warn('拿不到 webServer 服务，设置页里的扫码面板用不了（手机端不受影响）。')
      return
    }

    // 「进阶设置」的镜像要往**这台服务器**转发——它就是电脑端界面本身
    // （桌面端那个只绑回环的 19387；`dsh web` 那边就是 3080）。
    // 端口到这里才知道，所以镜像那边是惰性求值的（见上面 mirrorUpstream）。
    if (typeof webServer.port === 'number' && webServer.port > 0) {
      mirrorAppPort = webServer.port
      log.info?.(`「进阶设置」的上游定为这台界面：127.0.0.1:${webServer.port}`)
    }

    // 面板和开关都带着 token，所以两者都只允许从这台电脑自己访问。否则同一个
    // Wi-Fi 下谁都能把密码取走，token 就白设了。
    function localOnly(req, res) {
      if (isLocalRequest(req)) return true
      sendJson(res, 403, { ok: false, error: '配对信息只能在这台电脑上看。' })
      return false
    }

    async function pairingPayload() {
      if (!server) {
        // 分清「还在启动」和「起不来了」。原来两种情况都回同一句「过几秒刷新一下」，
        // 但失败之后 server 永远不会建好——用户会一直刷新，而且提示里没有半个字
        // 告诉他出了什么事。失败时把真实原因说出来，并告诉他去哪儿改。
        return {
          status: 503,
          body: {
            ok: false,
            error: serverError
              ? `手机服务起不来：${serverError}\n端口可以在设置文件里改（settings.json 里的 port）。`
              : '手机服务还在启动，过几秒刷新一下。',
          },
        }
      }
      const payload = await buildPairing({
        port: server.port,
        token,
        bound: server.addresses,
        tunnel: {
          enabled: Boolean(settings.tunnel?.enabled),
          mode: tunnelMode(),
          hostname: String(settings.tunnel?.hostname ?? '').trim().toLowerCase(),
          // Account ID 不是密码，回显出来用户才知道自己配的是哪个账号（多账号时尤其要紧）。
          accountId: String(settings.tunnel?.accountId ?? '').trim(),
          // 「建过一次」和「配好了」是两件事：前者说明重启之后不用再走 API，
          // 后者要 apiToken/tunnelToken 至少有一个。两个都给出去，界面才说得准。
          provisioned: Boolean(settings.tunnel?.tunnelId),
          hasApiToken: String(settings.tunnel?.apiToken ?? '').trim() !== '',
          hasTunnelToken: String(settings.tunnel?.tunnelToken ?? '').trim() !== '',
          dns: namedDns,
          // 判死之后**不再把网址交出去**（判断在 pairing.js 的 tunnelUrlFor 里，
          // 抽出去是为了能单测——它决定了用户会不会扫到一个扫不开的码）。
          url: tunnelUrlFor(tunnelHealthy, tunnel?.url),
          starting: tunnelStarting,
          error: tunnelError,
        },
      })
      return { status: payload.ok ? 200 : 500, body: payload }
    }

    const offGet = webServer.register({
      kind: 'exact',
      path: '/mini-remote/pairing',
      handler: async (req, res) => {
        if (!localOnly(req, res)) return
        try {
          const { status, body } = await pairingPayload()
          sendJson(res, status, body)
        } catch (err) {
          sendJson(res, 500, { ok: false, error: `读取配对信息失败：${err?.message ?? err}` })
        }
      },
    })

    /**
     * 一键配置第一步：拿 API Token 去问「你有哪几个域名」。
     *
     * 设置页拿到列表就能做成下拉框——用户不用回忆自己的域名叫什么、
     * 也不用去 Cloudflare 后台翻。这一步只读，不改任何东西。
     */
    const offZones = webServer.register({
      kind: 'exact',
      path: '/mini-remote/tunnel/zones',
      handler: async (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
          return
        }
        let want
        try {
          want = await readBody(req)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: `请求体读不了：${err?.message ?? err}` })
          return
        }
        const apiToken = typeof want?.apiToken === 'string' ? want.apiToken.trim() : ''
        if (!apiToken) {
          sendJson(res, 400, { ok: false, error: '先填 Cloudflare API Token。' })
          return
        }
        try {
          await verifyToken(apiToken)
          const zones = await listZones(apiToken)
          sendJson(res, 200, {
            ok: true,
            zones,
            empty: zones.length === 0,
            hint: zones.length === 0
              ? '这个令牌看不见任何域名。检查令牌的「区域资源」是否包含你的域名。'
              : null,
          })
        } catch (err) {
          sendJson(res, 400, { ok: false, error: describeProvisionError(err) })
        }
      },
    })

    const offTunnel = webServer.register({
      kind: 'exact',
      path: '/mini-remote/tunnel',
      handler: async (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
          return
        }
        let want
        try {
          want = await readBody(req)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: `请求体读不了：${err?.message ?? err}` })
          return
        }
        const enabled = Boolean(want?.enabled)
        // `mode` 可以不传（老界面只发 enabled）。传了就按它切出口。
        const wantMode = want?.mode === 'named' ? 'named' : (want?.mode === 'quick' ? 'quick' : null)
        const modeChanged = wantMode !== null && wantMode !== tunnelMode()
        settings.tunnel = { ...settings.tunnel, enabled, ...(wantMode ? { mode: wantMode } : {}) }
        persistSettings()
        // 换出口必须把旧那条整个停掉再起：quick 和 named 是两条不同的连接，
        // 就地改一个字段的后果是两条同时在跑，而插件只认得后一个句柄。
        if (modeChanged) bringTunnelDown()
        if (enabled) await bringTunnelUp()
        else bringTunnelDown()
        try {
          const { status, body } = await pairingPayload()
          sendJson(res, status, body)
        } catch (err) {
          sendJson(res, 500, { ok: false, error: `切换之后读不到状态：${err?.message ?? err}` })
        }
      },
    })

    /**
     * 配「固定域名隧道」：域名 + 账号 + API Token（或者直接粘隧道令牌）。
     *
     * 三件事按顺序发生，每一步失败都如实说出来：
     *   ① 校验域名——纯函数，不联网。用户从地址栏里粘进来的 `https://x/y?token=` 会被剥成域名；
     *   ② 存下来——**API Token 留空 = 不改动原来那份**（和访问口令同一条规矩：
     *      服务端从不回显它，让用户每存一次都重贴一遍，只会多一次贴错的机会）；
     *   ③ 换成固定模式并重建隧道——域名/账号/令牌一变，旧的隧道 id 和运行令牌就作废了，
     *      必须重新走一次 API；这三样都没变时**不重建**，省掉一次没必要的 API 调用。
     *
     * 和别的设置路由一样**只允许本机调用**：这里能写进一个能改整个 Cloudflare 账号的
     * API Token，同一个 Wi-Fi 下的别人不该替你写。
     */
    const offNamed = webServer.register({
      kind: 'exact',
      path: '/mini-remote/tunnel/named',
      handler: async (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
          return
        }
        let want
        try {
          want = await readBody(req)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: `请求体读不了：${err?.message ?? err}` })
          return
        }

        const check = normalizeHostname(want?.hostname)
        if (!check.ok) {
          sendJson(res, 400, { ok: false, error: check.error })
          return
        }

        const prev = settings.tunnel ?? {}
        const apiTokenIn = typeof want?.apiToken === 'string' ? want.apiToken.trim() : ''
        const tunnelTokenIn = typeof want?.tunnelToken === 'string' ? want.tunnelToken.trim() : ''
        const accountIdIn = typeof want?.accountId === 'string' ? want.accountId.trim() : ''
        const apiToken = apiTokenIn || String(prev.apiToken ?? '')
        const tunnelToken = tunnelTokenIn || String(prev.tunnelToken ?? '')
        if (!apiToken && !tunnelToken) {
          sendJson(res, 400, {
            ok: false,
            error: '要填 Cloudflare API Token（插件会自己建隧道、写 ingress、建 DNS），'
              + '或者把 Cloudflare 后台建好的隧道令牌直接粘进来。',
          })
          return
        }

        // 换了域名 / 账号 / API Token → 旧的隧道 id 与运行令牌全部作废。
        // 只换了别的（比如勾上 enabled）就沿用，避免每次保存都重建一条隧道。
        const identityChanged = check.hostname !== String(prev.hostname ?? '').trim().toLowerCase()
          || accountIdIn !== String(prev.accountId ?? '')
          || (apiTokenIn !== '' && apiTokenIn !== String(prev.apiToken ?? ''))

        const next = {
          ...prev,
          enabled: want?.enabled === undefined ? true : Boolean(want.enabled),
          mode: 'named',
          hostname: check.hostname,
          accountId: accountIdIn,
          apiToken,
          tunnelId: identityChanged ? '' : String(prev.tunnelId ?? ''),
          tunnelToken: identityChanged ? '' : String(prev.tunnelToken ?? ''),
        }
        // 用户直接粘了隧道令牌：那是「我后台已经建好了」，不需要再走 API 建隧道，
        // 也不再需要 API Token 就能跑起来（只是 DNS 得他自己加）。
        if (tunnelTokenIn) {
          next.tunnelToken = tunnelTokenIn
          next.tunnelId = next.tunnelId || 'manual'
        }
        settings.tunnel = next
        namedDns = null
        persistSettings()

        bringTunnelDown()
        if (next.enabled) await bringTunnelUp()

        try {
          const { status, body } = await pairingPayload()
          sendJson(res, status, body)
        } catch (err) {
          sendJson(res, 500, { ok: false, error: `保存之后读不到状态：${err?.message ?? err}` })
        }
      },
    })

    /**
     * 密码最短多少位。
     *
     * 12 位是「好记」和「猜不出」之间的折中。之所以不能像普通登录框那样放开短的：
     * 密码是编在网址里的（`?token=...`），猜的人不受表单那套限速的约束——他可以直接
     * 对着地址栏试，而限速只在服务端挡。用户想设成自己记得住的东西，这个需求是合理的，
     * 但「123456」这种等于把门拆了。
     */
    const MIN_TOKEN_LEN = 12

    /**
     * 换一个自己设的密码。
     *
     * **要重启 DSH 才生效。** 服务在启动时就把 token 读进内存了（见上面的
     * `loadOrCreateToken`），改文件不影响正在跑的那个。做成「立刻生效」得改服务内部的
     * 取值方式，影响面比这个需求本身大，所以这里如实告诉用户要重启，而不是假装换好了。
     *
     * 返回的 payload 里带一个 `pendingToken`：界面据此显示「新密码已保存，重启后生效」。
     * 面板上那些二维码仍然是**当前在用的**旧密码编出来的——它们在重启前确实还能用，
     * 显示成新的就成了骗人。
     */
    const offToken = webServer.register({
      kind: 'exact',
      path: '/mini-remote/token',
      handler: async (req, res) => {
        if (!localOnly(req, res)) return
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
          return
        }
        let want
        try {
          want = await readBody(req)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: `请求体读不了：${err?.message ?? err}` })
          return
        }
        const next = typeof want?.token === 'string' ? want.token.trim() : ''
        if (next.length < MIN_TOKEN_LEN) {
          sendJson(res, 400, { ok: false, error: `密码至少要 ${MIN_TOKEN_LEN} 位，现在这串只有 ${next.length} 位。` })
          return
        }
        if (/[\s?#&/]/.test(next)) {
          // 密码要拼进网址，这些字符会把网址拆坏，或者让密码只生效一半
          sendJson(res, 400, { ok: false, error: '密码里不能有空格，也不能有 ? # & / 这几个符号。' })
          return
        }
        settings.token = next
        persistSettings()
        // token 文件也一起写：将来要是把 settings.json 里的 token 清空，读到的该是现在这个，
        // 而不是上一个。两处不一致的话，用户会莫名其妙被挡在门外。
        try {
          writeFileSync(join(dir, 'token'), next, { mode: 0o600 })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: `密码写进配置文件了，但 token 文件没写成：${err?.message ?? err}` })
          return
        }
        try {
          const { status, body } = await pairingPayload()
          sendJson(res, status, { ...body, pendingToken: next })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: `改完之后读不到状态：${err?.message ?? err}` })
        }
      },
    })

    /**
     * 卸载时把注册过的路由全部注销。
     *
     * **每加一条 `webServer.register` 都要往这里补一笔**，否则插件卸载后那条路由
     * 还挂在服务器上，指向一个已经死掉的闭包——再有人打过来就是莫名其妙的报错。
     *
     * 2026-09-24 补：`offToken` 一直是漏的（改密码那条路由注册了却没注销），
     * 加新路由时对照着数了一遍才发现。**四条注册，四条注销**，现在对得上。
     */
    return () => {
      offGet?.()
      offZones?.()
      offTunnel?.()
      offNamed?.()
      offToken?.()
    }
  })
}
