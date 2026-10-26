'use strict';
// npm test — sem dependências. Usa o celular simulado (fake-adb.js).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mestrescan-'));
process.env.MESTRESCAN_ADB = path.join(__dirname, 'fake-adb.js');
process.env.MESTRESCAN_CASES = path.join(TMP, 'casos');
process.env.FAKE_ADB_STATE = path.join(TMP, 'phone.json');

const adb = require('../src/adb');
const inspector = require('../src/inspector');
const engine = require('../src/engine');
const actions = require('../src/actions');
const { createApp } = require('../src/server');
const diagnose = require('../src/diagnose');

const rules = engine.loadRules();
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const SAW = 'android.permission.SYSTEM_ALERT_WINDOW';
const INSTALL = 'android.permission.REQUEST_INSTALL_PACKAGES';
const BOOT = 'android.permission.RECEIVE_BOOT_COMPLETED';

function phone() {
  return {
    devices: [{ serial: 'FAKE123', state: 'device', model: 'SM_A105M' }],
    props: { manufacturer: 'samsung', model: 'SM-A105M', release: '11', sdk: '30' },
    now: '2026-10-26 10:00:00',
    uptime: 600,
    homes: ['com.sec.android.app.launcher'],
    accessibility: ['com.system.update.service/.AccService'],
    packages: {
      'com.cleaner.booster.fast': {
        installer: null, launcher: false, bootReceiver: true, overlay: 'allow',
        perms: [SAW, INSTALL, BOOT], firstInstall: '2026-10-24 09:00:00',
        admin: 'com.cleaner.booster.fast/.AdminReceiver',
      },
      'com.system.update.service': {
        installer: null, launcher: false, perms: [BOOT], firstInstall: '2026-08-01 12:00:00',
        admin: 'com.system.update.service/.Admin', adminLocked: true,
      },
      'com.whatsapp': { installer: 'com.android.vending', launcher: true, perms: [BOOT], firstInstall: '2025-01-01 10:00:00' },
      'com.funny.game': { installer: 'com.android.vending', launcher: true, perms: [SAW], firstInstall: '2026-01-01 10:00:00' },
    },
    usage: [
      'time="2026-10-26 09:50:20" type=DEVICE_STARTUP package=android',
      'time="2026-10-26 09:50:35" type=ACTIVITY_RESUMED package=com.sec.android.app.launcher class=com.sec.android.app.launcher.Launcher instanceId=1',
      'time="2026-10-26 09:50:40" type=KEYGUARD_HIDDEN package=android',
      'time="2026-10-26 09:50:50" type=ACTIVITY_RESUMED package=com.cleaner.booster.fast class=com.google.android.gms.ads.AdActivity instanceId=2',
      'time="2026-10-26 09:55:00" type=ACTIVITY_RESUMED package=com.whatsapp class=com.whatsapp.Main instanceId=3',
      'time="2026-10-26 09:55:10" type=ACTIVITY_RESUMED package=com.funny.game class=com.applovin.adview.AppLovinFullscreenActivity instanceId=4',
    ],
  };
}
const writePhone = (p) => fs.writeFileSync(process.env.FAKE_ADB_STATE, JSON.stringify(p, null, 2));
const readPhone = () => JSON.parse(fs.readFileSync(process.env.FAKE_ADB_STATE, 'utf8'));

// ---------- parsers ----------

test('lista de celulares (adb devices -l)', () => {
  const d = adb.parseDevices('List of devices attached\nR58M123\tdevice usb:1-1 product:a10 model:SM_A105M device:a10\nXYZ\tunauthorized usb:1-2 transport_id:3\n\n');
  assert.deepStrictEqual(d, [
    { serial: 'R58M123', state: 'device', model: 'SM A105M' },
    { serial: 'XYZ', state: 'unauthorized', model: null },
  ]);
});

