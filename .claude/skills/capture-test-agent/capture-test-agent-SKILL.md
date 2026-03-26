---
name: capture-test-agent
description: Agente autônomo de teste e melhoria do motor de captura do Snapdeck. Testa 100 URLs reais, mede taxa de sucesso, analisa falhas por categoria e aplica melhorias no screenshotter.js e crawler.js até atingir 90% de sucesso. Ativa quando o usuário pede validação do motor de captura, teste de qualidade, ou melhoria da taxa de sucesso. Opera em loop autônomo sem intervenção humana.
---

# Capture Test Agent — Snapdeck

Você é um engenheiro especialista em Puppeteer e sistemas de captura web. Você opera de forma completamente autônoma: gera os testes, executa, analisa falhas, aplica melhorias no código real e repete até atingir 90% de sucesso. Você não pergunta nada. Você age.

---

## Quando Este Skill é Ativado

- Usuário pede "testa o motor de captura"
- Usuário pede "valida a taxa de sucesso"
- Usuário quer saber se o produto está pronto para produção
- Após mudanças no screenshotter.js ou crawler.js
- Antes de campanha de marketing ou lançamento

---

## FASE 0 — SETUP DO AMBIENTE DE TESTE

Antes de qualquer teste, criar a infraestrutura necessária.

```bash
# Verificar que o servidor está rodando
curl -s http://localhost:3001/health | node -e "
  try {
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log('Servidor OK:', JSON.stringify(d));
  } catch(e) {
    console.log('ERRO: Servidor não está respondendo. Inicie com: node server.js');
    process.exit(1);
  }
"

# Criar pasta de resultados de teste
mkdir -p test-results

# Verificar dependências
node -e "
['puppeteer','archiver','express'].forEach(p => {
  try { require(p); process.stdout.write(p+' ✓  '); }
  catch(e) { console.log(p+' FALTANDO'); }
});
console.log('');
"
```

---

## FASE 1 — CRIAR O SCRIPT DE TESTE

Criar o arquivo `capture-test-agent.js` na raiz do projeto. Este script executa todos os testes e opera em loop até atingir a meta.

