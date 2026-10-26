'use strict';
// Diagnóstico de conexão: junta o que o adb diz com o que o Windows vê no USB
// e explica para o técnico o que fazer (driver, depuração, permissão, conflito
// de ADB...). Também traduz erros conhecidos do Android em dicas.
// Tudo aqui é puro (sem rodar comando) para poder testar.

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LINKS = {
  samsung: 'https://developer.samsung.com/android-usb-driver',
  motorola: 'https://mobilesupport.lenovo.com/us/en/solution/MS88481',
  google: 'https://developer.android.com/studio/run/win-usb',
};

// Fabricantes pelo VID do USB.
const VENDORS = {
  '04E8': 'Samsung', '22B8': 'Motorola', '2717': 'Xiaomi', '18D1': 'Google/Android',
  '12D1': 'Huawei', '2A70': 'OnePlus', '22D9': 'Oppo/Realme', '2D95': 'Vivo',
  '0E8D': 'MediaTek', '1782': 'Unisoc', '05C6': 'Qualcomm', '19D2': 'ZTE',
  '17EF': 'Lenovo', '1004': 'LG', '0FCE': 'Sony', '0BB4': 'HTC', '1BBB': 'TCL/Alcatel',
  '2A45': 'Meizu', '1949': 'Amazon', '2E04': 'Nokia', '0489': 'Nokia/Sharp', '0B05': 'Asus',
  '0502': 'Acer', '2916': 'Positivo', '1EBF': 'Multilaser', '29A9': 'Infinix/Tecno',
};

// Programas que costumam ocupar o ADB (porta 5037) e brigar com o nosso.
const ADB_RIVALS = [
  [/hisuite/i, 'Huawei HiSuite'], [/mi ?pc ?suite|xiaomipcsuite|miassistant/i, 'Mi PC Suite'],
  [/smart ?switch/i, 'Samsung Smart Switch'], [/vysor/i, 'Vysor'], [/scrcpy/i, 'scrcpy'],
  [/studio64|android studio/i, 'Android Studio'], [/hd-adb|bluestacks/i, 'BlueStacks'],
  [/nox_adb|nox/i, 'NoxPlayer'], [/ldplayer|dnplayer/i, 'LDPlayer'], [/memu/i, 'MEmu'],
  [/wondershare|drfone|mobilego|mobiletrans/i, 'Wondershare / Dr.Fone'], [/airdroid/i, 'AirDroid'],
  [/tenorshare|reiboot|4ukey/i, 'Tenorshare'], [/360/i, '360 Mobile Assistant'],
];

function rivalName(processName, processPath) {
  const text = `${processName || ''} ${processPath || ''}`;
  const hit = ADB_RIVALS.find(([re]) => re.test(text));
  if (hit) return hit[1];
  // adb.exe solto: mostra de qual pasta ele é, para o técnico achar o programa.
  return processPath ? `${processName || 'adb'} (${processPath})` : (processName || 'outro programa');
}

/** Saída do PowerShell (Win32_PnPEntity em JSON) -> lista de interfaces USB. */
function parsePnp(json) {
  let list;
  try { list = JSON.parse(String(json || '').trim() || '[]'); } catch { return []; }
  if (!Array.isArray(list)) list = [list];
  return list.filter(Boolean).map((d) => {
    const id = String(d.DeviceID || '');
    const m = id.match(/VID_([0-9A-F]{4})&PID_([0-9A-F]{4})(?:&MI_([0-9A-F]{2}))?/i);
    return {
      id,
      vid: m ? m[1].toUpperCase() : null,
      pid: m ? m[2].toUpperCase() : null,
      mi: m && m[3] ? m[3] : null,
      name: String(d.Name || ''),
      cls: String(d.PNPClass || ''),
      service: String(d.Service || ''),
      error: Number(d.ConfigManagerErrorCode) || 0,
    };
  });
}

const isAdbIface = (e) => /AndroidUsbDeviceClass/i.test(e.cls) || /\badb\b|android composite|android bootloader/i.test(e.name);
const looksPhone = (e) => /^(WPD|AndroidUsbDeviceClass)$/i.test(e.cls) || /android|\badb\b|\bmtp\b|galaxy|redmi|moto/i.test(e.name);

/**
 * Agrupa as interfaces por aparelho e diz o que está faltando em cada um.
 * Retorna { phones: [{ brand, vid, adb: 'ok'|'no_driver'|'absent', errors }], usbFail }.
 */