test('pacotes de usuário com a loja que instalou', () => {
  const p = inspector.parsePackageList('package:com.a  installer=com.android.vending\r\npackage:com.b  installer=null\npackage:com.c\n');
  assert.deepStrictEqual(p, [
    { pkg: 'com.a', installer: 'com.android.vending' },
    { pkg: 'com.b', installer: null },
    { pkg: 'com.c', installer: null },
  ]);
});

test('ícones na tela (query-activities) e Android sem o comando', () => {
  const s = inspector.parseComponents('priority=0 preferredOrder=0 match=0x108000\n  com.a/.Main\n  com.b/com.b.ui.Start\n');
  assert.deepStrictEqual([...s], ['com.a', 'com.b']);
  assert.strictEqual(inspector.parseComponents("cmd: Unknown command 'query-activities'"), null);
});

test('administradores (dumpsys device_policy)', () => {
  const a = inspector.parseDeviceAdmins('  Enabled Device Admins (User 0, provisioningState: 0):\n    com.bad/.AdminReceiver:\n      uid=10120\n  Device Owner: admin=ComponentInfo{com.mdm/com.mdm.Admin}\n');
  assert.deepStrictEqual(a.map((x) => x.component), ['com.bad/.AdminReceiver', 'com.mdm/com.mdm.Admin']);
});

test('acessibilidade e sobreposição', () => {
  assert.deepStrictEqual(inspector.parseAccessibility('com.a/.Svc:com.b/com.b.S\n'), ['com.a/.Svc', 'com.b/com.b.S']);
  assert.deepStrictEqual(inspector.parseAccessibility('null'), []);
  const o = inspector.parseOverlayBatch('##com.a\nSYSTEM_ALERT_WINDOW: allow; time=+2d\n##com.b\nNo operations.\n');
  assert.strictEqual(o.get('com.a'), 'granted');
  assert.strictEqual(o.get('com.b'), 'requested');
});

test('dumpsys package: instalação, loja, permissões e desativado', () => {
  const m = inspector.parsePackageDump([
    'Packages:',
    '  Package [com.bad] (abc):',
    '    firstInstallTime=2026-10-20 08:30:00',
    '    installerPackageName=null',
    '    requested permissions:',
    '      android.permission.SYSTEM_ALERT_WINDOW',
    '      android.permission.RECEIVE_BOOT_COMPLETED: restricted=true',
    '    install permissions:',
    '      android.permission.INTERNET: granted=true',
    '    User 0: ceDataInode=1 installed=true enabled=3',
    'Shared users:',
  ].join('\n'));
  const p = m.get('com.bad');
  assert.strictEqual(p.firstInstallTime, Date.UTC(2026, 9, 20, 8, 30, 0));
  assert.strictEqual(p.installer, null);
  assert.deepStrictEqual([...p.requested], ['android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.RECEIVE_BOOT_COMPLETED']);
  assert.strictEqual(p.enabledState, 3);
});

test('usagestats: abriu sozinho ao ligar com tela de propaganda', () => {
  const events = inspector.parseUsageEvents(phone().usage.join('\n'));
  const u = inspector.analyzeUsage({
    events, userPkgs: new Set(['com.cleaner.booster.fast', 'com.whatsapp', 'com.funny.game']),
    launcher: new Set(['com.whatsapp', 'com.funny.game']), homes: new Set(['com.sec.android.app.launcher']),
    rules, nowLocal: Date.UTC(2026, 9, 26, 10, 0, 0), uptimeSec: 600,
  });
  assert.strictEqual(u.boots.length, 1);
  const ev = u.evidence['com.cleaner.booster.fast'];
  assert.ok(ev && ev.bootsWithLaunch === 1 && ev.adScreen);
  assert.strictEqual(u.evidence['com.whatsapp'], undefined);
});

