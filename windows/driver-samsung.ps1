# MestreScan PC - baixa e instala o driver USB da Samsung (para o Windows reconhecer celulares Samsung no ADB).
# Pega sempre a versao mais nova do site da Samsung; se nao achar o link, usa a v1.9.5.0.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Site = 'https://developer.samsung.com'
$Fallback = '/SDP/file/a2fcaf64-7aa3-49f7-b06f-9e646590d528'

Write-Host ''
Write-Host '  MestreScan PC - Driver USB Samsung' -ForegroundColor Yellow
Write-Host ''

$keys = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
$found = Get-ItemProperty $keys -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'SAMSUNG USB Driver*' } | Select-Object -First 1
if ($found) {
    Write-Host "  Ja instalado: $($found.DisplayName) $($found.DisplayVersion)" -ForegroundColor Green
    Start-Sleep -Seconds 3
    exit 0
}

try {
    $link = $Fallback
    try {
        $page = Invoke-WebRequest -Uri "$Site/android-usb-driver" -UseBasicParsing
        $m = [regex]::Match($page.Content, '/SDP/file/[0-9a-fA-F-]{36}')
        if ($m.Success) { $link = $m.Value }
    } catch { }

    $exe = Join-Path $env:TEMP 'SAMSUNG_USB_Driver_MestreScan.exe'
    Write-Host '  Baixando o driver da Samsung (cerca de 35 MB)...'
    Invoke-WebRequest -Uri "$Site$link" -OutFile $exe -UseBasicParsing

    $sig = Get-AuthenticodeSignature $exe
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Samsung') {
        throw "O arquivo baixado nao tem a assinatura digital da Samsung ($($sig.Status))."
    }

    Write-Host '  Abrindo o instalador da Samsung: clique em Sim e depois em Avancar/Next ate o fim.'
    Start-Process -FilePath $exe -Verb RunAs -Wait
    Remove-Item $exe -Force -ErrorAction SilentlyContinue
    Write-Host '  Pronto. Se o celular ja estava no cabo, desconecte e conecte de novo.' -ForegroundColor Green
    Start-Sleep -Seconds 4
} catch {
    Write-Host ''
    Write-Host "  Nao deu para instalar o driver: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Baixe manualmente em $Site/android-usb-driver"
    Write-Host ''
    Read-Host '  Enter para fechar'
    exit 1
}
