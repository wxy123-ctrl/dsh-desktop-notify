// dsh-desktop-notify — browser half（v1.1.0，DSH 桌面端专用）。
//
// 桌面守卫：本插件只在 DSH 桌面端（Electron 渲染器，页面协议 dsh-app://app）
// 生效——apply() 开头判定，非桌面环境（如误装入 web profile 的浏览器页签）
// 全程 no-op：不注册按钮、不起轮询，绝不与 dsh-sysnotify 叠加弹通知。
// 桌面壳对 dsh-app://app 下非静态路径做透明转发（含认证 cookie），因此本页
// 里相对路径 fetch('/plugins/dsh-desktop-notify/…') 直接到达宿主 HTTP——
// 但转发会删除 Origin 头，宿主侧守卫已按「Origin 缺席放行」处理。
//
// v1.1.0 架构（v1.0.0 实测：渲染器 Web Notifications 被桌面端静默丢弃——
// 壳从未调用 app.setAppUserModelId()，进程无注册 AUMID，Windows 丢弃 toast
// 且构造函数不报错；插件层无法从外部修复进程级 AUMID）：
//   通知气泡由宿主半边 spawn toast-notify.ps1 弹出（NotifyIcon，sysnotify
//   同通道）；本半边只负责**点击跳转**——长轮询 notify-events 收
//   type:'click' 事件（PS 点击处理器经 notify-click 路由入队）即
//   uiWorkspace.openSession(sessionId)（与侧栏点击会话行同路径）。
//   renderer 投递模式（宿主 config delivery:'renderer'，预留）下才会收到
//   type:'notify' 事件 → new Notification() 弹渲染器通知。
//
// 长轮询：引导请求拿当前 seq 不回放历史；之后 after=seq 挂起至多 20s，
// 宿主有点击事件立即唤醒。成功响应在 fetch 链里立即续轮（不经
// setTimeout——桌面窗口最小化/置后台时定时器被 Chromium 深度节流，而挂起
// 的 fetch 不受影响：气泡点击多半发生在窗口不在前台时）；失败按
// 1s→2s→5s→10s 退避后重试。
//
// 会话级开关：composer 工具行的闹钟按钮（conversation.input.left Slot，
// sysnotify v1.8.3 同款原子化样式组件——静态外观内联 <button>、伪类规则由
// 组件随行 <style> 承载，与按钮同一次 React commit 生灭）；点击经 POST
// /plugins/dsh-desktop-notify/notify-pref 切换，宿主单点门控全部 5 类通知。
//
// 加载形式：手写 ClientModuleLoader 工厂（sysnotify 同款）；唯一外部
// require 是 'react'（shell 静态模块表）。本包经 bundle 安装进 desktop
// profile（package.json dsh.bundle.patch → cordis.patch.yml），宿主
// client-modules 服务在 /plugins/dsh-desktop-notify/client.js 提供本文件。

