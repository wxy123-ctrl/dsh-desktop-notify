# dsh-desktop-notify — DSH 桌面端专用系统通知插件

DSH 桌面端（Electron，profile `~/.dsh/profiles/desktop`）
专用：任意会话**完成工作 / 阻塞等待批准 / 阻塞等待回答 / plan 模式计划待审批 /
出错**时弹出系统通知；**点击通知自动聚焦桌面窗口并切到触发的会话**（含从
最小化、托盘隐藏恢复）。浏览器场景请继续用 web profile 的 `dsh-sysnotify`
（本插件与之互不干扰：client.js 有桌面守卫，非 `dsh-app:` 环境全程 no-op）。

## v1.1.0 架构（为什么不是「由 APP 直接发起」）

v1.0.0 曾用渲染器 `new Notification()`（Electron Web Notifications，应用身份）
投递——**实测失败**：`desktop-notify.log` 证明事件→队列→页面投递全链路畅通，
但 Windows 静默丢弃了 toast。根因（已从桌面端安装包源码证实）：

- 桌面端 main.js **从未调用 `app.setAppUserModelId()`**（全文件 0 处）；
- 开始菜单快捷方式的 AUMID 是 `electron.app.DeepSeek Harness`（NSIS 默认），
  进程运行时不设置同名 AUMID——**无匹配快捷方式的进程发出的 toast 会被
  Windows 静默丢弃**，且构造函数不报错；
- AUMID 只能由 Electron 主进程设置，**插件层无解**（宿主是独立 Node 进程，
  渲染器无此能力）。

因此 v1.1.0 把投递通道切回 PowerShell NotifyIcon 气泡（dsh-sysnotify 在
web profile 验证多年的同通道），点击跳转保持桌面原生：

```
宿主半边 index.js（desktop profile 内，纯 Node）
  5 类事件 → 静音门控 + 2.5s 防抖（文案/标题与 sysnotify 相同）
  →【delivery: powershell（默认）】spawn powershell -File toast-notify.ps1
    -Title -Body（U+2028 载体换行）-SessionId -ClickToken -ClickUrl
  →【delivery: 'renderer'（预留）】入队 type:'notify' 事件 → 页面长轮询 →
    client.js new Notification()（未来桌面端补上 AUMID 后启用）

点击气泡 → toast-notify.ps1：
  ① Send-ClickSignal：POST {sessionId, token} 到 notify-click 路由
    （HttpWebRequest + Proxy=$null + 1s 超时；token 去重）
    → 宿主入队 type:'click' 事件 → 唤醒页面长轮询
    → client.js uiWorkspace.openSession(sessionId)（= 侧栏点击会话行路径）
  ② 聚焦 DSH 桌面窗口：EnumWindows 按进程名 "DeepSeek Harness" 定位
    （不限可见——托盘隐藏窗口 IsWindowVisible=false）→ SW_RESTORE（最小化）
    / SW_SHOW（托盘隐藏）→ SetForegroundWindow（前台锁未放行时 Alt 键重试）
  ③ exit 0（已点击）/ exit 3（未点击超时）；exit 0 时宿主按 child→{sid,token}
    记账走退出码兜底通道，与 HTTP 通道按 token 去重，先到者生效
```

与 sysnotify（浏览器版）相比删除了：UIA 页签匹配、实时标题集（notify-titles）、
开新页兜底——桌面端只有一个 Electron 主窗口，按进程名定位即可。

| 通道纪律（sysnotify 血泪教训，全部保留） | 说明 |
|---|---|
| 明文 `-File` + 具名参数 | 火绒「隐藏执行 PowerShell」规则会误杀 `-WindowStyle Hidden` + `-EncodedCommand`，勿改回 |
| `toast-notify.ps1` UTF-8 **with BOM** | 无 BOM 被 PS 5.1 按 GBK 误读，`param()` 崩、静默失败（selftest 有 BOM 断言） |
| spawn 只用 `{stdio:'ignore'}` | detached/windowsHide 会让 NotifyIcon 气泡消失（实测致命） |
| waterfall 任何路径 `return next()` | 不调用会否决链条，dsh-tools 崩（2026-08 事故） |
| 路由守卫「Origin 缺席放行」 | 桌面壳转发删除 Origin 头；sysnotify 严格守卫会 403 桌面请求 |

## 通知内容

| 场景 | 标题 | 正文 |
|---|---|---|
| 完成工作 | `✅ <会话标题>` | 任务（最近一条用户指令）+ 耗时 |
| 等待批准 | `⏸️ <会话标题>：等待批准` | 操作 + 原因 + 正在执行的任务 |
| 等待回答 | `❓ <会话标题>：等待回答` | 问题原文 |
| 计划待审批 | `📋 <会话标题>：计划待审批` | 计划首标题 + 任务 +「批准执行 / 继续完善」提示 |
| 出错 | `⚠️ <会话标题>：出错` | 错误信息 |

会话标题来自 `sessionTitle` 服务（日志折叠，重启后依然正确）；同一会话同类
事件 2.5 秒防抖。通知在通知中心归组为 **Windows PowerShell**——桌面端未设置
AUMID，无法归组到 DSH 应用（见上「为什么」）。

## 会话级开关

composer 工具行「工作区内修改」芯片右侧的闹钟按钮（`conversation.input.left`
Slot），点击经 `POST /plugins/dsh-desktop-notify/notify-pref` 切换；静音 = 该会话
**全部 5 类**通知不投递；偏好持久化到插件目录 `notify-prefs.json`
（`{"muted":[sessionId…]}`，缺席 = 开启，上限 500 条）。按钮样式为 sysnotify
v1.8.3 的原子化配方（静态外观内联 `<button>`、伪类规则随组件 `<style>` 同一
React commit 生灭）。