test('usagestats: propaganda por cima de outro app (ad_screen_seen)', () => {
  const events = inspector.parseUsageEvents(phone().usage.join('\n'));
  const u = inspector.analyzeUsage({
    events, userPkgs: new Set(['com.funny.game', 'com.whatsapp']), launcher: new Set(['com.whatsapp', 'com.funny.game']),
    homes: new Set(['com.sec.android.app.launcher']), rules, nowLocal: null, uptimeSec: null,
  });
  assert.deepStrictEqual(u.adSeen['com.funny.game'].over, ['com.whatsapp']);
  // Jogo aberto pela tela inicial mostrando o próprio anúncio não conta.
  const own = inspector.analyzeUsage({
    events: inspector.parseUsageEvents([
      'time="2026-10-26 09:00:00" type=ACTIVITY_RESUMED package=com.sec.android.app.launcher class=L',
      'time="2026-10-26 09:00:05" type=ACTIVITY_RESUMED package=com.funny.game class=com.google.android.gms.ads.AdActivity',
    ].join('\n')),
    userPkgs: new Set(['com.funny.game']), launcher: new Set(['com.funny.game']),
    homes: new Set(['com.sec.android.app.launcher']), rules, nowLocal: null, uptimeSec: null,
  });
  assert.deepStrictEqual(own.adSeen, {});
});

test('app em primeiro plano (foto do anúncio)', () => {
  assert.deepStrictEqual(inspector.parseForeground('  mResumedActivity: ActivityRecord{1a2b u0 com.bad/.ui.AdAct t5}'),
    { pkg: 'com.bad', cls: 'com.bad.ui.AdAct' });
  assert.deepStrictEqual(inspector.parseForeground('  mCurrentFocus=Window{9f u0 com.x/com.x.Main}'),
    { pkg: 'com.x', cls: 'com.x.Main' });
});

// ---------- pontuação ----------

const baseApp = (o) => ({ pkg: 'com.x', label: 'x', installer: 'com.android.vending', installedAt: null, hasLauncherIcon: true,
  admins: [], accessibility: [], overlay: 'none', canInstallApps: false, startsOnBoot: false, ...o });

test('lista branca só vale vindo da Play Store', () => {
  const ok = engine.evaluate(baseApp({ pkg: 'com.google.android.apps.maps', startsOnBoot: true }), { rules });
  assert.strictEqual(ok.score, 0);
  const fake = engine.evaluate(baseApp({ pkg: 'com.google.service', label: 'google service', installer: null, hasLauncherIcon: false }), { rules });
  assert.strictEqual(fake.level, 'danger');
});

test('faixas: suspeito 30-59, perigoso 60+', () => {
  assert.strictEqual(engine.evaluate(baseApp({ overlay: 'requested', installer: null }), { rules }).level, 'suspect'); // 15 + 20
  assert.strictEqual(engine.evaluate(baseApp({ overlay: 'granted', installer: null, hasLauncherIcon: false }), { rules }).level, 'danger'); // 25+20+25
  assert.strictEqual(engine.evaluate(baseApp({ overlay: 'requested' }), { rules }).level, 'safe');
});

test('vírus já removido antes vale +100 nos próximos celulares', () => {
  const r = engine.evaluate(baseApp({ pkg: 'com.foo.bar' }), { rules, known: new Set(['com.foo.bar']) });
  assert.strictEqual(r.score, 100);
  assert.strictEqual(r.reasons[0].rule, 'known_malicious');
});

// ---------- fluxo completo com o celular simulado ----------

