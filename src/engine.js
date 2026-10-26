'use strict';
// Pontuação: espelho do RiskEngine.kt do APK MestreScan, mais as regras que
// só o PC consegue ver (ad_screen_seen e a lista de casos removidos).
const fs = require('fs');
const path = require('path');

const DAY_MS = 86400000;

function loadRules(file = path.join(__dirname, '..', 'rules.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Entradas terminadas em "." valem como prefixo (ex.: "com.google."). */
function isWhitelisted(rules, pkg) {
  return rules.whitelist.some((w) => (w.endsWith('.') ? pkg.startsWith(w) : pkg === w));
}

function levelFor(rules, score) {
  if (score >= rules.bands.red) return 'danger';
  if (score >= rules.bands.yellow) return 'suspect';
  return 'safe';
}

/**
 * @param app  saída do inspector.scan (um item de apps)
 * @param ctx  { rules, known: Set de pacotes já removidos como vírus, nowLocal, evidence, adSeen }
 */
function evaluate(app, ctx) {
  const { rules } = ctx;
  const reasons = [];
  const add = (rule, text) => {
    const points = rules.points[rule] || 0;
    if (points > 0) reasons.push({ rule, points, text });
  };

  if (rules.knownMalicious.includes(app.pkg) || (ctx.known && ctx.known.has(app.pkg))) {
    add('known_malicious', 'Já foi removido como vírus em outro celular');
  }

  const fromTrustedStore = rules.trustedInstallers.includes(app.installer);
  // Lista branca só vale se veio de loja confiável: um vírus pode usar
  // um nome de pacote parecido com "com.google.".
  if (!reasons.length && fromTrustedStore && isWhitelisted(rules, app.pkg)) {
    return { score: 0, level: 'safe', reasons: [] };
  }

  if (app.admins.length) add('device_admin', 'É administrador do celular (dificulta a remoção)');
  if (app.accessibility.length) add('accessibility', 'Tem acesso de acessibilidade (consegue controlar a tela)');
  if (app.overlay === 'granted') add('overlay_granted', 'Pode aparecer por cima de outros apps');
  else if (app.overlay === 'requested') add('overlay_requested', 'Pede para aparecer por cima de outros apps');
  if (!app.hasLauncherIcon) add('hidden', 'Está escondido: não tem ícone na tela');
  if (!fromTrustedStore) add('sideload', 'Instalado fora da Play Store');
  if (app.canInstallApps) add('install_packages', 'Pode instalar outros apps');

  const name = app.label.toLowerCase();
  const pkg = app.pkg.toLowerCase();
  if (rules.genericNameKeywords.some((k) => name.includes(k) || pkg.includes(k.replace(/ /g, '')))) {
    add('generic_name', 'Nome típico de app falso (limpador, acelerador…)');
  }
  if (rules.imitatesSystemKeywords.some((k) => name.includes(k))) {
    add('imitates_system', 'Nome imita app do sistema, mas não é do sistema');
  }
  if (app.startsOnBoot) add('boot_start', 'Inicia sozinho quando o celular liga');

  if (app.installedAt && ctx.nowLocal) {
    const days = Math.floor((ctx.nowLocal - app.installedAt) / DAY_MS);
    if (days >= 0 && days <= rules.recentInstallDays) {
      add('recent_install', days === 0 ? 'Instalado hoje' : days === 1 ? 'Instalado ontem' : `Instalado há ${days} dias`);
    }
  }

  const boot = ctx.evidence && ctx.evidence[app.pkg];
  if (boot && boot.bootsWithLaunch > 0) {
    add('boot_popup', `Abriu sozinho ${boot.firstSeconds} s depois de ligar o celular`);
    if (boot.adScreen) add('boot_ad_screen', 'Abriu uma tela de propaganda');
    if (boot.bootsWithLaunch >= 2) {
      add('boot_repeat', `Repetiu em ${boot.bootsWithLaunch} de ${boot.totalBoots} vezes que o celular ligou`);
    }
  }

  const ad = ctx.adSeen && ctx.adSeen[app.pkg];
  if (ad && ad.count > 0) {
    add('ad_screen_seen', ad.count === 1 ? 'Abriu propaganda por cima de outro app'
      : `Abriu propaganda por cima de outro app (${ad.count} vezes)`);
  }

  const score = reasons.reduce((s, r) => s + r.points, 0);
  return { score, level: levelFor(rules, score), reasons: reasons.sort((a, b) => b.points - a.points) };
}

module.exports = { loadRules, evaluate, isWhitelisted, levelFor };
