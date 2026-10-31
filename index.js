// dsh-desktop-notify — 桌面端专用系统通知插件（宿主半边，纯 Node）
//
// 与 dsh-sysnotify（web profile，浏览器场景）同构：监听全进程会话事件，
// 六类时机入队通知——
//   ✅ 会话完成工作（running → idle，附最近任务、耗时）
//   ⏸️ 会话阻塞等待批准（附工具名与原因）
//   ❓ 会话阻塞等待回答（附问题内容）
//   📋 plan 模式计划待审批（exit_plan_mode，附计划首标题）
//   ⚠️ 会话出错（附错误信息）
//   ⏰ 定时提醒到期（schedule 注入的到期提示词，v1.3.0）
//
// 子代理会话（header.parentSession / delegationDepth ≥ 1）默认全部静音
// （config.muteSubagents: false 可关），主会话默认开启。
//
// 差异在投递链路——本插件专用于 DSH 桌面端（Electron，~/.dsh/profiles/desktop）：
//   宿主事件 → 静音门控 + 防抖 →【delivery: powershell（默认）】spawn
//   toast-notify.ps1 明文参数弹 NotifyIcon 气泡；点击 → PS 先 POST
//   notify-click {sessionId, token}（宿主入队 type:'click' 事件、唤醒页面
//   长轮询 → client.js uiWorkspace.openSession 切会话）再聚焦 Electron 窗口
//   （含最小化/托盘隐藏恢复）→ exit 0；HTTP 失败时退出码通道兜底
//   （child→{sid,token} 记账 + token 去重，先到者生效）。
//   【delivery: 'renderer'（预留）】维持 v1.0.0 行为：入队 type:'notify' 事件
//   → 页面长轮询 → client.js new Notification() 弹渲染器通知。
//
// ⚠️ 为什么默认走 PowerShell 而不是「由桌面 APP 直接发起」：实测（v1.0.0，
// desktop-notify.log 2026-09-30 08:43）事件→队列→页面投递全链路畅通，但渲染器
// new Notification() 的 toast 被 Windows 静默丢弃——桌面端 main.js 从未调用
// app.setAppUserModelId()（0 处），进程无注册 AUMID（开始菜单快捷方式为
// electron.app.DeepSeek Harness，进程不匹配）；AUMID 只能由 Electron 主进程
// 设置，插件层无解。未来桌面端补上后，profile patch 里按 id: desktop-notify
// 覆盖 config: {delivery: 'renderer'} 即可切回应用身份通知，无需改代码。
// PowerShell 通道沿用 dsh-sysnotify 在 web profile 的全部实测纪律：
//   · 明文 -File + 具名参数调用（火绒「隐藏执行 PowerShell」规则会误杀
//     -WindowStyle Hidden + -EncodedCommand，勿改回）
//   · toast-notify.ps1 必须 UTF-8 with BOM（无 BOM 被 PS 5.1 按 GBK 误读，
//     param() 解析崩、静默失败；selftest 有 BOM 断言）
//   · spawn 只用 {stdio:'ignore'}——detached/windowsHide 会让 NotifyIcon
//     气泡消失（DETACHED_PROCESS 迫使子进程新建隐藏控制台，实测致命）
//   · 通知进程默认 powershell.exe（每台 Windows 必有，市场分发零依赖）；
//     config.shell 'pwsh' / 'auto' 切 pwsh 7——where.exe 定位 + 启动存活
//     探针，找不到/起不来一律回落 powershell.exe（toast-notify.ps1 两个
//     版本语法兼容，带 BOM，两版都要求明文 -File 调用）
//
// ⚠️ 路由同源守卫与 sysnotify 不同：桌面壳把 dsh-app://app 页面的请求经
// protocol.handle 转发给宿主 HTTP 时会【删除 Origin 头】（壳持有认证 cookie，
// 转发即受信），因此守卫为「Origin 缺席 → 放行；存在 → 必须匹配 Host」。
// sysnotify 的严格守卫会把桌面页请求 403 掉——不要照抄。
//
// 长轮询语义与 sysnotify 的 notify-events 相同（挂起响应为 WebRoute 契约
// 明文支持）：引导请求（无 after）只拿当前 seq 不回放历史（桌面窗口后开
// 不被旧通知骚扰）；有 after 无新事件挂起至多 waitMs（默认 20s、上限 25s）；
// 页面在 fetch 链内立即续轮——桌面窗口最小化/置后台时定时器被 Chromium
// 节流而挂起 fetch 不受影响。队列事件带 type 字段：'click'（点击跳转，
// client.js 调 openSession）/ 'notify'（仅 renderer 投递模式产生，client.js
// 弹渲染器通知）。
//
// webServer 为可选依赖（经 ctx.inject 回调注册路由，sysnotify 同款）：
// 无 webServer 的 profile 仍弹气泡（不传点击参数，纯通知无跳转），仅无
// 页面轮询/静音开关 UI。
//
// 会话级静音（v1.0 与 sysnotify v1.5+ 同款）：浏览器半边在 composer 工具行
// 「工作区内修改」芯片右侧注册闹钟按钮（conversation.input.left Slot），
// 点击经 POST /plugins/dsh-desktop-notify/notify-pref 切换；静音集记入本目录
// notify-prefs.json（{"muted":[sessionId…]}，缺席 = 开启，默认开启），notify()
// 单点门控——静音会话的全部 5 类通知都不投递。

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOAST_SCRIPT = fileURLToPath(new URL('./toast-notify.ps1', import.meta.url))
const NOTIFY_LOG = fileURLToPath(new URL('./desktop-notify.log', import.meta.url))
const DEFAULT_PREFS_PATH = fileURLToPath(new URL('./notify-prefs.json', import.meta.url))

