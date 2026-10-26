# MestreScan PC - prepara tudo e abre.
# Na primeira vez baixa o Node portatil e o ADB (platform-tools) para a pasta runtime\.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $PSScriptRoot
$Runtime = Join-Path $Root 'runtime'
$NodeVersion = 'v22.12.0'
New-Item -ItemType Directory -Force $Runtime | Out-Null

function Get-Zip($url, $dest) {
    $zip = Join-Path $Runtime 'download.zip'
    Write-Host "  Baixando $url ..."
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $dest -Force
    Remove-Item $zip -Force
}

Write-Host ''
Write-Host '  MestreScan PC - Plugou o cabo, ele limpa.' -ForegroundColor Yellow
Write-Host ''

# ---------- Node ----------
# O Setup.exe extrai o Node em runtime\node-<versao>-win-x64 (versoes antigas: runtime\node).
$Node = Join-Path $Runtime "node-$NodeVersion-win-x64\node.exe"
if (-not (Test-Path $Node)) { $Node = Join-Path $Runtime 'node\node.exe' }
if (-not (Test-Path $Node)) {
    $sys = Get-Command node -ErrorAction SilentlyContinue
    $major = 0
    if ($sys) { try { $major = [int]((& $sys.Source -v).TrimStart('v').Split('.')[0]) } catch { $major = 0 } }
    if ($major -ge 18) {
        $Node = $sys.Source
    } else {
        Write-Host '  Primeira vez: baixando o Node.js portatil...'
        $name = "node-$NodeVersion-win-x64"
        Get-Zip "https://nodejs.org/dist/$NodeVersion/$name.zip" $Runtime
        $Node = Join-Path $Runtime "$name\node.exe"
    }
}

# ---------- ADB ----------
$adbPaths = @(
    (Join-Path $Runtime 'platform-tools\adb.exe'),
    $(if ($env:ANDROID_HOME) { Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe' }),
    (Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe')
) | Where-Object { $_ -and (Test-Path $_) }
$hasAdb = $adbPaths -or (Get-Command adb -ErrorAction SilentlyContinue)
if (-not $hasAdb) {
    Write-Host '  Primeira vez: baixando o ADB (Android platform-tools)...'
    Get-Zip 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip' $Runtime
}

Write-Host "  Node: $Node"
Write-Host ''
& $Node (Join-Path $Root 'src\server.js')
exit $LASTEXITCODE