function classifyUsb(entries) {
  const groups = new Map();
  let usbFail = false;
  for (const e of entries) {
    // "Dispositivo USB desconhecido (falha na solicitação de descritor)": cabo/porta.
    if (e.vid === '0000' || (e.error === 43 && !VENDORS[e.vid])) { usbFail = true; continue; }
    if (!e.vid) continue;
    const known = Boolean(VENDORS[e.vid]);
    if (!known && !looksPhone(e)) continue;
    const key = `${e.vid}:${e.pid}`;
    if (!groups.has(key)) groups.set(key, { vid: e.vid, pid: e.pid, brand: VENDORS[e.vid] || 'Android', entries: [] });
    groups.get(key).entries.push(e);
  }
  // Teclado/mouse da mesma marca (ex.: Samsung) não é celular.
  const phones = [];
  for (const g of groups.values()) {
    if (g.entries.every((e) => /^(HIDClass|Keyboard|Mouse|Bluetooth|Image|Monitor|Net|Ports|Media|AudioEndpoint)$/i.test(e.cls) && !looksPhone(e))) continue;
    const broken = g.entries.filter((e) => e.error);
    const adbIfaces = g.entries.filter(isAdbIface);
    let adb = 'absent';
    if (adbIfaces.some((e) => !e.error)) adb = 'ok';
    else if (broken.length) adb = 'no_driver';
    phones.push({ brand: g.brand, vid: g.vid, pid: g.pid, adb, errors: broken.map((e) => e.error), names: g.entries.map((e) => e.name).filter(Boolean) });
  }
  return { phones, usbFail };
}

/** Seriais que não são celular no cabo: emulador, Wi-Fi, BlueStacks (127.0.0.1:5555). */
function isRemoteSerial(serial) {
  return /^emulator-\d+$/.test(serial) || /^[\d.]+:\d+$/.test(serial) || /\._adb-tls-connect\._tcp/.test(serial) || /^\[?[0-9a-f:]+\]?:\d+$/i.test(serial);
}

/** Problema no servidor do ADB pela mensagem de erro. */
function adbServerProblem(text) {
  const t = String(text || '');
  if (/doesn't match this client|server version .* doesn't match/i.test(t)) return 'version';
  if (/cannot bind|smartsocket|address already in use|Only one usage of each socket address/i.test(t)) return 'port';
  if (/cannot connect to daemon|failed to start daemon|daemon not running.*failed|cannot connect to the adb server/i.test(t)) return 'daemon';
  return null;
}

function driverHelp(brand) {
  if (/samsung/i.test(brand)) {
    return {
      steps: ['Clique em <b>Instalar driver Samsung</b>: ele baixa do site da Samsung e abre o instalador (clique Sim e Next até o fim).',
        'Depois tire e coloque o cabo de novo.'],
      fixes: [{ fix: 'samsung-driver', label: 'Instalar driver Samsung' }],
    };
  }
  if (/motorola|lenovo/i.test(brand)) {
    return {
      steps: ['Baixe e instale o <b>Motorola Device Manager</b> (tem os drivers USB da Motorola).',
        'Depois tire e coloque o cabo de novo.'],
      fixes: [{ link: LINKS.motorola, label: 'Baixar driver Motorola' }],
    };
  }
  return {
    steps: [
      'Primeiro tente pelo Windows Update: <b>Configurações › Windows Update › Opções avançadas › Atualizações opcionais › Drivers</b>, marque o do celular e instale.',
      'Se não tiver: baixe o <b>Google USB Driver</b> e extraia. No Gerenciador de Dispositivos, clique com o botão direito no aparelho com ⚠ › <b>Atualizar driver › Procurar no computador › Permitir que eu escolha</b> › <b>Com disco</b> › aponte a pasta extraída › <b>Android ADB Interface</b>.',
    ],
    fixes: [{ fix: 'device-manager', label: 'Abrir Gerenciador de Dispositivos' }, { link: LINKS.google, label: 'Baixar Google USB Driver' }],
  };
}

/**
 * Situação atual -> o que mostrar na tela de espera.
 * input: { adbFound, adbProblem, rival, devices, usb, unauthorizedSince, now }
 * Retorna { code, title, text, steps[], fixes[] } (fixes: {fix,label} ou {link,label}).
 */