/** 诊断日志（独立于 cordis logger 级别，无条件落盘）：加载、每次通知投递、
 *  路由异常各记一行。排障直接看 desktop-notify.log。 */
function diag(line) {
  try {
    appendFileSync(NOTIFY_LOG, new Date().toISOString() + ' ' + line + '\n', 'utf8')
  } catch {
    /* 日志失败不影响通知 */
  }
}

const DEBOUNCE_MS = 2500 // 同一会话同类事件的最小通知间隔
const TITLE_MAX = 48
const BODY_MAX = 200
const NOTIF_TITLE_MAX = 120 // 通知标题上限（含前缀图标，比会话标题宽松）
const NOTIF_BODY_MAX = 400 // 通知正文上限（Windows toast 自身还会截）
const PREFS_MAX = 500 // 静音集上限（超出丢最旧）

/** 每个会话的动态状态：runningSince（本轮开始时间）、lastTask（最近一条用户消息） */
const state = new Map()
/** 防抖表：kind|sessionId → 上次通知时间 */
const lastAt = new Map()

function clip(text, max) {
  const s = String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + '…' : s
}

function elapsedText(ms) {
  const sec = Math.max(1, Math.round(ms / 1000))
  if (sec < 60) return sec + ' 秒'
  const min = Math.round(sec / 60)
  if (min < 60) return min + ' 分钟'
  return Math.floor(min / 60) + ' 小时 ' + (min % 60) + ' 分'
}

/** 通知入队入口（renderer 投递模式）/ 点击入队入口：默认 no-op，apply() 内
 *  接到真实实现（未加载时调用只返回 false）。 */
let enqueueNotify = () => false
let emitClick = (sessionId, token) => false

/** 正文换行的 U+2028 载体（命令行参数不能直接携带换行符）：宿主把 '\n'
 *  替换为 U+2028 传入 PS，toast-notify.ps1 侧还原（sysnotify 同款约定）。
 *  显式 fromCharCode 避免源码里不可见字符被编辑器/复制悄悄替换。 */
const LF_TOKEN = String.fromCharCode(0x2028)

/** 进行中的 toast 子进程 → { sid, token }：exit 0（气泡被点击）时查表走
 *  退出码兜底通道。token 同时供 HTTP 先行通道（notify-click 路由）去重——
 *  两条通道各至多投递一次，先到者生效（sysnotify v1.7 同款）。 */
const pendingToasts = new Map()

/** notify-click 路由的完整 URL：webServer 注入回调内构造（host/port 来自
 *  服务实例）。空 = 无 webServer 或插件停用 → spawn 不传 -ClickUrl，
 *  PS 点击只聚焦窗口不发信号（页面轮询通道不可用时的退化行为）。 */
let clickUrl = ''

/** 通知进程：apply() 时经 pickShell() 解析（默认 'powershell.exe'）。 */
let toastShell = 'powershell.exe'

/** where.exe 定位 pwsh（取首个非空行；WindowsApps 执行别名是 0 字节重解析
 *  点，existsSync 为真，能否启动交给存活探针判定）。仅作 PATH 兜底——
 *  Electron 宿主的 PATH 不含用户级目录，where 在宿主里探不到 Store 版
 *  pwsh（2026-10-31 实测：宿主「pwsh 未找到」而工具进程能找到）。 */
