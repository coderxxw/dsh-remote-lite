/**
 * Cloudflare 固定隧道：用你自己的账号 + 自己的域名，把手机服务挂到一个**不变的**地址上。
 *
 * ## 它解决什么
 *
 * `lib/tunnel.js` 里那条快速隧道（`trycloudflare.com`）是免账号的，代价是**地址每次
 * 重启都换一个**——出门在外重启一次 DSH，手机上那条链接就废了。固定隧道把地址钉死成
 * 你自己的域名（`dsh.example.com`），重启、换网络都不影响。
 *
 * ## 为什么不走 `cloudflared tunnel login`（浏览器授权）
 *
 * 那条路要用户在电脑上打开浏览器点授权，凭据落在 `~/.cloudflared/cert.pem` 里，
 * 插件既看不见也管不了它的生命周期；而且 DSH 常常跑在没有桌面会话的机器上。
 * 所以这里只走 **API Token**：用户去 Cloudflare 后台点几下建一个令牌，粘进来，
 * 剩下的（建隧道、写 ingress、建 DNS 记录）全部由插件用 REST 完成。
 *
 * 令牌需要的三项权限（少一项就会在对应那一步报错，报错文案里会指名是哪一步）：
 *   - 账户 → Cloudflare Tunnel → 编辑     （建隧道、拿隧道令牌）
 *   - 区域 → DNS → 编辑                   （建 CNAME 记录）
 *   - 区域 → 区域 → 读取                  （按域名反查 zone id）
 *
 * ## 这里**不做**的事
 *
 * - 不删用户已有的 DNS 记录。目标域名上要是已经有 A/AAAA 记录，**停下来报错**，
 *   让用户自己去后台处理——「帮你删一条记录」这种事不该由一个插件代劳。
 * - 不建 zone、不改代理开关以外的东西。
 *
 * 纯逻辑（域名归一、候选 zone、ingress 形状、隧道命名）都单独导出成纯函数，
 * 好让 `test/cloudflare.test.mjs` 不联网也能钉住它们。
 */

/**
 * API 根地址。
 *
 * 可以用环境变量换掉——**只给测试用**：`test/cloudflare-provision.test.mjs` 会在本机
 * 起一个假的 Cloudflare（node:http），把 provision 的完整流程（校验令牌 → 定账号 →
 * 找 zone → 建隧道 → 写 ingress → 建 DNS）跑一遍，而不去碰真的 API。
 *
 * 这样「请求形状对不对」这件事才有测试：字段名、`config_src`、ingress 的 catch-all、
 * CNAME 的 content，全是错了会在很远的地方才炸的东西。
 */
const API_BASE = process.env.DSH_MINI_CF_API || 'https://api.cloudflare.com/client/v4'

/** 单次 API 调用的超时。Cloudflare 正常都是几十毫秒，慢到这个数就是网络问题了。 */
const TIMEOUT_MS = 20_000

/**
 * 一条 Cloudflare API 错误。
 *
 * `hint` 是给用户看的「下一步做什么」，和 `message`（Cloudflare 的原话）分开：
 * 原话经常是 "Authentication error" 这种，光看它不知道该去改什么。
 */
export class CloudflareError extends Error {
  constructor(message, { code = null, status = null, path = null, hint = null } = {}) {
    super(message)
    this.name = 'CloudflareError'
    this.code = code
    this.status = status
    this.path = path
    this.hint = hint
  }
}

/**
 * 域名归一化：接受用户从地址栏里复制来的各种写法。
 *
 * 用户很可能粘进来 `https://dsh.example.com/mini?token=xxx` 或者带端口、带尾点的
 * 东西。这里统一剥成 `dsh.example.com`，剥不成就返回错误——**不去猜**，
 * 猜错了会去改一个不相干的域名。
 */
export function normalizeHostname(input) {
  let raw = String(input ?? '').trim()
  if (!raw) return { ok: false, error: '请填一个域名，例如 dsh.example.com。' }
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // 协议
  raw = raw.split(/[/?#]/)[0] // 路径、查询串
  raw = raw.split('@').pop() // 万一带了 user@
  raw = raw.replace(/:\d+$/, '') // 端口
  raw = raw.replace(/\.+$/, '').toLowerCase() // 尾点
  if (!raw) return { ok: false, error: '这个域名看不出来是什么，填成 dsh.example.com 这样。' }
  if (raw.length > 253) return { ok: false, error: '域名太长了（超过 253 个字符）。' }
  // IP 先单独拦一道：它同样过不了下面的域名正则，但「这里要填域名，不能填 IP」
  // 比「不像一个域名」更能让用户立刻改对。
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) {
    return { ok: false, error: '这里要填域名，不能填 IP。' }
  }
  // 只接受「至少两段」的域名。单段（如 localhost）在 Cloudflare 上不可能有 zone。
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(raw)) {
    return {
      ok: false,
      error: `「${raw}」不像一个域名。要填完整的域名，例如 dsh.example.com（不带 http://、不带端口、不带路径）。`,
    }
  }
  return { ok: true, hostname: raw }
}