function diagnose(input) {
  const { adbFound, adbProblem, rival, devices = [], usb, unauthorizedSince, now = Date.now() } = input;
  const local = devices.filter((d) => !isRemoteSerial(d.serial));
  const restart = { fix: 'restart-adb', label: 'Reiniciar ADB' };

  if (!adbFound) {
    return { code: 'no_adb', title: 'ADB não encontrado',
      text: 'O programa que conversa com o celular (adb.exe) sumiu da pasta do MestreScan.',
      steps: ['Feche esta janela e abra de novo pelo atalho <b>MestreScan PC</b>: ele baixa o ADB sozinho.',
        'Se continuar, o antivírus pode ter apagado o adb.exe: libere a pasta do MestreScan PC no antivírus e reinstale.'],
      fixes: [] };
  }
  if (adbProblem) {
    const who = rival ? `<b>${esc(rival)}</b>` : 'outro programa';
    return { code: 'adb_conflict', title: 'Outro programa está usando o ADB',
      text: adbProblem === 'port'
        ? `A porta do ADB (5037) está ocupada por ${who}.`
        : `${who} está usando outra versão do ADB e os dois ficam brigando pelo celular.`,
      steps: [`Feche ${who} (veja também perto do relógio do Windows).`,
        'Ou clique em <b>Resolver conflito</b>: o MestreScan fecha o ADB do outro programa e inicia o dele.'],
      fixes: [{ fix: 'kill-rival', label: 'Resolver conflito' }] };
  }

  const serials = local.map((d) => d.serial);
  const dup = serials.find((s, i) => serials.indexOf(s) !== i);
  if (dup) {
    return { code: 'duplicate_serial', title: 'Dois celulares com o mesmo número de série',
      text: `Os aparelhos conectados se identificam igual (${esc(dup)}) e o ADB não consegue separar um do outro.`,
      steps: ['Deixe só um desses celulares no cabo de cada vez.'], fixes: [] };
  }

  if (local.some((d) => d.state === 'recovery' || d.state === 'sideload')) {
    return { code: 'recovery', title: 'Celular em modo de recuperação',
      text: 'Ele está no modo Recovery, não no Android normal.',
      steps: ['Escolha <b>Reboot system now</b> no celular e espere ligar.'], fixes: [] };
  }
  const unauthorized = local.find((d) => d.state === 'unauthorized');
  if (unauthorized) {
    const long = unauthorizedSince && now - unauthorizedSince > 40000;
    return { code: 'unauthorized', title: 'Olhe a tela do celular',
      text: 'Apareceu <b>"Permitir depuração USB?"</b>. Marque <b>"Sempre permitir deste computador"</b> e toque em <b>Permitir</b>.',
      steps: long ? [
        'Não apareceu a pergunta? Desbloqueie a tela, tire e coloque o cabo.',
        'Ainda não? Em <b>Opções do desenvolvedor</b> toque em <b>Revogar autorizações de depuração USB</b>, depois clique em <b>Reiniciar ADB</b>.',
        'Xiaomi/Oppo/Realme: troque o modo USB para <b>Transferência de arquivos</b>.',
      ] : ['Não apareceu? Desbloqueie a tela, tire e coloque o cabo de novo.'],
      fixes: long ? [restart] : [] };
  }
  if (local.some((d) => d.state === 'offline' || d.state === 'authorizing')) {
    return { code: 'offline', title: 'O celular não está respondendo',
      text: 'O ADB vê o aparelho, mas ele está "offline".',
      steps: ['Desbloqueie a tela do celular.', 'Tire e coloque o cabo de novo.', 'Se continuar, clique em <b>Reiniciar ADB</b>.'],
      fixes: [restart] };
  }

  const usbInfo = usb || { phones: [], usbFail: false };
  const noDriver = usbInfo.phones.find((p) => p.adb === 'no_driver');
  if (noDriver) {
    const help = driverHelp(noDriver.brand);
    return { code: 'no_driver', title: `Falta o driver USB (${noDriver.brand})`,
      text: 'O Windows está vendo o celular, mas sem o driver ele não deixa o ADB conversar com o aparelho.',
      steps: help.steps, fixes: help.fixes };
  }
  const adbOk = usbInfo.phones.find((p) => p.adb === 'ok');
  if (adbOk) {
    return { code: 'adb_not_listing', title: 'O celular está pronto, mas o ADB não o viu',
      text: `O Windows mostra o celular (${adbOk.brand}) com a depuração ligada.`,
      steps: ['Clique em <b>Reiniciar ADB</b>.', 'Se não resolver, tire e coloque o cabo.'],
      fixes: [restart] };
  }
  const plain = usbInfo.phones[0];
  if (plain) {
    const xiaomi = /xiaomi/i.test(plain.brand);
    return { code: 'no_debug', title: 'A depuração USB está desligada',
      text: `O Windows está vendo o celular (${plain.brand}) só para fotos e carregamento.`,
      steps: [
        'No celular: <b>Configurações › Sobre o telefone</b> › toque 7 vezes em <b>Número da versão</b>' + (xiaomi ? ' (Xiaomi: <b>Versão do MIUI/HyperOS</b>)' : '') + '.',
        'Volte, abra <b>Opções do desenvolvedor</b> e ligue a <b>Depuração USB</b>.',
        xiaomi ? 'Xiaomi: ligue também <b>Depuração USB (Configurações de segurança)</b>, senão ele não deixa remover.' : 'Se a depuração já está ligada, troque o modo USB para <b>Transferência de arquivos</b>.',
      ].filter(Boolean),
      fixes: [] };
  }
  if (usbInfo.usbFail) {
    return { code: 'usb_fail', title: 'O Windows não reconheceu o aparelho USB',
      text: 'Apareceu um "Dispositivo USB desconhecido": quase sempre é cabo ou porta.',
      steps: ['Troque o cabo (use um de dados, de preferência o original).', 'Use uma porta atrás do PC, sem hub ou extensão.', 'Limpe o conector do celular.'],
      fixes: [] };
  }
  return { code: 'waiting', title: 'Plugue o celular no cabo',
    text: 'Assim que ele conectar, o MestreScan escaneia e remove os vírus sozinho.',
    steps: [
      'No celular, vá em <b>Configurações › Sobre o telefone</b> e toque 7 vezes em <b>Número da versão</b> (Xiaomi: <b>Versão do MIUI/HyperOS</b>).',
      'Volte e abra <b>Opções do desenvolvedor</b>. Ligue a <b>Depuração USB</b>.',
      'Plugue o cabo e toque em <b>Permitir</b>.',
    ],
    trouble: ['O celular nem carrega ou não aparece nada: troque o cabo (alguns são só de carga) e use uma porta atrás do PC.',
      'Desbloqueie a tela do celular.'],
    fixes: [] };
}

