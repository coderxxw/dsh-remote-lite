/**
 * 配对信息：手机该扫哪个码、点哪条链接。
 *
 * 这是整个插件唯一一处主动把 token 交出去的地方，所以它只允许「本机」读取
 * （来源判断在 index.js 的路由里）。二维码里连 token 一起编进去——扫完直接
 * 进，不用手敲密码。
 *
 * 只有两条路：**局域网**（同一 Wi-Fi，明文 http）和**公网**（Cloudflare 隧道，
 * 走快速隧道时地址会变、走固定域名时地址不变）。别的一律没有。
 */
import QRCode from 'qrcode'
import { reachableAddresses } from './net.js'

const HINTS = {
  lan: '手机连同一个 Wi-Fi 时用这个',
  // 公网那条是唯一一条「出门也能用」的路，所以这里必须说清两件事：
  // 它是加密的（地址栏有 https 锁），以及**地址会不会变**（看用的是哪种隧道）。
  public: '出门在外用它，手机不用连家里 Wi-Fi。它也是加密的（地址栏上会出现 https 那把锁）。'
    + '用的是快速隧道，所以地址每次重启 DSH 都会换',
  // 固定隧道：同一个公网出口，但地址是**用户自己的域名**，钉死不换。
  named: '这是你自己域名上的固定地址，重启 DSH 也不会变，扫一次以后一直用。'
    + '它同样经过 Cloudflare（地址栏上会出现 https 那把锁）。',
}

/**
 * 交给面板的公网网址，该给还是该收回。
 *
 * 2026-09-22：用户照着一个写着「已开启」的面板去扫码，扫出来是 Cloudflare 的
 * Error 1033——cloudflared 进程活着，但它到边缘的连接早断了，插件只认「网址打印出来了」。
 * 补了一道自测（见 index.js 的 startTunnelProbe），判死之后**不再把网址交出去**：
 * 拿到网址就会画一条二维码，而那条现在扫了只会得到 1033。宁可什么都不给，
 * 也不要给一个扫不开的码。
 *
 * 抽成纯函数是为了能单测：真那条路要起 cloudflared、要等定时器、还要联网。
 *
 * @param {boolean|null} healthy true=通，false=判死，null=还不知道
 * @param {string|null|undefined} url cloudflared 打印出来的网址
 */
export function tunnelUrlFor(healthy, url) {
  if (healthy === false) return null
  return url ?? null
}

/**
 * 隧道自测失败时，这到底是「隧道坏了」还是「本机 DNS 坏了」。
 *
 * 两者必须分开，因为处置完全不同：
 * - `dns`：隧道是好的，只是**这台电脑**解析不了那个域名。手机在外面走运营商的 DNS
 *   很可能好好的，所以**不能收回网址**，只提醒一句。2026-09-22 实测：cloudflared
 *   连着 3 条边缘连接、公共 DNS 都解析得出、强制指到真实 IP 打过去是 200，
 *   可本机路由器（192.168.1.1）就是查不到 *.trycloudflare.com。
 * - `dead`：真的连不上，该判死、该收回网址。
 */
export function tunnelProbeVerdict(code) {
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns'
  return 'dead'
}

/** 二维码编成 PNG 的 data URL，前端直接塞进 <img src>。 */
async function qr(text) {
  try {
    return await QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 1, width: 220 })
  } catch {
    // 画不出二维码不该让整个面板挂掉，前端会退化成只显示链接
    return null
  }
}

/**
 * @param {object} opts
 * @param {number} opts.port 手机服务实际监听的端口
 * @param {string} opts.token
 * @param {string[]} [opts.bound] 真正绑定成功的地址；不传则用探测结果
 * @param {{enabled?: boolean, mode?: 'quick'|'named', hostname?: string, accountId?: string,
 *   url?: string|null, starting?: boolean, error?: string|null, provisioned?: boolean,
 *   hasApiToken?: boolean, hasTunnelToken?: boolean, dns?: 'ok'|'manual'|null}} [opts.tunnel] 公网隧道状态
 */
