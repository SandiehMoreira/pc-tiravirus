#!/usr/bin/env node
'use strict';
// Celular simulado: responde como o adb, lendo e gravando o estado num JSON
// (caminho em FAKE_ADB_STATE). Usado pelos testes no lugar do adb de verdade.
const fs = require('fs');

const STATE = process.env.FAKE_ADB_STATE;
const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
const out = (s) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');

let args = process.argv.slice(2);
if (args[0] === 'devices') {
  out('List of devices attached');
  for (const d of st.devices) out(`${d.serial}\t${d.state} product:x model:${d.model} device:x transport_id:1`);
  process.exit(0);
}
if (args[0] === '-s') args = args.slice(2);

const pkgs = st.packages;
const admins = () => Object.entries(pkgs).filter(([, p]) => p.admin).map(([, p]) => p.admin);
const accList = () => st.accessibility || [];

function shell(cmd) {
  // Vários comandos com ";" (ex.: lote do appops).
  if (/^echo "##/.test(cmd) && cmd.includes("; ")) {
    return cmd.split('; ').map(shell).join('\n');
  }
  let m;
  if ((m = cmd.match(/^echo "(.*)"$/))) return m[1];
  if (cmd.startsWith('getprop')) return [st.props.manufacturer, st.props.model, st.props.release, st.props.sdk].join('\n');
  if (cmd === 'pm list packages -3 -i') return Object.entries(pkgs).map(([n, p]) => `package:${n}  installer=${p.installer || 'null'}`).join('\n');
  if (cmd === 'pm list packages -3 -d') return Object.entries(pkgs).filter(([, p]) => p.disabled).map(([n]) => `package:${n}`).join('\n');
  if (cmd.includes('query-activities') && cmd.includes('LAUNCHER')) {
    return Object.entries(pkgs).filter(([, p]) => p.launcher).map(([n]) => `priority=0 preferredOrder=0 match=0x108000\n  ${n}/.MainActivity`).join('\n');
  }
  if (cmd.includes('query-activities') && cmd.includes('HOME')) return st.homes.map((h) => `  ${h}/.Launcher`).join('\n');
  if (cmd.includes('query-receivers')) return Object.entries(pkgs).filter(([, p]) => p.bootReceiver).map(([n]) => `  ${n}/.BootReceiver`).join('\n');
  if (cmd === 'dumpsys device_policy') {
    return 'Current Device Policy Manager state:\n  Enabled Device Admins (User 0, provisioningState: 0):\n' +
      admins().map((a) => `    ${a}:\n      uid=10123\n      testOnlyAdmin=false`).join('\n');
  }
  if (cmd === 'settings get secure enabled_accessibility_services') return accList().length ? accList().join(':') : 'null';
  if ((m = cmd.match(/^settings put secure enabled_accessibility_services '(.*)'$/))) { st.accessibility = m[1].split(':'); save(); return ''; }
  if (cmd.startsWith('settings delete secure enabled_accessibility_services')) { st.accessibility = []; save(); return ''; }
  if (cmd === 'dumpsys package packages') {
    let s = 'Packages:\n';
    for (const [n, p] of Object.entries(pkgs)) {
      s += `  Package [${n}] (1a2b3c):\n    userId=10123\n    firstInstallTime=${p.firstInstall}\n    installerPackageName=${p.installer || 'null'}\n`;
      s += `    requested permissions:\n${(p.perms || []).map((x) => `      ${x}`).join('\n')}\n    install permissions:\n      android.permission.INTERNET: granted=true\n`;
      s += `    User 0: ceDataInode=1 installed=true hidden=false suspended=false stopped=false enabled=${p.disabled ? 3 : 0}\n`;
    }
    return s + '\nShared users:\n';
  }
  if (cmd === 'dumpsys usagestats') return (st.usage || []).map((l) => `        ${l}`).join('\n');
  if (cmd.startsWith('date ')) return `${st.now}\n${st.uptime}.00 1000.00`;
  if ((m = cmd.match(/^appops get (\S+) SYSTEM_ALERT_WINDOW$/))) {
    const p = pkgs[m[1]];
    return p && p.overlay ? `SYSTEM_ALERT_WINDOW: ${p.overlay}; time=+1d` : 'No operations.';
  }
  if ((m = cmd.match(/^appops set (\S+) SYSTEM_ALERT_WINDOW deny$/))) { if (pkgs[m[1]]) { pkgs[m[1]].overlay = 'deny'; save(); } return ''; }
  if (cmd.startsWith('am force-stop')) return '';
  if (cmd.startsWith('am start')) { st.openedAdmins = (st.openedAdmins || 0) + 1; save(); return 'Starting: Intent { cmp=com.android.settings/.DeviceAdminSettings }'; }
  if ((m = cmd.match(/^pm path (\S+)$/))) return pkgs[m[1]] ? `package:/data/app/~~x==/${m[1]}-1/base.apk` : '';
  if ((m = cmd.match(/^dpm remove-active-admin --user 0 '(.+)'$/))) {
    const p = Object.values(pkgs).find((x) => x.admin === m[1]);
    if (!p) return 'Error: no admin';
    if (p.adminLocked) return 'java.lang.SecurityException: Attempt to remove non-test admin ComponentInfo{' + m[1] + '}';
    delete p.admin; save();
    return 'Success: Admin removed ComponentInfo{' + m[1] + '}';
  }
  if ((m = cmd.match(/^pm uninstall (?:--user 0 )?(\S+)$/))) {
    const p = pkgs[m[1]];
    if (!p) return 'Failure [DELETE_FAILED_INTERNAL_ERROR]';
    if (p.admin) return 'Failure [DELETE_FAILED_DEVICE_POLICY_MANAGER]';
    delete pkgs[m[1]]; save();
    return 'Success';
  }
  if ((m = cmd.match(/^pm disable-user --user 0 (\S+)$/))) {
    if (!pkgs[m[1]]) return 'Error: unknown package';
    pkgs[m[1]].disabled = true; save();
    return `Package ${m[1]} new state: disabled-user`;
  }
  if ((m = cmd.match(/^pm enable (\S+)$/))) {
    if (!pkgs[m[1]]) return 'Error: unknown package';
    pkgs[m[1]].disabled = false; save();
    return `Package ${m[1]} new state: enabled`;
  }
  if (cmd.startsWith('dumpsys activity activities')) return st.foreground ? `  mResumedActivity: ActivityRecord{a1b2c3 u0 ${st.foreground} t12}` : '';
  if (cmd.startsWith('dumpsys window')) return '';
  return `/system/bin/sh: ${cmd.split(' ')[0]}: inaccessible or not found`;
}

const [verb, ...rest] = args;
if (verb === 'shell') {
  out(shell(rest.join(' ')));
} else if (verb === 'pull') {
  fs.writeFileSync(rest[1], `APK FALSO de ${rest[0]}`);
  out('1 file pulled.');
} else if (verb === 'exec-out') {
  // FAKE_SCREEN_PNG: imagem de verdade para demonstração.
  if (process.env.FAKE_SCREEN_PNG) { process.stdout.write(fs.readFileSync(process.env.FAKE_SCREEN_PNG)); process.exit(0); }
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]);
  process.stdout.write(png);
} else if (verb === 'install') {
  st.installed = (st.installed || []).concat(rest[rest.length - 1]); save();
  out('Performing Streamed Install\nSuccess');
} else {
  process.stderr.write(`fake-adb: comando desconhecido ${args.join(' ')}\n`);
  process.exit(1);
}
