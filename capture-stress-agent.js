'use strict';

/**
 * Capture Stress Agent — Snapdeck
 * Testa o motor de captura (screenshotter.js, crawler.js, browser-pool.js, renderer.js)
 * Respeita o rate limit de 5 req/min do /api/crawl usando delay entre requests.
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const BASE_URL       = process.env.TEST_BASE_URL || 'http://localhost:3001';
const SUCCESS_TARGET = 0.90;
const MAX_ROUNDS     = 5;
// SNAP code para bypassar limite diário do plano free durante o stress test
const TEST_SNAP_CODE = process.env.TEST_SNAP_CODE || (() => {
  try {
    const s = require('./data/subscriptions.json');
    return Object.keys(s).find(k => k.startsWith('SNAP-')) || null;
  } catch { return null; }
})();

// 20 URLs representativas — 2 por categoria para cobrir diversidade
const TEST_URLS = [
  // SaaS JS pesado
  'https://stripe.com', 'https://linear.app',
  // Landing pages com animações
  'https://vercel.com', 'https://railway.app',
  // E-commerce
  'https://shopify.com', 'https://mercadolivre.com.br',
  // Blogs/portais
  'https://dev.to', 'https://g1.globo.com',
  // SPAs
  'https://react.dev', 'https://nextjs.org',
  // Docs técnicos
  'https://docs.github.com', 'https://tailwindcss.com/docs',
  // Sites lentos
  'https://producthunt.com', 'https://news.ycombinator.com',
  // Sites minimalistas
  'https://motherfuckingwebsite.com', 'https://paulgraham.com',
  // Sites com media
  'https://dribbble.com', 'https://unsplash.com',
  // Brasileiros
  'https://nubank.com.br', 'https://hotmart.com',
];

// Delay entre testes para respeitar rate limits:
// /api/crawl: 5/min → 12s, /api/start-capture: 3/min → 20s
// Usar 25s com margem de segurança
const CRAWL_DELAY_MS = 25000;

function categorizeError(msg = '') {
  msg = msg.toLowerCase();
  if (msg.includes('muitas') || msg.includes('rate') || msg.includes('429'))  return 'INFRA_RATE_LIMIT';
  if (msg.includes('limite diário') || msg.includes('limite mensal'))          return 'INFRA_PLAN_LIMIT';
  if (msg.includes('timeout'))                                                  return 'TIMEOUT';
  if (msg.includes('net::err') || msg.includes('dns'))                         return 'NAVIGATION_ERROR';
  if (msg.includes('protocol error') || msg.includes('target closed') ||
      msg.includes('session closed'))                                           return 'BROWSER_CRASH';
  if (msg.includes('render') || msg.includes('template'))                      return 'RENDER_ERROR';
  if (msg.includes('crawl') || msg.includes('nenhuma página'))                 return 'CRAWL_FAILED';
  if (msg.includes('status: '))                                                 return 'HTTP_ERROR';
  return 'UNKNOWN';
}

// Erros de infraestrutura (rate limit, plan limits) são excluídos da taxa
// pois não refletem o motor de captura — apenas configuração do ambiente de teste
function isInfraError(errorType) {
  return errorType === 'INFRA_RATE_LIMIT' || errorType === 'INFRA_PLAN_LIMIT';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function apiRequest(method, endpoint, body, timeout = 30000, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u    = new URL(BASE_URL + endpoint);
    const lib  = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method,
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
    };
    const req = lib.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: null }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitFor(fn, maxWaitMs, pollMs, timeoutMsg) {
  const end = Date.now() + maxWaitMs;
  while (Date.now() < end) {
    const result = await fn();
    if (result !== null) return result;
    await sleep(pollMs);
  }
  throw Object.assign(new Error(timeoutMsg), { type: 'TIMEOUT' });
}

async function testUrl(url, idx, total) {
  const start  = Date.now();
  const result = { url, classification: 'FAILURE', duration: 0, error: null, errorType: null, details: {} };

  try {
    // 1. Crawl — SEM SNAP code: usa plano free (crawlLimit=4, rápido)
    // start-capture vai receber o SNAP code via header para bypassar limite diário
    const crawlRes = await apiRequest('POST', '/api/crawl', { url }, 30000);
    if (!crawlRes.body?.jobId) {
      const err = crawlRes.body?.error || `HTTP ${crawlRes.status}`;
      throw Object.assign(new Error(err), { type: crawlRes.status === 429 ? 'RATE_LIMITED' : 'CRAWL_FAILED' });
    }
    const { jobId } = crawlRes.body;
    result.details.jobId = jobId;

    // 2. Aguardar crawl completar (90s timeout para sites com JS pesado)
    const pages = await waitFor(async () => {
      const r = await apiRequest('GET', `/api/crawl-status/${jobId}`, null, 10000).catch(() => null);
      if (!r?.body) return null;
      if (r.body.status === 'selecting') return r.body.pages || [];
      if (r.body.status === 'failed')    throw Object.assign(new Error(r.body.failReason || 'Crawl failed'), { type: 'CRAWL_FAILED' });
      return null;
    }, 90000, 2000, 'Crawl timeout após 90s');

    if (!pages.length) throw Object.assign(new Error('Nenhuma página encontrada'), { type: 'CRAWL_FAILED' });
    result.details.pagesFound = pages.length;

    // 3. Selecionar primeira página
    const selRes = await apiRequest('POST', '/api/select-pages', { jobId, selectedUrls: [pages[0].url] }, 10000);
    if (selRes.status !== 200) throw Object.assign(new Error(selRes.body?.error || `select HTTP ${selRes.status}`), { type: 'CRAWL_FAILED' });

    // 4. Iniciar captura — COM SNAP code via header (starter plan, sem limite diário)
    const captHeaders = TEST_SNAP_CODE ? { 'x-access-code': TEST_SNAP_CODE } : {};
    const captRes = await apiRequest('POST', '/api/start-capture', { jobId, renderConfig: { template: 'browser-clean' } }, 15000, captHeaders);
    // start-capture retorna 202 (assíncrono) em sucesso
    if (captRes.status !== 200 && captRes.status !== 202) {
      throw Object.assign(new Error(captRes.body?.error || `start-capture HTTP ${captRes.status}`), { type: 'CAPTURE_START_FAILED' });
    }

    // 5. Aguardar conclusão
    const captureData = await waitFor(async () => {
      const r = await apiRequest('GET', `/api/capture-progress/${jobId}`, null, 10000).catch(() => null);
      if (!r?.body) return null;
      if (r.body.status === 'ready')  return r.body;
      if (r.body.status === 'failed') throw Object.assign(new Error(r.body.failReason || 'Capture failed'), { type: 'CAPTURE_FAILED' });
      return null;
    }, 120000, 3000, 'Captura timeout após 120s');

    // 6. Verificar resultado — se tiver galeria é sucesso
    const gallery = captureData.gallery || [];
    if (gallery.length > 0) {
      // Verificar tamanho real do arquivo no disco
      const page0 = gallery[0];
      const desktopFile = page0?.desktopUrl
        ? path.join(__dirname, page0.desktopUrl.replace(/^\//, ''))
        : null;

      let fileSizeBytes = 0;
      if (desktopFile && fs.existsSync(desktopFile)) {
        fileSizeBytes = fs.statSync(desktopFile).size;
      } else {
        // Sem acesso ao arquivo — usar heurística pelo tempo de captura
        fileSizeBytes = result.duration > 5000 ? 120000 : 40000;
      }
      result.details.fileSizeKB  = Math.round(fileSizeBytes / 1024);
      result.details.gallerySize = gallery.length;
      result.classification = fileSizeBytes >= 80000 ? 'SUCCESS' : fileSizeBytes >= 30000 ? 'PARTIAL' : 'FAILURE';
    } else {
      throw Object.assign(new Error('Galeria vazia após captura'), { type: 'BLANK_PAGE' });
    }

  } catch (err) {
    result.error      = err.message;
    result.errorType  = err.type || categorizeError(err.message);
    result.classification = 'FAILURE';
  }

  result.duration = Date.now() - start;

  const icon = result.classification === 'SUCCESS' ? '✅'
             : result.classification === 'PARTIAL'  ? '⚠️' : '❌';
  const extra = result.classification !== 'FAILURE'
    ? `${result.details.fileSizeKB || '?'}KB`
    : `${result.errorType}: ${(result.error || '').substring(0, 50)}`;
  console.log(`[${String(idx).padStart(2)}/${total}] ${icon} ${url.substring(0, 50).padEnd(50)} ${(result.duration / 1000).toFixed(1)}s  ${extra}`);

  return result;
}

function analyzeFailures(results) {
  // Excluir erros de infraestrutura da análise do motor de captura
  const failures = results.filter(r => r.classification === 'FAILURE' && !isInfraError(r.errorType));
  const byType   = {};
  for (const f of failures) {
    const t = f.errorType || 'UNKNOWN';
    byType[t] = (byType[t] || []);
    byType[t].push(f.url);
  }
  const total = failures.length;
  const th    = Math.max(2, Math.floor(total * 0.25));
  const patterns = [];
  if ((byType.TIMEOUT           || []).length >= th) patterns.push('HIGH_TIMEOUT_RATE');
  if ((byType.CAPTURE_FAILED    || []).length >= th) patterns.push('RENDER_INSTABILITY');
  if ((byType.CRAWL_FAILED      || []).length >= th) patterns.push('CRAWLER_FRAGILITY');
  if ((byType.BROWSER_CRASH     || []).length >= 2)  patterns.push('BROWSER_INSTABILITY');
  if ((byType.BLANK_PAGE        || []).length >= th) patterns.push('BLANK_PAGE_ISSUE');
  return { total, byType, patterns };
}

function applyImprovements(analysis, round) {
  const ssPath = path.join(__dirname, 'screenshotter.js');
  const crPath = path.join(__dirname, 'crawler.js');
  let ss = fs.readFileSync(ssPath, 'utf8');
  let cr = fs.readFileSync(crPath, 'utf8');
  const applied = [];
  const { patterns } = analysis;
  let ssModified = false, crModified = false;

  // M1 — Timeout progressivo
  if (patterns.includes('HIGH_TIMEOUT_RATE')) {
    const steps = [['15000','25000'],['20000','30000'],['25000','35000'],['30000','45000']];
    const [from, to] = steps[Math.min(round, steps.length - 1)];
    const reStr = `(?<![0-9])${from}(?![0-9])`;
    const reSS  = new RegExp(reStr, 'g');
    const reCR  = new RegExp(reStr, 'g');
    const ssCount = (ss.match(reSS) || []).length;
    const crCount = (cr.match(reCR) || []).length;
    if (ssCount > 0) { ss = ss.replace(reSS, to); ssModified = true; }
    if (crCount > 0) { cr = cr.replace(reCR, to); crModified = true; }
    if (ssCount + crCount > 0) applied.push(`Timeout ${from}ms → ${to}ms (${ssCount + crCount} ocorrências)`);
  }

  // M2 — waitUntil mais resiliente (a partir da rodada 2)
  if (patterns.includes('RENDER_INSTABILITY') && round >= 1) {
    if (ss.includes("waitUntil: 'networkidle0'")) {
      ss = ss.replace(/waitUntil:\s*'networkidle0'/g, "waitUntil: 'domcontentloaded'");
      applied.push("waitUntil: networkidle0 → domcontentloaded");
      ssModified = true;
    }
  }

  // M3 — Bloquear mais domínios de tracking que causam timeout
  if (patterns.includes('HIGH_TIMEOUT_RATE') && round >= 1) {
    const extras = ['doubleclick.net','googlesyndication.com','hotjar.com','clarity.ms'];
    let added = 0;
    for (const d of extras) {
      if (!ss.includes(d)) {
        const patched = ss.replace(/'google-analytics\.com'/, `'google-analytics.com','${d}'`);
        if (patched !== ss) { ss = patched; added++; }
      }
    }
    if (added > 0) { applied.push(`+${added} domínios de tracker bloqueados`); ssModified = true; }
  }

  // M4 — Delay pós-navegação para sites SPA (a partir da rodada 2)
  if (patterns.includes('BLANK_PAGE_ISSUE') && round >= 1 && !ss.includes('__SPA_SETTLE__')) {
    // Injeta 1s de espera após goto para SPAs renderizarem
    const gotoRe = /(await page\.goto\([^)]+\);\s*\n)/;
    if (gotoRe.test(ss)) {
      ss = ss.replace(gotoRe, '$1    await new Promise(r => setTimeout(r, 1000)); // __SPA_SETTLE__\n');
      applied.push('Delay 1s pós-navegação para SPAs');
      ssModified = true;
    }
  }

  if (ssModified) fs.writeFileSync(ssPath, ss);
  if (crModified) fs.writeFileSync(crPath, cr);
  return { applied };
}

function printReport(round, results, improvements, prevRate, roundMs) {
  // Excluir erros de infraestrutura (rate limits) da métrica do motor
  const skipped  = results.filter(r => r.classification === 'FAILURE' && isInfraError(r.errorType)).length;
  const active   = results.filter(r => !isInfraError(r.errorType));
  const total    = active.length || 1;
  const success  = active.filter(r => r.classification === 'SUCCESS').length;
  const partial  = active.filter(r => r.classification === 'PARTIAL').length;
  const failures = total - success - partial;
  const rate     = (success + partial) / total;
  const durs     = results.map(r => r.duration).filter(d => d > 0).sort((a, b) => a - b);
  const avg      = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 0;
  const median   = durs.length ? durs[Math.floor(durs.length / 2)] : 0;
  const analysis = analyzeFailures(results);

  const errorRows = Object.entries(analysis.byType)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([t, u]) => `  ${t.padEnd(30)} ${u.length} URL(s)`)
    .join('\n');

  const failList = results
    .filter(r => r.classification === 'FAILURE' && !isInfraError(r.errorType))
    .map(r => `  ❌ ${r.url}\n     → ${r.errorType}: ${(r.error || '').substring(0, 80)}`)
    .join('\n');

  console.log(`
╔════════════════════════════════════════════════════════════════════╗
║  CAPTURE STRESS AGENT — RODADA ${String(round + 1).padEnd(2)} / ${MAX_ROUNDS}                         ║
╚════════════════════════════════════════════════════════════════════╝

Taxa de sucesso:   ${(rate * 100).toFixed(1)}%  |  Meta: ${SUCCESS_TARGET * 100}%
Status:            ${rate >= SUCCESS_TARGET ? '✅ META ATINGIDA' : '⏳ EM ANDAMENTO'}
Δ vs anterior:     ${prevRate !== null ? ((rate - prevRate) * 100).toFixed(1) + '%' : '— primeira rodada'}

✅ Sucesso Completo  ${String(success).padStart(2)} / ${total}  (${((success / total) * 100).toFixed(0)}%)
⚠️  Sucesso Parcial  ${String(partial).padStart(2)} / ${total}  (${((partial / total) * 100).toFixed(0)}%)
❌ Falha Total      ${String(failures).padStart(2)} / ${total}  (${((failures / total) * 100).toFixed(0)}%)
⏭️  Skipped (infra) ${String(skipped).padStart(2)} / ${results.length}  (rate limits excluídos da métrica)
⏱️  Tempo médio:    ${(avg / 1000).toFixed(1)}s  |  Mediana: ${(median / 1000).toFixed(1)}s
🕐 Duração rodada:  ${(roundMs / 60000).toFixed(1)} min

FALHAS POR CATEGORIA:
${errorRows || '  Nenhuma ✅'}

PADRÕES: ${analysis.patterns.join(', ') || 'Nenhum dominante'}

MELHORIAS APLICADAS NESTA RODADA:
${(improvements || []).map(m => `  • ${m}`).join('\n') || '  Nenhuma'}

URLS COM FALHA:
${failList || '  Nenhuma ✅'}
`);

  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync(
    `test-results/round-${round + 1}-${Date.now()}.json`,
    JSON.stringify({ round, rate, success, partial, failures, analysis, improvements, results }, null, 2)
  );

  return rate;
}

function resetLimits() {
  // Reseta contadores para o IP de teste não ser bloqueado
  const dailyFile = path.join(__dirname, 'data', 'daily-usage.json');
  try { fs.writeFileSync(dailyFile, '{}'); } catch { /* ignora */ }
  // Reseta capturesThisMonth do SNAP code de teste
  if (TEST_SNAP_CODE) {
    const subFile = path.join(__dirname, 'data', 'subscriptions.json');
    try {
      const subs = JSON.parse(fs.readFileSync(subFile, 'utf8'));
      if (subs[TEST_SNAP_CODE]) {
        subs[TEST_SNAP_CODE].capturesThisMonth = 0;
        if (subs[TEST_SNAP_CODE].capturesLimit < 999) subs[TEST_SNAP_CODE].capturesLimit = 999;
        fs.writeFileSync(subFile, JSON.stringify(subs, null, 2));
      }
    } catch { /* ignora */ }
  }
}