export async function buildPairing({ port, token, bound, tunnel }) {
  const detected = reachableAddresses()
  const usable = bound ? detected.filter((a) => bound.includes(a.address)) : detected

  const entries = []
  for (const a of usable) {
    const url = `http://${a.address}:${port}/mini?token=${token}`
    entries.push({
      kind: a.kind,
      label: a.label,
      hint: HINTS[a.kind] ?? '',
      url,
      qr: await qr(url),
    })
  }

  // 公网那条排在最后：它是补充，不是主路。
  //
  // 两种公网出口共用这一格：`mode: 'named'` 是固定域名（用户自己的域名，重启不变），
  // 否则是免账号的快速隧道（地址每次重启都换）。**kind 要分开**，因为界面上的文案
  // 完全不同——一个是「扫一次以后一直用」，一个是「重启后回来重扫」。
  if (tunnel?.url) {
    const named = tunnel?.mode === 'named'
    const url = `${tunnel.url}/mini?token=${token}`
    entries.push({
      kind: named ? 'named' : 'public',
      label: named ? '固定域名' : '公网',
      hint: named ? HINTS.named : HINTS.public,
      url,
      qr: await qr(url),
    })
  }

  const status = {
    enabled: Boolean(tunnel?.enabled),
    up: Boolean(tunnel?.url),
    starting: Boolean(tunnel?.starting),
    error: tunnel?.error ?? null,
    /**
     * 用的是哪条出口。`named` = 用户自己域名的固定隧道，`quick` = 免账号的快速隧道。
     *
     * 界面要按它换文案：固定隧道说「扫一次以后一直用」，快速隧道说「重启后回来重扫」。
     * 说反了比不说更糟——用户会以为地址不会变，重启之后拿着旧链接打不开。
     */
    mode: tunnel?.mode === 'named' ? 'named' : 'quick',
    /** 固定隧道用的域名（没配就是空串）。**不含令牌**，只有域名。 */
    hostname: typeof tunnel?.hostname === 'string' ? tunnel.hostname : '',
    /** Cloudflare Account ID。它不是密码，回显出来用户才知道自己配的是哪个账号。 */
    accountId: typeof tunnel?.accountId === 'string' ? tunnel.accountId : '',
    /** 隧道 id 已经落下来了（= 建过一次，重启不用再走 API）。 */
    provisioned: Boolean(tunnel?.provisioned),
    /** 手上有没有 API Token。**只回答有没有，永远不回显**。 */
    hasApiToken: Boolean(tunnel?.hasApiToken),
    /** 手上有没有隧道令牌（粘贴进来的，或者上次自动建出来的）。同上，只回答有没有。 */
    hasTunnelToken: Boolean(tunnel?.hasTunnelToken),
    /** DNS 那一步的结果：'ok' / 'manual'（要用户自己去后台加一条 CNAME）/ null（还没跑过）。 */
    dns: tunnel?.dns ?? null,
  }

  if (!entries.length) {
    // 一条能用的都没有。两种成因要分开说，否则用户不知道该去改配置、去查网络，
    // 还是去开公网——这两件事的下一步动作完全不同。
    if (status.enabled && status.error) {
      return { ok: false, error: `公网访问没起来：${status.error}`, tunnel: status }
    }
    if (detected.length) {
      return {
        ok: false,
        error: '现在设置成只有这台电脑能连。把 settings.json 里的 bindAddress 改成 "auto"，'
          + '重启 DSH 之后手机就能连了。',
        tunnel: status,
      }
    }
    return {
      ok: false,
      error: '没找到手机能连上的地址。检查一下这台电脑的 Wi-Fi／网线；'
        + '出门在外的话，把下面的「公网访问」打开。',
      tunnel: status,
    }
  }

  return { ok: true, port, token, entries, tunnel: status }
}
