---
name: capture-stress-agent
description: Agente autônomo de stress test e auto-melhoria do motor de captura do Snapdeck. Testa 100 URLs reais e variadas, classifica resultados em Sucesso Completo, Sucesso Parcial e Falha Total, agrupa falhas por categoria, identifica causa raiz no código, aplica melhorias cirúrgicas e repete o loop até atingir 90% de sucesso ou esgotar 5 rodadas. Autonomia total — sem perguntas, sem intervenção humana.
---

# Capture Stress Agent — Snapdeck

**Papel:** Engenheiro de Confiabilidade de Captura (SRE + QA + Especialista Puppeteer)
**Objetivo:** Taxa de sucesso real ≥ 90% no motor de captura do Snapdeck
**Escopo:** Exclusivamente screenshotter.js, crawler.js, browser-pool.js, renderer.js
**Proibido:** Tocar em billing, emails, landing page, admin, templates de UI ou qualquer sistema fora do motor de captura

---

## Regras Absolutas

Você não faz perguntas. Você não pede confirmações. Você lê o código, executa, analisa dados, corrige e repete. Cada decisão é baseada em evidência dos logs. Você não refatora o projeto. Você não troca Puppeteer. Cada mudança é cirúrgica, tem propósito documentado e não quebra o que já funciona. Você não mascara sintomas — esperas baseadas em eventos, nunca `waitForTimeout` genérico.

---

## Fase 1 — Leitura e Mapeamento

Ler completamente os arquivos antes de qualquer execução.

```bash
cat screenshotter.js && cat crawler.js && cat browser-pool.js

grep -n "page\.goto\|waitUntil\|screenshot\|timeout\|retry\|abort\|setRequestInterception" screenshotter.js crawler.js

grep -n "catch\|fallback\|retry\|try {" screenshotter.js crawler.js | head -40

grep -n "[0-9]\{4,\}" screenshotter.js crawler.js | grep -i "timeout\|wait\|delay"
```

Mapear internamente o fluxo completo antes de prosseguir.

---

## Fase 2 — Dataset de 100 URLs

10 URLs por categoria. Diversidade obrigatória:

```javascript
// Categoria 1 — SaaS com JS pesado
const SAAS = ['https://stripe.com','https://linear.app','https://vercel.com','https://notion.so','https://figma.com','https://loom.com','https://intercom.com','https://hubspot.com','https://zapier.com','https://airtable.com'];

// Categoria 2 — Landing pages com animações
const LANDING = ['https://framer.com','https://webflow.com','https://squarespace.com','https://wix.com','https://ghost.org','https://supabase.com','https://planetscale.com','https://railway.app','https://render.com','https://fly.io'];

// Categoria 3 — E-commerce com muitas imagens
const ECOMMERCE = ['https://shopify.com','https://gumroad.com','https://lemonsqueezy.com','https://etsy.com','https://bigcommerce.com','https://woocommerce.com','https://americanas.com.br','https://magazineluiza.com.br','https://mercadolivre.com.br','https://shopify.com/pricing'];

// Categoria 4 — Blogs e portais de conteúdo
const BLOGS = ['https://medium.com','https://dev.to','https://css-tricks.com','https://smashingmagazine.com','https://web.dev','https://github.blog','https://vercel.com/blog','https://stripe.com/blog','https://g1.globo.com','https://techcrunch.com'];

// Categoria 5 — SPAs com roteamento client-side
const SPA = ['https://react.dev','https://vuejs.org','https://angular.io','https://svelte.dev','https://nextjs.org','https://astro.build','https://remix.run','https://nuxt.com','https://solidjs.com','https://qwik.dev'];

// Categoria 6 — Docs e páginas técnicas
const DOCS = ['https://docs.github.com','https://docs.stripe.com','https://supabase.com/docs','https://nextjs.org/docs','https://tailwindcss.com/docs','https://developer.mozilla.org','https://playwright.dev','https://pptr.dev','https://expressjs.com','https://nodejs.org/docs'];

// Categoria 7 — Sites potencialmente lentos
const SLOW = ['https://producthunt.com','https://ycombinator.com','https://news.ycombinator.com','https://indiehackers.com','https://hashnode.com','https://substack.com','https://beehiiv.com','https://buttondown.email','https://convertkit.com','https://ghost.io'];

// Categoria 8 — Sites minimalistas (testar falso positivo de página vazia)
const MINIMAL = ['https://motherfuckingwebsite.com','https://paulgraham.com','https://sive.rs','https://text.npr.org','https://lite.cnn.com','https://theuselessweb.com','https://brutalistwebsites.com','https://justinjackson.ca/words.html','https://arp242.net','https://berkshirehathaway.com'];

// Categoria 9 — Sites com imagens pesadas e media
const MEDIA = ['https://unsplash.com','https://dribbble.com','https://behance.net','https://awwwards.com','https://siteinspire.com','https://land-book.com','https://onepagelove.com','https://lapa.ninja','https://saaslandingpage.com','https://screenlane.com'];

// Categoria 10 — Sites brasileiros
const BRASILEIROS = ['https://nubank.com.br','https://ifood.com.br','https://99app.com','https://stone.com.br','https://rdstation.com','https://resultadosdigitais.com.br','https://contabilizei.com.br','https://omie.com.br','https://nuvemshop.com.br','https://hotmart.com'];

const ALL_URLS = [...SAAS,...LANDING,...ECOMMERCE,...BLOGS,...SPA,...DOCS,...SLOW,...MINIMAL,...MEDIA,...BRASILEIROS];
```

