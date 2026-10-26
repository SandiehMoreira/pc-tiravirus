'use strict';
// Relatório do atendimento para o cliente (HTML; imprime ou salva em PDF).

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATE_TEXT = {
  removed: 'Removido',
  disabled: 'Desativado',
  admin_locked: 'Desativado (administrador)',
  enabled: 'Mantido',
};

function render(session, brand) {
  const c = brand.colors;
  const d = session.device || {};
  const results = session.results || [];
  const handled = results.filter((r) => r.action && ['removed', 'disabled', 'admin_locked'].includes(r.action.state));
  const pending = results.filter((r) => r.level !== 'safe' && !handled.includes(r));
  const date = new Date(session.startedAt || Date.now()).toLocaleString('pt-BR');

  const row = (r) => `
    <tr>
      <td><b>${esc(r.label)}</b><br><small>${esc(r.pkg)}</small></td>
      <td>${esc(r.reasons.slice(0, 3).map((x) => x.text).join('; '))}</td>
      <td class="st">${esc(r.action ? STATE_TEXT[r.action.state] || r.action.state : r.level === 'danger' ? 'Perigoso' : 'Suspeito')}</td>
    </tr>`;

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relatório — ${esc(brand.store)}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #1a1a1a; background: #fff; margin: 0; padding: 32px; }
  .wrap { max-width: 800px; margin: 0 auto; }
  header { display: flex; align-items: center; gap: 16px; border-bottom: 3px solid ${c.primary}; padding-bottom: 16px; }
  header img { width: 64px; height: 64px; border-radius: 12px; }
  h1 { margin: 0; font-size: 22px; }
  h2 { font-size: 17px; margin-top: 28px; }
  .muted { color: #666; }
  .box { background: #f6f6f7; border-radius: 10px; padding: 14px 18px; margin-top: 18px; display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; }
  .big { font-size: 28px; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  td, th { text-align: left; border-bottom: 1px solid #e5e5e5; padding: 8px 6px; vertical-align: top; }
  .st { white-space: nowrap; font-weight: 600; }
  ul { padding-left: 20px; line-height: 1.6; }
  footer { margin-top: 32px; border-top: 1px solid #ddd; padding-top: 12px; font-size: 13px; color: #555; }
  .print { margin-top: 20px; background: ${c.primary}; color: ${c.onPrimary}; border: 0; border-radius: 8px; padding: 10px 18px; font-weight: 600; cursor: pointer; }
  @media print { .print { display: none; } body { padding: 0; } }
</style></head>
<body><div class="wrap">
<header>
  <img src="/${esc(brand.logo)}" alt="">
  <div><h1>Relatório de limpeza do celular</h1><div class="muted">${esc(brand.store)} · ${esc(brand.tagline)}</div></div>
</header>

<div class="box">
  <div><div class="muted">Aparelho</div><b>${esc([d.manufacturer, d.model].filter(Boolean).join(' ') || 'Android')}</b></div>
  <div><div class="muted">Android</div><b>${esc(d.android || '—')}</b></div>
  <div><div class="muted">Data</div><b>${esc(date)}</b></div>
  <div><div class="muted">Apps analisados</div><b>${results.length}</b></div>
  <div><div class="muted">Vírus tratados</div><span class="big">${handled.length}</span></div>
</div>

<h2>O que foi feito</h2>
${handled.length ? `<table><tr><th>App</th><th>Por que era perigoso</th><th>Situação</th></tr>${handled.map(row).join('')}</table>`
    : '<p>Nenhum app perigoso precisou ser removido.</p>'}

${pending.length ? `<h2>Apps para ficar de olho</h2>
<p class="muted">Têm sinais suspeitos, mas foram mantidos.</p>
<table><tr><th>App</th><th>Sinais</th><th>Situação</th></tr>${pending.map(row).join('')}</table>` : ''}

<h2>Para não pegar vírus de novo</h2>
<ul>
  <li>Instale apps só pela Play Store.</li>
  <li>Desconfie de "limpadores", "aceleradores" e "VPN grátis".</li>
  <li>Não aceite "aparecer sobre outros apps", "acessibilidade" ou "administrador" para apps que você não conhece.</li>
  <li>Propaganda voltou? Fale com a gente antes de instalar outro app.</li>
</ul>

<footer>
  <b>${esc(brand.store)}</b> · ${esc(brand.address)}<br>
  WhatsApp ${esc(brand.whatsappDisplay)} · Instagram ${esc(brand.instagram)}
</footer>
<button class="print" onclick="window.print()">Imprimir / salvar em PDF</button>
</div></body></html>`;
}

module.exports = { render, esc };
