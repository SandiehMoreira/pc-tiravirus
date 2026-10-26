'use strict';
// Acha o adb (pasta runtime/, Android SDK ou PATH) e roda os comandos.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXE = process.platform === 'win32' ? 'adb.exe' : 'adb';

function candidates() {
  const env = process.env;
  const list = [];
  if (env.MESTRESCAN_ADB) list.push(env.MESTRESCAN_ADB);
  list.push(path.join(ROOT, 'runtime', 'platform-tools', EXE));
  for (const sdk of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    if (sdk) list.push(path.join(sdk, 'platform-tools', EXE));
  }
  if (env.LOCALAPPDATA) list.push(path.join(env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', EXE));
  const home = os.homedir();
  list.push(path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', EXE));
  list.push(path.join(home, 'Android', 'Sdk', 'platform-tools', EXE));
  list.push(path.join(home, 'android-dev', 'sdk', 'platform-tools', EXE));
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (dir) list.push(path.join(dir, EXE));
  }
  return list;
}

let cached;
function findAdb() {
  if (cached && fs.existsSync(cached)) return cached;
  cached = candidates().find((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  }) || null;
  return cached;
}

/** Roda o adb. O celular simulado dos testes é um .js, então roda com o próprio Node. */
function run(args, { timeout = 60000, binary = false } = {}) {
  const adb = findAdb();
  if (!adb) return Promise.reject(new Error('ADB não encontrado'));
  const [cmd, fullArgs] = adb.endsWith('.js') ? [process.execPath, [adb, ...args]] : [adb, args];
  return new Promise((resolve) => {
    execFile(cmd, fullArgs, {
      timeout,
      maxBuffer: 200 * 1024 * 1024,
      encoding: binary ? 'buffer' : 'utf8',
      windowsHide: true,
    }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        stdout: binary ? stdout : String(stdout || '').replace(/\r\n/g, '\n'),
        stderr: String(stderr || ''),
        timedOut: Boolean(err && err.killed),
      });
    });
  });
}

/** Comando no shell do celular; devolve o texto (saída + erro). */
async function shell(serial, command, opts) {
  const r = await run(['-s', serial, 'shell', command], opts);
  return (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim();
}

function parseDevices(text) {
  const out = [];
  for (const line of String(text).replace(/\r/g, '').split('\n')) {
    const m = line.match(/^(\S+)\s+(device|unauthorized|offline|authorizing|recovery|sideload|no permissions)\b(.*)$/);
    if (!m || line.startsWith('List of devices')) continue;
    const model = (m[3].match(/model:(\S+)/) || [])[1];
    out.push({ serial: m[1], state: m[2], model: model ? model.replace(/_/g, ' ') : null });
  }
  return out;
}

let lastStderr = '';
async function devices() {
  const r = await run(['devices', '-l'], { timeout: 15000 });
  lastStderr = r.stderr;
  if (r.code !== 0 && !r.stdout) throw new Error(r.stderr.trim() || 'adb devices falhou');
  return parseDevices(r.stdout);
}

/** Avisos do último "adb devices" (ex.: versão do servidor diferente = conflito). */
const lastDevicesStderr = () => lastStderr;

module.exports = { findAdb, run, shell, devices, lastDevicesStderr, parseDevices, ROOT };