function wherePwsh() {
  try {
    const r = spawnSync('where.exe', ['pwsh'], { timeout: 5000, windowsHide: true })
    if (r.error || r.status !== 0) return null
    const line = String(r.stdout ?? '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s !== '')
    return line && existsSync(line) ? line : null
  } catch {
    return null
  }
}

/** pwsh 启动存活探针：Store 版别名失效（卸载/损坏）时 spawnSync 报错或
 *  起不来——这种 pwsh 一条通知都弹不出，必须当场回落 5.1。 */
function pwshAlive(path) {
  try {
    const r = spawnSync(path, ['-NoProfile', '-Command', 'exit 0'], {
      timeout: 5000,
      stdio: 'ignore',
      windowsHide: true,
    })
    return !(r.error || r.status !== 0)
  } catch {
    return false
  }
}

/** 按优先级找 pwsh：① %LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe
 *  （Store 版别名——不依赖宿主 PATH）②③ MSI 标准路径（x64 / preview）
 *  ④ where.exe（PATH 兜底）。exists / where 可注入（selftest）。 */
export function findPwsh(exists = existsSync, where = wherePwsh) {
  const list = []
  const local = typeof process.env.LOCALAPPDATA === 'string' ? process.env.LOCALAPPDATA : ''
  if (local !== '') list.push(local + '\\Microsoft\\WindowsApps\\pwsh.exe')
  list.push('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
  list.push('C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe')
  const hit = where()
  if (typeof hit === 'string' && hit !== '') list.push(hit)
  for (const p of list) {
    try {
      if (exists(p)) return p
    } catch {
      /* 单个候选探测失败继续下一个 */
    }
  }
  return null
}

/** 解析通知进程：'powershell'（默认/非法值）→ powershell.exe；'pwsh' /
 *  'auto' → 探测 pwsh，找不到（pwsh-not-found）或起不来（pwsh-probe-
 *  failed）一律回落 powershell.exe。probe / liveness 可注入（selftest）。
 *  返回 { shell, via }，via 供诊断日志区分「用了 pwsh」与「回落」。 */
export function pickShell(shellConfig, probe = () => findPwsh(), liveness = pwshAlive) {
  if (shellConfig !== 'pwsh' && shellConfig !== 'auto') {
    return { shell: 'powershell.exe', via: 'default' }
  }
  const path = probe()
  if (typeof path !== 'string' || path === '') {
    return { shell: 'powershell.exe', via: 'pwsh-not-found' }
  }
  if (!liveness(path)) {
    return { shell: 'powershell.exe', via: 'pwsh-probe-failed' }
  }
  return { shell: path, via: 'pwsh' }
}

/** 加载诊断行里的 shell 描述（selftest 断言判据）。 */
export function shellText(pick) {
  if (pick.via === 'pwsh') return 'pwsh @ ' + pick.shell
  if (pick.via === 'pwsh-not-found') return 'powershell.exe（pwsh 未找到，已回落）'
  if (pick.via === 'pwsh-probe-failed') return 'powershell.exe（pwsh 探针失败，已回落）'
  return 'powershell.exe'
}

/** 提取 user/message 事件的文本内容（string 或 text parts 拼接；空 = 无文本）。 */
function messageText(event) {
  const content = event?.data?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join(' ')
      .trim()
  }
  return ''
}

/** 判定会话是否 AI 拉起的子代理：会话头持久化的 parentSession /
 *  delegationDepth 是权威信号（dsh-subagent 在创建子会话时写入；主会话
 *  两者皆无）。runtime 的 options.subagentDepth 不可靠（恢复的子会话不带），
 *  以持久化头为准。 */
export function isSubagentSession(session) {
  const header = session?.header
  if (header === null || typeof header !== 'object') return false
  const depth = Number(header.delegationDepth)
  if (Number.isFinite(depth) && depth > 0) return true
  return typeof header.parentSession === 'string' && header.parentSession !== ''
}

/** 弹出一条系统通知：明文 -File + 具名参数；命令行与参数经 CreateProcessW
 *  以 UTF-16 传递，中文无代码页问题。⚠️ spawn 选项只能是 {stdio:'ignore'}——
 *  加 detached/windowsHide 后 NotifyIcon 气泡不显示（DETACHED_PROCESS 迫使
 *  子进程新建隐藏控制台，气泡随之失效；宿主常驻，本来就不需要 detached）。
 *  非零退出码写入 desktop-notify.log 留诊断线索。testHooks.scriptPath 覆盖的
 *  自测路径不传点击参数（临时 exit-N 脚本正是用来验证退出码兜底通道的）。 */
function toast(title, body, sessionId) {
  try {
    const sid =
      typeof sessionId === 'string' && sessionId !== '' && sessionId !== '-' ? sessionId : ''
    const args = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', testHooks.scriptPath ?? TOAST_SCRIPT,
      '-Title', clip(title, 200),
      '-Body', clip(String(body ?? '').replaceAll('\n', LF_TOKEN), 500),
    ]
    const token = sid === '' ? '' : randomUUID()
    if (sid !== '' && clickUrl !== '' && testHooks.scriptPath === undefined) {
      // HTTP 先行通道参数（真脚本路径时才传；selftest 的临时 exit-N 脚本
      // 不需要——它们正是用来验证退出码兜底通道的）。
      args.push('-SessionId', sid, '-ClickToken', token, '-ClickUrl', clickUrl)
    }
    const child = spawn(toastShell, args, { stdio: 'ignore' })
    if (sid !== '') pendingToasts.set(child, { sid, token })
    const forget = () => pendingToasts.delete(child)
    child.on('error', (e) => {
      forget()
      diag('toast spawn 失败: ' + (e?.message ?? String(e))) // 无桌面会话或缺少 powershell 时留痕
    })
    child.on('exit', (code) => {
      const owner = pendingToasts.get(child)
      forget()
      if (code === 0 && owner !== undefined) {
        // 气泡被点击：退出码兜底通道（HTTP 先行通道已投递过的话按 token
        // 去重只记账不重复入队）。
        try {
          const delivered = emitClick(owner.sid, owner.token)
          diag(
            delivered
              ? 'toast 点击（退出码通道）sid=' + owner.sid
              : 'toast 点击（token 已由 HTTP 信号先行投递）sid=' + owner.sid,
          )
        } catch {
          /* 入队失败不影响通知本身 */
        }
      } else if (code !== 0 && code !== 3) {
        // 3 = 未点击（超时/关闭/自动消失）的正常退出码；其余才值得排查。
        diag('toast 进程退出码 ' + code + '（脚本解析失败？检查 toast-notify.ps1 需带 UTF-8 BOM）')
      }
    })
    child.unref()
  } catch (err) {
    diag('toast 异常: ' + (err?.message ?? String(err)))
  }
}

/** 测试缝隙：selftest 用。
 *  spawnToast：拦截真实气泡（计数器代替，测试过程不连环弹窗；真子进程
 *    端到端用 scriptPath 指向临时 exit-N 脚本走真 spawn）；
 *  notify：直调通知入口；emitClick：直调入队路径；
 *  queueDepth：断言队列深度；scriptPath：覆盖 PS 脚本路径。 */
export const testHooks = {
  spawnToast: (title, body, sessionId) => toast(title, body, sessionId),
  scriptPath: undefined,
  notify: (kind, sessionId, title, body) => enqueueNotify(kind, sessionId, title, body),
  emitClick: (sessionId, token) => emitClick(sessionId, token),
  queueDepth: () => 0,
}

// ── 会话级静音偏好（notify-prefs.json）──────────────────────────────────
//
// 文件属主是本插件目录（与 desktop-notify.log 同级）；{"muted":[sessionId…]}，
// 缺席 = 开启（默认全部会话通知）。会话销毁不清理（可恢复的会话保留
// 偏好）；上限 PREFS_MAX 条，超出丢最旧（Set 插入序）。