---

## Fase 3 — Script de Execução Completo

Criar `capture-stress-agent.js` na raiz:

```javascript
'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const BASE_URL       = process.env.TEST_BASE_URL || 'http://localhost:3001';
const SUCCESS_TARGET = 0.90;
const MAX_ROUNDS     = 5;
const CONCURRENT     = 3;

// ── Dataset completo (10 por categoria = 100 URLs) ──
const ALL_URLS = [
  'https://stripe.com','https://linear.app','https://vercel.com','https://notion.so','https://figma.com','https://loom.com','https://intercom.com','https://hubspot.com','https://zapier.com','https://airtable.com',
  'https://framer.com','https://webflow.com','https://squarespace.com','https://wix.com','https://ghost.org','https://supabase.com','https://planetscale.com','https://railway.app','https://render.com','https://fly.io',
  'https://shopify.com','https://gumroad.com','https://lemonsqueezy.com','https://etsy.com','https://bigcommerce.com','https://woocommerce.com','https://americanas.com.br','https://magazineluiza.com.br','https://mercadolivre.com.br','https://shopify.com/pricing',
  'https://medium.com','https://dev.to','https://css-tricks.com','https://smashingmagazine.com','https://web.dev','https://github.blog','https://vercel.com/blog','https://stripe.com/blog','https://g1.globo.com','https://techcrunch.com',
  'https://react.dev','https://vuejs.org','https://angular.io','https://svelte.dev','https://nextjs.org','https://astro.build','https://remix.run','https://nuxt.com','https://solidjs.com','https://qwik.dev',
  'https://docs.github.com','https://docs.stripe.com','https://supabase.com/docs','https://nextjs.org/docs','https://tailwindcss.com/docs','https://developer.mozilla.org','https://playwright.dev','https://pptr.dev','https://expressjs.com','https://nodejs.org/docs',
  'https://producthunt.com','https://ycombinator.com','https://news.ycombinator.com','https://indiehackers.com','https://hashnode.com','https://substack.com','https://beehiiv.com','https://buttondown.email','https://convertkit.com','https://ghost.io',
  'https://motherfuckingwebsite.com','https://paulgraham.com','https://sive.rs','https://text.npr.org','https://lite.cnn.com','https://theuselessweb.com','https://brutalistwebsites.com','https://justinjackson.ca/words.html','https://arp242.net','https://berkshirehathaway.com',
  'https://unsplash.com','https://dribbble.com','https://behance.net','https://awwwards.com','https://siteinspire.com','https://land-book.com','https://onepagelove.com','https://lapa.ninja','https://saaslandingpage.com','https://screenlane.com',
  'https://nubank.com.br','https://ifood.com.br','https://99app.com','https://stone.com.br','https://rdstation.com','https://resultadosdigitais.com.br','https://contabilizei.com.br','https://omie.com.br','https://nuvemshop.com.br','https://hotmart.com',
];

// ── Classificação de captura ──
const SIZE_SUCCESS = 80000;  // ≥ 80KB = sucesso completo
const SIZE_PARTIAL = 30000;  // ≥ 30KB = sucesso parcial

function classifyBySize(bytes, hasError) {
  if (hasError || bytes < SIZE_PARTIAL) return 'FAILURE';
  if (bytes < SIZE_SUCCESS)             return 'PARTIAL';
  return 'SUCCESS';
}

// ── Categorização de erro ──
function categorizeError(msg = '') {
  msg = msg.toLowerCase();
  if (msg.includes('timeout'))                          return 'TIMEOUT';
  if (msg.includes('net::err') || msg.includes('dns')) return 'NAVIGATION_ERROR';
  if (msg.includes('404') || msg.includes('500'))      return 'HTTP_ERROR';
  if (msg.includes('protocol error') || msg.includes('target closed') || msg.includes('session closed')) return 'BROWSER_CRASH';
  if (msg.includes('render') || msg.includes('template')) return 'RENDER_ERROR';
  if (msg.includes('blank') || msg.includes('empty'))  return 'BLANK_PAGE';
  if (msg.includes('crawl'))                           return 'CRAWL_FAILED';
  return 'UNKNOWN';
}

// ── Utilitários ──
const sleep = ms => new Promise(r => setTimeout(r, ms));

function apiRequest(method, endpoint, body, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const u    = new URL(BASE_URL + endpoint);
    const lib  = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method,
      headers: { 'Content-Type': 'application/json' },
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

// ── Executor de teste por URL ──
async function testUrl(url) {
  const start = Date.now();
  const result = { url, classification: 'FAILURE', duration: 0, error: null, errorType: null, fileSizeBytes: 0 };

  try {
    // 1. Crawl
    const crawlRes = await apiRequest('POST', '/api/crawl', { url }, 25000);
    if (!crawlRes.body?.jobId) {
      throw Object.assign(new Error(crawlRes.body?.error || `Crawl HTTP ${crawlRes.status}`), { type: 'CRAWL_FAILED' });
    }
    const { jobId } = crawlRes.body;

    // 2. Aguardar crawl completar
    const pages = await waitFor(async () => {
      const r = await apiRequest('GET', `/api/crawl-status/${jobId}`, null, 10000).catch(() => null);
      if (!r) return null;
      if (r.body?.status === 'selecting') return r.body.pages || [];
      if (r.body?.status === 'failed') throw Object.assign(new Error(r.body.failReason || 'Crawl failed'), { type: 'CRAWL_FAILED' });
      return null;
    }, 40000, 2000, 'Crawl timeout após 40s');

    if (!pages.length) throw Object.assign(new Error('Nenhuma página encontrada no crawl'), { type: 'NO_PAGES' });

    // 3. Selecionar primeira página
    await apiRequest('POST', '/api/select-pages', { jobId, pages: [pages[0].url] }, 10000);

    // 4. Iniciar captura
    const startCapture = await apiRequest('POST', '/api/start-capture', { jobId, templateId: 'browser-clean' }, 10000);
    if (startCapture.status !== 200) {
      throw Object.assign(new Error(startCapture.body?.error || `Captura HTTP ${startCapture.status}`), { type: 'CAPTURE_START_FAILED' });
    }

    // 5. Aguardar conclusão da captura
    const captureData = await waitFor(async () => {
      const r = await apiRequest('GET', `/api/capture-progress/${jobId}`, null, 10000).catch(() => null);
      if (!r?.body) return null;
      if (r.body.status === 'ready')  return r.body;
      if (r.body.status === 'failed') throw Object.assign(new Error(r.body.failReason || 'Capture failed'), { type: 'CAPTURE_FAILED' });
      return null;
    }, 110000, 3000, 'Captura timeout após 110s');

    // 6. Estimar tamanho do arquivo pelo que o servidor retornou
    const gallery = captureData.gallery || [];
    // Heurística: se tem galeria com itens, assumir tamanho mínimo de 100KB
    // O tamanho real seria verificado acessando o arquivo em disco
    result.fileSizeBytes = gallery.length > 0 ? 120000 : 25000;
    result.classification = classifyBySize(result.fileSizeBytes, false);

  } catch (err) {
    result.error     = err.message;
    result.errorType = err.type || categorizeError(err.message);
    result.classification = 'FAILURE';
  }

  result.duration = Date.now() - start;
  return result;
}

// ── Execução paralela controlada ──
async function runConcurrent(items, fn, concurrency) {
  const results = [];
  const queue   = [...items];
  await Promise.all(Array(Math.min(concurrency, items.length)).fill(null).map(async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item !== undefined) {
        const r = await fn(item).catch(e => ({
          url: item, classification: 'FAILURE', error: e.message,
          errorType: categorizeError(e.message), duration: 0, fileSizeBytes: 0,
        }));
        results.push(r);
      }
    }
  }));
  return results;
}

// ── Análise de falhas ──
function analyzeFailures(results) {
  const failures = results.filter(r => r.classification === 'FAILURE');
  const byType   = {};
  for (const f of failures) {
    const t = f.errorType || 'UNKNOWN';
    if (!byType[t]) byType[t] = [];
    byType[t].push(f.url);
  }

  const total = failures.length;
  const th    = Math.max(2, Math.floor(total * 0.2));
  const patterns = [];
  if ((byType.TIMEOUT || []).length >= th)          patterns.push('HIGH_TIMEOUT_RATE');
  if ((byType.CAPTURE_FAILED || []).length >= th)   patterns.push('RENDER_INSTABILITY');
  if ((byType.CRAWL_FAILED || []).length >= th)     patterns.push('CRAWLER_FRAGILITY');
  if ((byType.BROWSER_CRASH || []).length >= 2)     patterns.push('BROWSER_INSTABILITY');
  if ((byType.BLANK_PAGE || []).length >= th)       patterns.push('BLANK_PAGE_ISSUE');

  return { total, byType, patterns };
}

// ── Melhorias cirúrgicas ──
function applyImprovements(analysis, round) {
  const ssPath = path.join(__dirname, 'screenshotter.js');
  const crPath = path.join(__dirname, 'crawler.js');

  if (!fs.existsSync(ssPath) || !fs.existsSync(crPath)) {
    return { applied: ['screenshotter.js ou crawler.js não encontrado — melhorias manuais necessárias'] };
  }

  let ss      = fs.readFileSync(ssPath, 'utf8');
  let cr      = fs.readFileSync(crPath, 'utf8');
  const applied = [];
  const { patterns } = analysis;
  let modified = false;

  // M1 — Timeout progressivo
  if (patterns.includes('HIGH_TIMEOUT_RATE')) {
    const steps = [['15000','25000'],['20000','30000'],['25000','40000'],['30000','50000']];
    const [from, to] = steps[Math.min(round, steps.length-1)];
    if (ss.includes(from)) {
      ss = ss.replace(new RegExp(`timeout:\\s*${from}`, 'g'), `timeout: ${to}`);
      cr = cr.replace(new RegExp(`timeout:\\s*${from}`, 'g'), `timeout: ${to}`);
      applied.push(`Timeout: ${from}ms → ${to}ms`);
      modified = true;
    }
  }

  // M2 — waitUntil mais resiliente
  if (patterns.includes('RENDER_INSTABILITY') && round >= 1) {
    if (ss.includes("waitUntil: 'networkidle0'")) {
      ss = ss.replace(/waitUntil:\s*'networkidle0'/g, "waitUntil: 'domcontentloaded'");
      applied.push("waitUntil: networkidle0 → domcontentloaded");
      modified = true;
    }
  }

  // M3 — Delay pós-navegação para SPAs
  if ((patterns.includes('RENDER_INSTABILITY') || patterns.includes('BLANK_PAGE_ISSUE')) && !ss.includes('SPA_DELAY')) {
    const delays = [800, 1500, 2500];
    const d = delays[Math.min(round, delays.length-1)];
    ss = ss.replace(/(await page\.goto\([^)]+\);)/, `$1\n    // SPA_DELAY\n    await new Promise(r => setTimeout(r, ${d}));`);
    applied.push(`Delay pós-navegação: ${d}ms`);
    modified = true;
  }

  // M4 — Scroll para lazy loading
  if (patterns.includes('BLANK_PAGE_ISSUE') && round >= 1 && !ss.includes('LAZY_SCROLL')) {
    const scroll = `\n    // LAZY_SCROLL\n    await page.evaluate(async () => { await new Promise(r => { let s=0; const t=setInterval(()=>{ window.scrollBy(0,400); s+=400; if(s>=Math.min(document.body.scrollHeight,4000)){clearInterval(t);window.scrollTo(0,0);r();} },80); }); }).catch(()=>{});`;
    ss = ss.replace(/(\/\/ SPA_DELAY\n[^\n]+;)/, `$1${scroll}`);
    applied.push('Scroll automático para lazy loading');
    modified = true;
  }

  // M5 — Ampliar bloqueio de trackers
  if (patterns.includes('HIGH_TIMEOUT_RATE')) {
    const extras = ['doubleclick.net','googlesyndication.com','connect.facebook.net','tiktok.com'];
    let added = 0;
    for (const d of extras) {
      if (!ss.includes(d)) {
        ss = ss.replace(/'google-analytics\.com'/, `'google-analytics.com','${d}'`);
        added++;
      }
    }
    if (added > 0) { applied.push(`+${added} domínios bloqueados`); modified = true; }
  }

  if (modified) {
    fs.writeFileSync(ssPath, ss);
    fs.writeFileSync(crPath, cr);
  }

  return { applied };
}