/** Avisos que valem mesmo com celular conectado (texto puro: a tela escapa). */
function notes(devices = []) {
  const remote = devices.filter((d) => isRemoteSerial(d.serial));
  return remote.length
    ? [`Ignorando ${remote.length} conexão(ões) que não são pelo cabo (emulador ou Wi-Fi): ${remote.map((d) => d.serial).join(', ')}.`]
    : [];
}

/** Erro conhecido do Android -> dica para o técnico. */
function actionHint(text, manufacturer = '') {
  const t = String(text || '');
  const brand = String(manufacturer || '').toLowerCase();
  if (/USB debugging \(Security settings\)|WRITE_SECURE_SETTINGS|MANAGE_APP_OPS_MODES|GRANT_RUNTIME_PERMISSIONS/i.test(t) ||
      (/xiaomi|redmi|poco/.test(brand) && /SecurityException|Permission Denial/i.test(t))) {
    if (/xiaomi|redmi|poco/.test(brand)) return 'Xiaomi bloqueou: em Opções do desenvolvedor ligue "Depuração USB (Configurações de segurança)" (pede chip e conta Mi) e tente de novo.';
    if (/oppo|realme|oneplus/.test(brand)) return 'Oppo/Realme bloqueou: em Opções do desenvolvedor ligue "Desativar monitoramento de permissões" e tente de novo.';
    return 'O Android bloqueou a mudança de permissão pelo cabo. Veja nas Opções do desenvolvedor se há uma opção de segurança da depuração USB.';
  }
  if (/INSTALL_FAILED_USER_RESTRICTED/.test(t)) {
    return /xiaomi|redmi|poco/.test(brand)
      ? 'Xiaomi bloqueou a instalação: ligue "Instalar via USB" nas Opções do desenvolvedor e confirme na tela do celular.'
      : 'O celular bloqueou a instalação pelo cabo: confirme na tela do celular ou desligue a verificação de apps via USB.';
  }
  if (/DELETE_FAILED_USER_RESTRICTED|DELETE_FAILED_OWNER_BLOCKED|uninstall-blocked/i.test(t)) {
    return 'Este app está protegido pela empresa/gerenciador do aparelho (MDM). Não dá para remover pelo cabo; ele foi desativado se possível.';
  }
  if (/INSTALL_FAILED_VERSION_DOWNGRADE|INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(t)) return 'Já existe outra versão do app no celular: desinstale ela e tente de novo.';
  if (/INSTALL_FAILED_INSUFFICIENT_STORAGE/.test(t)) return 'Celular sem espaço: libere armazenamento e tente de novo.';
  if (/device offline|device '.*' not found|no devices\/emulators found|device not found/i.test(t)) return 'O cabo soltou ou o celular travou no meio. Reconecte e clique em "Tentar de novo".';
  if (/more than one device/i.test(t)) return 'Há dois aparelhos com o mesmo número de série: deixe só um no cabo.';
  return null;
}

module.exports = { VENDORS, LINKS, parsePnp, classifyUsb, isRemoteSerial, adbServerProblem, rivalName, diagnose, notes, actionHint };