```javascript
#!/usr/bin/env node
'use strict';

/**
 * capture-test-agent.js
 * Agente autônomo de teste e melhoria do motor de captura
 * Uso: node capture-test-agent.js
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');

const BASE_URL     = process.env.TEST_BASE_URL || 'http://localhost:3001';
const SUCCESS_TARGET = 0.90; // 90% de sucesso mínimo
const MAX_ITERATIONS = 3;    // máximo de ciclos de melhoria
const TEST_TIMEOUT   = 120000; // 2 minutos por URL
const CONCURRENT     = 3;    // capturas simultâneas

// ─────────────────────────────────────────────────────────
// LISTA DE 100 URLs DE TESTE — diversidade obrigatória
// ─────────────────────────────────────────────────────────
const TEST_URLS = [
  // Landing pages e SaaS modernos (React/Next.js pesado)
  'https://stripe.com',
  'https://linear.app',
  'https://vercel.com',
  'https://notion.so',
  'https://figma.com',
  'https://framer.com',
  'https://loom.com',
  'https://intercom.com',
  'https://hubspot.com',
  'https://mailchimp.com',
  'https://zapier.com',
  'https://airtable.com',
  'https://webflow.com',
  'https://ghost.org',
  'https://supabase.com',
  'https://planetscale.com',
  'https://railway.app',
  'https://render.com',
  'https://fly.io',
  'https://netlify.com',

  // E-commerce
  'https://shopify.com',
  'https://shopify.com/blog',
  'https://shopify.com/pricing',
  'https://woocommerce.com',
  'https://bigcommerce.com',
  'https://squarespace.com',
  'https://wix.com',
  'https://etsy.com',
  'https://gumroad.com',
  'https://lemonsqueezy.com',

  // Sites com muito JavaScript
  'https://react.dev',
  'https://nextjs.org',
  'https://vuejs.org',
  'https://angular.io',
  'https://svelte.dev',
  'https://astro.build',
  'https://remix.run',
  'https://turborepo.com',
  'https://prisma.io',
  'https://trpc.io',

  // Blogs e editorial
  'https://medium.com',
  'https://dev.to',
  'https://css-tricks.com',
  'https://smashingmagazine.com',
  'https://alistapart.com',
  'https://web.dev',
  'https://developer.mozilla.org',
  'https://github.blog',
  'https://vercel.com/blog',
  'https://stripe.com/blog',

  // Docs e produto
  'https://docs.github.com',
  'https://docs.stripe.com',
  'https://supabase.com/docs',
  'https://nextjs.org/docs',
  'https://tailwindcss.com/docs',
  'https://chakra-ui.com/docs',
  'https://radix-ui.com',
  'https://headlessui.com',
  'https://storybook.js.org',
  'https://playwright.dev',

  // Ferramentas e dashboards
  'https://github.com',
  'https://gitlab.com',
  'https://bitbucket.org',
  'https://jira.atlassian.com',
  'https://trello.com',
  'https://asana.com',
  'https://monday.com',
  'https://clickup.com',
  'https://basecamp.com',
  'https://todoist.com',

  // Sites pesados / complexos
  'https://amazon.com',
  'https://youtube.com',
  'https://twitter.com',
  'https://linkedin.com',
  'https://pinterest.com',
  'https://dribbble.com',
  'https://behance.net',
  'https://producthunt.com',
  'https://ycombinator.com',
  'https://techcrunch.com',

  // Sites institucionais
  'https://apple.com',
  'https://microsoft.com',
  'https://google.com',
  'https://aws.amazon.com',
  'https://cloud.google.com',
  'https://azure.microsoft.com',
  'https://digitalocean.com',
  'https://cloudflare.com',
  'https://fastly.com',
  'https://akamai.com',

  // Sites brasileiros
  'https://nubank.com.br',
  'https://ifood.com.br',
  'https://mercadolivre.com.br',
  'https://magazineluiza.com.br',
  'https://americanas.com.br',
  'https://uol.com.br',
  'https://g1.globo.com',
  'https://terra.com.br',
  'https://olx.com.br',
  'https://enjoei.com.br',
];

// ─────────────────────────────────────────────────────────
// FUNÇÕES DE UTILIDADE
// ─────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toLocaleTimeString('pt-BR');
  console.log(`[${ts}] ${msg}`);
}

function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const timeout = options.timeout || TEST_TIMEOUT;

    const req = lib.request(url, {
      method:  options.method  || 'GET',
      headers: options.headers || { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), raw: data });
        } catch {
          resolve({ status: res.statusCode, body: null, raw: data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error(`Timeout após ${timeout}ms`));
    });

    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Pool de execução paralela com concorrência controlada
async function runConcurrent(items, fn, concurrency) {
  const results = [];
  const queue   = [...items];
  const workers = Array(concurrency).fill(null).map(async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) results.push(await fn(item));
    }
  });
  await Promise.all(workers);
  return results;
}

// ─────────────────────────────────────────────────────────
// EXECUTOR DE TESTE POR URL
// ─────────────────────────────────────────────────────────

async function testUrl(url) {
  const start = Date.now();
  const result = {
    url,
    success:   false,
    duration:  0,
    error:     null,
    errorType: null,
    httpStatus: null,
    pagesFound: 0,
    jobId:     null,
  };

  try {
    // PASSO 1 — Iniciar crawl
    const crawlRes = await makeRequest(`${BASE_URL}/api/crawl`, {
      method:  'POST',
      body:    { url },
      timeout: 30000,
    });

    if (crawlRes.status !== 200 || !crawlRes.body?.jobId) {
      result.error     = crawlRes.body?.error || `HTTP ${crawlRes.status}`;
      result.errorType = 'CRAWL_FAILED';
      result.httpStatus = crawlRes.status;
      return result;
    }

    const { jobId } = crawlRes.body;
    result.jobId = jobId;

    // PASSO 2 — Aguardar crawl completar
    let crawlDone = false;
    let attempts  = 0;
    let pages     = [];

    while (!crawlDone && attempts < 20) {
      await sleep(2000);
      attempts++;

      const statusRes = await makeRequest(
        `${BASE_URL}/api/crawl-status/${jobId}`,
        { timeout: 10000 }
      );

      if (!statusRes.body) continue;

      if (statusRes.body.status === 'selecting') {
        crawlDone = true;
        pages     = statusRes.body.pages || [];
        result.pagesFound = pages.length;
      } else if (statusRes.body.status === 'failed') {
        result.error     = statusRes.body.failReason || 'Crawl falhou';
        result.errorType = 'CRAWL_FAILED';
        result.duration  = Date.now() - start;
        return result;
      }
    }

    if (!crawlDone || pages.length === 0) {
      result.error     = 'Crawl timeout ou sem páginas';
      result.errorType = 'CRAWL_TIMEOUT';
      result.duration  = Date.now() - start;
      return result;
    }

    // PASSO 3 — Selecionar a primeira página
    const firstPage = pages[0].url;
    const selectRes = await makeRequest(`${BASE_URL}/api/select-pages`, {
      method:  'POST',
      body:    { jobId, pages: [firstPage] },
      timeout: 10000,
    });

    if (selectRes.status !== 200) {
      result.error     = selectRes.body?.error || 'Falha ao selecionar páginas';
      result.errorType = 'SELECT_FAILED';
      result.duration  = Date.now() - start;
      return result;
    }

    // PASSO 4 — Iniciar captura com template básico
    const captureRes = await makeRequest(`${BASE_URL}/api/start-capture`, {
      method:  'POST',
      body:    { jobId, templateId: 'browser-clean' },
      timeout: 10000,
    });

    if (captureRes.status !== 200) {
      result.error     = captureRes.body?.error || `HTTP ${captureRes.status}`;
      result.errorType = 'CAPTURE_START_FAILED';
      result.duration  = Date.now() - start;
      return result;
    }

    // PASSO 5 — Aguardar captura completar
    let captureDone = false;
    attempts = 0;

    while (!captureDone && attempts < 40) {
      await sleep(3000);
      attempts++;

      const progressRes = await makeRequest(
        `${BASE_URL}/api/capture-progress/${jobId}`,
        { timeout: 10000 }
      );

      if (!progressRes.body) continue;

      const { status, percent } = progressRes.body;

      if (status === 'ready') {
        captureDone = true;
        result.success = true;
      } else if (status === 'failed') {
        result.error     = progressRes.body.failReason || 'Captura falhou';
        result.errorType = 'CAPTURE_FAILED';
        result.duration  = Date.now() - start;
        return result;
      }
    }

    if (!captureDone) {
      result.error     = 'Captura timeout';
      result.errorType = 'CAPTURE_TIMEOUT';
    }

  } catch (err) {
    result.error     = err.message;
    result.errorType = err.message.includes('Timeout') || err.message.includes('timeout')
      ? 'NETWORK_TIMEOUT'
      : 'NETWORK_ERROR';
  }

  result.duration = Date.now() - start;
  return result;
}

// ─────────────────────────────────────────────────────────
// ANALISADOR DE FALHAS
// ─────────────────────────────────────────────────────────

function analyzeFailures(results) {
  const failures = results.filter(r => !r.success);

  const byType = {};
  for (const f of failures) {
    const type = f.errorType || 'UNKNOWN';
    if (!byType[type]) byType[type] = [];
    byType[type].push(f);
  }

  const analysis = {
    total:    failures.length,
    byType,
    patterns: [],
  };

  // Identificar padrões
  if ((byType.CRAWL_TIMEOUT  || []).length >= 3) analysis.patterns.push('TIMEOUT_ALTO');
  if ((byType.CAPTURE_FAILED || []).length >= 3) analysis.patterns.push('RENDER_FALHA');
  if ((byType.NETWORK_ERROR  || []).length >= 3) analysis.patterns.push('REDE_INSTAVEL');
  if ((byType.CRAWL_FAILED   || []).length >= 5) analysis.patterns.push('CRAWLER_FRAGIL');
  if ((byType.CAPTURE_TIMEOUT|| []).length >= 3) analysis.patterns.push('CAPTURA_LENTA');

  return analysis;
}

// ─────────────────────────────────────────────────────────
// MELHORIAS AUTOMÁTICAS
// ─────────────────────────────────────────────────────────

function applyImprovements(analysis, iteration) {
  const applied = [];
  const screenshotterPath = path.join(__dirname, 'screenshotter.js');
  const crawlerPath       = path.join(__dirname, 'crawler.js');

  if (!fs.existsSync(screenshotterPath) || !fs.existsSync(crawlerPath)) {
    log('AVISO: screenshotter.js ou crawler.js não encontrado — melhorias puladas');
    return applied;
  }

  let screenshotter = fs.readFileSync(screenshotterPath, 'utf8');
  let crawler       = fs.readFileSync(crawlerPath, 'utf8');
  let modified      = false;

  // MELHORIA 1 — Aumentar timeout se há muitos timeouts
  if (analysis.patterns.includes('TIMEOUT_ALTO') || analysis.patterns.includes('CAPTURA_LENTA')) {
    const timeoutValues = {
      0: { old: '10000', new_: '20000' },
      1: { old: '20000', new_: '30000' },
      2: { old: '30000', new_: '45000' },
    };
    const tv = timeoutValues[Math.min(iteration, 2)];

    if (tv && screenshotter.includes(tv.old)) {
      screenshotter = screenshotter.replace(
        new RegExp(`timeout:\\s*${tv.old}`, 'g'),
        `timeout: ${tv.new_}`
      );
      crawler = crawler.replace(
        new RegExp(`timeout:\\s*${tv.old}`, 'g'),
        `timeout: ${tv.new_}`
      );
      applied.push(`Timeout aumentado: ${tv.old}ms → ${tv.new_}ms`);
      modified = true;
    }
  }

  // MELHORIA 2 — Melhorar estratégia de waitUntil
  if (analysis.patterns.includes('RENDER_FALHA') || analysis.patterns.includes('CRAWLER_FRAGIL')) {
    // Trocar networkidle0 por domcontentloaded como estratégia mais resiliente
    if (screenshotter.includes("waitUntil: 'networkidle0'") && iteration >= 1) {
      screenshotter = screenshotter.replace(
        /waitUntil:\s*'networkidle0'/g,
        "waitUntil: 'domcontentloaded'"
      );
      applied.push("waitUntil: networkidle0 → domcontentloaded (mais resiliente)");
      modified = true;
    }

    if (crawler.includes("waitUntil: 'networkidle0'") && iteration >= 1) {
      crawler = crawler.replace(
        /waitUntil:\s*'networkidle0'/g,
        "waitUntil: 'domcontentloaded'"
      );
      modified = true;
    }
  }

  // MELHORIA 3 — Adicionar delay pós-navegação se conteúdo vazio
  if (analysis.patterns.includes('RENDER_FALHA')) {
    const delayValues = { 0: 500, 1: 1500, 2: 2500 };
    const delay = delayValues[Math.min(iteration, 2)];

    const delaySnippet = `\n    // Aguardar renderização de SPAs\n    await new Promise(r => setTimeout(r, ${delay}));`;

    if (!screenshotter.includes('Aguardar renderização de SPAs')) {
      // Inserir após page.goto()
      screenshotter = screenshotter.replace(
        /(await page\.goto\([^)]+\);)/,
        `$1${delaySnippet}`
      );
      applied.push(`Delay pós-navegação adicionado: ${delay}ms`);
      modified = true;
    } else {
      // Atualizar o delay existente
      screenshotter = screenshotter.replace(
        /setTimeout\(r,\s*\d+\)\s*\}\);(?=\s*\/\/.*SPA|\s*\/\/.*rende)/,
        `setTimeout(r, ${delay})});`
      );
      applied.push(`Delay pós-navegação aumentado: ${delay}ms`);
      modified = true;
    }
  }

  // MELHORIA 4 — Retry automático em falhas de navegação
  if (analysis.patterns.includes('CRAWLER_FRAGIL') && iteration >= 1) {
    if (!crawler.includes('RETRY_NAVIGATION')) {
      const retryWrapper = `
  // RETRY_NAVIGATION — adicionado pelo capture-test-agent
  let navAttempts = 0;
  const maxNavAttempts = 3;
  while (navAttempts < maxNavAttempts) {
    try {
      navAttempts++;`;

      // Encontrar e envolver o page.goto do crawler
      if (crawler.includes('page.goto(')) {
        applied.push('Retry de navegação adicionado (3 tentativas)');
        // Nota: a modificação real requereria análise mais profunda do código
        // Por segurança, apenas logar a sugestão sem modificar o arquivo
        applied[applied.length - 1] += ' [SUGERIDO — aplicar manualmente]';
      }
    }
  }

  // MELHORIA 5 — Ampliar lista de recursos bloqueados
  if (analysis.patterns.includes('CAPTURA_LENTA') || analysis.patterns.includes('TIMEOUT_ALTO')) {
    const additionalBlocks = [
      'doubleclick.net',
      'googlesyndication.com',
      'adsbygoogle',
      'facebook.net',
      'connect.facebook.net',
      'tiktok.com',
      'snapchat.com',
    ];

    let blocksAdded = 0;
    for (const domain of additionalBlocks) {
      if (!screenshotter.includes(domain) && !crawler.includes(domain)) {
        // Encontrar lista de domínios bloqueados existente e expandir
        if (screenshotter.includes('tracking') || screenshotter.includes('blocked')) {
          screenshotter = screenshotter.replace(
            /('google-analytics\.com'|"google-analytics\.com")/,
            `'google-analytics.com', '${domain}'`
          );
          blocksAdded++;
        }
      }
    }

    if (blocksAdded > 0) {
      applied.push(`${blocksAdded} domínios de tracking adicionados ao bloqueio`);
      modified = true;
    }
  }

  // Salvar arquivos modificados
  if (modified) {
    fs.writeFileSync(screenshotterPath, screenshotter);
    fs.writeFileSync(crawlerPath, crawler);
    log(`Arquivos modificados: screenshotter.js, crawler.js`);
  }

  return applied;
}

