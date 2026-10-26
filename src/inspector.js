'use strict';
// Lê o celular pelo adb e transforma a saída dos comandos em dados.
// Os parsers são funções puras para poderem ser testadas sem celular.
const adb = require('./adb');

const PERM_OVERLAY = 'android.permission.SYSTEM_ALERT_WINDOW';
const PERM_INSTALL = 'android.permission.REQUEST_INSTALL_PACKAGES';
const PERM_BOOT = 'android.permission.RECEIVE_BOOT_COMPLETED';
const STARTUP_DELAY_MS = 90000; // o evento "ligou" é gravado um pouco depois do boot real
const SAME_BOOT_MS = 150000;
const NOT_APPS = new Set(['android', 'com.android.systemui']);

const lines = (t) => String(t || '').replace(/\r/g, '').split('\n');

/** Data do celular ("2026-10-25 20:19:49") em ms. Tudo é comparado no mesmo relógio. */
function parseTime(s) {
  const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

/** pm list packages -3 -i */
function parsePackageList(text) {
  const out = [];
  for (const l of lines(text)) {
    const m = l.trim().match(/^package:(\S+?)(?:\s+installer=(\S+))?$/);
    if (m) out.push({ pkg: m[1], installer: !m[2] || m[2] === 'null' ? null : m[2] });
  }
  return out;
}

/** cmd package query-activities/query-receivers --brief. null = o Android não tem o comando. */
function parseComponents(text) {
  const set = new Set();
  for (const l of lines(text)) {
    const m = l.trim().match(/^([A-Za-z][\w.]*)\/([\w.$]+)$/);
    if (m) set.add(m[1]);
  }
  if (!set.size && /unknown|error|exception|usage/i.test(text)) return null;
  return set;
}

/** dumpsys device_policy: administradores ativos. */
function parseDeviceAdmins(text) {
  const out = [];
  const seen = new Set();
  const add = (pkg, cls) => {
    const component = `${pkg}/${cls}`;
    if (!seen.has(component)) { seen.add(component); out.push({ pkg, component }); }
  };
  for (const l of lines(text)) {
    let m = l.match(/^\s+([A-Za-z][\w.]*)\/([\w.$]+):\s*$/);
    if (m) { add(m[1], m[2]); continue; }
    m = l.match(/admin=ComponentInfo\{([\w.]+)\/([\w.$]+)\}/);
    if (m) add(m[1], m[2]);
  }
  return out;
}

/** settings get secure enabled_accessibility_services ("pkg/Classe:pkg2/Classe2") */
function parseAccessibility(text) {
  const t = String(text || '').trim();
  if (!t || t === 'null') return [];
  return t.split(':').map((s) => s.trim()).filter((s) => s.includes('/'));
}

/** dumpsys package packages: data de instalação, loja, permissões pedidas e se está desativado. */
function parsePackageDump(text) {
  const map = new Map();
  let cur = null;
  let inRequested = false;
  for (const l of lines(text)) {
    const head = l.match(/^\s{1,4}Package \[([^\]]+)\]/);
    if (head) {
      cur = map.has(head[1]) ? null : { pkg: head[1], requested: new Set(), firstInstallTime: null, installer: null, enabledState: null };
      if (cur) map.set(head[1], cur);
      inRequested = false;
      continue;
    }
    if (!cur) continue;
    if (/^\S/.test(l)) { cur = null; continue; }
    let m;
    if ((m = l.match(/^\s+firstInstallTime=(.+)$/))) { cur.firstInstallTime = parseTime(m[1]); inRequested = false; continue; }
    if ((m = l.match(/installerPackageName=(\S+)/)) && m[1] !== 'null' && !cur.installer) cur.installer = m[1];
    if ((m = l.match(/^\s+User 0:.*\benabled=(\d+)/))) { cur.enabledState = Number(m[1]); inRequested = false; continue; }
    if (/^\s+requested permissions:/.test(l)) { inRequested = true; continue; }
    if (/^\s+\w[\w ]*permissions:/.test(l)) { inRequested = false; continue; }
    if (inRequested) {
      m = l.match(/^\s+([\w.]+\.[\w.]+)(?::.*)?\s*$/);
      if (m) cur.requested.add(m[1]); else inRequested = false;
    }
  }
  return map;
}

