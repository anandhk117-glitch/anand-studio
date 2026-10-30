# Turns auto-start on or off.
#   powershell -ExecutionPolicy Bypass -File tools\autostart.ps1          (turn on)
#   powershell -ExecutionPolicy Bypass -File tools\autostart.ps1 -Off     (turn off)
# It adds one small file to your Startup folder. Nothing else on Windows is changed.
param([switch]$Off)
$root = Split-Path -Parent $PSScriptRoot
$startup = [Environment]::GetFolderPath('Startup')
$vbs = Join-Path $startup 'Anand Studio.vbs'
if ($Off) {
  Remove-Item $vbs -ErrorAction SilentlyContinue
  Write-Host "Auto-start is OFF. (The Studio keeps running until you restart the PC.)"
  exit 0
}
$node = (Get-Command node -ErrorAction Stop).Source
$sup = Join-Path $root 'tools\supervisor.js'
$content = @"
' Starts Anand's YouTube Studio + FreeLLMAPI quietly at login. Delete this file to stop auto-start.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$root"
sh.Run """$node"" ""$sup""", 0, False
"@
Set-Content -Path $vbs -Value $content -Encoding ASCII
Write-Host "Auto-start is ON: $vbs"
