// dsh-remote-lite 网页客户端：在 DSH 设置页加一个「手机遥控」标签页。
//
// 手写，没有构建步骤：元素一律用 React.createElement 构造，样式全部内联。
// 外层 window.__ModuleLoader__.load({ id, factory }) 的写法照抄 dsh-pocket
// （见其 client/build.mjs 生成的 client/client.js），只把内容换成这里的。
//
// 数据来自同源 GET /mini-remote/pairing（host 侧 lib/index.js 注册的路由）：
//   { ok: true, port, token, entries: [{ kind, label, hint, url, qr }] }
//   { ok: false, error: '……' }   ← 403（不是本机）/ 503（还没起来）/ 500
// 注意：失败时 HTTP 状态码不是 200，但响应体仍是 JSON，里面带着真正的原因，
// 所以这里先解析响应体、再看 body.ok，不拿状态码覆盖原文。

window.__ModuleLoader__.load({
  id: "dsh-remote-lite",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // 客户端模块系统把 react 当模块提供，不是全局，必须 require。
    var React = require("react");

    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;

    var PAIRING_PATH = '/mini-remote/pairing';
    var TOKEN_PATH = '/mini-remote/token';
    var TUNNEL_PATH = '/mini-remote/tunnel';
    var NAMED_TUNNEL_PATH = '/mini-remote/tunnel/named';
    var ZONES_PATH = '/mini-remote/tunnel/zones';

    // 颜色走 DSH 主题变量（真名前缀是 --dsw-alias-，深浅色自动跟随）。
    // 每个变量都带一个浅色兜底值，变量缺失时界面仍然可读。
    var styles = {
      card: { background: 'var(--dsw-alias-bg-layer-1,#fff)', border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', borderRadius: 12, padding: '16px 20px', maxWidth: 560 },
      title: { fontWeight: 600, fontSize: 13, marginBottom: 4 },
      muted: { color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 12, lineHeight: 1.5 },
      warn: { color: 'var(--dsw-alias-state-warn-primary,#b45309)', fontSize: 12, lineHeight: 1.5, marginTop: 4 },
      loading: { color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 13, marginTop: 12 },
      error: { color: 'var(--dsw-alias-state-error-primary,#dc2626)', fontSize: 13, lineHeight: 1.6, marginTop: 12 },
      block: { borderTop: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', marginTop: 16, paddingTop: 16 },
      entryTitle: { fontWeight: 600, fontSize: 13 },
      link: { color: 'var(--dsw-alias-brand-primary,#2563eb)', fontSize: 12, textDecoration: 'underline', display: 'inline-block', marginTop: 4 },
      entryRow: { display: 'flex', alignItems: 'flex-start', gap: 14, marginTop: 10, flexWrap: 'wrap' },
      qr: { width: 180, height: 180, flex: 'none', borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', background: '#fff' },
      qrFallback: { width: 180, minHeight: 180, flex: 'none', boxSizing: 'border-box', padding: 12, borderRadius: 10, border: '1px dashed var(--dsw-alias-border-l3,#d1d5db)', color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 12, lineHeight: 1.5 },
      urlCol: { flex: '1 1 220px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 },
      input: { font: 'inherit', width: '100%', boxSizing: 'border-box', fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12, padding: '7px 9px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2,#e5e7eb)', background: 'var(--dsw-alias-bg-base,#fff)', color: 'var(--dsw-alias-label-primary,inherit)' },
      btn: { font: 'inherit', cursor: 'pointer', alignSelf: 'flex-start', height: 30, padding: '0 14px', borderRadius: 999, fontSize: 12, border: '1px solid var(--dsw-alias-button-ghost-active-border,var(--dsw-alias-border-l2,#d1d5db))', background: 'var(--dsw-alias-bg-layer-1,#fff)', color: 'var(--dsw-alias-label-primary,inherit)' },
      toggleRow: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 13, cursor: 'pointer' },
      // cloudflared 的报错是多行原文，换行要留住，否则一长条读不了。
      detail: { color: 'var(--dsw-alias-state-warn-primary,#b45309)', fontSize: 12, lineHeight: 1.6, marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    };

    function MiniRemoteSettingsTab() {
      var infoState = useState(null);
      var info = infoState[0];
      var setInfo = infoState[1];
      var failState = useState(null);
      var failure = failState[0];
      var setFailure = failState[1];
      var copyState = useState(null);
      var copied = copyState[0];
      var setCopied = copyState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      // 密码默认打码。面板虽然只有本机能看，但屏幕边上站着人的时候很多——
      // 一串明文密码摆在设置页上，截图、投屏、路过，都能带走它。
      var showState = useState(false);
      var showPwd = showState[0];
      var setShowPwd = showState[1];
      var draftState = useState('');
      var draft = draftState[0];
      var setDraft = draftState[1];
      var pwdErrState = useState(null);
      var pwdError = pwdErrState[0];
      var setPwdError = pwdErrState[1];
      // 固定隧道（自己的域名）那一块的草稿。
      // **两个凭据框永远是空的**：服务端从不回显它们（和访问口令同一条规矩），
      // 所以「留空」只能解释成「不改动原来那份」——否则用户每存一次都得重贴一遍令牌。
      var namedDraftState = useState(null);
      var namedDraft = namedDraftState[0];
      var setNamedDraft = namedDraftState[1];
      var namedErrState = useState(null);
      var namedError = namedErrState[0];
      var setNamedError = namedErrState[1];
      // 「直接粘隧道令牌」那条退路默认收起：它是给「我已经在后台建好了隧道」的人用的，
      // 摊开着会让第一次配的人以为要填两个令牌。
      var namedAdvState = useState(false);
      var namedAdvOpen = namedAdvState[0];
      var setNamedAdvOpen = namedAdvState[1];
      // 一键配置：从 API Token 读出来的域名列表。空列表表示还没读过。
      var zonesState = useState({ list: [], loading: false, error: null });
      var zones = zonesState[0];
      var setZones = zonesState[1];

      // 同源 GET，不带任何 token：这台电脑自己读得到，别人的电脑读不到。
      useEffect(function () {
        var alive = true;
        fetch(PAIRING_PATH)
          .then(function (res) {
            // 403 / 503 / 500 的响应体也是 JSON，里面写着原因，别按状态码丢掉。
            return res.json().then(
              function (body) { return { status: res.status, body: body }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            if (!alive) return;
            if (r.body && typeof r.body === 'object') setInfo(r.body);
            else setFailure('读不到配对信息：这台电脑上的服务返回了 HTTP ' + r.status + '。');
          })
          .catch(function (err) {
            if (!alive) return;
            setFailure('连不上这台电脑上的遥控服务：' + ((err && err.message) || String(err)));
          });
        return function () { alive = false; };
      }, []);

      // 「已复制」只停留一会儿，然后自己变回「复制」。
      useEffect(function () {
        if (!copied) return undefined;
        var timer = setTimeout(function () { setCopied(null); }, 1500);
        return function () { clearTimeout(timer); };
      }, [copied]);

      // 固定隧道那份草稿：**只填一次**。域名和 Account ID 是可以回显的（不是密码），
      // 两个令牌永远是空的——服务端根本不把它们送回来。
      useEffect(function () {
        if (namedDraft) return;
        var t = info && info.tunnel;
        if (!t) return;
        setNamedDraft({
          hostname: typeof t.hostname === 'string' ? t.hostname : '',
          accountId: typeof t.accountId === 'string' ? t.accountId : '',
          apiToken: '',
          tunnelToken: '',
        });
      }, [info, namedDraft]);

      var copy = function (url) {
        if (!url) return;
        var clip = typeof navigator !== 'undefined' ? navigator.clipboard : null;
        if (!clip || typeof clip.writeText !== 'function') return;
        try {
          var done = clip.writeText(url);
          // 失败就保持原样（不谎报「已复制」）——输入框里的地址仍可手动全选。
          if (done && typeof done.then === 'function') done.then(function () { setCopied(url); }, function () {});
          else setCopied(url);
        } catch (e) { /* 剪贴板不可用：保持原样 */ }
      };

      // 和服务端那道校验是同一个数。前端先拦一道只是为了让「太短了」当场说出来，
      // 不用等一趟网络；真正的门在服务端，这里改了那边不改也进不去。
      var MIN_PASSWORD_LEN = 12;

      // 换一个自己设的密码。
      var savePassword = function () {
        var next = (draft || '').trim();
        if (next.length < MIN_PASSWORD_LEN) {
          setPwdError('密码至少要 ' + MIN_PASSWORD_LEN + ' 位，现在这串只有 ' + next.length + ' 位。');
          return;
        }
        setPwdError(null);
        setBusy(true);
        fetch(TOKEN_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: next }),
        })
          .then(function (res) {
            return res.json().then(
              function (body) { return { status: res.status, body: body }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            if (r.status === 200 && r.body && r.body.ok !== false) {
              setDraft('');
              setInfo(r.body);
            } else {
              setPwdError((r.body && r.body.error) || ('改密码失败：服务返回了 HTTP ' + r.status + '。'));
            }
          })
          .catch(function (err) {
            setPwdError('改密码失败：' + ((err && err.message) || String(err)));
          })
          .then(function () { setBusy(false); });
      };

      // 开/关公网访问。这个请求可能要等十几秒（第一次要下载 cloudflared），
      // 所以期间把开关禁掉，免得连点几次起出好几条隧道。
      var toggleTunnel = function (enabled) {
        if (busy) return;
        setBusy(true);
        fetch(TUNNEL_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: enabled }),
        })
          .then(function (res) {
            return res.json().then(
              function (body) { return { status: res.status, body: body }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            if (r.body && typeof r.body === 'object') { setInfo(r.body); setFailure(null); }
            else setFailure('切换公网访问失败：服务返回了 HTTP ' + r.status + '。');
          })
          .catch(function (err) {
            setFailure('切换公网访问失败：' + ((err && err.message) || String(err)));
          })
          .then(function () { setBusy(false); });
      };

      /**
       * 切公网出口：快速隧道 ⇄ 固定域名。
       *
       * 服务端那边收到 `mode` 会把旧那条整个停掉再起新的（两条是不同的连接），
       * 所以这里要等一趟网络；期间禁掉按钮，免得连点切出两条。
       */
      var switchTunnelMode = function (mode) {
        if (busy) return;
        setBusy(true);
        setNamedError(null);
        fetch(TUNNEL_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            // 切换时**沿用当前的开关状态**：用户只是想换个出口，不是想开/关。
            enabled: Boolean(info && info.tunnel && info.tunnel.enabled),
            mode: mode,
          }),
        })
          .then(function (res) {
            return res.json().then(
              function (body) { return { status: res.status, body: body }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            if (r.body && typeof r.body === 'object') { setInfo(r.body); setFailure(null); }
            else setNamedError('切换公网出口失败：服务返回了 HTTP ' + r.status + '。');
          })
          .catch(function (err) {
            setNamedError('切换公网出口失败：' + ((err && err.message) || String(err)));
          })
          .then(function () { setBusy(false); });
      };

      /**
       * 存「固定域名隧道」的配置并启用。
       *
       * 两个令牌留空 = 不改动原来那份（服务端从不回显）。域名/账号/令牌只要变了一样，
       * 服务端就会重新走一次 Cloudflare API（旧的隧道 id 作废）；三样都没变时不重建，
       * 省掉一次没必要的调用。
       *
       * 隧道起不来的原因**不在这个函数的错误里**：它在 `info.tunnel.error` 上，
       * 由那一块自己渲染（服务端把「哪一步失败、下一步做什么」都写好了）。
       * 这里只管 HTTP 层面的失败和域名格式。
       */
      /**
       * 一键配置第一步：拿 API Token 问「你有哪几个域名」，结果做成下拉框。
       *
       * 以前用户得自己回忆域名、再去后台确认有没有托管过来；这一步把那个来回
       * 省掉。只读，不改任何设置。
       */
      var loadZones = function () {
        if (busy) return;
        var tok = (namedDraft && namedDraft.apiToken || '').trim();
        if (!tok) {
          setNamedError('先把 Cloudflare API Token 填进来，我才能读你的域名。');
          return;
        }
        setNamedError(null);
        setBusy(true);
        setZones({ list: [], loading: true, error: null });
        fetch(ZONES_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ apiToken: tok }),
        })
          .then(function (res) {
            return res.json().then(
              function (b) { return { status: res.status, body: b }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            var b = (r.body && typeof r.body === 'object') ? r.body : null;
            if (!b || b.ok === false) {
              setZones({
                list: [],
                loading: false,
                error: (b && b.error) || ('读取失败：HTTP ' + r.status),
              });
              return;
            }
            var list = Array.isArray(b.zones) ? b.zones : [];
            setZones({ list: list, loading: false, error: b.hint || null });
            // 只读到一个域名就直接选中，少一次点击。
            if (list.length === 1) {
              var only = list[0].name;
              setNamedDraft(function (prev) {
                var next = Object.assign({}, prev || {});
                next.hostname = 'dsh.' + only;
                return next;
              });
            }
          })
          .catch(function (err) {
            setZones({ list: [], loading: false, error: '读取失败：' + (err && err.message || err) });
          })
          .then(function () { setBusy(false); });
      };

      var saveNamedTunnel = function () {
        if (!namedDraft || busy) return;
        var host = (namedDraft.hostname || '').trim();
        if (!host) {
          setNamedError('先填一个域名，例如 dsh.example.com。');
          return;
        }
        setNamedError(null);
        setBusy(true);
        var body = {
          hostname: host,
          accountId: (namedDraft.accountId || '').trim(),
          enabled: true,
        };
        if (namedDraft.apiToken) body.apiToken = namedDraft.apiToken;
        if (namedDraft.tunnelToken) body.tunnelToken = namedDraft.tunnelToken;
        fetch(NAMED_TUNNEL_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function (res) {
            return res.json().then(
              function (b) { return { status: res.status, body: b }; },
              function () { return { status: res.status, body: null }; },
            );
          })
          .then(function (r) {
            var b = (r.body && typeof r.body === 'object') ? r.body : null;
            if (!b) {
              setNamedError('保存失败：服务返回了 HTTP ' + r.status + '。');
              return;
            }
            setInfo(b);
            setFailure(null);
            // 域名格式那类错误由服务端在 `error` 里给（HTTP 400），照登；
            // 隧道本身起不来的原因在 `tunnel.error`，那一块自己会显示。
            setNamedError(b.ok === false && b.error ? b.error : null);
            // 令牌已经落到服务端了，留在页面上只是多一份暴露面。
            setNamedDraft(function (d) {
              return d ? Object.assign({}, d, { apiToken: '', tunnelToken: '' }) : d;
            });
          })
          .catch(function (err) {
            setNamedError('保存失败：' + ((err && err.message) || String(err)));
          })
          .then(function () { setBusy(false); });
      };

      return h('div', { style: styles.card },
        h('div', { style: styles.title }, '手机遥控'),
        h('div', { style: styles.muted }, '手机扫码就能用，不用输密码——密码已经编在二维码里了。'),
        h('div', { style: styles.warn }, '这个页面带着密码，别截图发出去。'),
        content(info, failure, copied, copy, busy, toggleTunnel, {
          showPwd: showPwd,
          setShowPwd: setShowPwd,
          draft: draft,
          setDraft: setDraft,
          busy: busy,
          pwdError: pwdError,
          savePassword: savePassword,
        }, {
          draft: namedDraft,
          setDraft: setNamedDraft,
          error: namedError,
          busy: busy,
          save: saveNamedTunnel,
          switchMode: switchTunnelMode,
          advancedOpen: namedAdvOpen,
          toggleAdvanced: function () { setNamedAdvOpen(function (v) { return !v; }); },
          zones: zones,
          loadZones: loadZones,
        }),
      );
    }

    function content(info, failure, copied, copy, busy, toggle, pwd, named) {
      if (failure) return h('div', { style: styles.error }, failure);
      if (!info) return h('div', { style: styles.loading }, '正在读取配对信息…');

      var blocks = [];
      if (info.ok === false) {
        blocks.push(h('div', { key: 'err', style: styles.error }, info.error || '读取配对信息失败。'));
      } else {
        var entries = Array.isArray(info.entries) ? info.entries : [];
        if (!entries.length) {
          blocks.push(h('div', { key: 'none', style: styles.muted }, '这台电脑暂时没有手机能连上的地址。'));
        } else {
          for (var i = 0; i < entries.length; i += 1) blocks.push(entryBlock(entries[i], i, copied, copy));
        }
        // 密码紧跟在那几条二维码后面：它是这些链接背后的钥匙，放在一起才讲得通。
        if (typeof info.token === 'string' && info.token) blocks.push(passwordBlock(info, copied, copy, pwd));
      }
      // 出错时也要把开关露出来：不然「隧道起不来」会让整个面板变成一条报错，
      // 用户连关掉它的地方都找不到。
      if (info.tunnel) blocks.push(tunnelBlock(info.tunnel, busy, toggle, named));
      // 固定域名那一块：**不管当前用的是哪条出口都显示**。用快速隧道的人要能看见
      // 「还有一条地址不变的」，否则他永远不知道这个选项存在；而配了一半的人更要看见它。
      if (info.tunnel) blocks.push(namedTunnelBlock(info, named, busy));
      return h('div', null, blocks);
    }

    /** 设置页里的一个输入行。标签在上、输入框在下，和这一页其它地方一致。 */
    function field(label, value, placeholder, onChange, type) {
      return h('div', { key: label, style: { marginTop: 10 } },
        h('div', { style: styles.muted }, label),
        h('input', {
          type: type,
          value: value,
          placeholder: placeholder,
          spellCheck: false,
          autoComplete: 'off',
          onChange: function (e) { onChange(e.target.value); },
          style: Object.assign({}, styles.input, { marginTop: 4 }),
        }),
      );
    }


    /**
     * 公网访问：开关 + 当前出口。
     *
     * 出口有两条，**同一个开关管着**（`tunnel.enabled`）：快速隧道（地址会变）和
     * 固定域名（地址不变）。切换用下面两个按钮，服务端收到 `mode` 会把旧那条整个
     * 停掉再起新的——两条是不同的连接，不能同时开。
     */
    function tunnelBlock(tunnel, busy, toggle, named) {
      var enabled = Boolean(tunnel.enabled);
      var working = Boolean(busy || tunnel.starting);
      var namedMode = tunnel.mode === 'named';
      var host = typeof tunnel.hostname === 'string' ? tunnel.hostname : '';
      var status;
      if (working) status = '正在打开…第一次要先下载一个 50MB 左右的组件，可能要等一会儿。';
      else if (tunnel.up) {
        status = namedMode
          ? '已连上。上面那条「固定域名」就是出门用的地址——重启 DSH 也不会变。'
          : '已开启。上面那条「公网」就是出门用的地址。刚打开的话等半分钟再扫——Cloudflare 要先把这个域名公布出去。';
      }
      // 「一直没拿到地址」和「拿到过、后来断了」是两回事：前者多半还在等，后者得重开一次。
      // 合成一句「还没拿到公网地址」的话，第二种情况的用户会一直等下去。
      else if (enabled) {
        status = tunnel.error
          ? '开着，但公网那边连不上。手机现在走这条路会打不开——下面那段就是它说的话。'
          : (namedMode ? '已开启，但固定隧道还没连上 Cloudflare 的边缘。' : '已开启，但还没拿到公网地址。');
      } else {
        status = namedMode
          ? (host ? '没开。开了之后手机用固定域名 ' + host + ' 就能进来。' : '没开，而且下面还没填域名。')
          : '没开。手机不连家里 Wi-Fi 的时候就进不来（除非用下面的固定域名）。';
      }

      return h('div', { key: 'tunnel', style: styles.block },
        h('div', { style: styles.entryTitle }, '公网访问'),
        h('div', { style: styles.muted }, namedMode
          ? '当前出口：固定域名' + (host ? '（' + host + '）' : '（还没填域名）') + '。'
          : '当前出口：快速隧道（地址每次重启都会换）。'),
        h('label', { style: styles.toggleRow },
          h('input', {
            type: 'checkbox',
            checked: enabled,
            // starting 也要禁掉：那说明**别的地方**（另一个标签页）正在起隧道，
            // 这时候再点一下会起出第二条。
            disabled: Boolean(busy || tunnel.starting),
            onChange: function (e) { toggle(e.target.checked); },
          }),
          h('span', null, enabled ? '已开启' : '开启'),
        ),
        h('div', { style: enabled && tunnel.error ? styles.detail : styles.muted }, status),
        // cloudflared 的原始报错，多行原文照登——排查时这就是全部线索。
        enabled && tunnel.error ? h('div', { style: styles.detail }, tunnel.error) : null,
        // 两条出口的切换。当前是哪条，哪个按钮就禁用（没有「再切一次」这回事）。
        h('div', { style: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            disabled: Boolean(busy) || !namedMode,
            onClick: function () { named.switchMode('quick'); },
            style: styles.btn,
          }, namedMode ? '改回快速隧道' : '快速隧道（当前）'),
          h('button', {
            type: 'button',
            disabled: Boolean(busy) || namedMode,
            onClick: function () { named.switchMode('named'); },
            style: styles.btn,
          }, namedMode ? '固定域名（当前）' : '改用固定域名'),
        ),
        namedMode ? h('div', { style: styles.muted, marginTop: 8 },
          '固定域名要你自己的 Cloudflare 账号和域名，配置在下面那一块。') : null,
        enabled && !namedMode ? h('div', { style: styles.warn }, '这个地址每次重启 DSH 都会换一个，换了之后回来重新扫一下码。') : null,
        enabled ? h('div', { style: styles.warn }, '开着的时候这个服务就挂在公网上了。密码仍然是唯一的门，别把地址或二维码发出去。') : null,
      );
    }

    /**
     * 固定域名隧道那一块：域名 + 账号 + API Token。
     *
     * 为什么把「直接粘贴隧道令牌」收进「高级」：第一次配的人走的是 API Token 那条
     * （插件自动建隧道、写 ingress、建 DNS），把两个令牌并排摆着只会让他不知道该填哪个。
     * 而已经自己在后台建好隧道的人，粘一个令牌就能跑，不需要给插件 API Token
     * ——少给一份能改整个账号的凭据。
     */
    function namedTunnelBlock(info, st, busy) {
      var d = st.draft;
      if (!d) return null;
      var t = (info && info.tunnel) || {};
      var isNamed = t.mode === 'named';
      var host = typeof t.hostname === 'string' && t.hostname ? t.hostname : d.hostname;
      var status;
      if (t.error) status = '固定隧道没起来，原因在下面。';
      else if (t.starting) status = '正在连接 Cloudflare…';
      else if (t.up) status = '已连上 https://' + host + '，上面那条「固定域名」就是它。';
      else if (isNamed && t.enabled) status = '开着，但还没连上 Cloudflare 的边缘。';
      else if (t.provisioned) status = '隧道已经建好了（id 已保存），打开上面的开关就能用。';
      else status = '还没配。填上域名和 API Token，点「保存并启用」。';

      // 只有真改了什么才让点保存：令牌框永远是空的（服务端不回显），
      // 拿「空 = 改动」当判据会让保存按钮一直亮着，用户会以为每次都存了一次。
      var changed = d.hostname.trim() !== '' && (
        d.hostname.trim() !== (t.hostname || '')
        || d.accountId.trim() !== (t.accountId || '')
        || d.apiToken !== ''
        || d.tunnelToken !== ''
      );

      return h('div', { key: 'named', style: styles.block },
        h('div', { style: styles.entryTitle }, '固定域名（自己的域名 + Cloudflare）'),
        h('div', { style: styles.muted }, '和上面那条快速隧道是同一个出口，区别只有一个：地址是你自己的域名，重启 DSH 也不会变。'),
        h('div', { style: styles.warn }, '需要一个托管在 Cloudflare 上的域名，以及一个 API Token。令牌权限三项：'
          + '账户 → Cloudflare Tunnel → 编辑；区域 → DNS → 编辑；区域 → 区域 → 读取。'),
        h('div', { style: t.error ? styles.detail : styles.muted }, status),
        t.error ? h('div', { style: styles.detail }, t.error) : null,
        // DNS 那一步是**软失败**：隧道起来了，但域名还没指过来。这种半成功状态必须
        // 单独说，否则用户会看着「已连上」的绿灯，然后在手机上打开一个 404。
        t.dns === 'manual' ? h('div', { style: styles.warn },
          'DNS 没自动配好。去 Cloudflare 后台给 ' + (host || '这个域名')
          + ' 加一条 CNAME，指向你那条隧道的 <隧道id>.cfargotunnel.com，代理开着，加完就能用。') : null,
        // 一键配置：先把 API Token 填进去，点这里就能读出域名列表，
        // 省掉「去后台翻自己有哪些域名」那一步。
        h('div', { style: { marginTop: 10, marginBottom: 2 } },
          h('button', {
            type: 'button',
            disabled: Boolean(busy),
            onClick: st.loadZones,
            style: styles.btn,
          }, st.zones && st.zones.loading ? '读取中…' : '读取我的域名'),
        ),
        st.zones && st.zones.error
          ? h('div', { style: styles.warn }, st.zones.error)
          : null,
        st.zones && Array.isArray(st.zones.list) && st.zones.list.length
          ? h('div', { style: { marginTop: 8 } },
            h('div', { style: styles.muted }, '点一个域名，自动填成 dsh.<域名>：'),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 } },
              st.zones.list.map(function (z) {
                var pick = 'dsh.' + z.name;
                return h('button', {
                  key: z.id || z.name,
                  type: 'button',
                  onClick: function () {
                    st.setDraft(Object.assign({}, d, { hostname: pick }));
                  },
                  style: styles.btn,
                }, z.name);
              }),
            ),
          )
          : null,
        field('域名（例如 dsh.example.com）', d.hostname, 'dsh.example.com', function (v) {
          st.setDraft(Object.assign({}, d, { hostname: v }));
        }, 'text'),
        field('Account ID（可留空：令牌只看得见一个账号时会自动用那个）', d.accountId, '32 位十六进制，可留空', function (v) {
          st.setDraft(Object.assign({}, d, { accountId: v }));
        }, 'text'),
        field('API Token', d.apiToken, t.hasApiToken ? '已经存过一份了，留空就不改动它' : 'Cloudflare 后台建的 API Token', function (v) {
          st.setDraft(Object.assign({}, d, { apiToken: v }));
        }, 'password'),
        h('div', { style: { marginTop: 10 } },
          h('button', { type: 'button', onClick: st.toggleAdvanced, style: styles.btn },
            st.advancedOpen ? '收起「直接粘贴隧道令牌」' : '高级：直接粘贴隧道令牌'),
        ),
        st.advancedOpen ? field(
          '隧道令牌（Cloudflare 后台「隧道 → 安装连接器」里那一串；粘了它就不用 API Token，DNS 得你自己加）',
          d.tunnelToken,
          t.hasTunnelToken ? '已经有一份了，留空就不改动它' : 'eyJhIjoi… 这样的长串',
          function (v) { st.setDraft(Object.assign({}, d, { tunnelToken: v })); },
          'password',
        ) : null,
        h('div', { style: { marginTop: 12 } },
          h('button', {
            type: 'button',
            disabled: Boolean(busy) || !changed,
            onClick: st.save,
            style: styles.btn,
          }, busy ? '保存中…' : '保存并启用'),
        ),
        st.error ? h('div', { style: styles.error }, st.error) : null,
        t.hasApiToken ? h('div', { style: { color: 'var(--dsw-alias-label-tertiary,#8b93a1)', fontSize: 12, lineHeight: 1.5, marginTop: 10 } },
          'API Token 已经存在这台电脑上了（这里不会显示它）。只有换域名或换账号时才需要重新填。') : null,
      );
    }

    /**
     * 密码这一块。
     *
     * 以前这里只有一句「手机扫码就能用，不用输密码」——话没错，但用户既看不到密码本身，
     * 也没法换一个自己记得住的。2026-09-22 用户报：「手机遥控页面里似乎根本没有密码，
     * 也无法自定义密码」。配对接口其实一直返回着 token，只是从来没人渲染它。
     */
    function passwordBlock(info, copied, copy, pwd) {
      var token = typeof info.token === 'string' ? info.token : '';
      var shown = pwd.showPwd ? token : token.replace(/./g, '•');
      var done = token !== '' && copied === token;
      var pending = typeof info.pendingToken === 'string' ? info.pendingToken : '';
      return h('div', { key: 'password', style: styles.block },
        h('div', { style: styles.entryTitle }, '密码'),
        h('div', { style: styles.muted }, '手机扫码时已经带着它了，不用手输。它就是这道门的钥匙——别截图发出去。'),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
          h('input', {
            readOnly: true,
            value: shown,
            spellCheck: false,
            // 点一下全选：想复制走的时候不用一格一格拖。
            onFocus: function (e) { try { e.target.select(); } catch (err) { /* 忽略 */ } },
            style: Object.assign({}, styles.input, { flex: '1 1 240px', width: 'auto' }),
          }),
          h('button', {
            type: 'button',
            onClick: function () { pwd.setShowPwd(!pwd.showPwd); },
            style: styles.btn,
          }, pwd.showPwd ? '藏起来' : '显示'),
          h('button', { type: 'button', onClick: function () { copy(token); }, style: styles.btn }, done ? '已复制' : '复制'),
        ),
        // 服务端刚存下、但还没重启，所以还没生效的那个。**必须和上面显示的那个分开说**：
        // 上面那串是此刻真正在用的，重启前手机上认的还是它。
        pending ? h('div', { style: styles.warn },
          '新密码已经存好了，但要重启一次 DSH 才会生效。在那之前手机上用的还是上面这个旧的；'
          + '重启之后，手机上要重新扫一次码。') : null,
        h('div', { style: styles.muted, marginTop: 14 }, '换一个自己记得住的（至少 12 位）：'),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
          h('input', {
            type: 'text',
            value: pwd.draft,
            placeholder: '想一个自己记得住的',
            spellCheck: false,
            onChange: function (e) { pwd.setDraft(e.target.value); },
            style: Object.assign({}, styles.input, { flex: '1 1 240px', width: 'auto' }),
          }),
          h('button', {
            type: 'button',
            disabled: Boolean(pwd.busy),
            onClick: pwd.savePassword,
            style: styles.btn,
          }, pwd.busy ? '保存中…' : '保存'),
        ),
        pwd.pwdError ? h('div', { style: styles.error }, pwd.pwdError) : null,
      );
    }

    function entryBlock(entry, index, copied, copy) {
      var url = typeof entry.url === 'string' ? entry.url : '';
      var done = url !== '' && copied === url;
      return h('div', { key: entry.kind || String(index), style: styles.block },
        h('div', { style: styles.entryTitle }, entry.label || entry.kind || '手机'),
        entry.hint ? h('div', { style: styles.muted }, entry.hint) : null,
        h('div', { style: styles.entryRow },
          // host 侧二维码画不出来时给的是 null，退化成只显示链接。
          entry.qr
            ? h('img', { src: entry.qr, alt: '手机遥控二维码', style: styles.qr })
            : h('div', { style: styles.qrFallback }, '二维码没画出来，用右边的链接也能进。'),
          h('div', { style: styles.urlCol },
            h('input', {
              readOnly: true,
              value: url,
              spellCheck: false,
              // 点一下就把整条地址选中，方便直接 Ctrl+C。
              onFocus: function (e) { try { e.target.select(); } catch (err) { /* 忽略 */ } },
              style: styles.input,
            }),
            h('button', { type: 'button', onClick: function () { copy(url); }, style: styles.btn }, done ? '已复制' : '复制'),
          ),
        ),
      );
    }

    function apply(ctx) {
      // settings.section 由设置域插件声明；这里等声明出现再注册。
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'mini-remote',
            order: 2,
            // 传函数：外壳用 resolveSlotLabel 求值（字符串也支持），函数是更稳的那个。
            label: () => '手机遥控',
          },
          MiniRemoteSettingsTab,
        );
      });
    }

    exports.name = 'dsh-remote-lite';
    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  }
});