/** Saída de vários "appops get <pkg> SYSTEM_ALERT_WINDOW" separados por "##pkg". */
function parseOverlayBatch(text) {
  const out = new Map();
  let pkg = null;
  for (const l of lines(text)) {
    const h = l.match(/^##(\S+)/);
    if (h) { pkg = h[1]; out.set(pkg, 'requested'); continue; }
    if (pkg && /SYSTEM_ALERT_WINDOW:\s*allow/.test(l)) out.set(pkg, 'granted');
  }
  return out;
}

/** dumpsys usagestats: eventos com horário, tipo, app e tela. */
function parseUsageEvents(text) {
  const seen = new Set();
  const events = [];
  const re = /time="([^"]+)"\s+type=(\w+)(?:\s+package=(\S+))?(?:\s+class=(\S+))?/;
  for (const l of lines(text)) {
    const m = l.match(re);
    if (!m) continue;
    const t = parseTime(m[1]);
    if (t == null) continue;
    const type = m[2] === 'MOVE_TO_FOREGROUND' ? 'ACTIVITY_RESUMED' : m[2];
    const key = `${m[1]}|${type}|${m[3]}|${m[4]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ t, type, pkg: m[3] || null, cls: m[4] || null });
  }
  return events.sort((a, b) => a.t - b.t);
}

function isAdScreen(rules, cls) {
  if (!cls) return false;
  const c = cls.toLowerCase();
  return rules.adScreenPatterns.some((p) => c.includes(p.toLowerCase()));
}

/**
 * Mesma lógica do BootObserver do APK: quem abriu tela nos primeiros minutos
 * depois de ligar sem o usuário tocar no ícone. E, fora do boot, propaganda
 * que abriu por cima de outro app (regra ad_screen_seen).
 */
function analyzeUsage({ events, userPkgs, launcher, homes, rules, nowLocal, uptimeSec }) {
  const windowMs = rules.bootWindowSeconds * 1000;
  const hasKeyguard = events.some((e) => e.type === 'KEYGUARD_HIDDEN' || e.type === 'KEYGUARD_SHOWN');
  const hasIcon = (pkg) => (launcher ? launcher.has(pkg) : true);

  let boots = [];
  let lastShutdown = 0;
  for (const e of events) {
    if (e.type === 'DEVICE_SHUTDOWN') lastShutdown = e.t;
    if (e.type === 'DEVICE_STARTUP') boots.push(Math.max(lastShutdown, e.t - STARTUP_DELAY_MS));
  }
  if (nowLocal && uptimeSec != null && events.length) {
    const current = nowLocal - Math.round(uptimeSec * 1000);
    if (events[0].t <= current + windowMs) boots.push(current);
  }
  boots.sort((a, b) => a - b);
  boots = boots.filter((b, i) => i === 0 || b - boots[i - 1] >= SAME_BOOT_MS);

  const records = boots.map((bootTime) => {
    const end = bootTime + windowMs;
    let unlocked = !hasKeyguard;
    let previous = null;
    const found = new Map();
    for (const e of events) {
      if (e.t < bootTime || e.t > end) continue;
      if (e.type === 'KEYGUARD_HIDDEN') unlocked = true;
      else if (e.type === 'KEYGUARD_SHOWN') unlocked = false;
      else if (e.type === 'ACTIVITY_RESUMED' && e.pkg) {
        if (userPkgs.has(e.pkg)) {
          const ad = isAdScreen(rules, e.cls);
          const existing = found.get(e.pkg);
          if (!existing) {
            const icon = hasIcon(e.pkg);
            const fromHome = homes.size === 0 || homes.has(previous);
            found.set(e.pkg, {
              pkg: e.pkg,
              seconds: Math.max(0, Math.round((e.t - bootTime) / 1000)),
              cls: e.cls,
              adScreen: ad,
              beforeUnlock: !unlocked,
              hasIcon: icon,
              selfStarted: !icon || ad || !unlocked || !fromHome,
            });
          } else if (ad && !existing.adScreen) {
            Object.assign(existing, { adScreen: true, cls: e.cls, selfStarted: true });
          }
        }
        previous = e.pkg;
      }
    }
    return { bootTime, launches: [...found.values()] };
  });

  const evidence = {};
  for (const r of records) {
    for (const l of r.launches.filter((x) => x.selfStarted)) {
      const ev = evidence[l.pkg] || (evidence[l.pkg] = { bootsWithLaunch: 0, totalBoots: records.length, firstSeconds: l.seconds, adScreen: false });
      ev.bootsWithLaunch++;
      ev.firstSeconds = Math.min(ev.firstSeconds, l.seconds);
      ev.adScreen = ev.adScreen || l.adScreen;
    }
  }

  const adSeen = {};
  let prev = null;
  for (const e of events) {
    if (e.type !== 'ACTIVITY_RESUMED' || !e.pkg) continue;
    if (userPkgs.has(e.pkg) && isAdScreen(rules, e.cls) && prev && prev !== e.pkg &&
        !NOT_APPS.has(prev) && (!homes.has(prev) || !hasIcon(e.pkg))) {
      const a = adSeen[e.pkg] || (adSeen[e.pkg] = { count: 0, over: [], last: 0 });
      a.count++;
      a.last = Math.max(a.last, e.t);
      if (!a.over.includes(prev)) a.over.push(prev);
    }
    prev = e.pkg;
  }

  return { boots: records, evidence, adSeen };
}

/** App em primeiro plano (dumpsys activity / window). */
function parseForeground(text) {
  const patterns = [
    /(?:mResumedActivity|topResumedActivity|ResumedActivity)[:=]\s*ActivityRecord\{\S+ \S+ ([\w.]+)\/([\w.$]+)/,
    /mCurrentFocus=Window\{\S+ \S+ ([\w.]+)\/([\w.$]+)/,
    /mFocusedApp=.*?ActivityRecord\{\S+ \S+ ([\w.]+)\/([\w.$]+)/,
  ];
  for (const re of patterns) {
    const m = String(text || '').match(re);
    if (m) return { pkg: m[1], cls: m[2].startsWith('.') ? m[1] + m[2] : m[2] };
  }
  return null;
}

/** Sem rótulo pelo adb: monta um nome legível a partir do pacote. */
function labelFromPackage(pkg) {
  const parts = pkg.split('.').filter((p) => !['com', 'br', 'org', 'net', 'app', 'apps', 'android', 'mobile', 'io', 'co'].includes(p.toLowerCase()));
  return (parts.length ? parts : [pkg]).join(' ');
}

async function deviceInfo(serial) {
  const out = lines(await adb.shell(serial,
    'getprop ro.product.manufacturer; getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.version.sdk'));
  return { serial, manufacturer: out[0] || '', model: out[1] || '', android: out[2] || '', sdk: Number(out[3]) || null };
}

async function currentAdmins(serial) {
  return parseDeviceAdmins(await adb.shell(serial, 'dumpsys device_policy'));
}

async function foreground(serial) {
  return parseForeground(await adb.shell(serial, 'dumpsys activity activities | grep -E "ResumedActivity"')) ||
    parseForeground(await adb.shell(serial, 'dumpsys window | grep -E "mCurrentFocus|mFocusedApp"'));
}

/** Escaneia o celular inteiro e devolve os apps de usuário com os sinais de cada um. */
async function scan(serial, rules) {
  const sh = (c) => adb.shell(serial, c, { timeout: 120000 });
  const [device, pkgText, disabledText, launcherText, homeText, bootText, adminText, accText, dumpText, usageText, timeText] = await Promise.all([
    deviceInfo(serial),
    sh('pm list packages -3 -i'),
    sh('pm list packages -3 -d'),
    sh('cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER'),
    sh('cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.HOME'),
    sh('cmd package query-receivers --brief -a android.intent.action.BOOT_COMPLETED'),
    sh('dumpsys device_policy'),
    sh('settings get secure enabled_accessibility_services'),
    sh('dumpsys package packages'),
    sh('dumpsys usagestats'),
    sh("date '+%Y-%m-%d %H:%M:%S'; cat /proc/uptime"),
  ]);

  const packages = parsePackageList(pkgText);
  const userPkgs = new Set(packages.map((p) => p.pkg));
  const disabled = new Set(parsePackageList(disabledText).map((p) => p.pkg));
  const launcherRaw = parseComponents(launcherText);
  const launcher = launcherRaw && launcherRaw.size ? launcherRaw : null;
  const homes = parseComponents(homeText) || new Set();
  const bootReceivers = parseComponents(bootText) || new Set();
  const admins = parseDeviceAdmins(adminText);
  const accessibility = parseAccessibility(accText);
  const dump = parsePackageDump(dumpText);
  const [nowLine, uptimeLine] = lines(timeText);
  const nowLocal = parseTime(nowLine) || Date.now();
  const uptimeSec = parseFloat(uptimeLine) || null;

  const overlayAsked = packages.filter((p) => dump.get(p.pkg)?.requested.has(PERM_OVERLAY)).map((p) => p.pkg);
  let overlay = new Map();
  if (overlayAsked.length) {
    overlay = parseOverlayBatch(await sh(overlayAsked.map((p) => `echo "##${p}"; appops get ${p} SYSTEM_ALERT_WINDOW`).join('; ')));
  }

  const usage = analyzeUsage({ events: parseUsageEvents(usageText), userPkgs, launcher, homes, rules, nowLocal, uptimeSec });

  const apps = packages.map(({ pkg, installer }) => {
    const d = dump.get(pkg) || { requested: new Set() };
    return {
      pkg,
      label: labelFromPackage(pkg),
      installer: installer || d.installer || null,
      installedAt: d.firstInstallTime || null,
      hasLauncherIcon: launcher ? launcher.has(pkg) : true,
      admins: admins.filter((a) => a.pkg === pkg).map((a) => a.component),
      accessibility: accessibility.filter((c) => c.split('/')[0] === pkg),
      overlay: d.requested.has(PERM_OVERLAY) ? (overlay.get(pkg) || 'requested') : 'none',
      canInstallApps: d.requested.has(PERM_INSTALL),
      startsOnBoot: bootReceivers.has(pkg) || d.requested.has(PERM_BOOT),
      enabled: !disabled.has(pkg),
    };
  });

  return { device, apps, nowLocal, launcherKnown: Boolean(launcher), ...usage };
}

module.exports = {
  scan, deviceInfo, currentAdmins, foreground,
  parseTime, parsePackageList, parseComponents, parseDeviceAdmins, parseAccessibility,
  parsePackageDump, parseOverlayBatch, parseUsageEvents, analyzeUsage, parseForeground,
  labelFromPackage, isAdScreen,
};