/** 读取静音偏好：缺失/畸形文件 → 空集（全部开启）。 */
export function loadPrefs(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const muted = Array.isArray(parsed?.muted)
      ? parsed.muted.filter((id) => typeof id === 'string' && id !== '')
      : []
    return new Set(muted.slice(-PREFS_MAX))
  } catch {
    return new Set()
  }
}

/** 写回静音偏好（截断到上限）。写盘失败由调用方诊断。 */
export function savePrefs(path, mutedSet) {
  const muted = [...mutedSet].slice(-PREFS_MAX)
  writeFileSync(path, JSON.stringify({ muted }, null, 2) + '\n', 'utf8')
  return muted
}

/** 读一个请求体并解析 JSON（上限 1 MiB；sysnotify 同款）。 */
function readJsonBody(req, limit = 1 << 20) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        rejectBody(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        rejectBody(new Error('request body is not valid JSON'))
      }
    })
    req.on('error', rejectBody)
  })
}

/** 同源 / 桌面转发守卫：Origin 缺席 → 放行（桌面壳转发时删除了 Origin，
 *  连接本身由壳持有的认证 cookie 保障）；Origin 存在 → 必须匹配 Host
 *  （浏览器直连场景，防跨站）。返回错误文案或 null（放行）。 */
function originFailure(req) {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
  if (origin === '') return null
  const host = typeof req.headers.host === 'string' ? req.headers.host : ''
  if (origin === `http://${host}` || origin === `https://${host}`) return null
  return 'cross-origin request rejected'
}

// 导出形态：官方参考文档的具名 apply 函数 + 可选具名 inject（sysnotify 同款）。
export const name = 'dsh-desktop-notify'

export const inject = ['sessionTitle']