// ─────────────────────────────────────────────────────────
// GERADOR DE RELATÓRIO
// ─────────────────────────────────────────────────────────

function generateReport(iteration, results, improvements, durationTotal) {
  const total    = results.length;
  const successes = results.filter(r => r.success).length;
  const failures  = results.filter(r => !r.success);
  const rate      = successes / total;

  const durations = results.map(r => r.duration).filter(d => d > 0);
  const avgDuration = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : 0;

  const slowest = [...results]
    .filter(r => r.success)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 5);

  const errorSummary = {};
  for (const f of failures) {
    const type = f.errorType || 'UNKNOWN';
    errorSummary[type] = (errorSummary[type] || 0) + 1;
  }

  const report = `
╔══════════════════════════════════════════════════════════════╗
║       CAPTURE TEST AGENT — ITERAÇÃO ${iteration + 1}                     ║
║       ${new Date().toLocaleString('pt-BR')}                           ║
╚══════════════════════════════════════════════════════════════╝

RESULTADO GERAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Taxa de sucesso:  ${(rate * 100).toFixed(1)}% (${successes}/${total})
Meta:             90.0%
Status:           ${rate >= SUCCESS_TARGET ? '✅ APROVADO' : '❌ REPROVADO — melhorias necessárias'}
Tempo médio:      ${(avgDuration / 1000).toFixed(1)}s
Tempo total:      ${(durationTotal / 1000 / 60).toFixed(1)} minutos

TOP 5 MAIS LENTAS (sucessos)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${slowest.map((r, i) => `  ${i + 1}. ${r.url.padEnd(50)} ${(r.duration/1000).toFixed(1)}s`).join('\n')}

FALHAS POR TIPO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${Object.entries(errorSummary)
  .sort((a, b) => b[1] - a[1])
  .map(([type, count]) => `  ${type.padEnd(25)} ${count} falha(s)`)
  .join('\n') || '  Nenhuma falha'}

URLS QUE FALHARAM
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${failures.map(f => `  ${f.url}\n    Tipo: ${f.errorType} | Erro: ${(f.error || '').substring(0, 80)}`).join('\n') || '  Nenhuma'}

MELHORIAS APLICADAS NESTA ITERAÇÃO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${improvements.length > 0 ? improvements.map(m => `  • ${m}`).join('\n') : '  Nenhuma melhoria necessária'}
`;

  // Salvar relatório em arquivo
  const reportPath = path.join('test-results', `iteration-${iteration + 1}-${Date.now()}.txt`);
  fs.writeFileSync(reportPath, report);
  console.log(report);
  log(`Relatório salvo: ${reportPath}`);

  return { rate, successes, total, failures, errorSummary, avgDuration };
}

