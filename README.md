# MestreScan PC

**Plugou o cabo, ele limpa.**

Ferramenta de balcão da MestreCell que remove vírus de propaganda (adware) de
celulares Android pelo cabo USB, usando o ADB. É o Projeto 1. O Projeto 2 é o
app [MestreScan](https://github.com/SandiehMoreira/MestreScan), e os dois usam
a mesma tabela de pontos (`rules.json`).

Por enquanto é só para **Windows**.

## Instalar

**Jeito fácil:** baixe e rode **`MestreScan-PC-Setup.exe`** (em sandieh.online).
Avançar › Avançar › Instalar. O instalador:

- não pede administrador (instala em `%LOCALAPPDATA%\Programs\MestreScan PC`);
- instala o programa com janela própria (`MestreScan PC.exe`, feito com Electron,
  que já traz o Node) e baixa o ADB (platform-tools) durante a instalação;
- cria os atalhos no Menu Iniciar e na Área de Trabalho;
- se a opção estiver marcada, baixa o **driver USB da Samsung** do site da
  Samsung (confere a assinatura digital) e abre o instalador dele. Também dá
  para instalar depois pelo atalho *Instalar driver USB Samsung*;
- aparece em *Configurações › Aplicativos* para desinstalar (a pasta `casos\`
  com os backups é mantida).

O Windows pode mostrar "O Windows protegeu o computador" (o Setup não tem
assinatura digital): clique em **Mais informações › Executar assim mesmo**.

Na primeira vez o Firewall do Windows pode perguntar sobre o `adb.exe`: pode
cancelar, o ADB pelo cabo funciona do mesmo jeito.

**Versão portátil:** extraia o zip e dê dois cliques em `Abrir MestreScan PC.bat`;
na primeira vez ele baixa o Node.js e o ADB para a pasta `runtime\`. Essa versão
abre no navegador.

Para gerar o Setup: `windows\gerar-setup.bat` (precisa do Node e do Inno Setup 6:
`winget install JRSoftware.InnoSetup`). Ele roda `npm run empacotar` (sai em
`build\MestreScan PC-win32-x64`) e depois o Inno. Sai em `build\MestreScan-PC-Setup.exe`.

## Como usar

1. Abra o **MestreScan PC** (atalho). A tela abre na janela do programa;
   fechar a janela desliga o programa. Na versão portátil a tela abre no
   navegador em http://localhost:5757 e a janela preta minimizada é que desliga.
2. No celular, ligue a **Depuração USB** (Configurações › Sobre o telefone ›
   toque 7× em *Número da versão* › Opções do desenvolvedor › Depuração USB).
3. Plugue o cabo e toque em **Permitir** no celular.

A partir daí é automático:

- escaneia todos os apps instalados pelo usuário (`pm list packages -3`);
- **perigosos (60+ pontos)** são removidos sozinhos (dá para desligar em
  *Remover perigosos sozinho*);
- **suspeitos (30–59)** ficam para o técnico decidir: *Remover* ou *Só desativar*.

## Não conectou? O programa diz o porquê

Enquanto nenhum celular está pronto, o MestreScan cruza o `adb devices` com o que
o Windows vê no USB (Gerenciador de Dispositivos) e mostra o problema e a solução:

| Situação | Como ele percebe | O que oferece |
|---|---|---|
| Falta driver | Aparelho com ⚠ (erro de driver) no USB | Samsung: botão que instala o driver. Motorola: link do Motorola Device Manager. Outros: Windows Update ou Google USB Driver, com o passo a passo |
| Depuração desligada | O celular aparece só como MTP (fotos) | Passo a passo (Xiaomi: também a opção de segurança) |
| Esperando "Permitir" | `unauthorized` | Olhar a tela; depois de 40 s: revogar autorizações e **Reiniciar ADB** |
| Offline / travado | `offline` | Reconectar e **Reiniciar ADB** |
| Driver ok, mas o ADB não viu | Interface ADB funcionando e lista vazia | **Reiniciar ADB** |
| Outro programa com o ADB | Erro de versão repetido ou porta 5037 ocupada | Mostra quem é (HiSuite, Mi PC Suite, Smart Switch, Vysor, BlueStacks...) e o botão **Resolver conflito** |
| Cabo/porta ruim | "Dispositivo USB desconhecido" (erro 43) | Trocar cabo e porta |
| Recovery | `recovery`/`sideload` | Reiniciar no sistema |
| Dois celulares com o mesmo serial | Serial repetido (celular genérico) | Pede para deixar um de cada vez e não mexe em nenhum |

Emuladores e conexões por Wi-Fi (`emulator-5554`, `127.0.0.1:5555`) são ignorados:
o MestreScan só limpa o que está no cabo.

Durante a remoção, erros conhecidos do Android viram dica no registro: Xiaomi sem
"Depuração USB (Configurações de segurança)", Oppo/Realme sem "Desativar
monitoramento de permissões", "Instalar via USB" desligado, app protegido por
MDM (celular de empresa), cabo que soltou no meio.

No PC: se a porta 5757 estiver ocupada por outro programa ele usa a próxima
livre; se o MestreScan já estiver aberto, só abre o navegador. O instalador fecha
o MestreScan e o ADB dele antes de atualizar ou desinstalar (senão daria
"arquivo em uso") e recusa pastas com caminho comprido demais.

## Remoção

Ordem: `force-stop` › backup do APK em `casos\<data>\<serial>\` (com sha256) ›
tira a acessibilidade › bloqueia a sobreposição (`appops`) › tira o administrador
(`dpm`) › `pm uninstall`. Se não desinstalar: `pm disable-user`.

**Admin travado.** O Android só deixa tirar pelo cabo administradores de teste.
Quando o vírus é administrador "de verdade", o MestreScan desativa o app, abre a
tela de administradores no celular e pede para desmarcar e clicar em
**Tentar de novo**.

Todo vírus removido entra em `casos\maliciosos.json` e vale **+100 pontos**
(`known_malicious`) nos próximos celulares.

## Outras funções

- **Pegar o anúncio na tela**: tira uma foto da tela (`screencap`) e mostra qual
  app está em primeiro plano. Se for um app de usuário, oferece remover.
- **O que abriu sozinho ao ligar**: lê o `dumpsys usagestats` (mesma lógica do
  `BootObserver` do APK). Dica: reinicie o celular no balcão antes de plugar.
- **Propaganda por cima de outro app**: regra nova `ad_screen_seen` (30 pts),
  quando uma tela de anúncio (AdMob, AppLovin, Unity…) abre por cima de outro app.
- **Relatório do cliente**: HTML com a marca da loja, para imprimir ou salvar em PDF.
- **Instalar MestreScan no celular**: baixa o APK da última release do GitHub e instala.

## Pontos (`rules.json`)

Mesma tabela do APK, mais `ad_screen_seen`. Faixas: 0–29 normal, 30–59
suspeito, 60+ perigoso. A lista branca (`com.google.`, bancos…) só vale se o app
veio de loja confiável.

Diferença para o APK: pelo ADB não dá para ler o nome do app, então o nome
mostrado vem do pacote (`com.cleaner.booster` → "cleaner booster").

## Segurança

- O servidor só escuta em `127.0.0.1` e recusa outro `Host` (protege contra DNS rebinding).
- A API exige um token novo a cada vez que o programa abre.
- Só mexe em apps de usuário (`pm list packages -3`), nunca nos do sistema.
- `casos\` (APKs de vírus e fotos de tela de clientes) não vai para o Git.

## White label

Troque `brand.json` (nome, slogan, cores, WhatsApp, endereço) e `public\logo.png`.

## Arquivos

| Arquivo | O que faz |
|---|---|
| `src/adb.js` | Acha o adb (runtime, Android SDK ou PATH) e roda os comandos |
| `src/inspector.js` | Lê o celular e faz os parsers (pacotes, admin, acessibilidade, appops, usagestats, tela) |
| `src/engine.js` | Pontuação (espelho do `RiskEngine.kt` do APK) |
| `src/actions.js` | Remover, desativar, reativar, casos, foto da tela, instalar MestreScan |
| `src/server.js` | API + fluxo automático + monitor do cabo (a cada 2 s) |
| `src/diagnose.js` | Diagnóstico de conexão e dicas para erros do Android |
| `src/usb.js` | Windows: aparelhos USB, dono da porta do ADB, correções |
| `src/report.js` | Relatório do cliente |
| `public/` | Tela (`index.html`, `app.js`, `style.css`) |
| `desktop/main.js` | Janela própria (Electron): sobe o servidor e mostra a tela |
| `windows/instalar.ps1` | Versão portátil: baixa Node/ADB na primeira vez e abre o servidor |
| `test/` | `fake-adb.js` (celular simulado) e `run-tests.js` |

## Desenvolvimento

```
npm start   # abre o servidor no navegador (Node 18+)
npm run app # abre na janela própria (Electron)
npm test    # 22 testes com o celular simulado
```

## Próximos passos

1. Testar em celulares reais com propaganda (Samsung, Xiaomi, Motorola) e ajustar
   pesos e parsers conforme a saída real do adb.
2. Backend Node servindo `rules.json` e `maliciosos.json` para o PC e o APK.
