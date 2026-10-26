'use strict';
const TOKEN = document.querySelector('meta[name=token]').content;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

let state = null;
let lastJson = '';
let busyLocal = false;

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Token': TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

function toast(text, ms = 4000) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
}

async function poll() {
  try {
    const s = await api('/api/state');
    const json = JSON.stringify(s);
    if (json !== lastJson) { lastJson = json; state = s; render(); }
  } catch (e) {
    $('cableText').textContent = 'MestreScan PC fechado';
    $('cable').className = 'cable warn';
  }
  setTimeout(poll, 1000);
}

// ---------- tela ----------

const STATUS = {
  connecting: 'Conectando…',
  scanning: 'Escaneando os apps…',
  cleaning: 'Removendo os perigosos…',
  done: 'Pronto.',
  error: 'Deu erro. Veja o registro.',
};
const BADGE = {
  removed: 'Removido',
  disabled: 'Desativado',
  admin_locked: 'Administrador travado',
  enabled: 'Reativado',
  error: 'Não consegui',
};

function render() {
  const { brand, adb, devices, session, sessions } = state;
  document.title = brand.app;
  $('appName').textContent = brand.app;
  $('slogan').textContent = brand.slogan;
  for (const [k, v] of Object.entries(brand.colors || {})) {
    document.documentElement.style.setProperty('--' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), v);
  }

  const ready = devices.filter((d) => d.state === 'device' && !d.remote);
  const unauthorized = devices.find((d) => d.state === 'unauthorized' && !d.remote);
  const cable = $('cable');
  if (!adb.found) { cable.className = 'cable warn'; $('cableText').textContent = 'ADB não encontrado'; }
  else if (ready.length) { cable.className = 'cable on'; $('cableText').textContent = ready.length > 1 ? `${ready.length} celulares` : (ready[0].model || ready[0].serial); }
  else if (unauthorized) { cable.className = 'cable warn'; $('cableText').textContent = 'Aguardando permissão no celular'; }
  else if (state.diag && !['waiting', 'unauthorized'].includes(state.diag.code)) { cable.className = 'cable warn'; $('cableText').textContent = state.diag.title; }
  else { cable.className = 'cable'; $('cableText').textContent = 'Nenhum celular'; }

  renderWaiting(state.diag, session);
  renderNotes(state.notes || []);
  renderTabs(sessions, session);
  if (session) renderSession(session);
}

const DIAG_ICON = { waiting: '🔌', unauthorized: '📱', no_driver: '🧩', no_debug: '🛠️', adb_conflict: '⚔️', usb_fail: '🔌', offline: '📵', recovery: '🔁', duplicate_serial: '👯', adb_not_listing: '🔄', no_adb: '⚠️' };

function renderWaiting(diag, session) {
  const w = $('waiting');
  if (session || !diag) { w.classList.add('hidden'); return; }
  // Os textos do diagnóstico vêm prontos (com <b>) do servidor; o que veio do celular já foi escapado lá.
  const fixes = (diag.fixes || []).map((x) => x.link
    ? `<a class="btn" href="${esc(x.link)}" target="_blank" rel="noopener">${esc(x.label)} ↗</a>`
    : `<button class="primary" data-fix="${esc(x.fix)}">${esc(x.label)}</button>`).join('');
  const steps = diag.steps && diag.steps.length ? `<ol>${diag.steps.map((x) => `<li>${x}</li>`).join('')}</ol>` : '';
  const trouble = diag.trouble ? `<details><summary>Plugou e nada aconteceu?</summary><ul>${diag.trouble.map((x) => `<li>${x}</li>`).join('')}</ul></details>` : '';
  w.className = 'card' + (diag.code === 'waiting' ? '' : ' alert');
  w.innerHTML = `<div class="phone">${DIAG_ICON[diag.code] || '🔌'}</div><h1>${diag.title}</h1>
    <p${diag.code === 'waiting' ? ' class="muted"' : ''}>${diag.text}</p>${steps}
    ${fixes ? `<div class="fixes">${fixes}</div>` : ''}${trouble}`;
}

function renderNotes(notes) {
  const n = $('notes');
  n.classList.toggle('hidden', !notes.length);
  n.innerHTML = notes.map((x) => `<div>ℹ️ ${esc(x)}</div>`).join('');
}

function renderTabs(sessions, session) {
  const tabs = $('tabs');
  if (sessions.length < 2) { tabs.classList.add('hidden'); return; }
  tabs.classList.remove('hidden');
  tabs.innerHTML = sessions.map((s) => `<button data-serial="${esc(s.serial)}" class="${session && s.serial === session.serial ? 'on' : ''}">
    ${esc(s.model || s.serial)}${s.connected ? '' : ' (desconectado)'}</button>`).join('');
}