window.__ModuleLoader__.load({
  id: 'dsh-desktop-notify',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const PREF_URL = '/plugins/dsh-desktop-notify/notify-pref'
    const EVENTS_URL = '/plugins/dsh-desktop-notify/notify-events'

    /** 闹钟图标：宿主 IconAlarmClockOutline16 逐字复刻（描边 1.25）。
     *  muted 态叠一条对角斜线——与图标同笔画，视觉一致。 */
    function AlarmIcon(props) {
      const h = React.createElement
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M3.5 2.5 1.75 4', stroke: 'currentColor', strokeWidth: '1.25', strokeLinecap: 'round' }),
        h('path', { d: 'M12.5 2.5 14.25 4', stroke: 'currentColor', strokeWidth: '1.25', strokeLinecap: 'round' }),
        h('circle', { cx: '8', cy: '8.5', r: '4.75', stroke: 'currentColor', strokeWidth: '1.25' }),
        h('path', { d: 'M8 5.75V8.5L10 9.75', stroke: 'currentColor', strokeWidth: '1.25', strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'm4.75 12.25-1 1.5', stroke: 'currentColor', strokeWidth: '1.25', strokeLinecap: 'round' }),
        h('path', { d: 'm11.25 12.25 1 1.5', stroke: 'currentColor', strokeWidth: '1.25', strokeLinecap: 'round' }),
        props?.muted === true
          ? h('line', {
              x1: '2.25', y1: '13.75', x2: '13.75', y2: '2.25',
              stroke: 'currentColor', strokeWidth: '1.25', strokeLinecap: 'round',
            })
          : null,
      )
    }

    /** 同源 POST JSON（sysnotify 同款；Origin 守卫由宿主侧执行——桌面转发
     *  场景请求到达宿主时 Origin 已被壳删除，宿主按缺席放行）。 */
    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok || !payload || payload.ok !== true) {
        throw new Error(payload && payload.error ? String(payload.error) : `HTTP ${response.status}`)
      }
      return payload
    }

    function NotifyToggle(props) {
      const h = React.createElement
      const sessionId = props?.sessionId
      const [muted, setMuted] = React.useState(false)
      // last-write-wins 序号：过期响应（切换中又点了一次）不回写状态。
      const seq = React.useRef(0)

      // 挂载 / 会话身份变化时查询当前偏好；失败按默认开启渲染（仍可点击，
      // 点击走宿主权威值，成功即校正）。
      React.useEffect(() => {
        const mySeq = ++seq.current
        let cancelled = false
        postJson(PREF_URL, { sessionId })
          .then((payload) => {
            if (!cancelled && mySeq === seq.current) setMuted(payload.muted === true)
          })
          .catch(() => { /* 保持默认开启 */ })
        return () => { cancelled = true }
      }, [sessionId])

      if (typeof sessionId !== 'string' || sessionId === '') return null

      const toggle = async () => {
        const next = !muted
        const mySeq = ++seq.current
        setMuted(next) // 乐观切换
        try {
          const payload = await postJson(PREF_URL, { sessionId, muted: next })
          if (mySeq === seq.current) setMuted(payload.muted === true)
        } catch {
          if (mySeq === seq.current) setMuted(!next) // 失败回滚
        }
      }

      const label = muted
        ? '系统通知：关闭（本会话完成 / 阻塞 / 出错不再弹通知）'
        : '系统通知：开启（本会话完成 / 阻塞 / 出错弹系统通知）'
      // 样式原子化（sysnotify v1.8.3 教训）：<style> 与 <button> 同一次
      // React commit 插入/移除；静态外观内联在按钮上（HMR 热重组窗口内也
      // 不会回落到 UA 原生按钮样式），伪类规则由随行 <style> 承载。
      return h(
        React.Fragment,
        null,
        h('style', null, TOGGLE_PSEUDO_STYLES),
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-dn-toggle' + (muted ? ' dsh-dn-muted' : ''),
            'aria-pressed': muted ? 'false' : 'true',
            title: label,
            'aria-label': label,
            onClick: () => { void toggle() },
            style: {
              display: 'grid',
              placeItems: 'center',
              flex: 'none',
              width: '28px',
              height: '28px',
              border: 'none',
              borderRadius: '999px',
              outline: 'none',
              background: 'transparent',
              color: muted
                ? 'var(--dsw-alias-label-caption)'
                : 'var(--dsw-alias-label-secondary)',
              cursor: 'pointer',
            },
          },
          h(AlarmIcon, { muted }),
        ),
      )
    }

    // 伪类规则：hover 背景 !important 压过内联 background: transparent；
    // focus-visible 环无内联冲突，普通声明即可。类名 dsh-dn-muted 保留作
    // 语义标记，降色已内联。
    const TOGGLE_PSEUDO_STYLES = `
.dsh-dn-toggle:hover { background: var(--dsw-alias-interactive-bg-hover) !important; }
.dsh-dn-toggle:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }
`

    /** 弹一条系统通知并接线点击跳转（仅 renderer 投递模式会收到 'notify'
     *  事件——powershell 模式下宿主不入队通知、气泡由 PS 直接弹出）。
     *  tag 复用 'dshdn:'+sessionId——同一会话的新通知替换旧通知，不堆叠。
     *  点击：openSession（与侧栏点击会话行同路径；会话已归档/未知时
     *  sessions.open 可能抛错，吞掉并 warn）+ window.focus()。
     *  onshow/onerror：v1.1.0 观测点——当前桌面端构建未设置
     *  app.setAppUserModelId()，渲染器 toast 被 Windows 静默丢弃（v1.0.0
     *  实测根因）；两处日志让未来切 renderer 模式时可一眼判生死。 */
    function showNotification(ctx, ev) {
      if (typeof Notification === 'undefined') {
        console.warn('[dsh-desktop-notify] 本环境不支持 Web Notifications，事件被丢弃', ev?.kind)
        return
      }
      if (Notification.permission === 'denied') {
        console.warn('[dsh-desktop-notify] 通知权限被拒绝（系统设置），事件被丢弃', ev?.kind)
        return
      }
      const show = () => {
        let n
        try {
          n = new Notification(String(ev.title ?? 'DSH 会话'), {
            body: String(ev.body ?? ''),
            tag: 'dshdn:' + String(ev.sessionId ?? ''),
            lang: 'zh-CN',
          })
        } catch (err) {
          console.warn('[dsh-desktop-notify] new Notification 失败', err?.message ?? err)
          return
        }
        n.onshow = () => {
          try { console.info('[dsh-desktop-notify] 渲染器通知已显示（renderer 通道可用）') } catch { /* noop */ }
        }
        n.onerror = () => {
          try { console.warn('[dsh-desktop-notify] 渲染器通知显示失败（桌面端缺 AUMID？保持 powershell 投递）') } catch { /* noop */ }
        }
        n.onclick = () => {
          try {
            console.info('[dsh-desktop-notify] 通知点击，切换到会话', ev.sessionId, '（可见性:', document.visibilityState + '）')
            ctx.uiWorkspace.openSession(ev.sessionId)
            window.focus()
            try { n.close() } catch { /* 已自动消失 */ }
          } catch (err) {
            console.warn('[dsh-desktop-notify] openSession 失败（会话已归档？）', ev.sessionId, err?.message ?? err)
          }
        }
      }
      if (Notification.permission === 'granted') {
        show()
        return
      }
      // 'default'（理论不到达——桌面壳的权限处理器对非 media 一律放行）：
      // 异步请求权限后补弹本条（迟到总比丢掉好）。
      Notification.requestPermission()
        .then((p) => { if (p === 'granted') show() })
        .catch(() => { /* 忽略 */ })
    }

    function apply(ctx) {
      // ── 桌面守卫：非桌面环境全程 no-op ────────────────────────────────
      // 桌面页面协议 dsh-app://app 是壳注入的私有协议，浏览器页签不可能持有。
      if (location.protocol !== 'dsh-app:') {
        try {
          console.info('[dsh-desktop-notify] 非桌面环境（' + location.protocol + '），本插件不启用——桌面通知归 dsh-sysnotify/宿主管')
        } catch { /* noop */ }
        return
      }

      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.left', function* () {
            yield ctx.slots.register(
              {
                name: 'conversation.input.left',
                id: 'desktop-notify-toggle',
                order: 0,
                // session 作用域 Slot：框架把当前 Session id 传给 inject 回调
                // （ui-slots 对 strict session 槽位的既定契约）。
                inject: (sessionId) => ({ sessionId }),
              },
              NotifyToggle,
            )
          }),
        'dsh-desktop-notify: composer notify toggle',
      )

      // ── 事件长轮询 ─────────────────────────────────────────────────────
      // 常驻于插件生命周期（不依赖任何 Slot 挂载）。引导请求 {} 拿当前 seq
      // 不回放历史；此后 after=seq 挂起至多 20s。成功响应在 fetch 链内立即
      // 续轮——不经 setTimeout，桌面窗口置后台/最小化不被定时器节流；失败
      // 才退避。事件按 type 分发（v1.1.0）：
      //   'click'（powershell 投递模式的气泡点击，PS 已聚焦窗口）→
      //     uiWorkspace.openSession(sessionId) + window.focus()
      //   'notify'（renderer 投递模式才有）→ showNotification
      // type 缺席按 'notify' 处理（新 client + 旧宿主的升级窗口期兼容）。
      ctx.effect(() => {
        let stopped = false
        let backoffTimer = null
        const BACKOFF_STEPS = [1000, 2000, 5000, 10000]
        let backoffAt = 0
        let after = null // null = 引导（尚未拿到服务端 seq 基线）

        const sleep = (ms) =>
          new Promise((resolve) => {
            backoffTimer = setTimeout(resolve, ms)
          })

        const run = async () => {
          while (!stopped) {
            try {
              const body = after === null ? {} : { after }
              const response = await fetch(EVENTS_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              })
              if (!response.ok) throw new Error('HTTP ' + response.status)
              const payload = await response.json()
              if (!payload || payload.ok !== true || typeof payload.seq !== 'number') {
                throw new Error('bad notify-events payload')
              }
              after = payload.seq
              backoffAt = 0
              const list = Array.isArray(payload.events) ? payload.events : []
              for (const ev of list) {
                if (ev && typeof ev.sessionId === 'string' && ev.sessionId !== '') {
                  const type = ev.type === 'click' ? 'click' : 'notify'
                  // 观测点：事件确实到达本窗口（type/sid + 可见性）。
                  try {
                    console.info(
                      '[dsh-desktop-notify] 事件到达', type, ev.sessionId,
                      '（本窗口可见性:', document.visibilityState + '）',
                    )
                  } catch { /* noop */ }
                  if (type === 'click') {
                    // 气泡点击（PS 已发 HTTP 信号并聚焦窗口）：切到触发的
                    // 会话——与侧栏点击会话行完全同路径；归档/未知会话可能
                    // 抛错，吞掉并 warn。
                    try {
                      ctx.uiWorkspace.openSession(ev.sessionId)
                      window.focus() // PS 已聚焦窗口；失败时的无害兜底
                    } catch (err) {
                      console.warn('[dsh-desktop-notify] openSession 失败（会话已归档？）', ev.sessionId, err?.message ?? err)
                    }
                  } else {
                    showNotification(ctx, ev)
                  }
                }
              }
              continue // 立即续轮（服务端会挂起到 20s，不忙等）
            } catch {
              if (stopped) break
              const delay = BACKOFF_STEPS[Math.min(backoffAt, BACKOFF_STEPS.length - 1)]
              backoffAt++
              await sleep(delay)
            }
          }
        }
        // 观测点：一眼确认桌面侧轮询代码在跑（版本号即代码代次）。
        try { console.info('[dsh-desktop-notify] v1.1.0 事件长轮询已启动（桌面模式，点击跳转 + renderer 通知兜底）') } catch { /* noop */ }
        void run()
        return () => {
          stopped = true
          if (backoffTimer !== null) clearTimeout(backoffTimer)
        }
      }, 'dsh-desktop-notify: event long-poll')
    }

    exports.apply = apply
    // uiWorkspace：点击跳转的切换入口（ui-workspace 包提供，应用启动常驻）。
    exports.inject = ['slots', 'uiWorkspace']
    return module.exports
  },
})