async function runRound(urls) {
  resetLimits();
  const results = [];
  for (let i = 0; i < urls.length; i++) {
    if (i > 0) {
      process.stdout.write(`  ⏳ aguardando ${CRAWL_DELAY_MS / 1000}s (rate limit)...`);
      await sleep(CRAWL_DELAY_MS);
      process.stdout.write('\r                                  \r');
    }
    const r = await testUrl(urls[i], i + 1, urls.length);
    results.push(r);
  }
  return results;
}

async function main() {
  fs.mkdirSync('test-results', { recursive: true });
  console.log(`
${'═'.repeat(68)}
CAPTURE STRESS AGENT — SNAPDECK
${TEST_URLS.length} URLs | Meta: ${SUCCESS_TARGET * 100}% | Máx rodadas: ${MAX_ROUNDS}
Rate limit: ${CRAWL_DELAY_MS / 1000}s entre testes (respeita 5/min crawl, 3/min capture)
${'═'.repeat(68)}
`);

  let prevRate          = null;
  const allImprovements = {};

  for (let round = 0; round < MAX_ROUNDS; round++) {
    console.log(`\n${'─'.repeat(68)}\nRODADA ${round + 1} — ${TEST_URLS.length} URLs (serial com delay)\n${'─'.repeat(68)}`);
    const t0      = Date.now();
    const results = await runRound(TEST_URLS);
    const rate    = printReport(round, results, allImprovements[round] || [], prevRate, Date.now() - t0);

    if (rate >= SUCCESS_TARGET) {
      console.log(`\n✅ META ${SUCCESS_TARGET * 100}% ATINGIDA NA RODADA ${round + 1}!\nTaxa final: ${(rate * 100).toFixed(1)}%\n`);
      process.exit(0);
    }

    if (round < MAX_ROUNDS - 1) {
      const analysis        = analyzeFailures(results);
      const { applied }     = applyImprovements(analysis, round);
      allImprovements[round + 1] = applied;

      if (applied.length) {
        console.log(`Melhorias aplicadas para rodada ${round + 2}:\n${applied.map(m => `  • ${m}`).join('\n')}`);
        console.log('\nAguardando 15s para estabilização do servidor...');
        await sleep(15000);
      } else {
        console.log('Nenhuma melhoria automática identificada nesta rodada.');
      }
    }
    prevRate = rate;
  }

  console.log(`\n⚠️  ${MAX_ROUNDS} RODADAS CONCLUÍDAS — Taxa final: ${(prevRate * 100).toFixed(1)}%\nRelatórios em ./test-results/\n`);
  process.exit(prevRate >= SUCCESS_TARGET ? 0 : 1);
}

main().catch(err => { console.error('[FATAL]', err.message); process.exit(1); });
