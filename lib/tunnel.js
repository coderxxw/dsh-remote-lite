/**
 * 起一条 cloudflared 快速隧道，把本机的手机服务暴露到一个公网网址。
 *
 * 「快速隧道」是 Cloudflare 提供的免账号模式：跑起来就给你一个
 * `https://<随机词>.trycloudflare.com` 的地址，转发回本机。代价是**这个网址
 * 每次重启都会换一个**，所以手机上的旧链接会失效，得重新扫一次二维码。
 */
import { spawn } from 'node:child_process'

/**
 * 从 cloudflared 的输出里挑出公网网址。
 *
 * 有个坑：输出里会**先**出现 `https://api.trycloudflare.com`——那是它向
 * Cloudflare 注册时用的接口地址，不是给你的网址。不加排除就会把用户送到一个
 * 打不开的地址上。所以用负向前瞻把 `api.` 开头的排掉。
 *
 * 这个坑不是我们自己踩出来的，是从 dsh-pocket（shaobeichen，GPL-2.0）的注释里知道的，
 * 它记在自己的 issue #32。**知道一个坑和抄一段代码是两回事**——这个正则、这里的函数
 * 划分、以及这段说明都是我们自己写的。README 的「致谢」一节写明了这层关系。
 */
export const QUICK_TUNNEL_URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i

/**
 * 公网隧道失败时，告诉用户「接下来做什么」。
 *
 * 2026-09-22 实测：本机代理的 **TUN 模式**（Clash 这类）会掐断 cloudflared 到 Cloudflare
 * 边缘的连接——cloudflared 好好活着，却一条 ESTABLISHED 都没有；DNS 还被劫持成
 * `198.18.x.x` 这种假地址（RFC 2544 保留段，真实世界不存在），走假地址访问隧道，
 * Cloudflare 回 530（也就是用户看到的 Error 1033）。
 *
 * 这个坑 dsh-pocket 也踩过，它的报错文案里就写着「是否开着代理/VPN（Clash 等 TUN 模式
 * 会掐断隧道连接）」。它没有解决，只是把它写进报错——因为**用户看到「连不上」的第一
 * 反应是重试，而正确的动作往往是关代理**。所以这句必须写出来，不能省。
 *
 * 顺带指一条走得通的路：这个插件本来就有 Tailscale 那条，不必在 Cloudflare 上死磕。
 *
 * 放在这里（而不是 index.js 里）是为了能单测：文案本身就是这次的交付物，
 * 少写一句「关代理」用户就会一直重试，值得钉住。
 */
export const TUNNEL_HINT = '如果电脑上开着代理或 VPN（Clash 这类），先关掉再试一次——它们的'
  + '「TUN 模式」会把隧道连接掐断。关掉还不行，就说明这条网络走不通 Cloudflare，'
  + '改用设置页里的 Tailscale 那条（出门在外它更稳）。'

/**
 * 从一段输出里挑出公网网址，没有就返回 null。
 * 单独抽出来是为了能直接测——这段正则的坑（`api.trycloudflare.com` 要先出现）
 * 值得用测试钉住，而不是靠真连一次 Cloudflare 去碰运气。
 */
export function parseTunnelUrl(text) {
  return QUICK_TUNNEL_URL_RE.exec(String(text ?? ''))?.[0] ?? null
}

/** 累积输出的上限。网址最多几十字节，留 8KB 足够，免得日志越攒越多。 */
const TAIL_LIMIT = 8000

const START_TIMEOUT_MS = 30_000

/**
 * @param {object} opts
 * @param {string} opts.binPath cloudflared 可执行文件
 * @param {number} opts.port 本机手机服务的端口
 * @returns {Promise<{url: string, stop: () => void, onExit: (cb: (code: number|null) => void) => () => void}>}
 */
export function startTunnel({ binPath, port, log }) {
  // --no-autoupdate 必须放在子命令**之前**：cloudflared 2026.x 去掉了 `tunnel`
  //   子命令层级的这个参数，全局位置仍然有效。
  // --protocol http2 是必要的：默认走 QUIC（UDP 7844），国内网络和不少企业网把
  //   UDP 封掉，表现是隧道报 error 1033 连不上；HTTP/2 走 TCP 443，基本都通。
  // --edge-ip-version 4 同样是必要的，而且更隐蔽：隧道控制面 region1/region2.
  //   v2.argotunnel.com 在不少网络里**只解析出 IPv6**，而那条路往往不通。实测
  //   不加这个参数时，cloudflared 要么卡在向 api.trycloudflare.com 注册（POST
  //   超时），要么拿到网址却连不上边缘（公网访问回 HTTP 530）；加上之后连接
  //   立刻注册成功。走 IPv4 的代价是可以接受的——隧道两端都是 Cloudflare 的
  //   任播地址，IPv4 覆盖没有短板。
  const child = spawn(
    binPath,
    [
      '--no-autoupdate',
      'tunnel',
      '--url', `http://127.0.0.1:${port}`,
      '--protocol', 'http2',
      '--edge-ip-version', '4',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )

  const exitListeners = new Set()
  const stop = () => {
    try {
      child.kill()
    } catch {
      // 已经退出了
    }
  }
  const onExit = (cb) => {
    exitListeners.add(cb)
    return () => exitListeners.delete(cb)
  }
  child.on('exit', (code) => {
    for (const cb of exitListeners) cb(code)
  })

  return new Promise((resolve, reject) => {
    let settled = false
    let tail = ''

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      stop()
      reject(new Error(`等了 30 秒还没拿到公网网址。cloudflared 最后说的话：\n${tail.trim().slice(-500)}`))
    }, START_TIMEOUT_MS)
    timer.unref?.()

    // 拿到网址之后仍然保持监听、只是不再处理——中途摘掉监听会让管道不再被消费，
    // 64KB 缓冲填满后 cloudflared 会被卡住。
    const onData = (chunk) => {
      if (settled) return
      // 要在**累积**的缓冲区里找，不能只看刚到这一块：网址有可能被拆成两次写出来。
      tail = (tail + String(chunk)).slice(-TAIL_LIMIT)
      const found = parseTunnelUrl(tail)
      if (!found) return
      settled = true
      clearTimeout(timer)
      log?.info?.(`公网地址：${found}`)
      resolve({ url: found, stop, onExit })
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`cloudflared 起不来：${err?.message ?? err}`))
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`cloudflared 提前退出了（退出码 ${code}）。它最后说的话：\n${tail.trim().slice(-500)}`))
    })
  })
}

