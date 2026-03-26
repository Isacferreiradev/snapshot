#!/usr/bin/env node
/**
 * test-download.js — Testa o sistema de download end-to-end
 * Uso: node test-download.js
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const http = require('http');

let passed = 0, failed = 0;
const ok   = m => { console.log(`  ✅ ${m}`); passed++; };
const fail = m => { console.log(`  ❌ ${m}`); failed++; };
const info = m => console.log(`  ℹ️  ${m}`);
const sec  = t => console.log(`\n[${t}]`);

// ── TESTE 1: Disco ────────────────────────────────────────────────────────────
sec('TESTE 1 — Estrutura de screenshots em disco');
const ssDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(ssDir)) {
  info('Pasta screenshots não existe ainda — faça uma captura primeiro');
} else {
  const jobs = fs.readdirSync(ssDir).filter(f =>
    fs.statSync(path.join(ssDir,f)).isDirectory()
  ).sort().reverse();
  info(`Jobs encontrados: ${jobs.length}`);
  if (jobs.length > 0) {
    const jDir = path.join(ssDir, jobs[0]);
    info(`Job mais recente: ${jobs[0]}`);
    const pages = fs.readdirSync(jDir).filter(f =>
      fs.statSync(path.join(jDir,f)).isDirectory() && /^page-\d+$/.test(f)
    ).sort();
    pages.forEach(p => {
      const files = fs.readdirSync(path.join(jDir, p));
      console.log(`\n  Pasta: ${p}`);
      console.log(`  Arquivos: ${files.join(', ')}`);
      const hasDPro  = files.includes('desktop-professional.png');
      const hasMPro  = files.includes('mobile-professional.png');
      const hasD     = files.includes('desktop.png');
      const hasM     = files.includes('mobile.png');
      hasDPro ? ok('desktop-professional.png ✓') : (hasD ? ok('desktop.png ✓') : fail('NENHUM arquivo desktop encontrado'));
      hasMPro ? ok('mobile-professional.png ✓')  : (hasM ? ok('mobile.png ✓')  : fail('NENHUM arquivo mobile encontrado'));
      files.filter(f => f.endsWith('.png')).forEach(f => {
        const sz = fs.statSync(path.join(jDir, p, f)).size;
        sz > 5000 ? ok(`${f}: ${Math.round(sz/1024)}KB`) : fail(`${f}: ${sz} bytes — muito pequeno`);
      });
    });
  }
}

// ── TESTE 2: server.js lógica ─────────────────────────────────────────────────
sec('TESTE 2 — server.js: lógica de download');
try {
  const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  srv.includes('req.query.mode') ? ok('Lê req.query.mode') : fail('NÃO lê req.query.mode');
  (srv.includes('mobile-professional') || srv.includes("'mobile.png'") || srv.includes('"mobile.png"'))
    ? ok('Arquivo mobile referenciado no ZIP') : fail('Arquivo mobile NÃO referenciado no ZIP');
  (srv.includes("mode === 'mobile'") || srv.includes('includeMobile') || srv.includes('mode == "mobile"'))
    ? ok('Condição de modo mobile existe') : fail('Sem condição de modo mobile');
  srv.includes('archive.file') ? ok('archive.file() presente') : fail('archive.file() não encontrado');
} catch(e) { fail('Erro ao ler server.js: ' + e.message); }

// ── TESTE 3: index.html ───────────────────────────────────────────────────────
sec('TESTE 3 — index.html: seletor de formato e função de download');
try {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  (html.includes('data-mode') || html.includes('dl-mode') || html.includes('download-mode') || html.includes("value='full'") || html.includes('value="full"'))
    ? ok('Seletor de modo encontrado') : fail('Seletor de modo NÃO encontrado no HTML');
  (html.includes('?mode=') || html.includes('mode=${') || html.includes('mode="+'))
    ? ok('Função de download envia ?mode=') : fail('Função de download NÃO envia ?mode=');
  (html.includes('currentJobId') || html.includes('window.jobId'))
    ? ok('currentJobId referenciado') : fail('currentJobId não encontrado');
} catch(e) { fail('Erro ao ler index.html: ' + e.message); }

// ── TESTE 4: Servidor ─────────────────────────────────────────────────────────
sec('TESTE 4 — Servidor ativo');
const get = (url, cb) => {
  const r = http.get(url, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => cb(null, res.statusCode, d));
  });
  r.on('error', e => cb(e));
  r.setTimeout(3000, () => cb(new Error('timeout')));
};
get('http://localhost:3001/health', (err, status, body) => {
  if (err) { fail('Servidor não responde: ' + err.message); finish(); return; }
  ok(`Servidor OK (status ${status})`);
  get('http://localhost:3001/api/plan-status', (e2, s2, b2) => {
    if (e2) { fail('/api/plan-status erro: ' + e2.message); finish(); return; }
    try {
      const j = JSON.parse(b2);
      ok(`/api/plan-status OK — plan: ${j.plan}`);
      j.capturesRemaining !== undefined ? ok(`capturesRemaining: ${j.capturesRemaining}`) : fail('capturesRemaining ausente');
    } catch { fail('/api/plan-status resposta inválida'); }
    finish();
  });
});

function finish() {
  console.log('\n========================================');
  console.log('RESULTADO: ' + passed + ' OK | ' + failed + ' FALHOU');
  console.log('========================================\n');
  process.exit(failed > 0 ? 1 : 0);
}
