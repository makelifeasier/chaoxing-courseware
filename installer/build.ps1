param([string]$OutputPath = (Join-Path $PSScriptRoot 'ChaoxingCoursewareSetup.exe'))

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$repo = Split-Path $PSScriptRoot -Parent
$tempZip = Join-Path ([IO.Path]::GetTempPath()) ("courseware-" + [Guid]::NewGuid().ToString('N') + ".zip")
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (!(Test-Path -LiteralPath $compiler)) { throw '找不到 Windows 自带的 .NET Framework 编译器。' }

try {
    $wpf = Join-Path (Split-Path $compiler -Parent) 'WPF'
    [IO.Compression.ZipFile]::CreateFromDirectory(
        (Join-Path $repo 'extension'), $tempZip, [IO.Compression.CompressionLevel]::Optimal, $true
    )
    $compileArgs = @(
        '/nologo', '/target:winexe', '/optimize+', '/codepage:65001',
        '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll',
        '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll',
        "/reference:$wpf\UIAutomationClient.dll", "/reference:$wpf\UIAutomationTypes.dll",
        "/resource:$tempZip,extension.zip", "/out:$OutputPath",
        (Join-Path $PSScriptRoot 'Program.cs'), (Join-Path $PSScriptRoot 'BrowserGuide.cs'),
        (Join-Path $PSScriptRoot 'ExtensionFiles.cs')
    )
    & $compiler @compileArgs
    if ($LASTEXITCODE -ne 0) { throw "编译失败，退出码 $LASTEXITCODE" }
} finally {
    if (Test-Path -LiteralPath $tempZip) { Remove-Item -LiteralPath $tempZip }
}