// ---------------------------------------------------------------------------
// 固定隧道（自己的域名）
// ---------------------------------------------------------------------------

/**
 * 固定隧道「连上了」的那一行日志。
 *
 * 和快速隧道不一样：这里**没有网址可等**——域名是用户自己的，跑之前就知道。
 * 所以判据从「打印出一个 trycloudflare 网址」换成「它向边缘注册成功」：
 *
 *     INF Registered tunnel connection connIndex=0 connection=… location=nrt01 protocol=http2
 *
 * 这句话出现，才说明这条隧道真的挂上了 Cloudflare 的边缘；在此之前域名是打不开的
 * （Cloudflare 那边没有连接器，会回 1033）。只看「进程起来了」是不够的——那正是
 * 2026-09-22 那次「面板写着已开启、手机扫出来 1033」的同一个坑。
 *
 * 抽成纯函数是为了能单测：真那条路要起子进程、要联网、还要一个已存在的隧道。
 */
export const NAMED_READY_RE = /Registered tunnel connection|Registered tunnel connection connIndex/i

export function namedTunnelReady(text) {
  return NAMED_READY_RE.test(String(text ?? ''))
}

/**
 * `cloudflared` 跑固定隧道时的参数。
 *
 * 单独抽出来是为了能测：参数顺序错了不会有任何报错，只会表现成「进程起来了但永远
 * 注册不上」——最难查的那种。三条要求都写在数组的注释里。
 */
export function namedTunnelArgs() {
  return [
    // 这三个是**全局参数**，放在 `tunnel` 之前：`run` 这个动作下面没有它们。
    // （快速隧道那条把它们写在 `tunnel` 之后，是因为 `tunnel --url` 是另一条
    //  快捷形式、实测那样也能解析。这里不跟着抄，用最稳的位置。）
    '--no-autoupdate',
    '--protocol', 'http2',
    '--edge-ip-version', '4',
    'tunnel',
    'run',
  ]
}

/**
 * 起一条固定隧道。
 *
 * 令牌走**环境变量**（`TUNNEL_TOKEN`）而不是命令行参数：`--token` 会出现在进程列表里
 * （`ps`、任务管理器、某些监控都看得见），而这条令牌等同于「跑这条隧道」的钥匙。
 * cloudflared 官方就支持这个环境变量（Docker 那条路用的就是它）。
 *
 * ingress 用的是**远端配置**（建隧道时 `config_src: 'cloudflare'`，见 lib/cloudflare.js），
 * 所以这里不需要 `--config`，也不需要本地 config.yml——`run` 起来它会自己去拉。
 *
 * @param {object} opts
 * @param {string} opts.binPath cloudflared 可执行文件
 * @param {string} opts.token 隧道令牌（不是 API Token）
 * @param {string} opts.hostname 要报告的网址，例如 dsh.example.com
 * @returns {Promise<{url: string, kind: 'named', stop: () => void, onExit: (cb: (code: number|null) => void) => () => void}>}
 */
export function startNamedTunnel({ binPath, token, hostname, log }) {
  if (!token) return Promise.reject(new Error('没有隧道令牌，起不了固定隧道。'))

  const child = spawn(
    binPath,
    namedTunnelArgs(),
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TUNNEL_TOKEN: token },
    },
  )

  const exitListeners = new Set()
  const stop = () => {
    try {
      child.kill()
    } catch {
      // 已经退出了
    }
  }
  const onExit = (cb) => {
    exitListeners.add(cb)
    return () => exitListeners.delete(cb)
  }
  child.on('exit', (code) => {
    for (const cb of exitListeners) cb(code)
  })

  return new Promise((resolve, reject) => {
    let settled = false
    let tail = ''

    // 固定隧道比快速隧道慢一档：它要先拿远端配置、再和边缘注册。45 秒是实测
    // （国内经代理节点时最慢见过 20 多秒）留出的余量。
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      stop()
      reject(new Error(
        `等了 45 秒，这条固定隧道还没和 Cloudflare 的边缘注册上。cloudflared 最后说的话：\n${tail.trim().slice(-600)}`,
      ))
    }, 45_000)
    timer.unref?.()

    const onData = (chunk) => {
      if (settled) return
      tail = (tail + String(chunk)).slice(-TAIL_LIMIT)
      if (!namedTunnelReady(tail)) return
      settled = true
      clearTimeout(timer)
      const url = `https://${String(hostname ?? '').trim().toLowerCase()}`
      log?.info?.(`固定隧道已连上：${url}`)
      resolve({ url, kind: 'named', stop, onExit })
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`cloudflared 起不来：${err?.message ?? err}`))
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(
        `cloudflared 提前退出了（退出码 ${code}）。固定隧道最常见的原因是令牌不对或者隧道被删了。`
        + `它最后说的话：\n${tail.trim().slice(-600)}`,
      ))
    })
  })
}