function renderSession(s) {
  $('session').classList.remove('hidden');
  const d = s.device || {};
  $('devName').textContent = [d.manufacturer, d.model].filter(Boolean).join(' ') || d.serial;
  $('devSub').textContent = `${d.android ? 'Android ' + d.android + ' · ' : ''}${s.connected ? 'conectado' : 'cabo desconectado'}`;

  const results = s.results || [];
  const dangers = results.filter((r) => r.level === 'danger');
  const suspects = results.filter((r) => r.level === 'suspect');
  const safe = results.filter((r) => r.level === 'safe');
  $('nDanger').textContent = dangers.filter((r) => !r.action).length;
  $('nSuspect').textContent = suspects.filter((r) => !r.action).length;
  $('nDone').textContent = results.filter((r) => r.action && ['removed', 'disabled', 'admin_locked'].includes(r.action.state)).length;
  $('nTotal').textContent = results.length;
  $('nSafe').textContent = safe.length;

  const st = $('status');
  const working = s.busy || ['connecting', 'scanning', 'cleaning'].includes(s.status);
  st.textContent = s.busy === 'screen' ? 'Tirando foto da tela…' : s.busy === 'install' ? 'Instalando o MestreScan…' : STATUS[s.status] || '';
  st.className = 'status' + (working ? ' spin' : '');

  for (const id of ['btnScan', 'btnScreen', 'btnAdmins', 'btnInstall']) $(id).disabled = !s.connected || Boolean(working) || busyLocal;
  $('autoClean').checked = state.settings.autoClean;

  const disabled = !s.connected || Boolean(s.busy) || busyLocal;
  $('listDanger').innerHTML = dangers.length ? dangers.map((r) => appCard(r, disabled)).join('') : '<div class="empty">Nenhum app perigoso.</div>';
  $('listSuspect').innerHTML = suspects.length ? suspects.map((r) => appCard(r, disabled)).join('') : '<div class="empty">Nenhum suspeito.</div>';
  $('listSafe').innerHTML = safe.map((r) => appCard(r, disabled, true)).join('');

  renderScreens(s);
  renderBoots(s);
  $('log').innerHTML = s.log.slice().reverse().map((l) => `<div class="${l.kind}"><time>${time(l.t)}</time>${esc(l.text)}</div>`).join('');
}

function appCard(r, disabled, compact) {
  const a = r.action;
  const dis = disabled ? 'disabled' : '';
  let buttons = '';
  if (!a || a.state === 'enabled' || a.state === 'error') {
    buttons = compact
      ? `<button data-act="disable" data-pkg="${esc(r.pkg)}" ${dis}>Só desativar</button>`
      : `<button class="danger" data-act="remove" data-pkg="${esc(r.pkg)}" ${dis}>Remover</button>
         <button data-act="disable" data-pkg="${esc(r.pkg)}" ${dis}>Só desativar</button>`;
  } else if (a.state === 'disabled') {
    buttons = `<button data-act="remove" data-pkg="${esc(r.pkg)}" ${dis}>Remover de vez</button>
      <button data-act="enable" data-pkg="${esc(r.pkg)}" ${dis}>Reativar</button>`;
  } else if (a.state === 'admin_locked') {
    buttons = `<button class="primary" data-act="retry" data-pkg="${esc(r.pkg)}" ${dis}>Tentar de novo</button>
      <button data-open-admins ${dis}>Abrir administradores</button>`;
  }
  const note = a && a.state === 'admin_locked'
    ? `<div class="note">O Android não deixa tirar este administrador pelo cabo. O app já foi <b>desativado</b>.
       No celular, na tela <b>Administradores do dispositivo</b> que abriu, desmarque <b>${esc(r.label)}</b>
       (toque em <b>Desativar</b>) e clique em <b>Tentar de novo</b>.</div>` : '';
  const badge = a ? `<span class="badge ${a.state}" title="${esc((a.steps || []).join(' · '))}">${BADGE[a.state] || a.state}</span>` : '';
  const reasons = compact ? '' : `<ul>${r.reasons.map((x) => `<li>${esc(x.text)} <span>+${x.points}</span></li>`).join('')}</ul>`;
  return `<div class="app ${r.level}">
    <div><div class="title">${esc(r.label)} ${r.enabled === false && !a ? '<span class="badge disabled">já desativado</span>' : ''}</div>
      <div class="pkg">${esc(r.pkg)}${r.installer ? ' · instalado por ' + esc(r.installer) : ' · fora da loja'}</div></div>
    <div class="score">${r.score}</div>
    ${reasons}${note}
    <div class="actions">${badge}${buttons}</div>
  </div>`;
}