export function apply(ctx, config = {}) {
  // config.prefsPath：测试用覆盖；默认本目录 notify-prefs.json。
  const prefsPath = typeof config.prefsPath === 'string' && config.prefsPath !== ''
    ? resolve(config.prefsPath)
    : DEFAULT_PREFS_PATH
  // config.delivery：投递通道。'powershell'（默认——渲染器 Web Notifications
  // 在当前桌面端构建被 Windows 静默丢弃，见文件头）/ 'renderer'（预留，
  // 桌面端未来补上 app.setAppUserModelId 后启用）。非法值回落 powershell。
  const delivery = config.delivery === 'renderer' ? 'renderer' : 'powershell'
  // config.shell：通知进程。'powershell'（默认，每台 Windows 必有）/
  // 'pwsh'（pwsh 7，找不到/起不来回落 5.1 并记日志）/'auto'（pwsh 优先，
  // 回落静默）。解析在加载期一次完成，toast() 只消费结果。
  const shellPick = pickShell(config.shell)
  toastShell = shellPick.shell
  const muted = loadPrefs(prefsPath)
  // config.muteSubagents：AI 拉起的子代理会话（header.parentSession 存在
  // 或 delegationDepth ≥ 1）全部 6 类通知默认静音；主会话不受影响。
  // ⚠️ 子代理若触发提权审批，GUI 审批弹窗照旧——仅桌面气泡被压。
  // 设 false 整体恢复。
  const muteSubagents = config.muteSubagents !== false
  /** 已识别的子代理会话 id：任一事件入口首次见到即学习并记一行诊断。 */
  const subagentSids = new Set()
  const learnSubagent = (session, where) => {
    if (!isSubagentSession(session)) return
    const sid = String(session?.id ?? '')
    if (sid === '' || subagentSids.has(sid)) return
    subagentSids.add(sid)
    diag('子代理会话 sid=' + sid + ' 默认静音（来源 ' + where + '）')
  }
  const persist = () => {
    try {
      savePrefs(prefsPath, muted)
    } catch (err) {
      diag('静音偏好写盘失败: ' + (err?.message ?? String(err)))
    }
  }

  diag(
    '插件已加载（v1.3.0，投递 ' +
      delivery +
      '，shell ' +
      shellText(shellPick) +
      '，静音 ' +
      muted.size +
      ' 个会话），注册事件监听器',
  )
  const sessionTitle = ctx.sessionTitle

  // ── 事件队列（长轮询投递）────────────────────────────────────────────
  //
  // { seq, type, kind?, sessionId, title?, body?, ts } 单调递增；容量 50 丢
  // 最旧、TTL 10 分钟。type：'click'（气泡点击 → 页面 openSession）/
  // 'notify'（renderer 模式的通知载荷 → 页面弹渲染器通知）。waiters 是长
  // 轮询挂起请求，入队时唤醒全部 after < seq 的 waiter；res 提前断开（窗口
  // 刷新/关闭）由 'close' 事件摘除，插件停用时冲刷全部 waiter 后移除路由。
  const NOTIFY_MAX = 50
  const NOTIFY_TTL_MS = 10 * 60 * 1000
  const notifyEvents = []
  let notifySeq = 0
  const waiters = new Set()

  const pruneEvents = () => {
    const horizon = Date.now() - NOTIFY_TTL_MS
    while (
      notifyEvents.length > 0 &&
      (notifyEvents.length > NOTIFY_MAX || notifyEvents[0].ts < horizon)
    ) {
      notifyEvents.shift()
    }
  }

  const snapshotAfter = (after) => ({
    ok: true,
    seq: notifySeq,
    events: notifyEvents.filter((e) => e.seq > after),
  })

  /** 结束一个挂起 waiter（幂等；清 timer、摘表、容忍已销毁的 res）。 */
  const finishWaiter = (w, payload) => {
    if (w.finished) return
    w.finished = true
    waiters.delete(w)
    clearTimeout(w.timer)
    try {
      w.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      w.res.end(JSON.stringify(payload))
    } catch {
      /* 客户端已断开 */
    }
  }

  testHooks.queueDepth = () => notifyEvents.length

  /** 通用入队：写事件、修剪、唤醒等待中的页面轮询。 */
  const enqueueEvent = (event) => {
    notifyEvents.push(event)
    pruneEvents()
    let woke = 0
    for (const w of [...waiters]) {
      if (w.after < notifySeq) {
        finishWaiter(w, snapshotAfter(w.after))
        woke++
      }
    }
    return woke
  }

  /** 点击入队（带 token 去重，sysnotify v1.7 同款双通道语义）。
   *  返回 true = 本次调用实际入队（HTTP 先行或退出码通道的先到者）；
   *  false = 重复（另一通道已投递过同一 token）或无效 sid。 */
  const seenTokens = new Map() // token → 记录时间（双通道去重；10 分钟清理 + 200 上限）
  const recordClickWithToken = (sessionId, token) => {
    const sid = String(sessionId ?? '')
    if (sid === '' || sid === '-') return false
    if (token !== undefined && token !== '') {
      if (seenTokens.has(token)) return false
      seenTokens.set(token, Date.now())
      if (seenTokens.size > 200) {
        // 超限兜底：按插入序删到 200 条为止（Map 迭代序即插入序）。
        for (const t of seenTokens.keys()) {
          if (seenTokens.size <= 200) break
          seenTokens.delete(t)
        }
      }
    }
    const event = { seq: ++notifySeq, type: 'click', sessionId: sid, ts: Date.now() }
    const woke = enqueueEvent(event)
    // 观测点：有页面在等时记一行——与「页面轮询已连接」串起来即完整投递链。
    if (woke > 0) diag('notify-events 点击投递 sid=' + sid + ' 唤醒 ' + woke + ' 个等待请求')
    return true
  }
  emitClick = recordClickWithToken
  ctx.effect(
    () => () => {
      // 插件停用/重挂：解除模块级桥（toast 点击仍记日志，但不再入队）。
      if (emitClick === recordClickWithToken) emitClick = () => false
    },
    'dsh-desktop-notify: click sink detach',
  )

  /** 通知单点入口：sid 校验（空/占位不投递——点击无法跳转）→ 静音门控
   *  （在防抖之前——静音会话连防抖键都不记，取消静音立即可通知）→ 防抖
   *  → 按投递模式分发：powershell → spawn 气泡（不入队，页面轮询只服务
   *  点击跳转）；renderer → 入队 type:'notify' 事件唤醒页面弹渲染器通知。
   *  返回 true = 实际投递。 */
  const notify = (kind, sessionId, title, body) => {
    const sid = String(sessionId ?? '-')
    if (sid === '' || sid === '-') return false
    if (muted.has(sid)) return false
    // 子代理默认静音门（位于用户静音门之后、防抖之前——被压的会话不记
    // 防抖键，取消限制后立即可通知）。
    if (muteSubagents && subagentSids.has(sid)) return false
    const key = kind + '|' + sid
    const now = Date.now()
    const prev = lastAt.get(key)
    if (prev !== undefined && now - prev < DEBOUNCE_MS) return false
    lastAt.set(key, now)
    if (lastAt.size > 500) lastAt.clear()
    const clippedTitle = clip(title, NOTIF_TITLE_MAX)
    const clippedBody = clip(String(body ?? ''), NOTIF_BODY_MAX)
    if (delivery === 'powershell') {
      diag('notify kind=' + kind + ' sid=' + sid + ' spawn toast title=' + clip(clippedTitle, 80))
      testHooks.spawnToast(clippedTitle, clippedBody, sid)
      try {
        ctx.logger?.info?.('desktop-notify:', clippedTitle, '—', clippedBody.replace(/\n/g, ' '))
      } catch {
        /* 日志失败无所谓 */
      }
      return true
    }
    const event = {
      seq: ++notifySeq,
      type: 'notify',
      kind: String(kind ?? 'info'),
      sessionId: sid,
      title: clippedTitle,
      body: clippedBody,
      ts: now,
    }
    const woke = enqueueEvent(event)
    diag('notify kind=' + event.kind + ' sid=' + sid + ' 入队 seq=' + event.seq + ' title=' + clip(event.title, 80))
    // 观测点：有页面在等时记一行——与「页面轮询已连接」串起来即完整投递链。
    if (woke > 0) diag('notify-events 通知投递 sid=' + sid + ' 唤醒 ' + woke + ' 个等待请求')
    try {
      ctx.logger?.info?.('desktop-notify:', event.title, '—', event.body.replace(/\n/g, ' '))
    } catch {
      /* 日志失败无所谓 */
    }
    return true
  }
  enqueueNotify = notify
  ctx.effect(
    () => () => {
      if (enqueueNotify === notify) enqueueNotify = () => false
    },
    'dsh-desktop-notify: enqueue sink detach',
  )

  /** 取会话标题（从日志折叠，重启后依然正确）+ 最近任务。 */
  const info = (agent) => {
    let title
    try {
      title = sessionTitle.get(agent?.session)?.title ?? undefined
    } catch {
      title = undefined
    }
    const sid = agent ? String(agent.id ?? '') : ''
    const st = agent ? state.get(sid) : undefined
    const task = st?.lastTask || ''
    const fallback = task
      ? clip(task, TITLE_MAX)
      : sid
        ? '会话 …' + (sid.length > 6 ? sid.slice(-6) : sid)
        : 'DSH 会话'
    return { title: title ? clip(title, TITLE_MAX) : fallback, task }
  }

  /** 「等待批准」通知的统一出口：瀑布链来源与会话事件来源共用。
   *  ⚠️ 为什么要两条来源：'approval/request' 是 waterfall，真正的应答者
   *  （dsh-api-remotes → GUI 审批弹窗）在 bundle 顺序上先于本插件注册，
   *  且它以用户答复终结链条、**不再调用 next()** ⇒ 排在其后的观察型
   *  监听器永远不会被执行（2026-10-29 起 approval 类通知全灭的根因）。
   *  'approval/asked' 是 ApprovalService 在询问 answerers **之前**写入
   *  会话日志的持久化事件，与瀑布链顺序、作用域过滤均无关，作主路径；
   *  瀑布链监听器保留并 prepend，作为兜底。两条来源同刻触发时由
   *  2.5s 防抖表（kind|sid）收敛为一条通知。 */
  const notifyApproval = (sid, title, task, tool, reason) => {
    if (!sid) return
    const reasonText = typeof reason === 'string' && reason ? '\n原因：' + clip(reason, 120) : ''
    notify(
      'approval',
      sid,
      '⏸️ ' + title + '：等待批准',
      '操作：' + tool + reasonText + (task ? '\n正在执行：' + clip(task, 100) : ''),
    )
  }

  // ── 浏览器半边通道（可选依赖：webServer 缺席时气泡照弹——spawn 不传
  //    点击参数，纯通知无跳转；仅无页面轮询/静音开关 UI）────────────────
  ctx.inject(['webServer'], (wctx) => {
    // notify-click 的完整 URL：PS 点击处理器 POST {sessionId, token} 用。
    // 0.0.0.0 监听时 PS/页面都走 127.0.0.1。
    const host = wctx.webServer.host === '0.0.0.0' ? '127.0.0.1' : wctx.webServer.host
    clickUrl = `http://${host}:${wctx.webServer.port}/plugins/dsh-desktop-notify/notify-click`
    wctx.effect(
      () => {
        const disposePref = wctx.webServer.register({
          kind: 'exact',
          path: '/plugins/dsh-desktop-notify/notify-pref',
          handler: async (req, res) => {
            const send = (status, payload) => {
              res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify(payload))
            }
            try {
              if (req.method !== 'POST') {
                send(405, { ok: false, error: 'method not allowed' })
                return
              }
              const guard = originFailure(req)
              if (guard !== null) {
                send(403, { ok: false, error: guard })
                return
              }
              const body = await readJsonBody(req)
              if (body === null || typeof body !== 'object' || Array.isArray(body)) {
                send(400, { ok: false, error: 'request body must be { "sessionId": string, "muted"?: boolean }' })
                return
              }
              const sessionId = body.sessionId
              if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 200) {
                send(400, { ok: false, error: '"sessionId" must be a non-empty string (max 200 chars)' })
                return
              }
              if (body.muted !== undefined) {
                if (typeof body.muted !== 'boolean') {
                  send(400, { ok: false, error: '"muted" must be a boolean' })
                  return
                }
                // 已在集合里再静音时重插到末尾（维持「最旧先丢」的插入序）。
                if (body.muted) {
                  muted.delete(sessionId)
                  muted.add(sessionId)
                } else {
                  muted.delete(sessionId)
                }
                persist()
                diag('notify-pref set sid=' + sessionId + ' muted=' + body.muted)
              }
              send(200, { ok: true, muted: muted.has(sessionId) })
            } catch (error) {
              send(500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        })
        const disposeEvents = wctx.webServer.register({
          kind: 'exact',
          path: '/plugins/dsh-desktop-notify/notify-events',
          handler: async (req, res) => {
            const send = (status, payload) => {
              res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify(payload))
            }
            try {
              if (req.method !== 'POST') {
                send(405, { ok: false, error: 'method not allowed' })
                return
              }
              const guard = originFailure(req)
              if (guard !== null) {
                send(403, { ok: false, error: guard })
                return
              }
              const body = await readJsonBody(req)
              if (body === null || typeof body !== 'object' || Array.isArray(body)) {
                send(400, { ok: false, error: 'request body must be { "after"?: number, "waitMs"?: number }' })
                return
              }
              let after
              if (body.after !== undefined) {
                if (
                  typeof body.after !== 'number' ||
                  !Number.isSafeInteger(body.after) ||
                  body.after < 0
                ) {
                  send(400, { ok: false, error: '"after" must be a non-negative safe integer' })
                  return
                }
                after = body.after
              }
              let waitMs = 20000
              if (body.waitMs !== undefined) {
                if (typeof body.waitMs !== 'number' || !Number.isFinite(body.waitMs) || body.waitMs < 0) {
                  send(400, { ok: false, error: '"waitMs" must be a non-negative number' })
                  return
                }
                waitMs = Math.min(body.waitMs, 25000)
              }
              pruneEvents()
              // 引导（窗口加载/重连的第一个请求）：立即返回 seq 基线，不回放
              // 历史——通知只在页面在线时实时弹出，迟到的队列不补发。
              if (after === undefined) {
                diag('notify-events 页面轮询已连接（引导 seq=' + notifySeq + '）')
                send(200, { ok: true, seq: notifySeq, events: [] })
                return
              }
              // 落后于服务端 seq（宿主重启后 seq 重置）：同样引导式空回。
              if (after > notifySeq) {
                send(200, { ok: true, seq: notifySeq, events: [] })
                return
              }
              const pending = notifyEvents.filter((e) => e.seq > after)
              if (pending.length > 0) {
                send(200, { ok: true, seq: notifySeq, events: pending })
                return
              }
              // 无新事件：挂起，notify() 或超时唤醒。
              const waiter = { res, after, timer: undefined, finished: false }
              waiter.timer = setTimeout(
                () => finishWaiter(waiter, { ok: true, seq: notifySeq, events: [] }),
                waitMs,
              )
              waiters.add(waiter)
              res.on('close', () => {
                // 页面刷新/关闭导致连接断开：摘除防泄漏（响应完成也会走这里）。
                if (!waiter.finished) {
                  waiter.finished = true
                  waiters.delete(waiter)
                  clearTimeout(waiter.timer)
                }
              })
            } catch (error) {
              send(500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        })
        // PS 点击处理器的 HTTP 先行通道（sysnotify v1.7 同款）：点击瞬间
        // POST {sessionId, token}，宿主按 token 去重入队 type:'click' 事件。
        // PS 请求显式携带同源 Origin 头（Send-ClickSignal 构造）——守卫与
        // 其余路由一致（缺席亦放行）。
        const disposeClick = wctx.webServer.register({
          kind: 'exact',
          path: '/plugins/dsh-desktop-notify/notify-click',
          handler: async (req, res) => {
            const send = (status, payload) => {
              res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify(payload))
            }
            try {
              if (req.method !== 'POST') {
                send(405, { ok: false, error: 'method not allowed' })
                return
              }
              const guard = originFailure(req)
              if (guard !== null) {
                send(403, { ok: false, error: guard })
                return
              }
              const body = await readJsonBody(req)
              if (body === null || typeof body !== 'object' || Array.isArray(body)) {
                send(400, { ok: false, error: 'request body must be { "sessionId": string, "token": string }' })
                return
              }
              const sid = body.sessionId
              if (typeof sid !== 'string' || sid === '' || sid.length > 200) {
                send(400, { ok: false, error: '"sessionId" must be a non-empty string (max 200 chars)' })
                return
              }
              const token = body.token
              if (typeof token !== 'string' || token === '' || token.length > 100) {
                send(400, { ok: false, error: '"token" must be a non-empty string (max 100 chars)' })
                return
              }
              const delivered = recordClickWithToken(sid, token)
              if (delivered) diag('notify-click HTTP 信号 sid=' + sid + '（首次投递，页面切换进行中）')
              else diag('notify-click HTTP 信号 sid=' + sid + '（token 重复，忽略——退出码通道已投递？）')
              send(200, { ok: true, dup: !delivered })
            } catch (error) {
              send(500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        })
        return () => {
          disposePref()
          disposeEvents()
          disposeClick()
          clickUrl = ''
          // 路由摘除时冲刷挂起 waiter（客户端会退避重连，路由已不在则 404 退避）。
          for (const w of [...waiters]) finishWaiter(w, { ok: true, seq: notifySeq, events: [] })
        }
      },
      'dsh-desktop-notify: notify-pref + notify-events + notify-click routes',
    )
  })

  // 跟踪每个会话最近一条用户消息（作为"当前任务"描述）。
  // 仅统计真正来自人类输入的消息（source.kind === 'user'），与
  // session-title 服务的 collectSessionTitleMessages 口径一致；
  // 工具结果、子代理注入的 user 角色消息不污染任务文案。
  ctx.on('session/event', (session, event) => {
    try {
      // 子代理识别学习（任何事件都带会话对象——首次见到即记默认静音）。
      learnSubagent(session, 'session/event')
      // 「等待批准」的主路径：ApprovalService.request() 先把 approval/asked
      // 写进会话日志，再去派发 answerers。走会话事件 ⇒ 不受 approval/request
      // 瀑布链监听顺序与作用域过滤影响，提权申请（sandbox escalation 走
      // 同一审批通道）也能第一时间弹窗。
      if (event?.type === 'approval/asked') {
        const sid = String(session?.id ?? '')
        let title
        try {
          title = sessionTitle.get(session)?.title ?? undefined
        } catch {
          title = undefined
        }
        const st = state.get(sid) ?? { runningSince: 0, lastTask: '' }
        const fallback = st.lastTask
          ? clip(st.lastTask, TITLE_MAX)
          : sid
            ? '会话 …' + (sid.length > 6 ? sid.slice(-6) : sid)
            : 'DSH 会话'
        notifyApproval(
          sid,
          title ? clip(title, TITLE_MAX) : fallback,
          st.lastTask,
          String(event.data?.toolName ?? '未知操作'),
          event.data?.reason,
        )
        return
      }
      // ⏰ 定时提醒到期：dsh-schedule 把到期提示词以 source.kind ===
      // 'schedule' 的 user/message 注入会话并唤醒代理——此前插件只把它当
      // 普通消息忽略，窗口在后台时用户得不到任何「提醒到了」的信号。
      // 真人类输入（kind === 'user'）仍只记 lastTask，不在此列。
      if (event?.type === 'user/message' && event.data?.source?.kind === 'schedule') {
        const text = messageText(event)
        const sid = String(session?.id ?? '')
        let rTitle
        try {
          rTitle = sessionTitle.get(session)?.title ?? undefined
        } catch {
          rTitle = undefined
        }
        const rst = state.get(sid) ?? { runningSince: 0, lastTask: '' }
        const rFallback = rst.lastTask
          ? clip(rst.lastTask, TITLE_MAX)
          : sid
            ? '会话 …' + (sid.length > 6 ? sid.slice(-6) : sid)
            : 'DSH 会话'
        notify(
          'reminder',
          sid,
          '⏰ ' + (rTitle ? clip(rTitle, TITLE_MAX) : rFallback) + '：定时提醒',
          text ? '内容：' + clip(text, 120) : '提醒已到期，回到 DSH 查看',
        )
        return
      }
      if (event?.type !== 'user/message') return
      if (event.data?.source?.kind !== 'user') return
      const text = messageText(event)
      if (!text) return
      const sid = String(session?.id ?? '')
      const st = state.get(sid) ?? { runningSince: 0, lastTask: '' }
      st.lastTask = clip(text, BODY_MAX)
      state.set(sid, st)
    } catch {
      /* ignore */
    }
  })

  // 会话销毁时清理动态状态，避免长期运行的宿主内存缓慢增长。
  // 静音偏好不清理：可恢复（resume）的会话保留用户的开关选择。
  ctx.on('session/disposed', (session) => {
    try {
      state.delete(String(session?.id ?? ''))
    } catch {
      /* ignore */
    }
  })

  // 完成：running → idle。
  ctx.on('agent/status', (payload) => {
    try {
      const agent = payload?.agent
      learnSubagent(agent?.session, 'agent/status')
      const sid = String(agent?.id ?? '')
      const st = state.get(sid) ?? { runningSince: 0, lastTask: '' }
      if (payload?.status === 'running') {
        st.runningSince = Date.now()
        state.set(sid, st)
        return
      }
      if (payload?.status === 'idle' && st.runningSince) {
        const dur = Date.now() - st.runningSince
        st.runningSince = 0
        state.set(sid, st)
        const { title, task } = info(agent)
        const lines = [task ? '任务：' + task : '本轮工作已结束']
        if (dur > 0) lines.push('耗时 ' + elapsedText(dur))
        lines.push('回到 DSH 查看结果')
        notify('done', sid, '✅ ' + title, lines.join('\n'))
      }
    } catch {
      /* ignore */
    }
  })

  // 阻塞：等待批准。
  // ⚠️ waterfall 链监听器：任何路径都必须返回 next()，否则会否决整条
  // 链（2026-08 事故：不调用 next() 的监听器否决链条其余部分，dsh-tools
  // 读 gate.kind 崩溃）。包括 try/catch 兜底路径。
  // ⚠️ prepend：必须排在所有应答者之前——真正的应答者（dsh-api-remotes
  // → GUI 审批弹窗）注册更早，且以用户答复终结链条、不再调用 next()，
  // 排在其后的观察型监听器永远不会被执行（2026-10-29 起 approval 类
  // 通知全灭的根因）。本插件永远 next()，不改变审批结果。
  ctx.on(
    'approval/request',
    (req, next) => {
      try {
        const agent = req?.agent
        learnSubagent(agent?.session, 'approval/request')
        const sid = String(agent?.id ?? '')
        const { title, task } = info(agent)
        notifyApproval(sid, title, task, String(req?.toolName ?? '未知操作'), req?.reason)
      } catch {
        /* 通知失败绝不阻断批准流程 */
      }
      return next()
    },
    { prepend: true },
  )

  // 阻塞：等待回答（ask_user_question）或 plan 模式计划待审批
  // （exit_plan_mode——普通注册工具，执行时阻塞在 userQuestions.ask 的
  // 「批准 / 继续完善」选择题上；走 tools/pre-execute 同一管线）。
  // ⚠️ 同为 waterfall 链：任何路径（含兜底）都必须返回 next()。
  ctx.on('tools/pre-execute', (exec, next) => {
    try {
      if (exec?.name === 'ask_user_question') {
        const agent = exec?.agent
        learnSubagent(agent?.session, 'tools/pre-execute')
        const sid = String(agent?.id ?? '')
        const { title } = info(agent)
        const qs = Array.isArray(exec?.arguments?.questions) ? exec.arguments.questions : []
        const first =
          qs.map((q) => (q && typeof q === 'object' ? q.question : undefined)).find((q) => typeof q === 'string') ??
          '请打开 DSH 回答'
        notify('question', sid, '❓ ' + title + '：等待回答', clip(first, BODY_MAX))
      } else if (exec?.name === 'exit_plan_mode') {
        const agent = exec?.agent
        const sid = String(agent?.id ?? '')
        const { title, task } = info(agent)
        // 计划 markdown 必以 # 标题开头（工具自校验）；取首个标题行做摘要
        const raw = typeof exec?.arguments?.plan === 'string' ? exec.arguments.plan : ''
        const heading = (raw.split('\n').map((l) => l.trim()).find((l) => /^#\s+\S/.test(l)) ?? '').replace(/^#+\s+/, '')
        const lines = [heading ? '计划：' + clip(heading, 120) : '计划已生成，等待审批']
        if (task) lines.push('正在执行：' + clip(task, 100))
        lines.push('回到 DSH：批准执行 / 继续完善')
        notify('plan', sid, '📋 ' + title + '：计划待审批', lines.join('\n'))
      }
    } catch {
      /* 通知失败绝不阻断工具执行 */
    }
    return next()
  })

  // 出错。
  ctx.on('agent/error', (payload) => {
    try {
      const agent = payload?.agent
      learnSubagent(agent?.session, 'agent/error')
      const sid = String(agent?.id ?? '')
      const { title } = info(agent)
      const err = payload?.error
      const msg =
        typeof err === 'object' && err !== null && typeof err.message === 'string'
          ? err.message
          : typeof err === 'string'
            ? err
            : '未知错误'
      notify('error', sid, '⚠️ ' + title + '：出错', clip(msg, BODY_MAX))
    } catch {
      /* ignore */
    }
  })
}
