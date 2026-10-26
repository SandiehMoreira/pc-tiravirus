'use strict';
// O que mexe no celular: remover, desativar, reativar, foto da tela e instalar
// o MestreScan. Também guarda os casos (APK de backup + lista de maliciosos).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const adb = require('./adb');
const inspector = require('./inspector');

const CASES_DIR = process.env.MESTRESCAN_CASES || path.join(adb.ROOT, 'casos');
const CASES_FILE = path.join(CASES_DIR, 'maliciosos.json');
const RUNTIME_DIR = path.join(adb.ROOT, 'runtime');
const PKG_RE = /^[A-Za-z][\w.]*$/;

const today = () => new Date().toISOString().slice(0, 10);
const safeName = (s) => String(s).replace(/[^\w.-]+/g, '_');
const ok = (out) => /^Success/m.test(out);

function checkPkg(pkg) {
  if (!PKG_RE.test(pkg || '')) throw new Error('Pacote inválido');
}

// ---------- casos ----------

function loadCases() {
  try {
    return JSON.parse(fs.readFileSync(CASES_FILE, 'utf8'));
  } catch {
    return { version: 1, items: [] };
  }
}

function knownSet() {
  return new Set(loadCases().items.map((i) => i.pkg));
}

function recordCase({ pkg, sha256, device, score, reasons }) {
  const data = loadCases();
  let item = data.items.find((i) => i.pkg === pkg);
  if (!item) {
    item = { pkg, sha256: [], firstSeen: today(), lastSeen: today(), count: 0, devices: [], reasons: [] };
    data.items.push(item);
  }
  item.lastSeen = today();
  item.count++;
  if (sha256 && !item.sha256.includes(sha256)) item.sha256.push(sha256);
  const dev = [device.manufacturer, device.model].filter(Boolean).join(' ');
  if (dev && !item.devices.includes(dev)) item.devices.push(dev);
  for (const r of reasons || []) if (!item.reasons.includes(r.rule)) item.reasons.push(r.rule);
  item.lastScore = score;
  fs.mkdirSync(CASES_DIR, { recursive: true });
  fs.writeFileSync(CASES_FILE, JSON.stringify(data, null, 2) + '\n');
}

// ---------- passos da remoção ----------

