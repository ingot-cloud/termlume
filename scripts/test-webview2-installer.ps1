# Exercise the real NSIS hook using stub installers and a private test registry key.
# No Microsoft runtime or Microsoft registry key is changed.
param([string]$Makensis = '')
$ErrorActionPreference = 'Stop'
if (-not $Makensis) {
  $cached = Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'
  if (Test-Path $cached) { $Makensis = $cached }
  else { $Makensis = (Get-Command makensis.exe -ErrorAction Stop).Source }
}
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('termlume-webview2 smoke-' + [guid]::NewGuid())
[IO.Directory]::CreateDirectory($temporary) | Out-Null
$keyRoot = 'Software\TermlumeInstallerTests\' + [guid]::NewGuid().ToString('N')
$registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry32)
$core = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\src-tauri\windows\webview2.nsh'))
function NsisString([string]$Text) {
  if ($Text -match '[\r\n\x00"]|\$\{') { throw 'Invalid NSIS test path' }
  return $Text
}
function Compile([string]$Name, [string]$Source) {
  $script = Join-Path $temporary ($Name + '.nsi')
  [IO.File]::WriteAllText($script, $Source, (New-Object Text.UTF8Encoding($true)))
  & $Makensis /V2 $script
  if ($LASTEXITCODE -ne 0) { throw "NSIS compilation failed: $Name" }
}
try {
  foreach ($case in @(
    @{ Name='missing'; Initial=''; Code=0; Register=1; Success=$true; Called=$true },
    @{ Name='existing'; Initial='155.0.0.0'; Code=1603; Register=0; Success=$true; Called=$false },
    @{ Name='zero-version'; Initial='0.0.0.0'; Code=0; Register=1; Success=$true; Called=$true },
    @{ Name='failed'; Initial=''; Code=1603; Register=0; Success=$false; Called=$true },
    @{ Name='unregistered'; Initial=''; Code=0; Register=0; Success=$false; Called=$true },
    @{ Name='reboot'; Initial=''; Code=3010; Register=1; Success=$true; Called=$true }
  )) {
    $name = $case.Name
    $key = $keyRoot + '\' + $name
    if ($case.Initial) {
      $initial = $registry.CreateSubKey($key)
      $initial.SetValue('pv', $case.Initial)
      $initial.Dispose()
    }
    $stub = Join-Path $temporary ($name + '-runtime.exe')
    $probe = Join-Path $temporary ($name + '-probe.exe')
    $called = Join-Path $temporary ($name + '-called.txt')
    $installed = Join-Path $temporary ($name + '-installed.txt')
    $reboot = Join-Path $temporary ($name + '-reboot.txt')
    $stubSource = @'
Unicode true
Name "WebView2 test stub"
OutFile "@OUT@"
SilentInstall silent
RequestExecutionLevel user
Section
  FileOpen $0 "@CALLED@" w
  FileWrite $0 "called"
  FileClose $0
  !if @REGISTER@ == 1
    SetRegView 32
    WriteRegStr HKCU "@KEY@" "pv" "155.0.0.0"
  !endif
  SetErrorLevel @CODE@
SectionEnd
'@
    $stubSource = $stubSource.Replace('@OUT@',(NsisString $stub)).Replace('@CALLED@',(NsisString $called)).Replace('@REGISTER@',[string]$case.Register).Replace('@KEY@',$key).Replace('@CODE@',[string]$case.Code)
    Compile ($name + '-runtime') $stubSource
    $probeSource = @'
Unicode true
Name "Termlume WebView2 hook test"
OutFile "@OUT@"
SilentInstall silent
RequestExecutionLevel user
!include "@CORE@"
Section
  !insertmacro TermlumeEnsureWebView2 "@STUB@" "@KEY@"
  FileOpen $0 "@INSTALLED@" w
  FileWrite $0 "installed"
  FileClose $0
  IfRebootFlag reboot done
  reboot:
    FileOpen $0 "@REBOOT@" w
    FileWrite $0 "reboot required"
    FileClose $0
  done:
SectionEnd
'@
    $probeSource = $probeSource.Replace('@OUT@',(NsisString $probe)).Replace('@CORE@',(NsisString $core)).Replace('@STUB@',(NsisString $stub)).Replace('@KEY@',$key).Replace('@INSTALLED@',(NsisString $installed)).Replace('@REBOOT@',(NsisString $reboot))
    Compile ($name + '-probe') $probeSource
    $process = Start-Process -FilePath $probe -ArgumentList '/S' -Wait -PassThru
    try {
      if (($process.ExitCode -eq 0) -ne $case.Success) { throw "Unexpected exit code $($process.ExitCode): $name" }
      if ((Test-Path $installed) -ne $case.Success) { throw "App files were published incorrectly: $name" }
      if ((Test-Path $called) -ne $case.Called) { throw "Wrong runtime installation decision: $name" }
      if ((Test-Path $reboot) -ne ($name -eq 'reboot')) { throw "Wrong reboot state: $name" }
      Write-Output "PASS: WebView2 hook $name"
    } finally { $process.Dispose() }
  }
} finally {
  $registry.DeleteSubKeyTree($keyRoot, $false)
  $registry.Dispose()
  Remove-Item -LiteralPath $temporary -Recurse -Force
}
