'use strict';
// Janela própria do MestreScan PC (Electron): sobe o mesmo servidor local de
// src/server.js e mostra a tela numa janela do programa, sem navegador nem cmd.
const path = require('path');
const { app, BrowserWindow, Menu, nativeTheme, shell } = require('electron');

// Instalado: casos\ fica na pasta do programa, ao lado do MestreScan PC.exe
// (o código fica em resources\app).
if (app.isPackaged && !process.env.MESTRESCAN_CASES) {
  process.env.MESTRESCAN_CASES = path.join(path.dirname(process.execPath), 'casos');
}

const { createApp } = require('../src/server');

const ICON = path.join(__dirname, '..', 'windows', 'mestrescan.ico');
let server = null;
let win = null;

/** Mesma regra do modo navegador: 5757 ou a próxima livre. */
async function startServer() {
  const first = Number(process.env.PORT) || 5757;
  for (let port = first; port < first + 10; port++) {
    const s = createApp({ port });
    try {
      await s.listen();
      server = s;
      return port;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
    }
  }
  throw new Error(`Nenhuma porta livre entre ${first} e ${first + 9}`);
}

function createWindow(base) {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'MestreScan PC',
    icon: ICON,
    backgroundColor: '#0B0B0D',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());

  // Relatório e fotos da tela abrem numa janela do programa; o resto (WhatsApp,
  // links de ajuda) vai para o navegador.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(base + '/')) {
      return { action: 'allow', overrideBrowserWindowOptions: { icon: ICON, autoHideMenuBar: true, width: 1000, height: 800 } };
    }
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(base + '/')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  win.loadURL(base + '/');
  win.on('closed', () => { win = null; });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Abriu de novo pelo atalho: traz a janela que já está aberta.
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    nativeTheme.themeSource = 'dark'; // barra de título escura, igual à tela

    const port = await startServer();
    createWindow(`http://localhost:${port}`);
  }).catch((e) => {
    require('electron').dialog.showErrorBox('MestreScan PC', `Não consegui abrir o MestreScan PC.\n\n${e.message}`);
    app.quit();
  });

  // Sem esperar o close: conexão keep-alive aberta seguraria o programa.
  app.on('window-all-closed', () => {
    if (server) server.close();
    app.quit();
  });
}
