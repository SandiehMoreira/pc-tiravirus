'use strict';
// O lado do Windows: o que está plugado no USB (Gerenciador de Dispositivos),
// quem está ocupando a porta do ADB e as correções que o técnico pode disparar.
const { execFile, exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const adb = require('./adb');
const diagnose = require('./diagnose');

const WIN = process.platform === 'win32';
const FAKE = /\.js$/i.test(process.env.MESTRESCAN_ADB || ''); // celular simulado dos testes

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function powershell(script, timeout) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], timeout);
}

/** Aparelhos USB que o Windows vê (com erro de driver, se houver). */
async function scanUsb() {
  // Testes: lista simulada em JSON.
  if (process.env.MESTRESCAN_USB_JSON) return diagnose.classifyUsb(diagnose.parsePnp(fs.readFileSync(process.env.MESTRESCAN_USB_JSON, 'utf8')));
  if (!WIN || FAKE) return null;
  const r = await powershell(
    "Get-CimInstance Win32_PnPEntity -Filter \"DeviceID LIKE 'USB%'\" | " +
    'Select-Object DeviceID,Name,PNPClass,Service,ConfigManagerErrorCode | ConvertTo-Json -Compress', 20000);
  if (r.code !== 0) return null;
  return diagnose.classifyUsb(diagnose.parsePnp(r.stdout));
}

/** Programa que está escutando na porta do ADB (5037), se não for o nosso adb. */
async function portOwner() {
  if (!WIN || FAKE) return null;
  const r = await powershell(
    'try { $c = Get-NetTCPConnection -LocalPort 5037 -State Listen -ErrorAction Stop | Select-Object -First 1; ' +
    '$p = Get-Process -Id $c.OwningProcess -ErrorAction Stop; ' +
    '@{ pid = $p.Id; name = $p.ProcessName; path = $p.Path } | ConvertTo-Json -Compress } catch { }', 15000);
  try {
    const o = JSON.parse(r.stdout.trim());
    const ours = adb.findAdb();
    const mine = ours && o.path && path.resolve(o.path).toLowerCase() === path.resolve(ours).toLowerCase();
    return { pid: o.pid, name: o.name, path: o.path || '', mine, label: diagnose.rivalName(o.name, o.path) };
  } catch { return null; }
}

/** Fecha o servidor do ADB de outro programa e sobe o nosso. */
async function killRival() {
  const owner = await portOwner();
  if (owner && !owner.mine) await run('taskkill.exe', ['/F', '/T', '/PID', String(owner.pid)]);
  await adb.run(['kill-server'], { timeout: 10000 });
  const r = await adb.run(['start-server'], { timeout: 20000 });
  return { killed: owner && !owner.mine ? owner.label : null, ok: r.code === 0 };
}

async function restartAdb() {
  await adb.run(['kill-server'], { timeout: 10000 });
  const r = await adb.run(['start-server'], { timeout: 20000 });
  return { ok: r.code === 0 };
}

/** Abre o instalador do driver Samsung numa janela própria (ele pede administrador). */
function samsungDriver() {
  const script = path.join(adb.ROOT, 'windows', 'driver-samsung.ps1');
  if (!WIN || !fs.existsSync(script)) throw new Error('Instalador do driver não encontrado');
  // detached no Windows = janela de console própria, visível para o técnico.
  spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    { detached: true, stdio: 'ignore' }).unref();
}

function deviceManager() {
  if (!WIN) throw new Error('Só no Windows');
  exec('start "" devmgmt.msc', () => {});
}

module.exports = { scanUsb, portOwner, killRival, restartAdb, samsungDriver, deviceManager };