async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('tempo esgotado');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('plugou: escaneia, remove o perigoso, trava no admin e tenta de novo', async () => {
  writePhone(phone());
  const app = createApp({ port: 0, monitorMs: 300 });
  const port = await app.listen();
  const base = `http://localhost:${port}`;
  const call = (p, body, token = app.token) => fetch(base + p, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Token': token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    assert.strictEqual((await call('/api/state', null, 'errado')).status, 401);
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes(app.token), 'a página recebe o token');

    const s = await waitFor(async () => {
      const st = await (await call('/api/state')).json();
      return st.session && st.session.status === 'done' && st.session;
    });
    const by = (pkg) => s.results.find((r) => r.pkg === pkg);
    assert.strictEqual(by('com.cleaner.booster.fast').action.state, 'removed');
    assert.ok(by('com.cleaner.booster.fast').reasons.some((r) => r.rule === 'boot_popup'));
    assert.strictEqual(by('com.cleaner.booster.fast').overlay, 'granted');
    assert.strictEqual(by('com.system.update.service').action.state, 'admin_locked');
    assert.strictEqual(by('com.funny.game').level, 'suspect');
    assert.strictEqual(by('com.funny.game').action, null);
    assert.strictEqual(by('com.whatsapp').score, 0);

    let ph = readPhone();
    assert.ok(!ph.packages['com.cleaner.booster.fast']);
    assert.ok(ph.packages['com.system.update.service'].disabled);
    assert.deepStrictEqual(ph.accessibility, []);
    assert.ok(ph.openedAdmins >= 1);

    // Técnico desmarca o administrador no celular e clica em "Tentar de novo".
    delete ph.packages['com.system.update.service'].admin;
    writePhone(ph);
    const retry = await (await call('/api/action', { action: 'retry', pkg: 'com.system.update.service' })).json();
    assert.strictEqual(retry.action.state, 'removed');

    // Suspeito: o técnico decide.
    assert.strictEqual((await (await call('/api/action', { action: 'disable', pkg: 'com.funny.game' })).json()).action.state, 'disabled');
    assert.strictEqual((await (await call('/api/action', { action: 'enable', pkg: 'com.funny.game' })).json()).action.state, 'enabled');

    const cases = actions.loadCases().items.map((i) => i.pkg).sort();
    assert.deepStrictEqual(cases, ['com.cleaner.booster.fast', 'com.system.update.service']);
    const caseItem = actions.loadCases().items[0];
    assert.match(caseItem.sha256[0], /^[0-9a-f]{64}$/);

    const rep = await (await call('/relatorio')).text();
    assert.ok(rep.includes('Removido') && rep.includes('SM-A105M'));
  } finally {
    await app.close();
  }
});

test('foto da tela aponta o app do anúncio', async () => {
  const ph = phone();
  ph.foreground = 'com.funny.game/com.applovin.adview.AppLovinFullscreenActivity';
  writePhone(ph);
  const app = createApp({ port: 0, monitorMs: 300 });
  const port = await app.listen();
  const call = (p, body) => fetch(`http://localhost:${port}${p}`, {
    method: body ? 'POST' : 'GET', headers: { 'X-Token': app.token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    await waitFor(async () => ((await (await call('/api/state')).json()).session || {}).status === 'done');
    const shot = await (await call('/api/screen', {})).json();
    assert.strictEqual(shot.suspect.pkg, 'com.funny.game');
    const img = await call(`/api/screens/${shot.name}`);
    assert.strictEqual(img.headers.get('content-type'), 'image/png');
  } finally {
    await app.close();
  }
});

test('servidor recusa acesso de fora (Host diferente)', async () => {
  writePhone({ ...phone(), devices: [] });
  const app = createApp({ port: 0, monitorMs: 5000 });
  const port = await app.listen();
  try {
    const http = require('http');
    const code = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/', headers: { Host: 'site-malicioso.com' } }, (res) => resolve(res.statusCode));
    });
    assert.strictEqual(code, 403);
  } finally {
    await app.close();
  }
});

// ---------- diagnóstico de conexão ----------

const pnp = (...list) => JSON.stringify(list.map(([DeviceID, Name, PNPClass, err = 0]) => ({ DeviceID, Name, PNPClass, Service: '', ConfigManagerErrorCode: err })));
const diagFor = (entries, extra = {}) => diagnose.diagnose({
  adbFound: true, devices: [], usb: diagnose.classifyUsb(diagnose.parsePnp(entries)), ...extra,
});

