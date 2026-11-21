param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoPath 'dist\windows\Orchestrator' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
Set-Location -LiteralPath $repoPath
$sdkVersion = '1.0.4022.49'
$sdkRoot = Join-Path $repoPath '.cache\webview2\sdk'
if (-not (Test-Path -LiteralPath "$sdkRoot\lib\net462\Microsoft.Web.WebView2.Core.dll")) {
    New-Item -ItemType Directory -Force (Split-Path -Parent $sdkRoot) | Out-Null
    $archive = Join-Path (Split-Path -Parent $sdkRoot) 'sdk.zip'
    & curl.exe --fail --location --silent --show-error --max-time 120 --output $archive "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sdkVersion/microsoft.web.webview2.$sdkVersion.nupkg"
    if ($LASTEXITCODE -ne 0) { throw 'WebView2 SDK download failed' }
    Expand-Archive -LiteralPath $archive -DestinationPath $sdkRoot -Force
}
foreach ($name in @('Core','WinForms')) {
    $signature = Get-AuthenticodeSignature "$sdkRoot\lib\net462\Microsoft.Web.WebView2.$name.dll"
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw 'WebView2 Microsoft signature validation failed' }
}
& node scripts/bundle-desktop.mjs $OutputDirectory
if ($LASTEXITCODE -ne 0) { throw 'Runtime bundling failed' }
Copy-Item -LiteralPath "$sdkRoot\lib\net462\Microsoft.Web.WebView2.Core.dll","$sdkRoot\lib\net462\Microsoft.Web.WebView2.WinForms.dll","$sdkRoot\runtimes\win-x64\native\WebView2Loader.dll" -Destination $OutputDirectory -Force
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object Drawing.Bitmap 64,64
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = 'AntiAlias'; $graphics.Clear([Drawing.Color]::FromArgb(28,28,28))
$pen = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(230,230,230)),5
$graphics.DrawEllipse($pen,13,13,38,38);$graphics.FillEllipse([Drawing.Brushes]::CornflowerBlue,42,42,10,10)
$icon = [Drawing.Icon]::FromHandle($bitmap.GetHicon())
$iconPath = Join-Path $OutputDirectory 'Orchestrator.ico'
$stream = [IO.File]::Create($iconPath);$icon.Save($stream);$stream.Close();$graphics.Dispose();$bitmap.Dispose()
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$OutputDirectory\Orchestrator.exe" "/win32icon:$iconPath" "/win32manifest:$repoPath\src\desktop\app.manifest" /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll "/reference:$OutputDirectory\Microsoft.Web.WebView2.Core.dll" "/reference:$OutputDirectory\Microsoft.Web.WebView2.WinForms.dll" "$repoPath\src\desktop\Orchestrator.cs"
if ($LASTEXITCODE -ne 0) { throw 'Windows executable compilation failed' }
$bootstrapper = Join-Path $OutputDirectory 'MicrosoftEdgeWebview2Setup.exe'
if (-not (Test-Path -LiteralPath $bootstrapper)) {
    & curl.exe --fail --location --silent --show-error --max-time 90 --output $bootstrapper 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'
    if ($LASTEXITCODE -ne 0) { throw 'WebView2 bootstrapper download failed' }
}
$signature = Get-AuthenticodeSignature -LiteralPath $bootstrapper
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw 'WebView2 bootstrapper signature validation failed' }
Write-Output "Built $OutputDirectory\Orchestrator.exe"
