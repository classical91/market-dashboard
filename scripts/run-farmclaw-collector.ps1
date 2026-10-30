param(
  [ValidateSet('doctor', 'run', 'tasks')][string]$Mode = 'doctor',
  [string]$KeyFile = (Join-Path $env:LOCALAPPDATA 'OpenClaw\Secrets\farmclaw-collector-key.xml'),
  [string]$DashboardUrl = 'https://market-dashboard-production-b2f4.up.railway.app',
  [string]$LogFile = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$key = Import-Clixml -LiteralPath $KeyFile
if ($key -isnot [System.Security.SecureString]) { throw 'Collector requires a user-protected SecureString credential file' }
$pointer = [IntPtr]::Zero
$names = @('BROADCAST_LEDGER_API_KEY', 'FARMCLAW_DASHBOARD_URL', 'FARMCLAW_DELIVER_CMD', 'FARMCLAW_DELIVER_TIMEOUT_MS', 'FARMCLAW_OPENCLAW_HOOKS_URL', 'FARMCLAW_OPENCLAW_HOOK_TOKEN')
$previous = @{}
foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($key)
  $env:BROADCAST_LEDGER_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $env:FARMCLAW_DASHBOARD_URL = $DashboardUrl
  $deliveryScript = Join-Path $repo 'scripts\farmclaw-session-deliver.ps1'
  $env:FARMCLAW_DELIVER_CMD = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $deliveryScript + '"'
  $env:FARMCLAW_DELIVER_TIMEOUT_MS = '720000'
  [Environment]::SetEnvironmentVariable('FARMCLAW_OPENCLAW_HOOKS_URL', $null, 'Process')
  [Environment]::SetEnvironmentVariable('FARMCLAW_OPENCLAW_HOOK_TOKEN', $null, 'Process')
  Push-Location -LiteralPath $repo
  try {
    $ErrorActionPreference = 'Continue'
    $output = @(& node scripts\farmclaw-collector.js $Mode --limit 1 2>&1)
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
  } finally { Pop-Location }
  $safeOutput = ($output | ForEach-Object { ([string]$_).Replace($env:BROADCAST_LEDGER_API_KEY, '[redacted]') }) -join "`n"
  if ($LogFile) {
    if ((Test-Path -LiteralPath $LogFile) -and (Get-Item -LiteralPath $LogFile).Length -gt 2MB) {
      Copy-Item -LiteralPath $LogFile -Destination ($LogFile + '.previous') -Force
      Set-Content -LiteralPath $LogFile -Value ''
    }
    Add-Content -LiteralPath $LogFile -Value ("[{0}] mode={1} exit={2}`n{3}" -f [DateTime]::UtcNow.ToString('o'), $Mode, $exitCode, $safeOutput)
  }
  Write-Output $safeOutput
} finally {
  foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
  if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  $key.Dispose()
}
exit $exitCode
