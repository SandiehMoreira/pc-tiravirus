'use strict';
// Servidor local (só localhost) + monitor do cabo + fluxo automático:
// plugou -> escaneia -> remove os perigosos -> deixa os suspeitos pro técnico.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { exec } = require('child_process');
const adb = require('./adb');
const inspector = require('./inspector');
const engine = require('./engine');
const actions = require('./actions');
const report = require('./report');
const diagnose = require('./diagnose');
const usb = require('./usb');

const ROOT = adb.ROOT;
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function createApp({ port = 5757, monitorMs = 2000 } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const brand = JSON.parse(fs.readFileSync(path.join(ROOT, 'brand.json'), 'utf8'));
  const rules = engine.loadRules();
  const settings = { autoClean: true };
  const sessions = new Map(); // serial -> atendimento
  let active = null;
  let devices = [];
  let adbError = null;
  // Diagnóstico da conexão (driver, depuração, conflito de ADB...).
  const diag = { usb: null, usbAt: 0, usbBusy: false, problem: null, rival: null, mismatches: [], unauthorizedSince: null };

  // ---------- atendimento ----------

  function newSession(dev) {
    return {
      id: crypto.randomBytes(4).toString('hex'),
      serial: dev.serial,
      connected: true,
      status: 'connecting',
      startedAt: Date.now(),
      device: { serial: dev.serial, model: dev.model },
      results: [],
      boots: [],
      screens: [],
      log: [],
      busy: null,
      queue: Promise.resolve(),
    };
  }

  function log(s, text, kind = 'info') {
    s.log.push({ t: Date.now(), text, kind });
    if (s.log.length > 300) s.log.shift();
  }

  /** Uma coisa de cada vez no mesmo celular. */
  function enqueue(s, label, fn) {
    const run = s.queue.then(async () => {
      s.busy = label;
      try { return await fn(); } finally { s.busy = null; }
    });
    s.queue = run.catch(() => {});
    return run;
  }

  async function scanSession(s) {
    s.status = 'scanning';
    log(s, 'Escaneando os apps do celular…');
    const data = await inspector.scan(s.serial, rules);
    const known = actions.knownSet();
    const previous = new Map(s.results.map((r) => [r.pkg, r.action]));
    s.device = data.device;
    s.boots = data.boots.filter((b) => b.launches.length);
    s.results = data.apps.map((app) => ({
      ...app,
      ...engine.evaluate(app, { rules, known, nowLocal: data.nowLocal, evidence: data.evidence, adSeen: data.adSeen }),
      action: previous.get(app.pkg) || null,
    })).sort((a, b) => b.score - a.score);
    // Quem foi removido some do celular; continua na lista para o relatório.
    for (const [pkg, action] of previous) {
      if (action && action.state === 'removed' && !s.results.some((r) => r.pkg === pkg)) {
        const old = s.lastRemoved && s.lastRemoved.get(pkg);
        if (old) s.results.push(old);
      }
    }
    const dangers = s.results.filter((r) => r.level === 'danger').length;
    const suspects = s.results.filter((r) => r.level === 'suspect').length;
    log(s, `${s.results.length} apps analisados: ${dangers} perigosos, ${suspects} suspeitos.`, dangers ? 'danger' : 'ok');
  }

  async function act(s, pkg, kind) {
    const r = s.results.find((x) => x.pkg === pkg);
    if (!r) throw new Error('App não encontrado');
    log(s, `${kind === 'disable' ? 'Desativando' : kind === 'enable' ? 'Reativando' : 'Removendo'} ${r.label} (${pkg})…`);
    let result;
    if (kind === 'remove' || kind === 'retry') {
      result = await actions.removeApp(s.serial, r, { device: s.device, score: r.score, reasons: r.reasons });
    } else if (kind === 'disable') {
      result = await actions.disableApp(s.serial, r);
    } else if (kind === 'enable') {
      result = await actions.enableApp(s.serial, r);
    } else {
      throw new Error('Ação inválida');
    }
    r.action = { ...result, at: Date.now() };
    if (result.state === 'removed') {
      s.lastRemoved = s.lastRemoved || new Map();
      s.lastRemoved.set(pkg, r);
    }
    const msg = {
      removed: `${r.label}: removido.`,
      disabled: `${r.label}: desativado.`,
      enabled: `${r.label}: reativado.`,
      admin_locked: `${r.label}: é administrador e o Android não deixa tirar pelo cabo. No celular, desmarque ele em Administradores e clique em "Tentar de novo".`,
      error: `${r.label}: não consegui (${result.message || result.steps.slice(-1)[0]}).`,
    }[result.state];
    log(s, msg, result.state === 'error' || result.state === 'admin_locked' ? 'warn' : 'ok');
    const hint = diagnose.actionHint([...(result.steps || []), result.message || ''].join('\n'), s.device.manufacturer);
    if (hint) log(s, hint, 'warn');
    return r;
  }

  async function runFlow(s) {
    try {
      await enqueue(s, 'scan', () => scanSession(s));
      if (settings.autoClean) {
        const dangers = s.results.filter((r) => r.level === 'danger' && !r.action);
        if (dangers.length) {
          s.status = 'cleaning';
          log(s, `Removendo ${dangers.length} perigoso(s) automaticamente…`, 'danger');
          for (const r of dangers) {
            if (!s.connected) break;
            await enqueue(s, 'remove', () => act(s, r.pkg, 'remove')).catch((e) => log(s, `${r.label}: ${e.message}`, 'warn'));
          }
        }
      }
      s.status = 'done';
      const left = s.results.filter((r) => r.level === 'suspect' && !r.action).length;
      log(s, left ? `Pronto. ${left} suspeito(s) esperando sua decisão.` : 'Pronto. Celular limpo.', 'ok');
    } catch (e) {
      s.status = 'error';
      log(s, `Erro: ${e.message}`, 'warn');
    }
  }

  // ---------- monitor do cabo ----------

  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      if (!adb.findAdb()) { adbError = 'ADB não encontrado'; devices = []; return; }
      try {
        devices = await adb.devices();
        adbError = null;
      } catch (e) {
        devices = [];
        throw e;
      } finally {
        checkAdbServer();
      }
      const local = devices.filter((d) => !diagnose.isRemoteSerial(d.serial));
      // Celulares genéricos com o mesmo serial: o adb não separa, então não mexe em nenhum.
      const counts = local.reduce((m, d) => m.set(d.serial, (m.get(d.serial) || 0) + 1), new Map());
      const ready = local.filter((d) => d.state === 'device' && counts.get(d.serial) === 1);
      diag.unauthorizedSince = local.some((d) => d.state === 'unauthorized') ? (diag.unauthorizedSince || Date.now()) : null;
      if (!ready.length) refreshUsb();
      const connected = new Set(ready.map((d) => d.serial));
      for (const s of sessions.values()) {
        if (s.connected && !connected.has(s.serial)) {
          s.connected = false;
          log(s, 'Cabo desconectado.');
        }
      }
      for (const d of ready) {
        const s = sessions.get(d.serial);
        if (s && s.connected) continue;
        const ns = newSession(d);
        sessions.set(d.serial, ns);
        active = d.serial;
        log(ns, `Celular conectado: ${d.model || d.serial}`, 'ok');
        runFlow(ns);
      }
    } catch (e) {
      adbError = e.message;
    } finally {
      ticking = false;
    }
  }

  /** Versão do ADB brigando com outro programa, porta 5037 ocupada... */
  function checkAdbServer() {
    const err = adb.lastDevicesStderr() + '\n' + (adbError || '');
    const kind = diagnose.adbServerProblem(err);
    const now = Date.now();
    if (kind === 'version') diag.mismatches.push(now);
    diag.mismatches = diag.mismatches.filter((t) => now - t < 60000);
    // Uma troca de versão sozinha é normal (o adb resolve); repetindo é briga.
    const problem = kind === 'port' || kind === 'daemon' ? kind : diag.mismatches.length >= 2 ? 'version' : null;
    if (problem && !diag.problem) usb.portOwner().then((o) => { diag.rival = o && !o.mine ? o.label : null; }).catch(() => {});
    if (!problem) diag.rival = null;
    diag.problem = problem;
  }

  /** Pergunta ao Windows o que está no USB (no máximo a cada 4 s, sem travar o monitor). */
  function refreshUsb() {
    if (diag.usbBusy || Date.now() - diag.usbAt < 4000) return;
    diag.usbBusy = true;
    usb.scanUsb().then((u) => { diag.usb = u; }).catch(() => {}).finally(() => { diag.usbBusy = false; diag.usbAt = Date.now(); });
  }

  async function fix(kind) {
    if (kind === 'restart-adb') {
      const r = await usb.restartAdb();
      diag.mismatches = []; diag.problem = null;
      return r.ok ? 'ADB reiniciado.' : 'O ADB não reiniciou.';
    }
    if (kind === 'kill-rival') {
      const r = await usb.killRival();
      diag.mismatches = []; diag.problem = null; diag.rival = null;
      return r.killed ? `Fechei o ADB do ${r.killed} e iniciei o do MestreScan.` : 'ADB do MestreScan reiniciado.';
    }
    if (kind === 'samsung-driver') { usb.samsungDriver(); return 'Abrindo o instalador do driver Samsung numa janela nova.'; }
    if (kind === 'device-manager') { usb.deviceManager(); return 'Gerenciador de Dispositivos aberto.'; }
    throw new Error('Correção desconhecida');
  }

  // ---------- HTTP ----------

  function publicSession(s) {
    if (!s) return null;
    const { queue, lastRemoved, ...rest } = s;
    return rest;
  }

  function state() {
    return {
      brand,
      adb: { found: Boolean(adb.findAdb()), error: adbError },
      devices: devices.map((d) => ({ ...d, remote: diagnose.isRemoteSerial(d.serial) })),
      diag: diagnose.diagnose({
        adbFound: Boolean(adb.findAdb()), adbProblem: diag.problem, rival: diag.rival,
        devices, usb: diag.usb, unauthorizedSince: diag.unauthorizedSince,
      }),
      notes: diagnose.notes(devices),
      settings,
      sessions: [...sessions.values()].map((s) => ({ serial: s.serial, model: s.device.model, connected: s.connected, status: s.status })),
      session: publicSession(sessions.get(active)),
    };
  }

  function send(res, code, body, type = 'application/json; charset=utf-8') {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-App': 'MestreScan-PC' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
      req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    });
  }

  function serveStatic(res, urlPath) {
    const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.slice(1));
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Não encontrado', 'text/plain');
    let body = fs.readFileSync(file);
    if (rel === 'index.html') body = body.toString('utf8').replace('__TOKEN__', token);
    send(res, 200, body, MIME[path.extname(file)] || 'application/octet-stream');
  }

  const server = http.createServer(async (req, res) => {
    // Só aceita o próprio PC (protege contra páginas de fora e DNS rebinding).
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1'].includes(host)) return send(res, 403, 'Proibido', 'text/plain');
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (!p.startsWith('/api/') && p !== '/relatorio') return serveStatic(res, p);

    const given = req.headers['x-token'] || url.searchParams.get('t');
    if (given !== token) return send(res, 401, { error: 'Token inválido. Recarregue a página.' });

    const s = sessions.get(active);
    const needDevice = () => {
      if (!s || !s.connected) throw Object.assign(new Error('Nenhum celular conectado'), { code: 409 });
      return s;
    };

    try {
      if (req.method === 'GET' && p === '/api/state') return send(res, 200, state());

      if (req.method === 'GET' && p === '/relatorio') {
        if (!s) return send(res, 404, 'Nenhum atendimento ainda', 'text/plain');
        return send(res, 200, report.render(s, brand), MIME['.html']);
      }

      if (req.method === 'GET' && p.startsWith('/api/screens/')) {
        const file = actions.screenFile(p.slice('/api/screens/'.length));
        return file ? send(res, 200, fs.readFileSync(file), 'image/png') : send(res, 404, 'Não encontrado', 'text/plain');
      }

      if (req.method !== 'POST') return send(res, 405, { error: 'Método não permitido' });
      const body = await readBody(req);

      if (p === '/api/select') {
        if (!sessions.has(body.serial)) return send(res, 404, { error: 'Celular não encontrado' });
        active = body.serial;
        return send(res, 200, { ok: true });
      }
      if (p === '/api/settings') {
        if (typeof body.autoClean === 'boolean') settings.autoClean = body.autoClean;
        return send(res, 200, settings);
      }
      if (p === '/api/scan') {
        const cur = needDevice();
        enqueue(cur, 'scan', () => scanSession(cur)).then(() => { cur.status = 'done'; })
          .catch((e) => log(cur, `Erro: ${e.message}`, 'warn'));
        return send(res, 202, { ok: true });
      }
      if (p === '/api/action') {
        const cur = needDevice();
        const r = await enqueue(cur, body.action, () => act(cur, body.pkg, body.action));
        return send(res, 200, { ok: true, action: r.action });
      }
      if (p === '/api/screen') {
        const cur = needDevice();
        const shot = await enqueue(cur, 'screen', () => actions.captureScreen(cur.serial));
        const r = shot.foreground && cur.results.find((x) => x.pkg === shot.foreground.pkg);
        const item = { ...shot, at: Date.now(), suspect: r ? { pkg: r.pkg, label: r.label, score: r.score, level: r.level } : null };
        cur.screens.unshift(item);
        log(cur, shot.foreground ? `Foto da tela: em primeiro plano está ${shot.foreground.pkg}` : 'Foto da tela tirada.');
        return send(res, 200, item);
      }
      if (p === '/api/fix') {
        return send(res, 200, { ok: true, message: await fix(body.fix) });
      }
      if (p === '/api/open-admins') {
        const cur = needDevice();
        await actions.openAdminSettings(cur.serial);
        return send(res, 200, { ok: true });
      }
      if (p === '/api/install-mestrescan') {
        const cur = needDevice();
        log(cur, 'Instalando o MestreScan no celular…');
        await enqueue(cur, 'install', () => actions.installMestreScan(cur.serial, brand.mestrescanApkUrl)).catch((e) => {
          const hint = diagnose.actionHint(e.message, cur.device.manufacturer);
          if (hint) log(cur, hint, 'warn');
          throw e;
        });
        log(cur, 'MestreScan instalado.', 'ok');
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'Não encontrado' });
    } catch (e) {
      return send(res, e.code === 409 ? 409 : 500, { error: e.message });
    }
  });

  let timer = null;
  return {
    token,
    server,
    tick,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          tick();
          timer = setInterval(tick, monitorMs);
          resolve(server.address().port);
        });
      });
    },
    close() {
      clearInterval(timer);
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

/** A porta está com o MestreScan (já aberto) ou com outro programa? */
async function isMestreScan(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
    return r.headers.get('x-app') === 'MestreScan-PC';
  } catch { return false; }
}

async function start() {
  const first = Number(process.env.PORT) || 5757;
  // Se outro programa estiver na 5757, tenta as próximas.
  for (let port = first; port < first + 10; port++) {
    try {
      await createApp({ port }).listen();
    } catch (e) {
      if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
      if (await isMestreScan(port)) {
        console.log(`MestreScan PC já está aberto. Abrindo http://localhost:${port}`);
        openBrowser(`http://localhost:${port}`);
        setTimeout(() => process.exit(0), 1500);
        return;
      }
      console.log(`  Porta ${port} ocupada por outro programa, tentando a ${port + 1}...`);
      continue;
    }
    const url = `http://localhost:${port}`;
    console.log(`\n  MestreScan PC rodando em ${url}`);
    console.log(`  ADB: ${adb.findAdb() || 'NÃO ENCONTRADO'}`);
    console.log('  Deixe esta janela aberta. Para sair, feche a janela.\n');
    if (!process.env.NO_BROWSER) openBrowser(url);
    return;
  }
  throw new Error(`Nenhuma porta livre entre ${first} e ${first + 9}`);
}

if (require.main === module) {
  start().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { createApp };