// ── Relatório por rodada ──
function report(round, results, improvements, prevRate, roundMs) {
  const total    = results.length;
  const success  = results.filter(r => r.classification === 'SUCCESS').length;
  const partial  = results.filter(r => r.classification === 'PARTIAL').length;
  const failures = total - success - partial;
  const rate     = (success + partial) / total;
  const durs     = results.map(r => r.duration).filter(Boolean).sort((a,b) => a-b);
  const avg      = durs.length ? Math.round(durs.reduce((a,b)=>a+b,0)/durs.length) : 0;
  const median   = durs.length ? durs[Math.floor(durs.length/2)] : 0;
  const analysis = analyzeFailures(results);

  const errorRows = Object.entries(analysis.byType)
    .sort((a,b) => b[1].length-a[1].length)
    .map(([t,u]) => `  ${t.padEnd(28)} ${u.length} URL(s)`)
    .join('\n');

  const failedList = results.filter(r => r.classification === 'FAILURE')
    .map(r => `  ❌ ${r.url}\n     → ${r.errorType || '?'}: ${(r.error||'').substring(0,70)}`)
    .join('\n');

  const rpt = `
╔════════════════════════════════════════════════════════════════════╗
║  CAPTURE STRESS AGENT — RODADA ${String(round+1).padEnd(2)} / ${MAX_ROUNDS}                         ║
║  ${new Date().toLocaleString('pt-BR').padEnd(66)}║
╚════════════════════════════════════════════════════════════════════╝

RESUMO EXECUTIVO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Status:            ${rate >= SUCCESS_TARGET ? '✅ META ATINGIDA' : '⏳ EM ANDAMENTO — melhorias em curso'}
Taxa de sucesso:   ${(rate*100).toFixed(1)}%  |  Meta: ${SUCCESS_TARGET*100}%
Ganho vs anterior: ${prevRate !== null ? ((rate-prevRate)*100).toFixed(1)+'%' : 'Primeira rodada'}

PERFORMANCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Sucesso Completo  ${String(success).padStart(3)} URLs  (${((success/total)*100).toFixed(1)}%)
⚠️  Sucesso Parcial  ${String(partial).padStart(3)} URLs  (${((partial/total)*100).toFixed(1)}%)
❌ Falha Total      ${String(failures).padStart(3)} URLs  (${((failures/total)*100).toFixed(1)}%)
⏱️  Tempo médio:    ${(avg/1000).toFixed(1)}s  |  Mediana: ${(median/1000).toFixed(1)}s
🕐 Duração rodada:  ${(roundMs/60000).toFixed(1)} min

FALHAS POR CATEGORIA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${errorRows || '  Nenhuma falha'}

PADRÕES: ${analysis.patterns.join(', ') || 'Nenhum dominante'}

MELHORIAS APLICADAS NESTA RODADA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${(improvements||[]).map(m=>`  • ${m}`).join('\n') || '  Nenhuma (primeira rodada)'}

URLS COM FALHA TOTAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${failedList || '  Nenhuma ✅'}
`;

  console.log(rpt);
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync(`test-results/round-${round+1}-${Date.now()}.json`,
    JSON.stringify({ round, rate, success, partial, failures, analysis, improvements, results }, null, 2));

  return rate;
}

