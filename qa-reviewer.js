'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL   = 'claude-opus-4-5';
const ROOT    = __dirname;

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(msg) { process.stdout.write(msg + '\n'); }
function esc(s)   { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function readFile(rel, maxChars) {
  try {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) return null;
    let content = fs.readFileSync(full, 'utf8');
    const lines = content.split('\n').length;
    const kb    = Math.round(Buffer.byteLength(content) / 1024 * 10) / 10;
    if (maxChars && content.length > maxChars) content = content.slice(0, maxChars) + '\n... [truncado]';
    return { rel, content, lines, kb };
  } catch { return null; }
}

async function callClaude(prompt, systemPrompt) {
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY não configurada.');
  const body = {
    model: MODEL,
    max_tokens: 2048,
    system: systemPrompt || 'Você é um revisor de código sênior e especialista em produtos SaaS. Responda SEMPRE em JSON válido conforme o schema solicitado. Seja brutal e honesto.',
    messages: [{ role: 'user', content: prompt }],
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`API error ${res.status}: ${txt}`);
  }
  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  // Extract JSON from response
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Resposta não contém JSON: ' + text.slice(0, 200));
  return JSON.parse(match[0]);
}

// ── Step 1: Read files ────────────────────────────────────────────────────────
const FILE_LIST = [
  { rel: 'server.js' },
  { rel: 'screenshotter.js' },
  { rel: 'crawler.js' },
  { rel: 'renderer.js' },
  { rel: 'jobs.js' },
  { rel: 'billing.js' },
  { rel: 'subscriptions.js' },
  { rel: 'codes.js' },
  { rel: 'public/index.html', maxChars: 15000 },
  { rel: 'data/config.json' },
  { rel: 'data/templates.json' },
  { rel: '.env.example' },
  { rel: 'package.json' },
  { rel: 'instrument.js' },
];

function readAllFiles() {
  const results = [];
  let totalKb = 0;
  for (const { rel, maxChars } of FILE_LIST) {
    const f = readFile(rel, maxChars);
    if (f) { results.push(f); totalKb += f.kb; }
  }
  return { files: results, totalKb: Math.round(totalKb * 10) / 10 };
}

// ── Step 2: Static analysis ───────────────────────────────────────────────────
function staticAnalysis(files) {
  const issues = [];
  let totalTodos = 0, totalConsoleLogs = 0;
  const fileSummary = [];

  for (const f of files) {
    const todos = (f.content.match(/\bTODO\b|\bFIXME\b|\bplaceholder\b/gi) || []).length;
    const logs  = (f.content.match(/\bconsole\.log\b/g) || []).length;
    totalTodos       += todos;
    totalConsoleLogs += logs;
    fileSummary.push({ name: f.rel, lines: f.lines, kb: f.kb, todos, logs });
    if (todos > 0) issues.push(`${f.rel}: ${todos} TODO/FIXME encontrado(s)`);
    if (logs > 5) issues.push(`${f.rel}: ${logs} console.log em produção`);
  }

  // Check package.json
  const pkg = files.find(f => f.rel === 'package.json');
  if (pkg) {
    try {
      const p = JSON.parse(pkg.content);
      if (!p.scripts?.start) issues.push('package.json: script "start" não definido');
    } catch { issues.push('package.json: JSON inválido'); }
  }

  // Check .env.example
  const envEx = files.find(f => f.rel === '.env.example');
  const envVars = envEx ? envEx.content.match(/^[A-Z_]+=.*/gm) || [] : [];

  // Check instrument.js for Sentry
  const hasSentry = files.some(f => f.rel === 'instrument.js' && f.content.length > 20);
  if (!hasSentry) issues.push('instrument.js: Sentry não configurado');

  return { issues, totalTodos, totalConsoleLogs, fileSummary, envVars: envVars.length };
}

// ── Step 3: AI review dimensions ─────────────────────────────────────────────
const SCHEMA = `{
  "score": <number 0-10>,
  "critical": [<string>, ...],
  "minor": [<string>, ...],
  "positive": [<string>, ...]
}`;

async function reviewDimension(name, prompt) {
  process.stdout.write(`Revisando ${name}... `);
  try {
    const result = await callClaude(prompt);
    const score = typeof result.score === 'number' ? result.score : 5;
    log(`✓ Score: ${score.toFixed(1)}/10`);
    return { name, score, ...result };
  } catch (e) {
    log(`✗ Erro: ${e.message}`);
    return { name, score: 5, critical: [`Erro ao revisar: ${e.message}`], minor: [], positive: [] };
  }
}

