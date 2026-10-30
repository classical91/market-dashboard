$ErrorActionPreference = 'Stop'
$payloadText = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($payloadText)) { throw 'Delivery payload was empty' }
$payload = $payloadText | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace([string]$payload.message) -or [string]$payload.handoffId -notmatch '^fch_[a-zA-Z0-9_-]+$') {
  throw 'Delivery requires a valid handoff ID and message'
}
$messageFile = Join-Path ([IO.Path]::GetTempPath()) ('farmclaw-delivery-' + [guid]::NewGuid() + '.txt')
try {
  [IO.File]::WriteAllText($messageFile, [string]$payload.message, [Text.UTF8Encoding]::new($false))
  # Separate stable handoff sessions avoid contending with a Telegram chat's
  # long-running session or inheriting its obsolete direct-queue instructions.
  $arguments = @('agent', '--agent', 'commentfarm', '--session-key', ('agent:commentfarm:handoff:' + $payload.handoffId),
    '--message-file', $messageFile, '--timeout', '600', '--json')
  if (-not $payload.test -and -not ([string]$payload.handoffId).StartsWith('fch_test_')) {
    $arguments += @('--deliver', '--reply-channel', 'telegram', '--reply-account', 'commentfarm', '--reply-to', '5752282291')
  }
  $ErrorActionPreference = 'Continue'
  $raw = @(& 'C:\Users\JAson\AppData\Roaming\npm\openclaw.cmd' @arguments 2>&1)
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($exitCode -ne 0) { throw ('OpenClaw delivery failed with exit ' + $exitCode + '; inspect the gateway logs before retrying') }
  $result = (($raw | ForEach-Object { [string]$_ }) -join "`n") | ConvertFrom-Json
  if ($result.status -and $result.status -ne 'ok') { throw 'OpenClaw did not confirm an ok agent result' }
  $deliveryId = @($result.runId, $result.result.runId, $result.meta.runId, $result.deliveryId, $result.result.deliveryId) |
    Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Select-Object -First 1
  if (-not $deliveryId) { throw 'OpenClaw completed without a confirmed run ID' }
  [pscustomobject]@{ deliveryId = [string]$deliveryId } | ConvertTo-Json -Compress
} finally {
  if (Test-Path -LiteralPath $messageFile) { Remove-Item -LiteralPath $messageFile -Force }
}
