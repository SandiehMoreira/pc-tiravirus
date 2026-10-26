; MestreScan PC - instalador tradicional (Setup.exe) feito com Inno Setup 6.
; Gerar:  windows\gerar-setup.bat   (saida em build\MestreScan-PC-Setup.exe)
;
; Instala so para o usuario (sem pedir administrador), baixa o Node portatil e o ADB
; durante a instalacao, cria os atalhos e, se marcado, instala o driver USB da Samsung.

#define AppName "MestreScan PC"
#define AppVersion "0.3.0"
#define NodeVersion "v22.12.0"

[Setup]
AppId={{6E1C8F2A-4B7D-4C3E-9A51-3F2D8B7E5C10}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=MestreCell
AppPublisherURL=https://sandieh.online
AppSupportURL=https://wa.me/5541991663168
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
ArchiveExtraction=full
WizardStyle=modern
SetupIconFile=mestrescan.ico
UninstallDisplayIcon={app}\windows\mestrescan.ico
UninstallDisplayName={#AppName}
OutputDir=..\build
OutputBaseFilename=MestreScan-PC-Setup
Compression=lzma2
SolidCompression=yes

[Languages]
Name: "ptbr"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Messages]
ptbr.WelcomeLabel2=Este assistente vai instalar o [name/ver] no seu computador.%n%nPlugou o cabo, ele limpa: remove virus de propaganda de celulares Android pelo cabo USB.%n%nPrecisa de internet durante a instalacao (Node.js e ADB, cerca de 45 MB).

[Tasks]
Name: "desktopicon"; Description: "Criar atalho na Area de Trabalho"; GroupDescription: "Atalhos:"
Name: "samsung"; Description: "Instalar o driver USB da Samsung (recomendado: sem ele o Windows pode nao reconhecer celulares Samsung)"; GroupDescription: "Drivers:"

[Files]
Source: "..\Abrir MestreScan PC.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\rules.json"; DestDir: "{app}"; Flags: ignoreversion
; brand.json e a lista de casos sao da loja: nao sobrescrever numa atualizacao.
Source: "..\brand.json"; DestDir: "{app}"; Flags: onlyifdoesntexist
Source: "..\casos\.gitkeep"; DestDir: "{app}\casos"; Flags: onlyifdoesntexist
Source: "..\src\*"; DestDir: "{app}\src"; Flags: ignoreversion recursesubdirs
Source: "..\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs
Source: "instalar.ps1"; DestDir: "{app}\windows"; Flags: ignoreversion
Source: "driver-samsung.ps1"; DestDir: "{app}\windows"; Flags: ignoreversion
Source: "mestrescan.ico"; DestDir: "{app}\windows"; Flags: ignoreversion
; Baixados durante a instalacao e extraidos em runtime\
Source: "https://nodejs.org/dist/{#NodeVersion}/node-{#NodeVersion}-win-x64.zip"; DestName: "node.zip"; DestDir: "{app}\runtime"; \
  Hash: "2b8f2256382f97ad51e29ff71f702961af466c4616393f767455501e6aece9b8"; \
  ExternalSize: 34872043; Flags: external download extractarchive recursesubdirs ignoreversion
Source: "https://dl.google.com/android/repository/platform-tools-latest-windows.zip"; DestName: "platform-tools.zip"; DestDir: "{app}\runtime"; \
  ExternalSize: 8044989; Flags: external download extractarchive recursesubdirs ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\Abrir MestreScan PC.bat"; WorkingDir: "{app}"; IconFilename: "{app}\windows\mestrescan.ico"; Flags: runminimized
Name: "{group}\Instalar driver USB Samsung"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\windows\driver-samsung.ps1"""; IconFilename: "{app}\windows\mestrescan.ico"
Name: "{group}\Pasta de casos (backups)"; Filename: "{app}\casos"
Name: "{group}\Desinstalar {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\Abrir MestreScan PC.bat"; WorkingDir: "{app}"; IconFilename: "{app}\windows\mestrescan.ico"; Flags: runminimized; Tasks: desktopicon

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\windows\driver-samsung.ps1"""; \
  StatusMsg: "Instalando o driver USB da Samsung..."; Flags: waituntilterminated; Tasks: samsung
Filename: "{app}\Abrir MestreScan PC.bat"; WorkingDir: "{app}"; Description: "Abrir o MestreScan PC agora"; \
  Flags: postinstall nowait skipifsilent shellexec runminimized

[UninstallDelete]
Type: filesandordirs; Name: "{app}\runtime"

[Code]
// Fecha o MestreScan aberto e o ADB dele (o adb.exe continua rodando em segundo
// plano depois de fechar o programa). Sem isso a atualizacao e a desinstalacao
// falham com "arquivo em uso".
procedure FecharMestreScan();
var
  Code: Integer;
begin
  // So o cmd.exe: a janela do proprio Setup ("MestreScan PC x.y.z - Instalador") tambem casa com o titulo.
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /FI "IMAGENAME eq cmd.exe" /FI "WINDOWTITLE eq MestreScan PC*"', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -Command "Get-Process | Where-Object { $_.Path -like ''' +
    ExpandConstant('{app}') + '\*'' } | Stop-Process -Force -ErrorAction SilentlyContinue"', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  FecharMestreScan();
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then FecharMestreScan();
end;

// O Node tem arquivos com caminho comprido: pasta longa estoura o limite de 260 do Windows.
function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = wpSelectDir) and (Length(WizardDirValue) > 100) then begin
    MsgBox('Esta pasta tem o caminho muito comprido e o Windows pode nao conseguir instalar.' + #13#10 +
      'Escolha uma pasta mais curta (ex.: C:\MestreScan PC).', mbError, MB_OK);
    Result := False;
  end;
end;
