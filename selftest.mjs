// selftest.mjs — 模拟 cordis 加载：用最小假 context 调用 apply()，
// 并用假事件负载逐个触发每个监听器。除了"任何输入都不抛未捕获异常"外，
// 还断言以下回归（多数继承自 dsh-sysnotify 的历史事故）：
//   1. waterfall 链监听器（approval/request、tools/pre-execute）在任何负载下
//      都必须返回 next() 的结果——不调用 next() 会否决链条，导致 dsh-tools
//      读 gate.kind 崩溃（sysnotify 2026-08 事故）。
//   2. 会话标题必须经 sessionTitle.get() 读取（幻影 API 静默失效教训）。
//   3. 偏好 roundtrip；notify-pref 路由 get/set/畸形/405/403 守卫。
//   4. 【桌面专属】Origin 缺席 → 放行（桌面壳转发删除 Origin 头）；Origin
//      存在且不匹配 Host → 403。
//   5. v1.1.0 powershell 投递（默认）：notify() → spawn 气泡（计数器拦截）
//      且不入队（防与 PS 气泡双弹）；静音门控在防抖之前；同类 2.5s 防抖；
//      跨类/跨会话不互相防抖。
//   6. notify-events 长轮询（click 事件）：引导不回放 / 挂起被点击唤醒 /
//      waitMs 超时空回 / after·waitMs 校验 / 容量 50 丢最旧 / 断连不泄漏 /
//      无效 sid 不入队；事件 type:'click'。
//   7. notify-click 路由（PS 点击处理器通道）：合法投递/dup 标记、token
//      跨通道去重（HTTP 先投 → emitClick 兜底 false；新 token → true）、
//      全套守卫（缺字段/405/403/无-Origin 放行/400/500）。
//   8. 退出码端到端（真 spawn + 临时 exit-N 脚本）：exit 0 → 点击入队 →
//      长轮询唤醒；exit 3 → 无事件。
//   9. renderer 投递（config.delivery:'renderer'，第二实例）：notify() 入队
//      type:'notify' 事件，载荷带 kind/sessionId/title/body。
//  10. client.js 静态断言：桌面守卫、click/notify 按 type 分发、
//      openSession 接线、长轮询免 setTimeout 续轮、样式原子化。
//  11. toast-notify.ps1 静态断言：存在、UTF-8 BOM（EF BB BF——无 BOM 被
//      PS 5.1 按 GBK 误读、param 崩、静默失败）、按进程名聚焦、无隐藏执行。
// 运行：node D:\TS\dsh-desktop-notify\selftest.mjs
import { apply as pluginApply, loadPrefs, savePrefs, testHooks } from './index.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件目录的 desktop-notify.log（diag 观测点断言用；append-only，增量比对）。 */
const NOTIFY_LOG = fileURLToPath(new URL('./desktop-notify.log', import.meta.url))
const logText = () => {
  try {
    return readFileSync(NOTIFY_LOG, 'utf8')
  } catch {
    return ''
  }
}

let failures = 0
const fail = (msg) => {
  failures++
  console.error('FAIL:', msg)
}
const ok = (cond, msg) => {
  if (!cond) fail(msg)
  else console.log('  ok:', msg)
}

/** 最小假 context 工厂（A/B 两个 apply 实例各一份）。 */
let getTitleCalls = 0
const fakeLogger = { info: () => {}, warn: () => {}, error: () => {} }
const makeFakeCtx = () => {
  const listeners = new Map()
  const injectCallbacks = []
  const ctx = {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
      return () => {}
    },
    inject(names, cb) {
      injectCallbacks.push({ names, cb })
    },
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    logger: fakeLogger,
    sessionTitle: {
      get(_session) {
        getTitleCalls++
        return { title: '模拟会话标题' }
      },
    },
  }
  return { ctx, listeners, injectCallbacks }
}