// ── Step 4: Generate HTML report ──────────────────────────────────────────────
function scoreColor(score) {
  if (score >= 7.5) return '#22c55e';
  if (score >= 5)   return '#f59e0b';
  return '#ef4444';
}

function verdictColor(v) {
  if (v === 'PRONTO') return '#22c55e';
  if (v === 'QUASE PRONTO') return '#f59e0b';
  return '#ef4444';
}

function generateHtml(staticResult, dimensions, finalReview, totalKb, fileSummary) {
  const avgScore   = dimensions.reduce((s, d) => s + d.score, 0) / dimensions.length;
  const verdict    = finalReview.verdict || (avgScore >= 7.5 ? 'QUASE PRONTO' : avgScore >= 5 ? 'NÃO ESTÁ PRONTO' : 'NÃO ESTÁ PRONTO');
  const priorities = finalReview.priorities || [];
  const now        = new Date().toLocaleString('pt-BR');

  const dimCards = dimensions.map(d => `
    <div class="dim-card" style="border-top:3px solid ${scoreColor(d.score)}">
      <div class="dim-header">
        <span class="dim-name">${esc(d.name)}</span>
        <span class="dim-score" style="color:${scoreColor(d.score)}">${d.score.toFixed(1)}/10</span>
      </div>
      ${d.critical?.length ? `<div class="dim-section crit"><div class="dim-sec-title">🔴 Crítico</div>${d.critical.map(c=>`<div class="dim-item">${esc(c)}</div>`).join('')}</div>` : ''}
      ${d.minor?.length    ? `<div class="dim-section minor"><div class="dim-sec-title">🟡 Menor</div>${d.minor.map(c=>`<div class="dim-item">${esc(c)}</div>`).join('')}</div>` : ''}
      ${d.positive?.length ? `<div class="dim-section pos"><div class="dim-sec-title">🟢 Positivo</div>${d.positive.map(c=>`<div class="dim-item">${esc(c)}</div>`).join('')}</div>` : ''}
    </div>`).join('');

  const fileRows = fileSummary.map(f => `
    <tr>
      <td>${esc(f.name)}</td>
      <td>${f.lines.toLocaleString()}</td>
      <td>${f.kb} KB</td>
      <td style="color:${f.todos>0?'#f59e0b':'#22c55e'}">${f.todos}</td>
      <td style="color:${f.logs>5?'#f59e0b':'#666'}">${f.logs}</td>
    </tr>`).join('');

  const prioItems = priorities.map((p, i) => `
    <div class="prio-item">
      <div class="prio-num">${i+1}</div>
      <div class="prio-text">${esc(typeof p === 'string' ? p : JSON.stringify(p))}</div>
    </div>`).join('');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA Report — SnapShot.pro</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{background:#0a0a0a;color:rgba(255,255,255,0.85);font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;line-height:1.6;}
body::before{content:'';position:fixed;inset:0;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Ccircle cx='1' cy='1' r='1' fill='rgba(255,255,255,0.04)'/%3E%3C/svg%3E");background-size:20px 20px;pointer-events:none;z-index:0;}
.wrap{max-width:1100px;margin:0 auto;padding:40px 24px;position:relative;z-index:1;}
.header{text-align:center;padding:60px 0 40px;}
.logo{font-size:13px;color:rgba(255,255,255,0.3);letter-spacing:0.15em;text-transform:uppercase;margin-bottom:16px;}
.verdict-badge{display:inline-block;padding:16px 40px;border-radius:12px;font-size:28px;font-weight:800;letter-spacing:0.05em;margin:16px 0;}
.score-big{font-size:72px;font-weight:900;line-height:1;margin:8px 0;}
.meta{font-size:13px;color:rgba(255,255,255,0.3);margin-top:8px;}
.section{margin:40px 0;}
.section-title{font-size:11px;text-transform:uppercase;letter-spacing:0.15em;color:rgba(255,255,255,0.3);margin-bottom:20px;font-weight:600;}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;}
.stat-card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:16px;}
.stat-val{font-size:32px;font-weight:700;color:rgba(255,255,255,0.9);}
.stat-lbl{font-size:11px;color:rgba(255,255,255,0.35);margin-top:4px;}
table{width:100%;border-collapse:collapse;background:rgba(255,255,255,0.02);border-radius:10px;overflow:hidden;border:1px solid rgba(255,255,255,0.07);}
th{padding:10px 14px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:rgba(255,255,255,0.35);border-bottom:1px solid rgba(255,255,255,0.07);}
td{padding:10px 14px;font-size:13px;border-bottom:1px solid rgba(255,255,255,0.04);}
tr:last-child td{border-bottom:none;}
.dim-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;}
.dim-card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:20px;}
.dim-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;}
.dim-name{font-size:15px;font-weight:600;}
.dim-score{font-size:20px;font-weight:800;}
.dim-section{margin-top:12px;}
.dim-sec-title{font-size:11px;font-weight:600;margin-bottom:6px;opacity:0.6;}
.dim-item{font-size:12px;color:rgba(255,255,255,0.65);padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);}
.dim-item:last-child{border-bottom:none;}
.prio-item{display:flex;align-items:flex-start;gap:16px;padding:16px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;margin-bottom:10px;}
.prio-num{width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;flex-shrink:0;}
.prio-text{font-size:14px;color:rgba(255,255,255,0.8);line-height:1.5;}
.issue-list{background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.15);border-radius:10px;padding:16px;}
.issue-item{font-size:13px;color:rgba(239,68,68,0.8);padding:4px 0;}
footer{text-align:center;padding:40px 0;font-size:12px;color:rgba(255,255,255,0.2);}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div class="logo">SnapShot.pro — Relatório de QA</div>
    <div class="verdict-badge" style="background:${verdictColor(verdict)}22;color:${verdictColor(verdict)};border:2px solid ${verdictColor(verdict)}44;">${esc(verdict)}</div>
    <div class="score-big" style="color:${scoreColor(avgScore)}">${avgScore.toFixed(1)}<span style="font-size:24px;color:rgba(255,255,255,0.2)">/10</span></div>
    <div class="meta">Gerado em ${esc(now)} · ${fileSummary.length} arquivos revisados · ${totalKb} KB total</div>
  </div>

  <div class="section">
    <div class="section-title">Métricas do Projeto</div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-val">${fileSummary.length}</div><div class="stat-lbl">Arquivos analisados</div></div>
      <div class="stat-card"><div class="stat-val">${totalKb} KB</div><div class="stat-lbl">Tamanho total</div></div>
      <div class="stat-card"><div class="stat-val" style="color:${staticResult.totalTodos>0?'#f59e0b':'#22c55e'}">${staticResult.totalTodos}</div><div class="stat-lbl">TODOs / FIXMEs</div></div>
      <div class="stat-card"><div class="stat-val" style="color:${staticResult.totalConsoleLogs>10?'#f59e0b':'#666'}">${staticResult.totalConsoleLogs}</div><div class="stat-lbl">console.log</div></div>
      <div class="stat-card"><div class="stat-val">${staticResult.envVars}</div><div class="stat-lbl">Variáveis de ambiente</div></div>
    </div>
  </div>

  ${staticResult.issues.length ? `
  <div class="section">
    <div class="section-title">Problemas Detectados Automaticamente</div>
    <div class="issue-list">
      ${staticResult.issues.map(i => `<div class="issue-item">⚠ ${esc(i)}</div>`).join('')}
    </div>
  </div>` : ''}

  <div class="section">
    <div class="section-title">Tamanho dos Arquivos</div>
    <table>
      <thead><tr><th>Arquivo</th><th>Linhas</th><th>Tamanho</th><th>TODOs</th><th>console.log</th></tr></thead>
      <tbody>${fileRows}</tbody>
    </table>
  </div>

  <div class="section">
    <div class="section-title">Revisão por Dimensão</div>
    <div class="dim-grid">${dimCards}</div>
  </div>

  ${prioItems ? `
  <div class="section">
    <div class="section-title">Top Prioridades Antes do Lançamento</div>
    ${prioItems}
  </div>` : ''}

  <footer>Revisão gerada automaticamente pelo agente de QA do SnapShot.pro</footer>
