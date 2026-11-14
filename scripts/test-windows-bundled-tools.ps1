param([string]$InstallDir = '')
$ErrorActionPreference = 'Stop'
if (-not $InstallDir) {
  foreach ($candidate in @((Join-Path $env:LOCALAPPDATA 'Termlume'), (Join-Path $env:ProgramFiles 'Termlume'))) {
    if (Test-Path (Join-Path $candidate 'tools\windows\manifest.json')) { $InstallDir = $candidate; break }
  }
}
if (-not $InstallDir) { throw 'Cannot find Termlume. Pass -InstallDir with the app installation directory.' }
$runtime = Join-Path $InstallDir 'tools\windows'
$git = Join-Path $runtime 'git\cmd\git.exe'
$ssh = Join-Path $runtime 'openssh\ssh.exe'
foreach ($file in @($git, $ssh, (Join-Path $runtime 'git\usr\bin\sh.exe'))) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing bundled tool: $file" }
}
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('termlume-tool-check-' + [guid]::NewGuid())
[IO.Directory]::CreateDirectory($temporary) | Out-Null
$emptyConfig = Join-Path $temporary 'empty-config'
[IO.File]::WriteAllText($emptyConfig, '')
$toolPath = @('openssh', 'git\cmd', 'git\ucrt64\bin', 'git\usr\bin') | ForEach-Object { Join-Path $runtime $_ }
$minimalPath = (@($toolPath) + (Join-Path $env:SystemRoot 'System32')) -join ';'
# Git for Windows interprets GIT_SSH_COMMAND with its bundled POSIX shell.
$shellSsh = "'" + $ssh.Replace('\','/').Replace("'", "'`"'`"'") + "' -V"

function Invoke-BundledTool([string]$File, [string]$Arguments, [string]$InputText = '', [bool]$AllowFailure = $false) {
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $File
  $start.Arguments = $Arguments
  $start.WorkingDirectory = $temporary
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($name in @($start.EnvironmentVariables.Keys)) {
    if ($name.StartsWith('GIT_')) { $start.EnvironmentVariables.Remove($name) }
  }
  $start.EnvironmentVariables['PATH'] = $minimalPath
  $start.EnvironmentVariables['GIT_EXEC_PATH'] = Join-Path $runtime 'git\ucrt64\libexec\git-core'
  $start.EnvironmentVariables['GIT_CONFIG_GLOBAL'] = $emptyConfig
  $start.EnvironmentVariables['GIT_CONFIG_NOSYSTEM'] = '1'
  $start.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
  $start.EnvironmentVariables['GIT_SSH_VARIANT'] = 'ssh'
  $start.EnvironmentVariables['GIT_SSH_COMMAND'] = $shellSsh
  $start.EnvironmentVariables['GIT_AUTHOR_NAME'] = 'Termlume check'
  $start.EnvironmentVariables['GIT_COMMITTER_NAME'] = 'Termlume check'
  $start.EnvironmentVariables['GIT_AUTHOR_EMAIL'] = 'check@termlume.invalid'
  $start.EnvironmentVariables['GIT_COMMITTER_EMAIL'] = 'check@termlume.invalid'
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $start
  try {
    if (-not $process.Start()) { throw "Could not start $File" }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.Write($InputText)
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'Bundled tool timed out' }
    $result = [pscustomobject]@{ ExitCode = $process.ExitCode; Out = $stdout.Result; Err = $stderr.Result }
    if (-not $AllowFailure -and $result.ExitCode -ne 0) { throw $result.Err }
    return $result
  } finally { $process.Dispose() }
}

try {
  $gitVersion = (Invoke-BundledTool $git '--version').Out.Trim()
  $sshVersion = (Invoke-BundledTool $ssh '-V').Err.Trim()
  Invoke-BundledTool $git 'init --bare --quiet --template=' | Out-Null
  $contents = "bundled tools round trip`n"
  $blob = (Invoke-BundledTool $git 'hash-object -w --stdin' $contents).Out.Trim()
  $tree = (Invoke-BundledTool $git 'mktree' "100644 blob $blob`tfixture.txt`n").Out.Trim()
  $commit = (Invoke-BundledTool $git "commit-tree $tree" "fixture commit`n").Out.Trim()
  Invoke-BundledTool $git "update-ref refs/heads/tools-check $commit" | Out-Null
  if ((Invoke-BundledTool $git 'show refs/heads/tools-check:fixture.txt').Out -ne $contents) { throw 'Git object round trip failed' }
  # -V exits before connecting: no network or user SSH key is accessed.
  $dispatch = Invoke-BundledTool $git 'ls-remote ssh://fixture.invalid/unused' '' $true
  if ($dispatch.Err -notmatch 'OpenSSH_') { throw "Git did not invoke bundled SSH: $($dispatch.Err)" }
  [pscustomobject]@{
    Git = $gitVersion; OpenSSH = $sshVersion; GitObjectRoundTrip = 'passed'; GitInvokesBundledSsh = 'passed'
    SystemGitOrSshOnPath = $false; InstallDir = $InstallDir
  } | ConvertTo-Json
} finally { Remove-Item -LiteralPath $temporary -Recurse -Force }
