# toast-notify.ps1 v1.1.0 — 弹一条 Windows 系统通知；点击气泡跳回 DSH 桌面端对应会话
# 用法（宿主 index.js 明文 -File 调用；⚠️ 绝不改用 -WindowStyle Hidden +
# -EncodedCommand 隐藏执行——火绒等安全软件的「隐藏执行 PowerShell」规则会
# 误杀，dsh-sysnotify v1.1.0 实测）：
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File toast-notify.ps1 `
#     -Title "标题" -Body "正文" -SessionId <sid> -ClickToken <uuid> -ClickUrl <url>
#
# ⚠️ 本文件必须保持 UTF-8 with BOM：无 BOM 的 UTF-8 会被 Windows PowerShell
# 5.1 按 ANSI/GBK 误读，中文注释乱码破坏 param() 解析，脚本以退出码 1 静默
# 失败（dsh-sysnotify v1.1.1 实测）。selftest 有 BOM 断言防回归。
#
# 正文换行经 U+2028（行分隔符）载体传递——命令行参数不能直接携带换行符，
# 宿主侧把 '\n' 替换为 U+2028 后传入，这里还原。
#
# 退出码：
#   0 = 气泡被点击过（宿主把该 toast 关联的会话按 child→{sid,token} 记账
#       入队，页面长轮询 openSession 完成跳转——HTTP 信号已投递过时按
#       token 去重不重复入队）
#   3 = 未点击（超时 / 用户关闭 / 气泡自动消失）——正常路径，宿主静默
#   其他 = 真实失败（宿主写 desktop-notify.log 告警）
#
# 点击行为（与 dsh-sysnotify 的浏览器版差异：无 UIA 页签匹配、无标题集、
# 无开新页兜底——桌面端只有一个 Electron 主窗口，按进程名定位即可）：
#   ① Send-ClickSignal：POST {sessionId, token} 到 -ClickUrl（HttpWebRequest +
#      Proxy=$null 绕开系统代理 + 1s 超时封顶，失败静默——退出码通道兜底）。
#      宿主入队 type:'click' 事件并唤醒页面长轮询 → client.js
#      uiWorkspace.openSession(sessionId)（与侧栏点击会话行同路径）。
#      信号先行：桌面端聚焦按进程名匹配、不依赖页面标题，不存在
#      sysnotify v1.8.2 的「页签名翻转竞态」——切换发生在窗口升起的过程中。
#   ② 聚焦 DSH 桌面窗口：EnumWindows 匹配进程名 "DeepSeek Harness"
#      （不限可见——窗口关闭到托盘时 IsWindowVisible=false，必须全量枚举）；
#      最小化 → SW_RESTORE；托盘隐藏 → SW_SHOW；再 SetForegroundWindow
#      （前台锁未放行时 Alt 键解除后重试，sysnotify 同款）。
#      应用窗口不存在（已完全退出）→ 什么都不做（宿主与窗口同生共死，
#      能收到本通知说明宿主活着，窗口只是隐藏或最小化）。
# 另：NotifyIcon 事件需要消息泵，用隐藏窗体 + Application::Run 代替
# Start-Sleep；12 秒兜底退出（进程存活期内点击均有效）。
param(
	[Parameter(Mandatory = $true)][string]$Title,
	[Parameter(Mandatory = $true)][string]$Body,
	[string]$SessionId = '',
	[string]$ClickToken = '',
	[string]$ClickUrl = ''
)
$Body = $Body.Replace([string][char]0x2028, [string][char]0x0A)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Namespace Native -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
'@

function Send-ClickSignal {
	# HTTP 先行通道：点击瞬间立刻通知宿主（本地回环 ~30-80ms），页面在窗口
	# 升起过程中就完成会话切换。HttpWebRequest 显式 Proxy=$null（Invoke-
	# RestMethod 可能吃系统代理/PAC 拖慢）、Timeout=1000ms 封顶；任何失败都
	# 静默——退出码通道（exit 0）兜底，正确性不受影响。Origin 头满足宿主
	# 「Origin 缺席放行 / 存在须匹配 Host」守卫（与 ClickUrl 同源）。
	param([string]$Url, [string]$Origin, [string]$SessionId, [string]$Token)
	try {
		$req = [System.Net.HttpWebRequest]::Create($Url)
		$req.Method = 'POST'
		$req.Timeout = 1000
		$req.ReadWriteTimeout = 1000
		$req.Proxy = $null
		$req.ContentType = 'application/json'
		$req.Headers.Add('Origin', $Origin)
		# sessionId/token 均为 [a-z0-9-] 安全字符，直接拼接无需转义。
		$bytes = [System.Text.Encoding]::UTF8.GetBytes(
			'{"sessionId":"' + $SessionId + '","token":"' + $Token + '"}')
		$req.ContentLength = $bytes.Length
		$s = $req.GetRequestStream()
		$s.Write($bytes, 0, $bytes.Length)
		$s.Close()
		$resp = $req.GetResponse()
		$null = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
		$resp.Close()
		return $true
	} catch { return $false }
}

function Get-DesktopWindows {
	# EnumWindows 收集 DSH 桌面端（进程 "DeepSeek Harness"）的全部带标题顶层
	# 窗口句柄。不做可见性过滤——窗口关闭到托盘时 IsWindowVisible=false，
	# 过滤会永远找不到它。带空标题的窗口（Chrome 辅助窗口）跳过。
	$wins = New-Object System.Collections.ArrayList
	$cb = {
		param($h, $lp)
		$wpid = [uint32]0
		[Native.Win32]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
		if ($wpid -ne 0) {
			$p = Get-Process -Id $wpid -ErrorAction SilentlyContinue
			if ($p -and $p.ProcessName -eq 'DeepSeek Harness') {
				$t = New-Object System.Text.StringBuilder 256
				[Native.Win32]::GetWindowText($h, $t, 256) | Out-Null
				if ($t.ToString().Trim() -ne '') { [void]$wins.Add($h) }
			}
		}
		return $true
	}
	[Native.Win32]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
	return ,$wins
}

function Focus-DesktopApp {
	# 聚焦 DSH 桌面主窗口：优先可见窗口（多窗口时取第一个），无可见窗口
	# 取第一个（托盘隐藏态）。最小化 → SW_RESTORE(9)；不可见 → SW_SHOW(5)；
	# 再 SetForegroundWindow，前台锁未放行时模拟一次 Alt 键解除后重试
	# （sysnotify 同款技巧）。找不到窗口 → 静默返回（应用已退出）。
	$wins = Get-DesktopWindows
	if ($wins.Count -eq 0) { return }
	$h = [IntPtr]::Zero
	foreach ($w in $wins) {
		if ([Native.Win32]::IsWindowVisible($w)) { $h = $w; break }
	}
	if ($h -eq [IntPtr]::Zero) { $h = $wins[0] }
	if ([Native.Win32]::IsIconic($h)) {
		[Native.Win32]::ShowWindowAsync($h, 9) | Out-Null  # 9 = SW_RESTORE
	} elseif (-not [Native.Win32]::IsWindowVisible($h)) {
		[Native.Win32]::ShowWindowAsync($h, 5) | Out-Null  # 5 = SW_SHOW（托盘隐藏）
	}
	Start-Sleep -Milliseconds 150
	[Native.Win32]::SetForegroundWindow($h) | Out-Null
	Start-Sleep -Milliseconds 100
	if ([Native.Win32]::GetForegroundWindow() -ne $h) {
		[System.Windows.Forms.SendKeys]::SendWait('%')
		[Native.Win32]::SetForegroundWindow($h) | Out-Null
	}
}

# 点击标记：hashtable 引用被 GetNewClosure 捕获后仍可变（sysnotify 同款）。
# 点击处理器先发信号再聚焦：信号让页面 openSession（毫秒级），聚焦把窗口
# 升到前台——切换发生在窗口升起的过程中，用户看到的就是已切好的会话。
$state = @{ clicked = $false }
$form = New-Object System.Windows.Forms.Form
$form.ShowInTaskbar = $false
$form.WindowState = 'Minimized'
$form.Opacity = 0
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.Visible = $true
$n.BalloonTipTitle = $Title
$n.BalloonTipText = $Body
$n.BalloonTipIcon = 'Info'
$n.Add_BalloonTipClicked({
	$state.clicked = $true
	$origin = ''
	if ($ClickUrl -ne '') {
		$origin = ([uri]$ClickUrl).GetLeftPart([System.UriPartial]::Authority)
		[void](Send-ClickSignal -Url $ClickUrl -Origin $origin -SessionId $SessionId -Token $ClickToken)
	}
	Focus-DesktopApp
	$form.Close()
}.GetNewClosure())
$n.Add_BalloonTipClosed({ $form.Close() }.GetNewClosure())
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 12000
$timer.Add_Tick({ $form.Close() }.GetNewClosure())
$timer.Start()
$n.ShowBalloonTip(10000)
[System.Windows.Forms.Application]::Run($form)
$timer.Stop()
$timer.Dispose()
$n.Dispose()
if ($state.clicked) { exit 0 } else { exit 3 }
