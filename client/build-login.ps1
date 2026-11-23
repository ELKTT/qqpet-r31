param([string]$OutputDirectory = (Join-Path $PSScriptRoot 'build'))
$ErrorActionPreference = 'Stop'
$sourceDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) 'tools/local-login'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
    throw 'Install the .NET Framework 4.x x86 compiler on Windows.'
}
$sources = @(
    'LocalLoginLauncher.cs', 'RemoteLoginTransport.cs', 'LocalLoginPanel.cs',
    'FlashHost.cs', 'LauncherPreferences.cs', 'CompleteLaunchConfiguration.cs',
    'LayeredLoginSkin.cs'
) | ForEach-Object { Join-Path $sourceDirectory $_ }
$references = @(
    '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll',
    '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll',
    '/r:Microsoft.CSharp.dll', '/r:System.Security.dll'
)
$buildDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $buildDirectory) { throw "Choose a new output directory: $buildDirectory" }
$helperDirectory = [IO.Directory]::CreateDirectory((Join-Path $buildDirectory 'QQPetAgent')).FullName
$helper = Join-Path $helperDirectory 'QQPetAgent.exe'
$activation = Join-Path $PSScriptRoot 'login-activation.manifest'
& $compiler /nologo /target:winexe /platform:x86 /optimize+ /warnaserror+ /utf8output @references ("/win32manifest:" + $activation) ("/out:" + $helper) @sources
if ($LASTEXITCODE -ne 0) { throw 'Login helper compilation failed.' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'QQPet.Flash9d.manifest') -Destination $helperDirectory
$entry = Join-Path $buildDirectory ('QQ' + [char]0x5ba0 + [char]0x7269 + '.exe')
$entrySource = Join-Path (Split-Path -Parent $sourceDirectory) 'feedback-release-20261016/DirectEntry.cs'
$config = Join-Path $sourceDirectory 'CompleteLaunchConfiguration.cs'
& $compiler /nologo /target:winexe /platform:x86 /optimize+ /warnaserror+ /utf8output @references /main:QQPet.LocalLogin.DirectEntry ("/out:" + $entry) $entrySource $config
if ($LASTEXITCODE -ne 0) { throw 'Login entry compilation failed.' }
Write-Output $entry
Write-Output $helper