</div>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log('\nSnapShot.pro QA Reviewer');
  log('========================');

  if (!API_KEY) {
    log('\n✗ ANTHROPIC_API_KEY não encontrada no .env');
    log('  Adicione ao .env: ANTHROPIC_API_KEY=sk-ant-...');
    process.exit(1);
  }

  // Step 1 — Read files
  process.stdout.write('Lendo arquivos do projeto... ');
  const { files, totalKb } = readAllFiles();
  log(`✓ (${files.length} arquivos, ${totalKb} KB total)`);

  // Step 2 — Static analysis
  process.stdout.write('Análise estática... ');
  const staticResult = staticAnalysis(files);
  log(`✓ (${staticResult.totalTodos} TODOs, ${staticResult.totalConsoleLogs} console.logs)`);

  // Helper to get file content
  const getContent = (...rels) => rels.map(r => {
    const f = files.find(x => x.rel === r);
    return f ? `\n\n=== ${r} (${f.lines} linhas) ===\n${f.content}` : '';
  }).join('');

  // Step 3 — AI reviews
  const dimensions = [];

  dimensions.push(await reviewDimension('Qualidade do Código', `
Revise o código Node.js backend abaixo e responda com o schema JSON exato: ${SCHEMA}

PERGUNTA: Este código está pronto para produção? Identifique: funções incompletas, falta de error handling, possíveis memory leaks, código duplicado, anti-patterns, e qualquer coisa que causaria problema com usuários reais. Seja brutal e honesto. Foco em problemas que afetam o funcionamento real.

ARQUIVOS:
${getContent('server.js', 'jobs.js', 'crawler.js')}`));

  dimensions.push(await reviewDimension('Fluxo de Pagamento', `
Revise o sistema de pagamento abaixo e responda com o schema JSON exato: ${SCHEMA}

PERGUNTA: Este sistema de pagamento está correto e seguro? O checkout PIX está implementado corretamente? A verificação de webhook está segura? O código de acesso é gerado e validado corretamente? Identifique qualquer falha que causaria perda de dinheiro ou acesso não autorizado.

ARQUIVOS:
${getContent('billing.js', 'codes.js', 'subscriptions.js')}`));

  dimensions.push(await reviewDimension('UX e Interface', `
Revise a interface frontend abaixo e responda com o schema JSON exato: ${SCHEMA}

PERGUNTA: Esta interface está pronta para um usuário real que chegou por um anúncio de Meta Ads? Avalie: clareza do fluxo, mensagens de erro, estados de loading, mobile responsiveness, e qualquer ponto onde o usuário ficaria confuso ou abandonaria. Liste pontos específicos que parecem amadores ou incompletos.

ARQUIVO:
${getContent('public/index.html')}`));

  dimensions.push(await reviewDimension('Performance e Confiabilidade', `
Revise o sistema de captura abaixo e responda com o schema JSON exato: ${SCHEMA}

PERGUNTA: Este sistema de captura vai funcionar com usuários reais em sites variados? Identifique: possíveis travamentos, memory leaks de browser, sites que vão falhar, timeouts mal configurados, e qualquer situação onde o produto entregaria resultado ruim.

ARQUIVOS:
${getContent('screenshotter.js', 'renderer.js')}`));

  dimensions.push(await reviewDimension('Segurança', `
Revise a segurança do servidor abaixo e responda com o schema JSON exato: ${SCHEMA}

PERGUNTA: Este servidor tem vulnerabilidades que afetariam um produto real? Verifique: validação de inputs, proteção do painel admin, exposição de dados sensíveis, rate limiting, e qualquer vetor de abuso ou ataque óbvio.

ARQUIVO:
${getContent('server.js')}`));

  // Final verdict
  process.stdout.write('Gerando veredicto final... ');
  const verdictSchema = `{
  "score": <number 0-10 média geral>,
  "verdict": <"PRONTO" | "QUASE PRONTO" | "NÃO ESTÁ PRONTO">,
  "priorities": [<string top-5 prioridades em ordem>],
  "critical": [],
  "minor": [],
  "positive": [<string pontos fortes gerais>]
}`;
  const finalReview = await callClaude(`
Com base nas avaliações das seguintes dimensões de um produto SaaS chamado SnapShot.pro, responda com o schema JSON exato: ${verdictSchema}

DIMENSÕES AVALIADAS:
${dimensions.map(d => `- ${d.name}: ${d.score.toFixed(1)}/10
  Crítico: ${(d.critical||[]).slice(0,3).join('; ')}
  Positivo: ${(d.positive||[]).slice(0,2).join('; ')}`).join('\n')}

ANÁLISE ESTÁTICA:
- TODOs: ${staticResult.totalTodos}
- console.logs: ${staticResult.totalConsoleLogs}
- Problemas: ${staticResult.issues.join(', ') || 'nenhum'}

PERGUNTA: Com base em tudo avaliado, este produto está pronto para receber usuários reais pagantes via Meta Ads? Dê um veredicto claro. Liste as 5 coisas mais importantes a corrigir antes de lançar, em ordem de prioridade. Seja direto como um investidor avaliando o produto.`);
  log('✓\n');

  const avgScore = dimensions.reduce((s, d) => s + d.score, 0) / dimensions.length;
  log(`VEREDICTO: ${finalReview.verdict || 'QUASE PRONTO'} (Score: ${avgScore.toFixed(1)}/10)`);

  // Generate HTML
  const html = generateHtml(staticResult, dimensions, finalReview, totalKb, staticResult.fileSummary);
  const outPath = path.join(ROOT, 'qa-report.html');
  fs.writeFileSync(outPath, html, 'utf8');
  log(`Relatório salvo em: qa-report.html`);
}

main().catch(e => { log(`\nErro fatal: ${e.message}`); process.exit(1); });