/** Copia o APK para casos/<data>/<serial>/ e calcula o sha256. */
async function backupApk(serial, pkg) {
  const out = await adb.shell(serial, `pm path ${pkg}`);
  const apkPath = (out.match(/^package:(.+\.apk)$/m) || [])[1];
  if (!apkPath) return null;
  const dir = path.join(CASES_DIR, today(), safeName(serial));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${pkg}.apk`);
  const r = await adb.run(['-s', serial, 'pull', apkPath.trim(), file], { timeout: 180000 });
  if (r.code !== 0 || !fs.existsSync(file)) return null;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return { file: path.relative(adb.ROOT, file), sha256 };
}

/** O Android recusou o comando (Xiaomi/Oppo sem a opção de segurança, MDM...). */
const refused = (out) => /SecurityException|Permission Denial|not allowed|java\.lang\.\w+Exception/i.test(out || '');

async function removeAccessibility(serial, pkg) {
  const list = inspector.parseAccessibility(await adb.shell(serial, 'settings get secure enabled_accessibility_services'));
  const keep = list.filter((c) => c.split('/')[0] !== pkg);
  if (keep.length === list.length) return false;
  const out = keep.length
    ? await adb.shell(serial, `settings put secure enabled_accessibility_services '${keep.join(':')}'`)
    : await adb.shell(serial, 'settings delete secure enabled_accessibility_services; settings put secure accessibility_enabled 0');
  if (refused(out)) throw new Error(`não saiu (${out.split('\n')[0]})`);
  return true;
}

async function removeAdmins(serial, pkg) {
  const before = (await inspector.currentAdmins(serial)).filter((a) => a.pkg === pkg);
  for (const a of before) await adb.shell(serial, `dpm remove-active-admin --user 0 '${a.component}'`);
  const after = (await inspector.currentAdmins(serial)).filter((a) => a.pkg === pkg);
  return { had: before.length > 0, stuck: after.map((a) => a.component) };
}

/** Abre no celular a tela de administradores (o nome muda de fabricante para fabricante). */
async function openAdminSettings(serial) {
  const tries = [
    "am start -n 'com.android.settings/.Settings$DeviceAdminSettingsActivity'",
    "am start -n 'com.android.settings/.DeviceAdminSettings'",
    'am start -a android.settings.SECURITY_SETTINGS',
  ];
  for (const cmd of tries) {
    const out = await adb.shell(serial, cmd);
    if (!/Error|Exception|does not exist|not found/i.test(out)) return true;
  }
  return false;
}

/**
 * Remove o app: force-stop > backup > acessibilidade > sobreposição > admin >
 * pm uninstall. Se não sair, desativa. Admin travado: desativa, abre a tela de
 * administradores e pede para o técnico desmarcar e tentar de novo.
 */
async function removeApp(serial, app, { device, score, reasons } = {}) {
  checkPkg(app.pkg);
  const pkg = app.pkg;
  const steps = [];
  const step = (text) => steps.push(text);

  await adb.shell(serial, `am force-stop ${pkg}`);
  step('Parado (force-stop)');

  let backup = null;
  try { backup = await backupApk(serial, pkg); } catch { /* backup não impede a remoção */ }
  step(backup ? `Backup do APK salvo (${backup.sha256.slice(0, 12)}…)` : 'Sem backup do APK');

  try {
    if (await removeAccessibility(serial, pkg)) step('Acessibilidade retirada');
  } catch (e) { step(`Acessibilidade: ${e.message}`); }
  const ops = await adb.shell(serial, `appops set ${pkg} SYSTEM_ALERT_WINDOW deny`);
  step(refused(ops) ? `Sobreposição não bloqueou: ${ops.split('\n')[0]}` : 'Sobreposição bloqueada');

  const admin = await removeAdmins(serial, pkg);
  if (admin.had) step(admin.stuck.length ? 'Administrador não saiu pelo cabo' : 'Administrador retirado');

  const record = () => recordCase({ pkg, sha256: backup && backup.sha256, device: device || {}, score, reasons });

  let out = await adb.shell(serial, `pm uninstall ${pkg}`);
  if (!ok(out)) out = await adb.shell(serial, `pm uninstall --user 0 ${pkg}`);
  if (ok(out)) {
    step('Desinstalado');
    record();
    return { state: 'removed', steps, backup };
  }

  const disabled = /new state: disabled/i.test(await adb.shell(serial, `pm disable-user --user 0 ${pkg}`));
  step(disabled ? 'Não desinstalou; foi desativado' : `Não desinstalou: ${out.split('\n')[0]}`);
  if (admin.stuck.length) {
    await openAdminSettings(serial);
    step('Tela de administradores aberta no celular');
    record();
    return { state: 'admin_locked', steps, backup, admins: admin.stuck };
  }
  if (disabled) {
    record();
    return { state: 'disabled', steps, backup };
  }
  return { state: 'error', steps, backup, message: out.split('\n')[0] };
}

/** "Só desativar": o app fica no celular, mas não roda nem aparece. */
async function disableApp(serial, app) {
  checkPkg(app.pkg);
  const steps = [];
  await adb.shell(serial, `am force-stop ${app.pkg}`);
  try {
    if (await removeAccessibility(serial, app.pkg)) steps.push('Acessibilidade retirada');
  } catch (e) { steps.push(`Acessibilidade: ${e.message}`); }
  const ops = await adb.shell(serial, `appops set ${app.pkg} SYSTEM_ALERT_WINDOW deny`);
  if (refused(ops)) steps.push(`Sobreposição não bloqueou: ${ops.split('\n')[0]}`);
  const out = await adb.shell(serial, `pm disable-user --user 0 ${app.pkg}`);
  const disabled = /new state: disabled/i.test(out);
  steps.push(disabled ? 'Desativado' : `Não desativou: ${out.split('\n')[0]}`);
  return { state: disabled ? 'disabled' : 'error', steps };
}

async function enableApp(serial, app) {
  checkPkg(app.pkg);
  const out = await adb.shell(serial, `pm enable ${app.pkg}`);
  const enabled = /new state: enabled/i.test(out);
  return { state: enabled ? 'enabled' : 'error', steps: [enabled ? 'Reativado' : `Não reativou: ${out.split('\n')[0]}`] };
}

/** Foto da tela + app em primeiro plano ("pegar o anúncio na tela"). */
async function captureScreen(serial) {
  const r = await adb.run(['-s', serial, 'exec-out', 'screencap -p'], { binary: true, timeout: 30000 });
  if (r.code !== 0 || !r.stdout || r.stdout.length < 100) throw new Error('Não consegui tirar a foto da tela');
  const dir = path.join(CASES_DIR, 'telas');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${today()}_${safeName(serial)}_${Date.now()}.png`;
  fs.writeFileSync(path.join(dir, name), r.stdout);
  const fg = await inspector.foreground(serial);
  return { name, foreground: fg };
}

function screenFile(name) {
  if (!/^[\w.-]+\.png$/.test(name)) return null;
  const file = path.join(CASES_DIR, 'telas', name);
  return fs.existsSync(file) ? file : null;
}

/** Baixa (uma vez) o APK do MestreScan do GitHub e instala no celular. */
async function installMestreScan(serial, url) {
  const apk = path.join(RUNTIME_DIR, 'MestreScan.apk');
  if (!fs.existsSync(apk)) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Download do MestreScan falhou (${res.status})`);
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(apk, Buffer.from(await res.arrayBuffer()));
  }
  const r = await adb.run(['-s', serial, 'install', '-r', apk], { timeout: 300000 });
  const out = r.stdout + r.stderr;
  if (!/Success/.test(out)) throw new Error(out.trim().split('\n').pop() || 'Instalação falhou');
  return true;
}

module.exports = {
  removeApp, disableApp, enableApp, openAdminSettings, captureScreen, screenFile,
  installMestreScan, loadCases, knownSet, recordCase, CASES_DIR,
};