/**
 * 由完整域名推出「可能的 zone 名」，从最长到最短。
 *
 * `a.dsh.example.com` → `dsh.example.com`、`example.com`。
 * Cloudflare 的 zone 可能是其中任何一个（用户完全可能把 `dsh.example.com` 单独
 * 托管在 CF 上），所以按长度从长到短挨个问，第一个命中的就是它。
 *
 * 至少要留两段（`example.com`），单段的 `com` 不是谁的 zone。
 */
export function zoneCandidates(hostname) {
  const clean = String(hostname ?? '').trim().toLowerCase().replace(/\.+$/, '')
  if (!clean) return []
  const parts = clean.split('.').filter(Boolean)
  const out = []
  for (let i = 1; i < parts.length - 1; i += 1) out.push(parts.slice(i).join('.'))
  return out
}

/** 隧道名。同一个域名反复配置时靠它复用同一条隧道，不重复创建。 */
export function tunnelNameFor(hostname) {
  const slug = String(hostname ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `dsh-remote-lite-${slug || 'tunnel'}`
}

/**
 * 远端 ingress 配置：把域名指向本机的手机服务，其余一律 404。
 *
 * 最后那条 catch-all 是**必须的**：Cloudflare 要求 ingress 列表必须有兜底项，
 * 少了它 `PUT /configurations` 直接 400。给 `http_status:404` 而不是随便指个
 * 服务，是为了让「域名被别的路径扫到」时什么都拿不到。
 */
export function ingressFor(hostname, port) {
  const host = String(hostname ?? '').trim().toLowerCase()
  return {
    config: {
      ingress: [
        { hostname: host, service: `http://127.0.0.1:${Number(port)}` },
        { service: 'http_status:404' },
      ],
    },
  }
}

/** 这个域名该指向的 CNAME 目标。Cloudflare 隧道的固定写法。 */
export function tunnelCname(tunnelId) {
  return `${String(tunnelId ?? '').trim()}.cfargotunnel.com`
}

/**
 * 调一次 Cloudflare API。
 *
 * 两件事必须做对：
 *   ① 业务失败时 Cloudflare 也回 **HTTP 200**，真正的结果在 `success` 里——
 *      只看状态码会把失败当成功（后面拿到的 `result` 是 null，报错报在很远的地方）。
 *   ② 把第一条 error 的 `code` 一起抛出去，上层才能按错误码给人话。
 */
async function cf(apiToken, path, { method = 'GET', body, timeoutMs = TIMEOUT_MS } = {}) {
  const url = `${API_BASE}${path}`
  let res
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${apiToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new CloudflareError(`连不上 Cloudflare API：${err?.message ?? err}`, {
      path,
      hint: '检查这台电脑的网络，以及有没有代理/VPN 把到 api.cloudflare.com 的连接掐断。',
    })
  }

  let payload = null
  try {
    payload = await res.json()
  } catch {
    // 非 JSON：多半是网关的错误页，下面按状态码报。
  }

  if (!res.ok || payload?.success === false) {
    const first = Array.isArray(payload?.errors) ? payload.errors[0] : null
    throw new CloudflareError(first?.message || `Cloudflare 返回 HTTP ${res.status}`, {
      status: res.status,
      code: first?.code ?? null,
      path,
      hint: hintForStatus(res.status, first?.code),
    })
  }
  return payload?.result
}

/** 常见失败 → 下一步做什么。宁可啰嗦，也不要让用户对着 "Authentication error" 发呆。 */
function hintForStatus(status, code) {
  if (status === 401 || status === 403) {
    return 'API Token 没通过校验，或者权限不够。建令牌时至少要勾这三项：'
      + '账户 → Cloudflare Tunnel → 编辑；区域 → DNS → 编辑；区域 → 区域 → 读取。'
      + '另外「区域资源」要包含你这个域名所在的区域。'
  }
  if (code === 10000) return 'Cloudflare 说这个请求不被接受，通常是令牌权限和这一步不匹配。'
  if (status === 429) return '被 Cloudflare 限流了，等一分钟再试。'
  if (status >= 500) return 'Cloudflare 那边出错了，等一会儿再试。'
  return null
}

/** 令牌能不能用。返回 `{ok, status}`；无效直接抛错。 */
export async function verifyToken(apiToken) {
  const result = await cf(apiToken, '/user/tokens/verify')
  const status = result?.status ?? null
  if (status !== 'active') {
    throw new CloudflareError(`这个 API Token 的状态是「${status ?? '未知'}」，不是可用的状态。`, {
      hint: '去 Cloudflare 后台重新建一个令牌，建完立刻复制（令牌只显示一次）。',
    })
  }
  return { ok: true, status }
}

/**
 * 确定要用哪个 Cloudflare 账号。
 *
 * 填了就校验它属于这个令牌；没填就在令牌能看见的账号里挑——**只有一个时直接用**，
 * 多于一个就报错让用户填，绝不猜：猜错账号会在别人的账号里建一条隧道。
 */
export async function resolveAccount(apiToken, accountId) {
  const wanted = String(accountId ?? '').trim()
  if (wanted) {
    const one = await cf(apiToken, `/accounts/${encodeURIComponent(wanted)}`)
    if (!one?.id) {
      throw new CloudflareError(`找不到 Account ID 为 ${wanted} 的账号。`, {
        hint: 'Account ID 在 Cloudflare 后台的「账户主页 → 右侧栏」里，是一串 32 位十六进制。',
      })
    }
    return { id: one.id, name: one.name ?? '' }
  }
  const list = await cf(apiToken, '/accounts?per_page=50')
  const rows = Array.isArray(list) ? list : []
  if (!rows.length) {
    throw new CloudflareError('这个 API Token 一个账号都看不见。', {
      hint: '令牌的「账户资源」要包含你的账号。',
    })
  }
  if (rows.length > 1) {
    throw new CloudflareError(
      `这个令牌能看见 ${rows.length} 个账号（${rows.map((r) => r.name || r.id).join('、')}），不知道该用哪一个。`,
      { hint: '把 Account ID 填上。它在 Cloudflare 后台的「账户主页 → 右侧栏」。' },
    )
  }
  return { id: rows[0].id, name: rows[0].name ?? '' }
}

/**
 * 列出这个令牌能看见的所有域名（zone）。
 *
 * 一键配置要知道「用户有哪些域名」才能让他从列表里挑，而不是自己回忆
 * 或者去后台翻。返回 `[{id, name}]`，按名字排好序。
 */
export async function listZones(apiToken) {
  const list = await cf(apiToken, '/zones?per_page=50&account.id=*')
  const rows = Array.isArray(list) ? list : []
  return rows
    .filter((z) => z?.id && z?.name)
    .map((z) => ({ id: z.id, name: z.name, status: z.status ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** 按域名反查 zone。返回 `{id, name}`。 */
export async function findZone(apiToken, hostname) {
  const candidates = zoneCandidates(hostname)
  for (const name of candidates) {
    const list = await cf(apiToken, `/zones?name=${encodeURIComponent(name)}&per_page=1`)
    const zone = Array.isArray(list) ? list[0] : null
    if (zone?.id) return { id: zone.id, name: zone.name ?? name }
  }
  throw new CloudflareError(
    `在这个账号下找不到 ${hostname} 所属的区域（试过：${candidates.join('、') || '无'}）。`,
    {
      hint: '两种可能：① 这个域名还没托管到 Cloudflare（要先把域名的 NS 指过来）；'
        + '② 令牌的「区域资源」没包含它，或者少了「区域 → 区域 → 读取」权限。',
    },
  )
}

/**
 * 找到或建出这条隧道。
 *
 * 先按名字找：同一个域名配第二次时复用原来那条，不重复创建——否则 Cloudflare
 * 后台会堆出一串 `dsh-remote-lite-example-com`。
 */
export async function ensureTunnel(apiToken, accountId, name) {
  const query = `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`
    + `?name=${encodeURIComponent(name)}&is_deleted=false`
  const existing = await cf(apiToken, query)
  const hit = (Array.isArray(existing) ? existing : []).find((t) => t?.name === name && !t?.deleted_at)
  if (hit?.id) return { id: hit.id, created: false }

  const created = await cf(apiToken, `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`, {
    method: 'POST',
    body: {
      name,
      // 远端配置：ingress 存在 Cloudflare 那边，`cloudflared tunnel run --token`
      // 起来时会自己拉下来。用 local 的话插件还得在磁盘上维护一个 config.yml。
      config_src: 'cloudflare',
    },
  })
  if (!created?.id) throw new CloudflareError('Cloudflare 没有返回新建隧道的 id。')
  return { id: created.id, token: created.token ?? null, created: true }
}

/** 拿隧道令牌（建隧道那次没给全时补一次）。 */
export async function getTunnelToken(apiToken, accountId, tunnelId) {
  const token = await cf(
    apiToken,
    `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`,
  )
  if (typeof token !== 'string' || !token) {
    throw new CloudflareError('Cloudflare 没有返回隧道令牌。', {
      hint: '去后台「零信任 → 网络 → 隧道」里选中这条隧道，用「安装连接器」那条命令里的令牌。',
    })
  }
  return token
}

/** 把 ingress 写进远端配置。 */
export async function putIngress(apiToken, accountId, tunnelId, hostname, port) {
  await cf(
    apiToken,
    `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
    { method: 'PUT', body: ingressFor(hostname, port) },
  )
}

/**
 * 把域名的 CNAME 指向隧道。
 *
 * **软失败**：令牌没有 DNS 权限、或者记录冲突时，这里不抛——隧道本身还是能起来的，
 * 用户只要去后台手动加一条 CNAME 就通了。所以返回 `{ok:false, error, cname}`，
 * 由上层决定怎么告诉用户。硬失败会让「隧道已经建好了」这件事一起失败，得不偿失。
 *
 * **不删已有记录**：目标域名上已经有 A/AAAA 时直接报冲突。删用户的 DNS 记录这种事
 * 不该由一个插件代劳——他可能是故意指着别的东西。
 */
export async function ensureDns(apiToken, zoneId, hostname, tunnelId) {
  const cname = tunnelCname(tunnelId)
  let list
  try {
    list = await cf(apiToken, `/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(hostname)}`)
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err), cname, action: 'unknown' }
  }
  const existing = Array.isArray(list) ? list[0] : null

  try {
    if (!existing) {
      await cf(apiToken, `/zones/${encodeURIComponent(zoneId)}/dns_records`, {
        method: 'POST',
        body: { type: 'CNAME', name: hostname, content: cname, proxied: true, ttl: 1 },
      })
      return { ok: true, action: 'created', cname }
    }
    if (existing.type !== 'CNAME') {
      return {
        ok: false,
        action: 'conflict',
        cname,
        error: `${hostname} 上已经有一条 ${existing.type} 记录（指向 ${existing.content}），这里没有动它。`
          + `要去掉它、或者换一个子域名，然后再保存一次。`,
      }
    }
    if (existing.content === cname && existing.proxied === true) {
      return { ok: true, action: 'unchanged', cname }
    }
    await cf(apiToken, `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(existing.id)}`, {
      method: 'PUT',
      body: { type: 'CNAME', name: hostname, content: cname, proxied: true, ttl: 1 },
    })
    return { ok: true, action: 'updated', cname }
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err), cname, action: 'failed' }
  }
}

/**
 * 一条龙：校验令牌 → 定账号 → 找 zone → 建/复用隧道 → 写 ingress → 建 DNS。
 *
 * 返回的 `tunnelToken` 是**运行令牌**（cloudflared 用那个），和用户的 API Token
 * 不是一回事：前者只能跑这一条隧道，后者能改整个账号。两个都别外传。
 *
 * @returns {Promise<{accountId: string, accountName: string, tunnelId: string, tunnelToken: string,
 *   zone: string, dns: {ok: boolean, action: string, cname: string, error?: string}, created: boolean}>}
 */
export async function provision({ apiToken, accountId, hostname, port, log }) {
  await verifyToken(apiToken)
  log?.info?.('Cloudflare：令牌可用。')

  const account = await resolveAccount(apiToken, accountId)
  log?.info?.(`Cloudflare：账号 ${account.name || account.id}。`)

  const zone = await findZone(apiToken, hostname)
  log?.info?.(`Cloudflare：区域 ${zone.name}。`)

  const name = tunnelNameFor(hostname)
  const tun = await ensureTunnel(apiToken, account.id, name)
  log?.info?.(`Cloudflare：隧道 ${name}（${tun.created ? '新建' : '复用'}）。`)

  const token = tun.token || await getTunnelToken(apiToken, account.id, tun.id)
  await putIngress(apiToken, account.id, tun.id, hostname, port)
  log?.info?.(`Cloudflare：已把 ${hostname} 指向本机 ${port}。`)

  const dns = await ensureDns(apiToken, zone.id, hostname, tun.id)
  if (dns.ok) log?.info?.(`Cloudflare：DNS 记录已就绪（${dns.action}）。`)
  else log?.warn?.(`Cloudflare：DNS 没配好——${dns.error}`)

  return {
    accountId: account.id,
    accountName: account.name,
    tunnelId: tun.id,
    tunnelToken: token,
    zone: zone.name,
    dns,
    created: tun.created,
  }
}

/**
 * 把 provision 抛出来的东西整理成「一句人话 + 一句下一步」。
 *
 * 设置页那一块只有一行位置，塞不下多段。所以：有 hint 就带上，没有就只给原话。
 */
export function describeProvisionError(err) {
  const message = err?.message ?? String(err)
  const hint = err?.hint ?? null
  return hint ? `${message}\n${hint}` : message
}