// 假 webServer：捕获路由注册。A/B 实例共用路由表——后注册者覆盖同路径
// handler（与测试顺序配套：A 先测完，B 最后接管路由）。
const routes = new Map() // path -> handler
const fakeWebCtx = {
  webServer: {
    host: '127.0.0.1',
    port: 3999,
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
  effect(fn) {
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  get: () => undefined,
  logger: fakeLogger,
}

// 临时偏好文件目录（不污染插件目录的 notify-prefs.json）。
const tmpPrefsDir = mkdtempSync(join(tmpdir(), 'desktop-notify-selftest-'))
const prefsPath = join(tmpPrefsDir, 'notify-prefs.json')

// 实例 A：默认投递（powershell）。
const A = makeFakeCtx()
try {
  pluginApply(A.ctx, { prefsPath })
  console.log('apply() OK — 注册的事件:', [...A.listeners.keys()].join(', '))
  for (const { names, cb } of A.injectCallbacks) {
    if (names.includes('webServer')) cb(fakeWebCtx)
  }
  ok(routes.has('/plugins/dsh-desktop-notify/notify-pref'), 'notify-pref 路由已注册')
  ok(routes.has('/plugins/dsh-desktop-notify/notify-events'), 'notify-events 路由已注册')
  ok(routes.has('/plugins/dsh-desktop-notify/notify-click'), 'notify-click 路由已注册（v1.1.0 PS 点击通道）')

  // ══ toast-notify.ps1 静态断言（BOM 是 sysnotify v1.1.1 事故级纪律）════
  const psPath = fileURLToPath(new URL('./toast-notify.ps1', import.meta.url))
  const psBytes = readFileSync(psPath)
  ok(psBytes.length > 3 && psBytes[0] === 0xef && psBytes[1] === 0xbb && psBytes[2] === 0xbf,
    'toast-notify.ps1 带 UTF-8 BOM（无 BOM 被 PS 5.1 按 GBK 误读、静默失败）')
  const psSrc = psBytes.toString('utf8')
  // 剥离注释行后再检查隐藏执行特征——文件头注释里引用这些字样是纪律
  // 说明本身，不是实际用法（实际 spawn 在 index.js，selftest 同样检查）。
  const psCode = psSrc.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
  ok(psSrc.includes("'DeepSeek Harness'"),
    'PS 按进程名 DeepSeek Harness 定位桌面窗口（非浏览器页签匹配）')
  ok(psSrc.includes('Send-ClickSignal') && psSrc.includes('-ClickUrl'),
    'PS 点击处理器含 HTTP 先行信号通道')
  ok(!psCode.includes('-WindowStyle Hidden') && !psCode.includes('-EncodedCommand'),
    'PS 代码无隐藏执行特征（火绒误杀纪律；注释中的引用除外）')
  const hostSrc = readFileSync(fileURLToPath(new URL('./index.js', import.meta.url)), 'utf8')
  const hostCode = hostSrc.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
  ok(!hostCode.includes('-WindowStyle') && !hostCode.includes('-EncodedCommand'),
    '宿主 spawn 无隐藏执行参数（明文 -File 纪律；注释中的引用除外）')

  // ══ client.js 静态断言（桌面守卫 + type 分发 + 样式原子化）══════════
  const clientSrc = readFileSync(fileURLToPath(new URL('./client.js', import.meta.url)), 'utf8')
  ok(clientSrc.includes("location.protocol !== 'dsh-app:'"), '桌面守卫存在（dsh-app: 协议判定）')
  ok(clientSrc.includes('非桌面环境'), '非桌面环境打印 no-op 横幅（防御误装）')
  ok(clientSrc.includes("ev.type === 'click'"), '长轮询按 type 分发（click → 跳转）')
  ok(/ctx\.uiWorkspace\.openSession\(ev\.sessionId\)/.test(clientSrc), '点击事件 → uiWorkspace.openSession(sessionId)')
  ok(/window\.focus\(\)/.test(clientSrc), '点击路径附带 window.focus() 兜底')
  ok(/new Notification\(/.test(clientSrc), 'renderer 模式保留 new Notification() 路径')
  ok(/tag: 'dshdn:'/.test(clientSrc), '渲染器通知 tag 按会话复用')
  ok(clientSrc.includes('v1.1.0 事件长轮询已启动'), '控制台横幅版本 v1.1.0（版本判据）')
  ok(/continue \/\/ 立即续轮/.test(clientSrc), '成功响应在 fetch 链内立即续轮（后台窗口不被节流）')
  ok(!/installStyles\s*\(/.test(clientSrc), '无 installStyles（不经 head 注入）')
  ok(/h\(['"]style['"]/.test(clientSrc), '组件随行渲染 <style>（伪类规则与按钮同一 commit）')
  ok(/style:\s*\{/.test(clientSrc), '按钮带内联 style 对象（静态外观不依赖样式表）')
  ok(/!important/.test(clientSrc), 'hover 背景带 !important（压过内联 background）')
} catch (err) {
  console.error('FAIL: apply() 抛出异常:', err.stack)
  process.exit(1)
}

// 拦截真实气泡：计数器代替（selftest 运行不连环弹窗）；realSpawnToast 保留
// 真实 spawn 路径——退出码端到端用例经 testHooks.scriptPath 指向临时 exit-N
// 脚本走真子进程（不弹真气泡）。
const realSpawnToast = testHooks.spawnToast
let toasts = 0
testHooks.spawnToast = () => { toasts++ }

// 普通事件：逐个调用，不允许抛异常。
const fire = (listeners, name, ...args) => {
  for (const fn of listeners.get(name) ?? []) {
    try {
      const r = fn(...args)
      if (r && typeof r.then === 'function') r.catch((e) => fail(`${name} 异步回调异常: ${e.message}`))
    } catch (err) {
      fail(`${name} 回调异常: ${err.message}`)
    }
  }
}

// waterfall 事件：监听器必须把 next() 的返回值原样返回。
const SENTINEL = Symbol('waterfall-next-result')
const fireWaterfall = (listeners, name, ...args) => {
  for (const fn of listeners.get(name) ?? []) {
    const next = () => SENTINEL
    let r
    try {
      r = fn(...args, next)
    } catch (err) {
      fail(`${name} 回调异常: ${err.message}`)
      continue
    }
    if (r && typeof r.then === 'function') {
      r.then(
        (v) => {
          if (v !== SENTINEL) fail(`${name} 异步路径未返回 next() 的结果（否决 waterfall 链）`)
        },
        (e) => fail(`${name} 异步回调异常: ${e.message}`),
      )
    } else if (r !== SENTINEL) {
      fail(`${name} 未返回 next() 的结果（否决 waterfall 链）——负载: ${JSON.stringify(String(args[0]?.name ?? args[0]?.toolName ?? 'n/a'))}`)
    }
  }
}

const agent = { id: 'session-abcdef123456', session: { id: 'session-abcdef123456' } }
const payload = (extra) => ({ agent, ...extra })

// ── session/event：任务跟踪 ────────────────────────────────────────────
fire(A.listeners, 'session/event', { id: 'session-abcdef123456' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '多段任务描述' }] } })
fire(A.listeners, 'session/event', { id: 'session-abcdef123456' }, { type: 'user/message', data: { source: { kind: 'user' }, content: '帮我做一个网页应用'.repeat(60) } })
fire(A.listeners, 'session/event', { id: 'session-abcdef123456' }, { type: 'user/message', data: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: '工具注入的消息不应污染任务文案' }] } })
fire(A.listeners, 'session/event', { id: 'session-abcdef123456' }, { type: 'user/message', data: { source: { kind: 'user' }, content: [] } })
fire(A.listeners, 'session/event', { id: 'session-abcdef123456' }, { type: 'assistant/message', data: {} })
fire(A.listeners, 'session/event', undefined, undefined)

// ── agent/status：完成通知（powershell 模式 → spawn 计数）──────────────
fire(A.listeners, 'agent/status', payload({ status: 'running' }))
fire(A.listeners, 'agent/status', payload({ status: 'idle' }))
fire(A.listeners, 'agent/status', {})

// ── waterfall：approval/request ────────────────────────────────────────
fireWaterfall(A.listeners, 'approval/request', { agent, toolName: 'pwsh', reason: 'workspace 外写入' })
fireWaterfall(A.listeners, 'approval/request', undefined)
fireWaterfall(A.listeners, 'approval/request', { agent, toolName: '' })

// ── waterfall：tools/pre-execute（sysnotify 2026-08 事故的案发现场）────
fireWaterfall(A.listeners, 'tools/pre-execute', { name: 'ask_user_question', agent, arguments: { questions: [{ question: '选择哪个方案？' }] } })
fireWaterfall(A.listeners, 'tools/pre-execute', { name: 'read', agent })
fireWaterfall(A.listeners, 'tools/pre-execute', { name: 'write', agent, arguments: { file_path: '/x', content: 'y' } })
fireWaterfall(A.listeners, 'tools/pre-execute', { name: 'ask_user_question' })
fireWaterfall(A.listeners, 'tools/pre-execute', undefined)
fireWaterfall(A.listeners, 'tools/pre-execute', { name: 'ask_user_question', agent, arguments: { questions: '不是数组' } })
fireWaterfall(A.listeners, 'tools/pre-execute', { name: 'exit_plan_mode', agent, arguments: { plan: '# 测试计划：重构通知模块\n\n1. 第一步\n2. 第二步' } })
fireWaterfall(A.listeners, 'tools/pre-execute', { name: 'exit_plan_mode', agent })
fireWaterfall(A.listeners, 'tools/pre-execute', { name: 'exit_plan_mode', agent, arguments: { plan: '' } })
fireWaterfall(A.listeners, 'tools/pre-execute', { name: 'exit_plan_mode', agent, arguments: { plan: 42 } })
fireWaterfall(A.listeners, 'tools/pre-execute', { name: 'exit_plan_mode', agent, arguments: { plan: '没有标题头的计划\n正文' } })

// ── agent/error ────────────────────────────────────────────────────────
fire(A.listeners, 'agent/error', payload({ turn: 1, step: 1, error: new Error('模拟错误：模型请求失败') }))
fire(A.listeners, 'agent/error', payload({ turn: 1, step: 1, error: '字符串错误' }))
fire(A.listeners, 'agent/error', {})

// ── session/disposed：状态清理 ─────────────────────────────────────────
fire(A.listeners, 'session/disposed', { id: 'session-abcdef123456' })
fire(A.listeners, 'session/disposed', undefined)

// 最小 req/res 假件。origin 默认 ''：模拟桌面壳转发（Origin 被删除）与 PS
// 显式同源 Origin 之外的缺席形态。
const fakeReq = (body, { method = 'POST', origin = '', host = 'h', raw = null } = {}) => ({
  method,
  headers: { origin, host },
  on(event, cb) {
    if (event === 'data') setTimeout(() => cb(Buffer.from(raw ?? JSON.stringify(body))), 0)
    if (event === 'end') setTimeout(() => cb(), 0)
    if (event === 'error') { /* 不触发 */ }
  },
  destroy() {},
})
const fakeRes = () => {
  let resolveEnded
  const ended = new Promise((r) => { resolveEnded = r })
  const res = {
    status: 0,
    body: undefined,
    closeCbs: [],
    writeHead(status) { res.status = status },
    end(payload) { res.body = payload; resolveEnded() },
    on(event, cb) { if (event === 'close') res.closeCbs.push(cb) },
    simulateClose() { for (const cb of res.closeCbs) cb() },
  }
  res.ended = ended
  return res
}
const callRoute = async (path, reqOptions, body) => {
  const handler = routes.get(path)
  const res = fakeRes()
  await handler(fakeReq(body, reqOptions), res)
  return { status: res.status, json: res.body === undefined ? undefined : JSON.parse(res.body) }
}
const callPref = (reqOptions, body) => callRoute('/plugins/dsh-desktop-notify/notify-pref', reqOptions, body)
const callClick = (reqOptions, body) => callRoute('/plugins/dsh-desktop-notify/notify-click', reqOptions, body)

// 事件路由调用：挂起路径（无新事件）handler 先返回、响应稍后写出——
// ended Promise 兜底等待，两种路径统一拿到最终 status/body。
const callEvents = async (body, reqOptions) => {
  const handler = routes.get('/plugins/dsh-desktop-notify/notify-events')
  const res = fakeRes()
  const held = handler(fakeReq(body ?? {}, reqOptions ?? {}), res)
  await held
  if (res.body === undefined) await res.ended
  return { status: res.status, json: JSON.parse(res.body), res }
}

const legacyToastCount = toasts

const run = async () => {
  console.log('—— 偏好文件 roundtrip ——')
  const prefsA = join(tmpPrefsDir, 'a.json')
  savePrefs(prefsA, new Set(['session-x', 'session-y']))
  ok(loadPrefs(prefsA).has('session-x') && loadPrefs(prefsA).has('session-y'), 'savePrefs → loadPrefs 往返一致')
  ok(loadPrefs(join(tmpPrefsDir, 'missing.json')).size === 0, '缺失文件 → 空集（默认全开）')
  const prefsBad = join(tmpPrefsDir, 'bad.json')
  writeFileSync(prefsBad, '{not json', 'utf8')
  ok(loadPrefs(prefsBad).size === 0, '畸形 JSON → 空集')
  const prefsBig = join(tmpPrefsDir, 'big.json')
  const many = []
  for (let i = 0; i < 505; i++) many.push('session-big-' + i)
  savePrefs(prefsBig, new Set(many))
  ok(loadPrefs(prefsBig).size === 500, '静音集截断到 500（丢最旧）')
  ok(!loadPrefs(prefsBig).has('session-big-0') && loadPrefs(prefsBig).has('session-big-504'), '截断保留最新条目')

  console.log('—— notify-pref 路由（桌面转发：Origin 缺席）——')
  let r = await callPref({}, { sessionId: 'session-route-1' })
  ok(r.status === 200 && r.json.ok === true && r.json.muted === false, 'get（无 Origin）：默认未静音')
  r = await callPref({}, { sessionId: 'session-route-1', muted: true })
  ok(r.status === 200 && r.json.muted === true, 'set muted=true → true')
  r = await callPref({}, { sessionId: 'session-route-1' })
  ok(r.status === 200 && r.json.muted === true, 'get 再查 → 已静音（状态保持）')
  ok(loadPrefs(prefsPath).has('session-route-1'), 'set 已持久化到偏好文件')
  r = await callPref({}, { sessionId: 'session-route-1', muted: false })
  ok(r.status === 200 && r.json.muted === false, 'set muted=false → false')
  ok(!loadPrefs(prefsPath).has('session-route-1'), '取消静音已从偏好文件移除')

  console.log('—— notify-pref 路由：校验与守卫 ——')
  r = await callPref({}, {})
  ok(r.status === 400, '缺 sessionId → 400')
  r = await callPref({}, { sessionId: 42 })
  ok(r.status === 400, 'sessionId 非字符串 → 400')
  r = await callPref({}, { sessionId: 'x'.repeat(201) })
  ok(r.status === 400, 'sessionId 超长 → 400')
  r = await callPref({}, { sessionId: 's', muted: 'yes' })
  ok(r.status === 400, 'muted 非布尔 → 400')
  r = await callPref({}, [1, 2])
  ok(r.status === 400, '数组 body → 400')
  r = await callPref({ raw: 'not-json' }, null)
  ok(r.status === 500, '非法 JSON body → 500（读体异常路径）')
  r = await callPref({ method: 'GET' }, { sessionId: 's' })
  ok(r.status === 405, 'GET → 405')
  r = await callPref({ origin: 'http://evil' }, { sessionId: 's' })
  ok(r.status === 403, '跨源 Origin → 403')
  r = await callPref({ origin: 'http://h', host: 'h' }, { sessionId: 'session-same-origin' })
  ok(r.status === 200 && r.json.ok === true, '同源 Origin（http://h == Host h）→ 放行')

  console.log('—— powershell 投递（默认）：spawn 气泡且不入队 ——')
  const doneOf = (sid) => ({ agent: { id: sid, session: { id: sid } } })
  const s0 = toasts
  const q0 = testHooks.queueDepth()
  fire(A.listeners, 'agent/status', { ...doneOf('session-chain-1'), status: 'running' })
  fire(A.listeners, 'agent/status', { ...doneOf('session-chain-1'), status: 'idle' })
  ok(toasts === s0 + 1, '完成事件恰好 spawn 1 条气泡')
  ok(testHooks.queueDepth() === q0, 'powershell 模式不入队（页面轮询只服务点击，防双弹）')
  ok(testHooks.notify('approval', '', 't', 'b') === false, '空/占位 sid 不投递')

  console.log('—— 防抖（spawn 计数）——')
  const d0 = toasts
  ok(testHooks.notify('approval', 'session-deb', '⏸️ T', 'B') === true, '首个 approval 通知投递')
  ok(testHooks.notify('approval', 'session-deb', '⏸️ T', 'B') === false, '2.5s 内同类同会话 → 防抖不投递')
  ok(testHooks.notify('question', 'session-deb', '❓ T', 'B') === true, '同类防抖不影响其他类型')
  ok(testHooks.notify('approval', 'session-deb-2', '⏸️ T', 'B') === true, '同类型不同会话不互相防抖')
  ok(toasts === d0 + 3, '防抖后气泡恰好 +3')

  console.log('—— 静音门控（在防抖之前）——')
  await callPref({}, { sessionId: 'session-mute-1', muted: true })
  const m0 = toasts
  fire(A.listeners, 'agent/status', { ...doneOf('session-mute-1'), status: 'running' })
  fire(A.listeners, 'agent/status', { ...doneOf('session-mute-1'), status: 'idle' })
  ok(toasts === m0, '静音会话完成 → 不弹')
  ok(testHooks.notify('approval', 'session-mute-1', '⏸️ T', 'B') === false, '静音会话直调 notify → false')
  await callPref({}, { sessionId: 'session-mute-1', muted: false })
  ok(testHooks.notify('approval', 'session-mute-1', '⏸️ T', 'B') === true, '取消静音立即恢复（防抖键从未记录）')

  console.log('—— notify-events：引导 / 不回放 ——')
  // 点击发生在任何轮询之前（对应"窗口后开"）——引导请求不得回放它。
  testHooks.emitClick('session-stale-click')
  const logBeforeBootstrap = logText()
  let ev = await callEvents({})
  ok(ev.status === 200 && ev.json.ok === true && Array.isArray(ev.json.events)
    && ev.json.events.length === 0 && ev.json.seq >= 1,
    '引导请求立即返回当前 seq，不回放历史点击')
  ok(logText().slice(logBeforeBootstrap.length).includes('notify-events 页面轮询已连接'),
    '引导轮询写入「页面轮询已连接」诊断行（窗口侧存活判据）')
  let curSeq = ev.json.seq

  console.log('—— notify-events：挂起被点击唤醒 ——')
  const logBeforeWake = logText()
  const heldPoll = callEvents({ after: curSeq })
  await new Promise((r) => setTimeout(r, 30))
  testHooks.emitClick('session-wake-a')
  ev = await heldPoll
  ok(ev.status === 200 && ev.json.events.length === 1
    && ev.json.events[0].sessionId === 'session-wake-a'
    && ev.json.events[0].type === 'click',
    '挂起中的长轮询被点击事件立即唤醒，载荷 type=click + sessionId')
  ok(logText().slice(logBeforeWake.length).includes('notify-events 点击投递 sid=session-wake-a 唤醒 1 个等待请求'),
    '唤醒 waiter 写入「点击投递」诊断行（完整投递链判据）')
  curSeq = ev.json.seq

  console.log('—— notify-events：超时空回 ——')
  ev = await callEvents({ after: curSeq, waitMs: 120 })
  ok(ev.status === 200 && ev.json.events.length === 0 && ev.json.seq === curSeq,
    '无新事件时按 waitMs 超时返回空 events + 当前 seq')

  console.log('—— notify-events：积压点击立即返回 ——')
  const beforeBatch = curSeq
  testHooks.emitClick('session-batch-1')
  testHooks.emitClick('session-batch-2')
  ev = await callEvents({ after: beforeBatch })
  ok(ev.status === 200 && ev.json.events.length === 2
    && ev.json.events.map((e) => e.sessionId).join(',') === 'session-batch-1,session-batch-2',
    '已积压的多条点击按 seq 升序一次性返回')
  curSeq = ev.json.seq

  console.log('—— notify-events：校验与守卫 ——')
  ok((await callEvents({ after: -1 })).status === 400, 'after 负数 → 400')
  ok((await callEvents({ after: '3' })).status === 400, 'after 字符串 → 400')
  ok((await callEvents({ after: 1.5 })).status === 400, 'after 非整数 → 400')
  ok((await callEvents({ after: 0, waitMs: 'fast' })).status === 400, 'waitMs 非数字 → 400')
  ok((await callEvents({ after: 999999999 })).status === 200
    && (await callEvents({ after: 999999999 })).json.events.length === 0,
    'after 超前于服务端 seq → 引导式空回（seq 重置场景）')
  ok((await callEvents({}, { method: 'GET' })).status === 405, 'GET → 405')
  ok((await callEvents({}, { origin: 'http://evil' })).status === 403, '跨源 Origin → 403')
  ok((await callEvents({}, { origin: 'http://h', host: 'h' })).status === 200, '同源 Origin → 放行')
  ok((await callEvents([1, 2])).status === 400, '数组 body → 400')
  ok((await callEvents(null, { raw: 'not-json' })).status === 500, '非法 JSON body → 500')

  // ══ notify-click 路由（PS 点击处理器的 HTTP 先行通道）════════════════
  console.log('—— notify-click：HTTP 先行 + token 去重 ——')
  const logBeforeHttp = logText()
  let rc = await callClick({}, { sessionId: 'session-http-1', token: 'tok-1' })
  ok(rc.status === 200 && rc.json.ok === true && rc.json.dup === false,
    '合法 POST（无 Origin）→ ok 且非重复（首次投递）')
  ev = await callEvents({ after: curSeq })
  ok(ev.json.events.length === 1 && ev.json.events[0].sessionId === 'session-http-1'
    && ev.json.events[0].type === 'click',
    'HTTP 信号入队 type=click，长轮询可取到')
  curSeq = ev.json.seq
  rc = await callClick({}, { sessionId: 'session-http-1', token: 'tok-1' })
  ok(rc.status === 200 && rc.json.dup === true, '同 token 二次 POST → dup=true 不重复入队')
  ev = await callEvents({ after: curSeq })
  ok(ev.json.events.length === 0, '重复 token 未产生新事件')
  // 跨通道去重：HTTP 已投递 tok-2 后，退出码通道（emitClick 带 token）同样被去重。
  await callClick({}, { sessionId: 'session-http-2', token: 'tok-2' })
  ok(testHooks.emitClick('session-http-2', 'tok-2') === false,
    '退出码通道携带已投递 token → false（去重）')
  ok(testHooks.emitClick('session-http-3', 'tok-3') === true,
    '退出码通道携带新 token → true（HTTP 失败时的兜底路径）')
  ev = await callEvents({ after: curSeq })
  ok(ev.json.events.length === 2
    && ev.json.events[0].sessionId === 'session-http-2'
    && ev.json.events[1].sessionId === 'session-http-3',
    'tok-2（HTTP 首发）与 tok-3（兜底）各恰好入队一次')
  curSeq = ev.json.seq
  ok(logText().slice(logBeforeHttp.length).includes('notify-click HTTP 信号 sid=session-http-1'),
    'HTTP 信号写入诊断行（时间线判据）')

  console.log('—— notify-click：守卫 ——')
  ok((await callClick({}, { token: 't' })).status === 400, '缺 sessionId → 400')
  ok((await callClick({}, { sessionId: 's' })).status === 400, '缺 token → 400')
  ok((await callClick({}, { sessionId: 42, token: 't' })).status === 400, 'sessionId 非字符串 → 400')
  ok((await callClick({}, { sessionId: 'x'.repeat(201), token: 't' })).status === 400, 'sessionId 超长 → 400')
  ok((await callClick({}, { sessionId: 's', token: 7 })).status === 400, 'token 非字符串 → 400')
  ok((await callClick({ method: 'GET' }, { sessionId: 's', token: 't' })).status === 405, 'GET → 405')
  ok((await callClick({ origin: 'http://evil' }, { sessionId: 's', token: 't' })).status === 403, '跨源 Origin → 403')
  ok((await callClick({ origin: 'http://h', host: 'h' }, { sessionId: 'session-click-same', token: 't' })).status === 200,
    '同源 Origin（PS Send-ClickSignal 形态）→ 放行')
  ok((await callClick({}, [1])).status === 400, '数组 body → 400')
  ok((await callClick({ raw: 'not-json' }, null)).status === 500, '非法 JSON → 500')

  console.log('—— notify-events：无效 sid / 容量 50 ——')
  const seqBeforeInvalid = (await callEvents({})).json.seq
  testHooks.emitClick(''); testHooks.emitClick('-'); testHooks.emitClick(undefined)
  ok((await callEvents({})).json.seq === seqBeforeInvalid, '空/占位 sid 的点击不入队（seq 不变）')
  const beforeCap = curSeq
  for (let i = 0; i < 51; i++) testHooks.emitClick('session-cap-' + i)
  ev = await callEvents({ after: beforeCap })
  ok(ev.json.events.length === 50, '容量 50：第 51 条入队后丢最旧')
  ok(!ev.json.events.some((e) => e.sessionId === 'session-cap-0')
    && ev.json.events.some((e) => e.sessionId === 'session-cap-50'), '丢弃的是最旧的 session-cap-0')
  curSeq = ev.json.seq

  console.log('—— notify-events：断连不泄漏 ——')
  {
    const handler = routes.get('/plugins/dsh-desktop-notify/notify-events')
    const closedRes = fakeRes()
    await handler(fakeReq({ after: curSeq }, {}), closedRes)
    ok(closedRes.body === undefined, '无新事件时 handler 挂起返回（响应未写出）')
    closedRes.simulateClose()
    testHooks.emitClick('session-after-close')
    ok(closedRes.body === undefined, '断开的 waiter 不再被写响应')
  }
  ev = await callEvents({ after: curSeq })
  ok(ev.json.events.length === 1 && ev.json.events[0].sessionId === 'session-after-close',
    '断连摘除后新轮询正常拿到后续点击（无崩溃无丢失）')
  curSeq = ev.json.seq

  console.log('—— 退出码端到端（真 spawn + 临时脚本）——')
  const psExit0 = join(tmpPrefsDir, 'exit0.ps1')
  const psExit3 = join(tmpPrefsDir, 'exit3.ps1')
  writeFileSync(psExit0, 'exit 0\r\n', 'utf8')
  writeFileSync(psExit3, 'exit 3\r\n', 'utf8')
  // exit 0：子进程退出码 → emitClick → 唤醒挂起轮询（整条链路）。
  testHooks.scriptPath = psExit0
  const exit0Poll = callEvents({ after: curSeq })
  await new Promise((r) => setTimeout(r, 30))
  realSpawnToast('自测', 'exit 0 链路', 'session-exit0-click')
  ev = await exit0Poll
  ok(ev.json.events.some((e) => e.sessionId === 'session-exit0-click' && e.type === 'click'),
    '真子进程 exit 0 → 点击入队 → 长轮询唤醒（完整链路）')
  curSeq = ev.json.seq
  // exit 3：未点击——不产生任何事件。
  testHooks.scriptPath = psExit3
  realSpawnToast('自测', 'exit 3 链路', 'session-exit3-silent')
  let exit3Leak = false
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 400))
    const probe = await callEvents({ after: curSeq, waitMs: 50 })
    if (probe.json.events.length > 0) { exit3Leak = true; break }
  }
  ok(!exit3Leak, '真子进程 exit 3（未点击）→ 无点击事件')
  testHooks.scriptPath = undefined // 还原

  // ══ renderer 投递模式（第二实例，最后接管路由表）════════════════════
  console.log('—— renderer 投递（delivery:"renderer"）：入队 type=notify ——')
  const B = makeFakeCtx()
  pluginApply(B.ctx, { prefsPath: join(tmpPrefsDir, 'b-prefs.json'), delivery: 'renderer' })
  for (const { names, cb } of B.injectCallbacks) {
    if (names.includes('webServer')) cb(fakeWebCtx)
  }
  const spawnBeforeRenderer = toasts
  // 先拿 seq 基线，再入队——after=bootSeq 才能取到其后入队的事件。
  const bootSeq = (await callEvents({})).json.seq
  ok(testHooks.notify('done', 'session-renderer-1', '✅ 渲染器标题', '任务：验证 renderer 模式') === true,
    'renderer 模式 notify → true（入队）')
  ok(toasts === spawnBeforeRenderer, 'renderer 模式不 spawn PS 气泡（无双弹）')
  const ev2 = await callEvents({ after: bootSeq })
  const mine = ev2.json.events.filter((e) => e.sessionId === 'session-renderer-1')
  ok(mine.length === 1 && mine[0].type === 'notify' && mine[0].kind === 'done',
    '事件载荷 type=notify + kind=done')
  ok(mine[0].title === '✅ 渲染器标题' && mine[0].body.includes('renderer 模式'),
    '载荷带完整 title/body（client.js 弹渲染器通知的原料）')
  ok(typeof mine[0].seq === 'number', '事件带 seq（长轮询游标）')

  // 收尾断言
  if (getTitleCalls === 0) fail('sessionTitle.get() 从未被调用——标题读取路径失效（误用了幻影 API？）')
  if (toasts === 0) fail('拦截计数为 0——通知链路整体失效')
  if (legacyToastCount === 0) fail('legacy 段未产生任何气泡——事件→notify 链路失效')
}

run()
  .catch((err) => { fail('异步测试段异常: ' + (err?.stack ?? String(err))) })
  .finally(() => {
    rmSync(tmpPrefsDir, { recursive: true, force: true })
    if (failures > 0) {
      console.error(`\n${failures} 处失败`)
      process.exit(1)
    }
    console.log('\n全部自测通过 ✅（waterfall + 标题 + 全负载 + 偏好/路由/守卫(无-Origin 放行) + PS 投递/防抖/静音 + 点击长轮询/断连/容量 + notify-click 双通道去重 + 退出码端到端 + renderer 模式 + PS BOM/进程聚焦 + client 分发/守卫/样式）')
  })