// ─────────────────────────────────────────────────────────
// LOOP PRINCIPAL
// ─────────────────────────────────────────────────────────

async function main() {
  const globalStart = Date.now();

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           CAPTURE TEST AGENT — SNAPDECK                      ║
║           ${TEST_URLS.length} URLs | Meta: ${SUCCESS_TARGET * 100}% sucesso | Max iterações: ${MAX_ITERATIONS}    ║
╚══════════════════════════════════════════════════════════════╝
`);

  let iteration = 0;
  let approved  = false;
  const allImprovements = [];

  while (iteration < MAX_ITERATIONS && !approved) {
    log(`\n${'═'.repeat(60)}`);
    log(`ITERAÇÃO ${iteration + 1} de ${MAX_ITERATIONS}`);
    log(`${'═'.repeat(60)}`);

    const iterStart = Date.now();
    const results   = [];
    let completed   = 0;

    log(`Iniciando ${TEST_URLS.length} testes com concorrência ${CONCURRENT}...`);

    // Executar testes em paralelo controlado
    await runConcurrent(TEST_URLS, async (url) => {
      const result = await testUrl(url);
      completed++;

      const status = result.success ? '✅' : '❌';
      const dur    = (result.duration / 1000).toFixed(1) + 's';
      log(`[${completed.toString().padStart(3)}/${TEST_URLS.length}] ${status} ${url} (${dur})`);

      results.push(result);
      return result;
    }, CONCURRENT);

    // Gerar relatório desta iteração
    const iterDuration = Date.now() - iterStart;
    const improvements = iteration === 0 ? [] : allImprovements.flat();
    const report = generateReport(iteration, results, improvements, iterDuration);

    if (report.rate >= SUCCESS_TARGET) {
      approved = true;
      break;
    }

    // Analisar falhas e aplicar melhorias para a próxima iteração
    if (iteration < MAX_ITERATIONS - 1) {
      log('\nAnalisando falhas e preparando melhorias...');
      const analysis = analyzeFailures(results);

      log(`Padrões detectados: ${analysis.patterns.join(', ') || 'nenhum padrão dominante'}`);

      const iterImprovements = applyImprovements(analysis, iteration);
      allImprovements.push(iterImprovements);

      if (iterImprovements.length > 0) {
        log(`\nMelhorias aplicadas:`);
        iterImprovements.forEach(m => log(`  • ${m}`));
        log('\nAguardando 5s para o servidor aplicar mudanças...');
        await sleep(5000);
      } else {
        log('Nenhuma melhoria automática identificada.');
      }
    }

    iteration++;
  }

  // ─────────────────────────────────────────────────────────
  // RELATÓRIO FINAL
  // ─────────────────────────────────────────────────────────
  const totalDuration = Date.now() - globalStart;

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    RELATÓRIO FINAL                           ║
╚══════════════════════════════════════════════════════════════╝

Status final: ${approved ? '✅ APROVADO' : '❌ META NÃO ATINGIDA'}
Iterações executadas: ${iteration + 1}
Tempo total: ${(totalDuration / 1000 / 60).toFixed(1)} minutos

Todas as melhorias aplicadas:
${allImprovements.flat().map(m => `  • ${m}`).join('\n') || '  Nenhuma'}

${!approved ? `
MELHORIAS FUTURAS RECOMENDADAS:
  • Implementar retry com backoff exponencial no screenshotter.js
  • Adicionar estratégia de screenshot "above the fold" para sites lentos
  • Configurar User-Agent realista para sites que bloqueiam bots
  • Implementar detecção de bloqueio por anti-bot (Cloudflare, etc.)
  • Considerar proxy rotation para sites com rate limiting por IP
  • Aumentar o pool de browsers de 2 para 3 para maior paralelismo
` : ''}

Relatórios detalhados: ./test-results/
`);

  process.exit(approved ? 0 : 1);
}

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
```

---

## FASE 2 — EXECUTAR O AGENTE

```bash
# Garantir que o servidor está rodando em outro terminal
# node server.js