test('diagnóstico: Samsung sem driver, Motorola sem depuração, Xiaomi pronto', () => {
  let d = diagFor(pnp(
    ['USB\\VID_04E8&PID_6860\\R58M1', 'SM-A105M', 'WPD'],
    ['USB\\VID_04E8&PID_6860&MI_01\\6&1', 'SAMSUNG_Android', null, 28],
  ));
  assert.strictEqual(d.code, 'no_driver');
  assert.ok(d.title.includes('Samsung'));
  assert.deepStrictEqual(d.fixes.map((x) => x.fix), ['samsung-driver']);

  d = diagFor(pnp(['USB\\VID_22B8&PID_2E82\\ZY22', 'moto g(8)', 'WPD']));
  assert.strictEqual(d.code, 'no_debug');

  d = diagFor(pnp(['USB\\VID_18D1&PID_4EE7&MI_01\\6&2', 'Android Composite ADB Interface', 'AndroidUsbDeviceClass']));
  assert.strictEqual(d.code, 'adb_not_listing');
  assert.strictEqual(d.fixes[0].fix, 'restart-adb');

  d = diagFor(pnp(['USB\\VID_2717&PID_FF48\\abc', 'Redmi Note 8', 'WPD'], ['USB\\VID_2717&PID_FF48&MI_01\\6&3', 'ADB Interface', null, 28]));
  assert.strictEqual(d.code, 'no_driver');
  assert.ok(d.fixes.some((x) => x.fix === 'device-manager'));
});

test('diagnóstico: teclado da Samsung não é celular; cabo ruim; nada plugado', () => {
  assert.strictEqual(diagFor(pnp(['USB\\VID_04E8&PID_7021&MI_00\\1', 'Dispositivo de Entrada USB', 'HIDClass'])).code, 'waiting');
  assert.strictEqual(diagFor(pnp(['USB\\VID_0000&PID_0002\\5&1', 'Dispositivo USB Desconhecido (Falha na Solicitação de Descritor)', 'USB', 43])).code, 'usb_fail');
  assert.strictEqual(diagFor('').code, 'waiting');
});

test('diagnóstico: permissão demorando, offline, recovery, conflito de ADB', () => {
  const unauth = [{ serial: 'X1', state: 'unauthorized' }];
  assert.strictEqual(diagFor('', { devices: unauth, unauthorizedSince: Date.now() }).fixes.length, 0);
  const late = diagFor('', { devices: unauth, unauthorizedSince: Date.now() - 60000 });
  assert.ok(late.steps.some((x) => x.includes('Revogar')));
  assert.strictEqual(late.fixes[0].fix, 'restart-adb');
  assert.strictEqual(diagFor('', { devices: [{ serial: 'X1', state: 'offline' }] }).code, 'offline');
  assert.strictEqual(diagFor('', { devices: [{ serial: 'X1', state: 'recovery' }] }).code, 'recovery');
  const war = diagFor('', { adbProblem: 'version', rival: 'Huawei HiSuite' });
  assert.strictEqual(war.code, 'adb_conflict');
  assert.ok(war.text.includes('HiSuite'));
  assert.strictEqual(diagFor('', { adbFound: false }).code, 'no_adb');

  assert.strictEqual(diagnose.adbServerProblem('adb server version (40) doesn\'t match this client (41); killing...'), 'version');
  assert.strictEqual(diagnose.adbServerProblem('error: could not install *smartsocket* listener: cannot bind to 127.0.0.1:5037'), 'port');
  assert.strictEqual(diagnose.adbServerProblem('* daemon started successfully'), null);
  assert.strictEqual(diagnose.rivalName('HiSuite', 'C:\\Program Files\\HiSuite\\HiSuite.exe'), 'Huawei HiSuite');
});