## 文件

| 文件 | 用途 |
|---|---|
| `index.js` | 宿主半边：事件监听 + 防抖/静音 + PS spawn + 点击队列 + notify-pref / notify-events / notify-click 三条路由 |
| `client.js` | 桌面渲染器半边：桌面守卫 + 长轮询按 type 分发（click→openSession / notify→渲染器通知）+ 闹钟开关按钮 |
| `toast-notify.ps1` | 气泡脚本：NotifyIcon + 点击（HTTP 信号 + 聚焦 Electron 窗口）+ exit 0/3（**UTF-8 with BOM**） |
| `notify-prefs.json` | 会话级静音偏好（运行时生成，可手编；缺席 = 开启） |
| `desktop-notify.log` | 诊断日志（加载 / spawn / 入队 / 投递唤醒 / 点击双通道 / 路由异常，无条件落盘） |
| `package.json` | `dsh.bundle.patch` 声明 bundle 补丁，`dsh.client` 声明浏览器半边 |
| `cordis.patch.yml` | bundle 补丁：`insert` 行 `{id: desktop-notify, name: dsh-desktop-notify}` |
| `selftest.mjs` | 自测：`node selftest.mjs`（99 项断言，无 UI 依赖，含真子进程退出码端到端） |

## 启用流程（desktop profile）

1. 克隆本仓库到任意目录（下称 `<本仓库>`）：

   ```powershell
   git clone https://github.com/wxy123-ctrl/dsh-desktop-notify.git
   ```

2. 注册依赖与 bundle：编辑 `~/.dsh/profiles/desktop/package.json`——
   `dependencies` 加 `"dsh-desktop-notify": "link:<本仓库绝对路径>"`，
   `dsh.profile.bundles` 数组加 `"dsh-desktop-notify"`。
3. `pnpm install --dir <desktop profile>`（以 link 方式挂载本仓库）。
   也可在桌面端的 Plugins 页按本仓库绝对路径安装（官方路径，等效）。
4. 重启桌面端（应用菜单 →「重启应用与 Host」；desktop profile 未开
   `patchReload: live`，不依赖热重组）。
5. 验证：任一会话输入框「工作区内修改」右侧出现闹钟按钮；触发一次阻塞
   → 通知弹出 → 点击 → 窗口置前且主区切到该会话。
6. 卸载：从 `package.json` 移除依赖与 bundle 条目后再 `pnpm install`，或经
   桌面端 Plugins 页移除；重启桌面端生效。

切换投递通道：profile 的 `cordis.patch.yml` 里按 id 覆盖——

```yaml
- id: desktop-notify
  config:
    delivery: renderer   # 默认 powershell
```

## 排障（按投递链三环）

1. **宿主环**：`desktop-notify.log` 应有「插件已加载（v1.1.0，投递
   powershell…）」；触发事件后有 `notify kind=… spawn toast` 行。没有 →
   事件未到或宿主半边未加载（确认 bundle 注册 + 已重启桌面端）。
2. **气泡环**：log 出现 `toast 进程退出码 N`（N≠3）→ PS 脚本执行失败
   （检查 BOM / 安全软件拦截记录）；`toast spawn 失败` → 无 powershell。
3. **点击环**：点击气泡后 log 应有 `notify-click HTTP 信号 sid=…`（或
   `toast 点击（退出码通道）sid=…` 兜底）+ `notify-events 点击投递 …唤醒 1 个
   等待请求`；桌面端 DevTools 控制台 `[dsh-desktop-notify] 事件到达 click
   <sid>`。窗口没切 → 对比控制台有无 `openSession 失败` 警告；页面轮询死 →
   确认横幅 `[dsh-desktop-notify] v1.1.0 事件长轮询已启动` 存在，刷新窗口一次。

## 已知边界

- **应用完全退出**（宿主随之停止）→ 无通知。GUI 关闭也要收通知的场景，
  请用 web profile 的 dsh-sysnotify（其宿主独立于浏览器存活）。
- **通知归组为 Windows PowerShell**（非 DSH 应用）——桌面端未设置 AUMID
  所致；哪天桌面端补上 `app.setAppUserModelId`，切 `delivery: renderer`
  即可回到应用身份。
- **其他工作区的会话**：`openSession` 仅作用于当前工作区——点击后不跳转
  （通知仍正常弹出）。与 sysnotify 同限。
- **误装入浏览器 profile**：client.js 桌面守卫使插件全程 no-op（控制台有
  「非桌面环境」横幅）；宿主半边气泡照弹但点击无法跳转（PS 找不到桌面窗口
  时静默）。
- 通知正文超长由 Windows 截断（宿主已截 400 字符）。

## 操作规程

- 停用/卸载走 profile 的 bundle 注册（见上），不要手工编辑共享
  `cordis.patch.yml`。
- 编辑本目录 `index.js` / `toast-notify.ps1` 后需重启桌面端（或经「重启应用
  与 Host」）；编辑 `client.js` 随 HMR 约 1 秒热生效，出问题改回即可。
- `selftest.mjs` 全绿后再安装升级（在本仓库目录内运行 `node selftest.mjs`）。

## 许可证与声明

MIT，见 [LICENSE](./LICENSE)。

- 本插件为社区作品，与 DeepSeek / 深度求索不存在隶属、合作或官方背书关系；
  「DeepSeek Harness」为深度求索的商标，此处仅作兼容性引用，插件名使用
  官方推荐的 DSH 缩写。
- 本插件仅经本 GitHub 仓库分发；npm 上的同名第三方包 `dsh-desktop-notify`
  （不同实现，跨平台 toast）与本仓库及其作者无关联。
