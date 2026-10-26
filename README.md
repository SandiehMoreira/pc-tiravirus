# MestreScan PC

**Plugou o cabo, ele limpa.**

Ferramenta de balcão da MestreCell que remove vírus de propaganda (adware) de
celulares Android pelo cabo USB, usando o ADB. É o Projeto 1. O Projeto 2 é o
app [MestreScan](https://github.com/SandiehMoreira/MestreScan), e os dois usam
a mesma tabela de pontos (`rules.json`).

Por enquanto é só para **Windows**.

## Como usar

1. Dois cliques em **`Abrir MestreScan PC.bat`**.
   Na primeira vez ele baixa o Node.js portátil e o ADB (platform-tools) para a
   pasta `runtime\`. Depois disso abre direto. A tela abre no navegador em
   http://localhost:5757. Deixe a janela preta aberta.
2. No celular, ligue a **Depuração USB** (Configurações › Sobre o telefone ›
   toque 7× em *Número da versão* › Opções do desenvolvedor › Depuração USB).
3. Plugue o cabo e toque em **Permitir** no celular.

A partir daí é automático:

- escaneia todos os apps instalados pelo usuário (`pm list packages -3`);
- **perigosos (60+ pontos)** são removidos sozinhos (dá para desligar em
  *Remover perigosos sozinho*);
- **suspeitos (30–59)** ficam para o técnico decidir: *Remover* ou *Só desativar*.

Samsung no Windows: se o celular não aparecer, instale o
**Samsung Android USB Driver**.

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
| `src/report.js` | Relatório do cliente |
| `public/` | Tela (`index.html`, `app.js`, `style.css`) |
| `windows/instalar.ps1` | Baixa Node/ADB na primeira vez e abre o servidor |
| `test/` | `fake-adb.js` (celular simulado) e `run-tests.js` |

## Desenvolvimento

```
npm start   # abre o servidor (Node 18+)
npm test    # 15 testes com o celular simulado
```

## Próximos passos

1. Testar em celulares reais com propaganda (Samsung, Xiaomi, Motorola) e ajustar
   pesos e parsers conforme a saída real do adb.
2. Backend Node servindo `rules.json` e `maliciosos.json` para o PC e o APK.
3. Empacotar como `.exe` para não depender do Node.