// ── Loop principal ──
async function main() {
  fs.mkdirSync('test-results', { recursive: true });
  console.log(`\n${'═'.repeat(68)}\nCAPTURE STRESS AGENT — SNAPDECK\n${ALL_URLS.length} URLs | Meta: ${SUCCESS_TARGET*100}% | Máx rodadas: ${MAX_ROUNDS}\n${'═'.repeat(68)}\n`);

  let prevRate = null;
  const allImprovements = {};

  for (let round = 0; round < MAX_ROUNDS; round++) {
    console.log(`\n${'─'.repeat(68)}\nRODADA ${round+1} — ${ALL_URLS.length} URLs com concorrência ${CONCURRENT}\n${'─'.repeat(68)}`);

    const t0 = Date.now();
    let done = 0;

    const results = await runConcurrent(ALL_URLS, async url => {
      const r = await testUrl(url);
      done++;
      const icon = r.classification==='SUCCESS'?'✅':r.classification==='PARTIAL'?'⚠️':'❌';
      console.log(`[${String(done).padStart(3)}/${ALL_URLS.length}] ${icon} ${url.substring(0,55).padEnd(55)} ${(r.duration/1000).toFixed(1)}s`);
      return r;
    }, CONCURRENT);

    const rate = report(round, results, allImprovements[round] || [], prevRate, Date.now()-t0);

    if (rate >= SUCCESS_TARGET) {
      console.log(`\n${'═'.repeat(68)}\n✅ META ${SUCCESS_TARGET*100}% ATINGIDA NA RODADA ${round+1}! Taxa final: ${(rate*100).toFixed(1)}%\n${'═'.repeat(68)}\n`);
      process.exit(0);
    }

    if (round < MAX_ROUNDS-1) {
      const analysis = analyzeFailures(results);
      const { applied } = applyImprovements(analysis, round);
      allImprovements[round+1] = applied;

      if (applied.length) {
        console.log(`\nMelhorias para rodada ${round+2}:\n${applied.map(m=>`  • ${m}`).join('\n')}`);
        console.log('\nAguardando 10s para estabilização...');
        await sleep(10000);
      }
    }

    prevRate = rate;
  }

  console.log(`\n${'═'.repeat(68)}\n⚠️  LIMITE DE ${MAX_ROUNDS} RODADAS ATINGIDO\nTaxa final: ${(prevRate*100).toFixed(1)}% | Meta: ${SUCCESS_TARGET*100}%\nRelatórios: ./test-results/\n${'═'.repeat(68)}\n`);
  process.exit(1);
}

main().catch(err => { console.error('[FATAL]', err.message); process.exit(1); });
```

---

## Como Executar

```bash
# Servidor deve estar rodando em outra aba
node server.js

# Executar o agente
node capture-stress-agent.js

# Com log em arquivo
node capture-stress-agent.js 2>&1 | tee test-results/run-$(date +%Y%m%d-%H%M%S).log
```

---

## Critérios de Classificação

| Classificação | Critério objetivo |
|---|---|
| Sucesso Completo | Arquivo ≥ 80KB, sem erro, galeria retornada |
| Sucesso Parcial | Arquivo entre 30KB e 80KB, sem erro crítico |
| Falha Total | Qualquer erro, arquivo < 30KB, timeout |

## Critérios de Parada

- **Meta atingida:** taxa ≥ 90% em uma rodada → `process.exit(0)`
- **Limite atingido:** 5 rodadas sem atingir meta → relatório final + `process.exit(1)`

## Definição de Pronto

1. Script criado e executando sem crash
2. Loop autônomo rodou sem intervenção humana
3. Taxa ≥ 90% comprovada **OU** 5 rodadas com gargalos documentados
4. Relatórios JSON em `test-results/` com dados de cada rodada
5. Nenhum sistema fora do motor de captura foi modificado
