# toast-host.ps1 v1.3.0 — 常驻气泡进程（warm host）
# 宿主 index.js 启动本进程后常驻：预热 WinForms/P-Invoke（编译一次），
# 以 150ms UI 线程定时器轮询 toast-spool.jsonl 增量，新记录即弹
# NotifyIcon 气泡——免掉每条通知冷启 PowerShell 的 400–1500ms。
# 用法（明文 -File 纪律，同 toast-notify.ps1；⚠️ 不用 -WindowStyle
# Hidden + -EncodedCommand——火绒「隐藏执行 PowerShell」规则误杀）：
#   pwsh|powershell -NoProfile -ExecutionPolicy Bypass -File toast-host.ps1 `
#     -Spool <toast-spool.jsonl 绝对路径> -ParentPid <宿主pid> [-ClickUrl <url>]
#
# ⚠️ 本文件必须保持 UTF-8 with BOM（同 toast-notify.ps1：无 BOM 被
# PS 5.1 按 GBK 误读、param 崩、退出码 1 静默失败）。selftest 有断言。
#
# 生命周期：Windows 子进程不随父进程终止——每 ~6s 自查 -ParentPid，
# 宿主消失即退出；宿主重启后由插件重新拉起（并重建 spool 基线）。
# spool 基线：启动时只记录现有最大 id 不回放（历史通知不补弹）；宿主
# 裁剪（重写变短）时同样只重置基线不重弹。
# 点击行为与 toast-notify.ps1 相同：Send-ClickSignal（HTTP 先行）→
# 聚焦桌面窗口 → 销毁图标；进程不退出（常驻）。12s 未点击的图标由
# 主定时器清扫销毁。
param(
	[Parameter(Mandatory = $true)][string]$Spool,
	[int]$ParentPid = 0,
	[string]$ClickUrl = ''
)
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
	param([string]$Url, [string]$Origin, [string]$SessionId, [string]$Token)
	try {
		$req = [System.Net.HttpWebRequest]::Create($Url)
		$req.Method = 'POST'
		$req.Timeout = 1000
		$req.ReadWriteTimeout = 1000
		$req.Proxy = $null
		$req.ContentType = 'application/json'
		$req.Headers.Add('Origin', $Origin)
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
	# 与 toast-notify.ps1 同款，但睡眠已削减（常驻进程里编译成本为零，
	# 150ms/100ms 的等待是为冷启进程观察窗口动画留的余量，实测可省）：
	# 恢复/显示 → 40ms → SetForegroundWindow，前台锁未放行时 Alt 重试。
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
	Start-Sleep -Milliseconds 40
	[Native.Win32]::SetForegroundWindow($h) | Out-Null
	if ([Native.Win32]::GetForegroundWindow() -ne $h) {
		[System.Windows.Forms.SendKeys]::SendWait('%')
		[Native.Win32]::SetForegroundWindow($h) | Out-Null
	}
}

# ── 状态 ────────────────────────────────────────────────────────────────
# 基线机制：baseline=$false 时只扫描现有记录的最大 id 不回放（历史通知不
# 补弹）；spool 变短（宿主重启截断 / 超 200 行裁剪重写）→ 重建基线，避免
# 旧 id 遮蔽新记录（宿主重启后 spoolSeq 归零、新记录 id 从 1 重新开始）。
$script:baseline = $false
$script:lastId = [long]0
$script:lastLen = [long]-1
$script:tick = 0
$script:live = New-Object System.Collections.ArrayList  # @{ n=图标; born=时刻; closed }

function Show-Toast([string]$Title, [string]$Body, [string]$Sid, [string]$Token) {
	$Body = $Body.Replace([string][char]0x2028, [string][char]0x0A)
	$owner = @{ n = $null; born = [DateTime]::UtcNow; closed = $false }
	$n = New-Object System.Windows.Forms.NotifyIcon
	$owner.n = $n
	$n.Icon = [System.Drawing.SystemIcons]::Information
	$n.Visible = $true
	$n.BalloonTipTitle = $Title
	$n.BalloonTipText = $Body
	$n.BalloonTipIcon = 'Info'
	$n.Add_BalloonTipClicked({
		$origin = ''
		if ($ClickUrl -ne '') {
			$origin = ([uri]$ClickUrl).GetLeftPart([System.UriPartial]::Authority)
			[void](Send-ClickSignal -Url $ClickUrl -Origin $origin -SessionId $Sid -Token $Token)
		}
		Focus-DesktopApp
		$owner.closed = $true
	}.GetNewClosure())
	$n.Add_BalloonTipClosed({ $owner.closed = $true }.GetNewClosure())
	[void]$script:live.Add($owner)
	$n.ShowBalloonTip(10000)
}

# ── 主循环：UI 线程定时器（消息泵内，无跨线程 Marshal 风险）────────────
$form = New-Object System.Windows.Forms.Form
$form.ShowInTaskbar = $false
$form.WindowState = 'Minimized'
$form.Opacity = 0
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 150
$timer.Add_Tick({
	$script:tick++
	try {
		if ((Test-Path $Spool) -and ((Get-Item $Spool).Length -gt 0)) {
			$len = (Get-Item $Spool).Length
			if ($len -lt $script:lastLen) { $script:baseline = $false }  # 变短 → 重建基线
			$script:lastLen = $len
			foreach ($line in [System.IO.File]::ReadAllLines($Spool)) {
				if ([string]::IsNullOrWhiteSpace($line)) { continue }
				try { $rec = $line | ConvertFrom-Json } catch { continue }
				$id = [long]0
				if (-not [long]::TryParse([string]$rec.id, [ref]$id)) { continue }
				if (-not $script:baseline) {
					if ($id -gt $script:lastId) { $script:lastId = $id }  # 基线扫描：只记最大 id
					continue
				}
				if ($id -le $script:lastId) { continue }
				$script:lastId = $id
				Show-Toast ([string]$rec.title) ([string]$rec.body) ([string]$rec.sid) ([string]$rec.token)
			}
			$script:baseline = $true
		} elseif ((Test-Path $Spool) -and ((Get-Item $Spool).Length -eq 0)) {
			if ($script:lastLen -gt 0) { $script:baseline = $false; $script:lastId = [long]0 }
			$script:lastLen = 0
		}
	} catch { }
	# 宿主存活自查（每 ~6s）：Windows 子进程不随父进程死，必须自己退场。
	if (($script:tick % 40) -eq 0 -and $ParentPid -gt 0) {
		if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { $form.Close() }
	}
	# 清扫：已点击/已关闭 或 超过 12s 的图标。
	for ($i = $script:live.Count - 1; $i -ge 0; $i--) {
		$o = $script:live[$i]
		$age = ([DateTime]::UtcNow - $o.born).TotalMilliseconds
		if ($o.closed -or $age -gt 12000) {
			try { $o.n.Visible = $false; $o.n.Dispose() } catch { }
			$script:live.RemoveAt($i)
		}
	}
})
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
$timer.Stop()
$timer.Dispose()
foreach ($o in @($script:live)) { try { $o.n.Dispose() } catch { } }
exit 0