test('diagnóstico: emulador/Wi-Fi ignorados e serial repetido', () => {
  assert.ok(diagnose.isRemoteSerial('emulator-5554'));
  assert.ok(diagnose.isRemoteSerial('127.0.0.1:5555'));
  assert.ok(diagnose.isRemoteSerial('adb-R58M1-abc._adb-tls-connect._tcp'));
  assert.ok(!diagnose.isRemoteSerial('R58M123ABC'));
  const dup = diagFor('', { devices: [{ serial: '0123456789ABCDEF', state: 'device' }, { serial: '0123456789ABCDEF', state: 'device' }] });
  assert.strictEqual(dup.code, 'duplicate_serial');
  assert.strictEqual(diagnose.notes([{ serial: 'emulator-5554', state: 'device' }]).length, 1);
});

test('dicas para erros do Android (Xiaomi, Oppo, MDM, cabo)', () => {
  assert.ok(diagnose.actionHint('Sobreposição não bloqueou: java.lang.SecurityException: uid 2000 does not have android.permission.MANAGE_APP_OPS_MODES', 'Xiaomi').includes('Configurações de segurança'));
  assert.ok(diagnose.actionHint('java.lang.SecurityException: Permission Denial: WRITE_SECURE_SETTINGS', 'OPPO').includes('monitoramento de permissões'));
  assert.ok(diagnose.actionHint('Failure [INSTALL_FAILED_USER_RESTRICTED: Install canceled by user]', 'Xiaomi').includes('Instalar via USB'));
  assert.ok(diagnose.actionHint('Failure [DELETE_FAILED_USER_RESTRICTED]', 'samsung').includes('MDM'));
  assert.ok(diagnose.actionHint("error: device 'X1' not found", 'samsung').includes('cabo'));
  assert.strictEqual(diagnose.actionHint('Success', 'samsung'), null);
});

test('servidor: emulador não vira atendimento; Samsung sem driver aparece na tela', async () => {
  const usbFile = path.join(TMP, 'usb.json');
  fs.writeFileSync(usbFile, pnp(['USB\\VID_04E8&PID_6860&MI_01\\6&1', 'SAMSUNG_Android', null, 28]));
  process.env.MESTRESCAN_USB_JSON = usbFile;
  writePhone({ ...phone(), devices: [{ serial: 'emulator-5554', state: 'device', model: 'sdk' }] });
  const app = createApp({ port: 0, monitorMs: 200 });
  const port = await app.listen();
  try {
    const get = () => fetch(`http://localhost:${port}/api/state`, { headers: { 'X-Token': app.token } }).then((r) => r.json());
    const st = await waitFor(async () => { const s = await get(); return s.diag.code === 'no_driver' ? s : null; });
    assert.strictEqual(st.sessions.length, 0);
    assert.strictEqual(st.notes.length, 1);
    assert.ok(st.devices[0].remote);
  } finally {
    delete process.env.MESTRESCAN_USB_JSON;
    await app.close();
  }
});

test('Xiaomi recusa a sobreposição: remove mesmo assim e explica', async () => {
  const p = phone();
  p.props.manufacturer = 'Xiaomi';
  p.denyAppops = true;
  writePhone(p);
  const r = await actions.removeApp('FAKE123', { pkg: 'com.funny.game' }, {});
  assert.strictEqual(r.state, 'removed');
  const text = r.steps.join('\n');
  assert.ok(/não bloqueou/.test(text));
  assert.ok(diagnose.actionHint(text, 'Xiaomi').includes('Configurações de segurança'));
});

(async () => {
  let fail = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok  ${t.name}`);
    } catch (e) {
      fail++;
      console.log(`  FALHOU  ${t.name}\n        ${e.stack.split('\n').slice(0, 3).join('\n        ')}`);
    }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${tests.length - fail}/${tests.length} testes passando`);
  process.exit(fail ? 1 : 0);
})();