function renderScreens(s) {
  $('screens').innerHTML = (s.screens || []).slice(0, 3).map((sc) => {
    const url = `/api/screens/${encodeURIComponent(sc.name)}?t=${TOKEN}`;
    const fg = sc.foreground;
    const verdict = sc.suspect
      ? `<p>Esse anúncio é do app <b>${esc(sc.suspect.label)}</b> (${esc(sc.suspect.pkg)}), ${sc.suspect.score} pontos.</p>
         <button class="danger" data-act="remove" data-pkg="${esc(sc.suspect.pkg)}">Remover ${esc(sc.suspect.label)}</button>`
      : fg ? `<p>Em primeiro plano: <b>${esc(fg.pkg)}</b>${fg.cls ? `<br><small class="muted">${esc(fg.cls)}</small>` : ''}</p>
              <p class="muted">Não é um app de usuário (é do sistema ou já foi removido).</p>`
        : '<p class="muted">Não consegui saber qual app estava na tela.</p>';
    return `<div class="card screen"><a href="${url}" target="_blank"><img src="${url}" alt="Tela do celular"></a>
      <div><b>Anúncio na tela · ${time(sc.at)}</b>${verdict}</div></div>`;
  }).join('');
}

function renderBoots(s) {
  const boots = s.boots || [];
  const box = $('bootBox');
  const self = boots.flatMap((b) => b.launches.filter((l) => l.selfStarted).map((l) => ({ ...l, bootTime: b.bootTime })));
  if (!self.length) { box.innerHTML = ''; return; }
  const name = (pkg) => ((s.results || []).find((r) => r.pkg === pkg) || {}).label || pkg;
  box.innerHTML = `<h2>O que abriu sozinho ao ligar</h2><div class="card boot"><ul>${self.map((l) => `
    <li><b>${esc(name(l.pkg))}</b> abriu ${l.seconds} s depois de ligar
      ${l.adScreen ? ' · <b style="color:var(--danger)">tela de propaganda</b>' : ''}
      ${l.beforeUnlock ? ' · antes de desbloquear' : ''}${l.hasIcon ? '' : ' · sem ícone'}</li>`).join('')}</ul></div>`;
}

// ---------- botões ----------

async function doAction(act, pkg) {
  if (act === 'remove' && !confirm(`Remover ${pkg} do celular?`)) return;
  busyLocal = true; lastJson = ''; render();
  try {
    const r = await api('/api/action', { action: act, pkg });
    toast({ removed: 'Removido.', disabled: 'Desativado.', enabled: 'Reativado.', admin_locked: 'Administrador travado: veja as instruções no app.', error: 'Não consegui. Veja o registro.' }[r.action.state] || 'Feito.');
  } catch (e) {
    toast(e.message);
  } finally {
    busyLocal = false; lastJson = '';
  }
}

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button');
  if (!btn || btn.disabled) return;
  if (btn.dataset.act) return doAction(btn.dataset.act, btn.dataset.pkg);
  if (btn.dataset.fix) {
    btn.disabled = true;
    toast('Resolvendo…');
    try { toast((await api('/api/fix', { fix: btn.dataset.fix })).message, 6000); } catch (e) { toast(e.message, 8000); }
    btn.disabled = false; lastJson = '';
    return;
  }
  if (btn.dataset.serial) { await api('/api/select', { serial: btn.dataset.serial }); lastJson = ''; return; }
  if ('openAdmins' in btn.dataset) { api('/api/open-admins', {}).then(() => toast('Tela de administradores aberta no celular.')).catch((e) => toast(e.message)); }
});

$('btnScan').onclick = () => api('/api/scan', {}).catch((e) => toast(e.message));
$('btnScreen').onclick = async () => {
  toast('Tirando foto da tela do celular…');
  try { await api('/api/screen', {}); lastJson = ''; } catch (e) { toast(e.message); }
};
$('btnAdmins').onclick = () => api('/api/open-admins', {}).then(() => toast('Tela de administradores aberta no celular.')).catch((e) => toast(e.message));
$('btnInstall').onclick = async () => {
  toast('Baixando e instalando o MestreScan…', 15000);
  try { await api('/api/install-mestrescan', {}); toast('MestreScan instalado no celular.'); } catch (e) { toast(e.message, 8000); }
};
$('btnReport').onclick = () => window.open(`/relatorio?t=${TOKEN}`, '_blank');
$('autoClean').onchange = (e) => api('/api/settings', { autoClean: e.target.checked }).catch((er) => toast(er.message));

poll();