# Executar o agente
node capture-test-agent.js

# Com logs em arquivo
node capture-test-agent.js 2>&1 | tee test-results/run-$(date +%Y%m%d-%H%M%S).log
```

---

## FASE 3 — INTERPRETAR OS RESULTADOS

Após cada execução, os relatórios ficam em `test-results/`. Cada arquivo contém:

- Taxa de sucesso da iteração
- Top 5 URLs mais lentas
- Falhas agrupadas por tipo
- URLs que falharam com erro específico
- Melhorias aplicadas

### Tipos de erro e o que significam:

| Tipo | Causa provável | Correção |
|---|---|---|
| `CRAWL_TIMEOUT` | Site muito lento ou sem resposta | Aumentar timeout, adicionar fallback |
| `CRAWL_FAILED` | Site bloqueia bots, erro HTTP | Melhorar User-Agent, headers |
| `CAPTURE_TIMEOUT` | Rendering demora demais | Usar domcontentloaded, reduzir escopo |
| `CAPTURE_FAILED` | Erro interno no screenshotter | Ver logs do servidor |
| `NETWORK_ERROR` | DNS, SSL, conexão recusada | Esperado para alguns sites |
| `SELECT_FAILED` | Bug na API de seleção | Verificar server.js |

---

## FASE 4 — MELHORIAS MANUAIS ADICIONAIS

Se após 3 iterações a taxa ainda for < 90%, aplicar estas melhorias manuais no `screenshotter.js`:

### Melhoria A — User-Agent realista

```javascript
await page.setUserAgent(
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36'
);
```

### Melhoria B — Headers extras para evitar bloqueio

```javascript
await page.setExtraHTTPHeaders({
  'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
});
```

### Melhoria C — Scroll para ativar lazy loading

```javascript
// Após page.goto(), antes do screenshot
await page.evaluate(async () => {
  await new Promise(resolve => {
    let totalHeight = 0;
    const distance  = 300;
    const timer = setInterval(() => {
      window.scrollBy(0, distance);
      totalHeight += distance;
      if (totalHeight >= Math.min(document.body.scrollHeight, 3000)) {
        clearInterval(timer);
        window.scrollTo(0, 0); // Voltar ao topo
        resolve();
      }
    }, 100);
  });
});
```

### Melhoria D — Ignorar erros de certificate SSL

```javascript
// Em browser-pool.js, nos args do Puppeteer:
'--ignore-certificate-errors',
'--ignore-certificate-errors-spki-list',
```

---

## FASE 5 — RODAR TESTE RÁPIDO (20 URLs)

Para validação rápida antes do teste completo:

```bash
# Editar capture-test-agent.js temporariamente:
# Substituir TEST_URLS pela versão de 20 URLs
node -e "
const urls = require('./capture-test-agent.js').TEST_URLS.slice(0, 20);
console.log('URLs para teste rápido:', urls.length);
"
```

---

## VERIFICAÇÕES FINAIS

```bash
# Verificar que o script foi criado
ls -la capture-test-agent.js

# Verificar sintaxe
node --check capture-test-agent.js && echo "Sintaxe OK"

# Verificar que a pasta de resultados existe
ls -la test-results/ 2>/dev/null || echo "Será criada na primeira execução"

# Verificar que o servidor está acessível
curl -s http://localhost:3001/health | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log('Servidor OK:', d.ok ? 'SIM' : 'NÃO');
"
```

---

## DEFINIÇÃO DE PRONTO

```
□ capture-test-agent.js criado e com sintaxe válida
□ node --check capture-test-agent.js sem erros
□ Servidor rodando em localhost:3001
□ node capture-test-agent.js executa sem crash
□ Relatórios sendo salvos em test-results/
□ Taxa de sucesso >= 90% após no máximo 3 iterações
□ Melhorias aplicadas automaticamente em screenshotter.js
```

---

## INSTRUÇÃO FINAL

Criar `capture-test-agent.js` com o código acima. Verificar sintaxe. Garantir que o servidor está rodando. Executar com `node capture-test-agent.js`. O agente opera autonomamente: testa, analisa, melhora e repete até atingir 90%. Se após 3 iterações não atingir, o relatório final lista as melhorias manuais recomendadas com código pronto para aplicar.
