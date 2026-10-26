; MestreScan PC - instalador tradicional (Setup.exe) feito com Inno Setup 6.
; Gerar:  windows\gerar-setup.bat   (empacota o Electron e sai em build\MestreScan-PC-Setup.exe)
;
; Instala so para o usuario (sem pedir administrador) o programa com janela propria
; (Electron, ja traz o Node), baixa o ADB durante a instalacao, cria os atalhos e,
; se marcado, instala o driver USB da Samsung.
; O codigo fica em {app}\resources\app; casos\ fica em {app}\casos.

#define AppName "MestreScan PC"
#define AppVersion "0.4.0"
#define AppDir "{app}\resources\app"

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
UninstallDisplayIcon={app}\{#AppName}.exe
UninstallDisplayName={#AppName}
OutputDir=..\build
OutputBaseFilename=MestreScan-PC-Setup
Compression=lzma2/ultra64
SolidCompression=yes

[Languages]
Name: "ptbr"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Messages]
ptbr.WelcomeLabel2=Este assistente vai instalar o [name/ver] no seu computador.%n%nPlugou o cabo, ele limpa: remove virus de propaganda de celulares Android pelo cabo USB.%n%nPrecisa de internet durante a instalacao (ADB, cerca de 8 MB).

[Tasks]
Name: "desktopicon"; Description: "Criar atalho na Area de Trabalho"; GroupDescription: "Atalhos:"
Name: "samsung"; Description: "Instalar o driver USB da Samsung (recomendado: sem ele o Windows pode nao reconhecer celulares Samsung)"; GroupDescription: "Drivers:"

[InstallDelete]
; Versao 0.3 (abria no navegador pelo .bat com Node portatil).
Type: filesandordirs; Name: "{app}\src"
Type: filesandordirs; Name: "{app}\public"
Type: filesandordirs; Name: "{app}\windows"
Type: filesandordirs; Name: "{app}\runtime"
Type: files; Name: "{app}\Abrir MestreScan PC.bat"
Type: files; Name: "{app}\package.json"
Type: files; Name: "{app}\README.md"
Type: files; Name: "{app}\rules.json"
Type: files; Name: "{app}\brand.json"

[Files]
; Gerado por "npm run empacotar".
Source: "..\build\MestreScan PC-win32-x64\*"; DestDir: "{app}"; Excludes: "\resources\app\brand.json"; \
  Flags: ignoreversion recursesubdirs createallsubdirs
; brand.json e a lista de casos sao da loja: nao sobrescrever numa atualizacao.
Source: "..\brand.json"; DestDir: "{#AppDir}"; Flags: onlyifdoesntexist
Source: "..\casos\.gitkeep"; DestDir: "{app}\casos"; Flags: onlyifdoesntexist
; Baixado durante a instalacao e extraido em runtime\
Source: "https://dl.google.com/android/repository/platform-tools-latest-windows.zip"; DestName: "platform-tools.zip"; DestDir: "{#AppDir}\runtime"; \
  ExternalSize: 8044989; Flags: external download extractarchive recursesubdirs ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppName}.exe"; WorkingDir: "{app}"
Name: "{group}\Instalar driver USB Samsung"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{#AppDir}\windows\driver-samsung.ps1"""; IconFilename: "{#AppDir}\windows\mestrescan.ico"
Name: "{group}\Pasta de casos (backups)"; Filename: "{app}\casos"
Name: "{group}\Desinstalar {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppName}.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{#AppDir}\windows\driver-samsung.ps1"""; \
  StatusMsg: "Instalando o driver USB da Samsung..."; Flags: waituntilterminated; Tasks: samsung
Filename: "{app}\{#AppName}.exe"; WorkingDir: "{app}"; Description: "Abrir o MestreScan PC agora"; \
  Flags: postinstall nowait skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{#AppDir}\runtime"

[Code]
// Fecha o MestreScan aberto e o ADB dele (o adb.exe continua rodando em segundo
// plano depois de fechar o programa). Sem isso a atualizacao e a desinstalacao
// falham com "arquivo em uso".
procedure FecharMestreScan();
var
  Code: Integer;
begin
  // Versao 0.3 (janela do cmd). So o cmd.exe: a janela do proprio Setup
  // ("MestreScan PC x.y.z - Instalador") tambem casa com o titulo.
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

// O Electron tem arquivos com caminho comprido: pasta longa estoura o limite de 260 do Windows.
function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = wpSelectDir) and (Length(WizardDirValue) > 100) then begin
    MsgBox('Esta pasta tem o caminho muito comprido e o Windows pode nao conseguir instalar.' + #13#10 +
      'Escolha uma pasta mais curta (ex.: C:\MestreScan PC).', mbError, MB_OK);
    Result := False;
  end;
end;
