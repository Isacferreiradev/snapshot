'use strict';

const fs   = require('fs');
const path = require('path');

const SCREENSHOTS_BASE = path.join(__dirname, 'screenshots');
const MAX_AGE_MS       = 30 * 60 * 1000; // 30 minutos
const CLEANUP_INTERVAL = 15 * 60 * 1000; // varrer a cada 15 minutos

// Garantir que a pasta base existe ao iniciar
if (!fs.existsSync(SCREENSHOTS_BASE)) {
  fs.mkdirSync(SCREENSHOTS_BASE, { recursive: true });
  console.log('[Storage] Pasta base criada:', SCREENSHOTS_BASE);
}

/**
 * Retorna o path da pasta de um job.
 * Cria a pasta se não existir.
 */
function getJobDir(jobId) {
  const dir = path.join(SCREENSHOTS_BASE, jobId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Retorna o path da pasta de uma página específica dentro de um job.
 * Cria a pasta se não existir.
 */
function getPageDir(jobId, pageIndex) {
  const dir = path.join(SCREENSHOTS_BASE, jobId, `page-${String(pageIndex).padStart(2, '0')}`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Verifica se a pasta de um job existe em disco.
 */
function jobDirExists(jobId) {
  return fs.existsSync(path.join(SCREENSHOTS_BASE, jobId));
}

/**
 * Deleta a pasta completa de um job de forma síncrona.
 * Seguro para chamar mesmo se a pasta não existir.
 */
function deleteJobDir(jobId) {
  const dir = path.join(SCREENSHOTS_BASE, jobId);
  if (!fs.existsSync(dir)) return;

  try {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[Storage] Deletado: ${jobId}`);
  } catch (err) {
    console.error(`[Storage] Erro ao deletar ${jobId}:`, err.message);
  }
}

/**
 * Deleta a pasta de um job de forma assíncrona (não bloqueia o event loop).
 * Usar ao deletar após download — o usuário já recebeu o arquivo.
 */
function deleteJobDirAsync(jobId) {
  setImmediate(() => deleteJobDir(jobId));
}

/**
 * Lista todos os jobIds que têm pasta em disco.
 */
function listJobDirsOnDisk() {
  if (!fs.existsSync(SCREENSHOTS_BASE)) return [];
  return fs.readdirSync(SCREENSHOTS_BASE)
    .filter(name => {
      const fullPath = path.join(SCREENSHOTS_BASE, name);
      try { return fs.statSync(fullPath).isDirectory(); } catch { return false; }
    });
}

/**
 * Retorna o tamanho total da pasta de um job em bytes.
 */
function getJobDirSize(jobId) {
  const dir = path.join(SCREENSHOTS_BASE, jobId);
  if (!fs.existsSync(dir)) return 0;

  let total = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(d, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) walk(fullPath);
        else total += stat.size;
      } catch {}
    }
  };
  walk(dir);
  return total;
}

/**
 * Retorna o tamanho total da pasta base em bytes.
 */
function getTotalStorageSize() {
  let total = 0;
  for (const jobId of listJobDirsOnDisk()) {
    total += getJobDirSize(jobId);
  }
  return total;
}

/**
 * Cleanup automático. Chamado a cada CLEANUP_INTERVAL.
 * Remove:
 *   1. Pastas de jobs mais antigas que MAX_AGE_MS
 *   2. Pastas órfãs (sem job em memória correspondente)
 *
 * @param {Function} getActiveJobIds — função que retorna Set/Array dos jobIds ativos em memória
 */
function runCleanup(getActiveJobIds) {
  const now       = Date.now();
  const onDisk    = listJobDirsOnDisk();
  const activeIds = new Set(getActiveJobIds());

  if (onDisk.length === 0) return;

  console.log(`[Storage] Cleanup iniciado — ${onDisk.length} pasta(s) em disco`);

  let deleted = 0;
  let kept    = 0;

  for (const jobId of onDisk) {
    const dir = path.join(SCREENSHOTS_BASE, jobId);
    let stat;
    try { stat = fs.statSync(dir); } catch { continue; }

    const age    = now - stat.mtimeMs;
    const tooOld = age > MAX_AGE_MS;
    const orphan = !activeIds.has(jobId);

    if (tooOld || orphan) {
      const reason = tooOld
        ? `${Math.round(age / 60000)}min de idade`
        : 'órfão (sem job em memória)';
      console.log(`[Storage] Deletando ${jobId} — ${reason}`);
      deleteJobDir(jobId);
      deleted++;
    } else {
      kept++;
    }
  }

  const totalMB = (getTotalStorageSize() / 1024 / 1024).toFixed(1);
  console.log(`[Storage] Cleanup concluído — deletados: ${deleted} | mantidos: ${kept} | uso total: ${totalMB}MB`);
}

/**
 * Inicializa o cleanup automático em background.
 * Chamar uma vez no startup do servidor.
 *
 * @param {Function} getActiveJobIds — função que retorna Array dos jobIds ativos em memória
 */
function startCleanupScheduler(getActiveJobIds) {
  // Rodar imediatamente no startup para limpar resíduos de sessões anteriores
  setTimeout(() => runCleanup(getActiveJobIds), 5000);

  // Rodar periodicamente
  const interval = setInterval(() => runCleanup(getActiveJobIds), CLEANUP_INTERVAL);

  // Não impedir o processo de fechar
  interval.unref();

  console.log(`[Storage] Scheduler iniciado — cleanup a cada ${CLEANUP_INTERVAL / 60000}min | expiração: ${MAX_AGE_MS / 60000}min`);
}

module.exports = {
  getJobDir,
  getPageDir,
  jobDirExists,
  deleteJobDir,
  deleteJobDirAsync,
  listJobDirsOnDisk,
  getJobDirSize,
  getTotalStorageSize,
  runCleanup,
  startCleanupScheduler,
  SCREENSHOTS_BASE,
  MAX_AGE_MS,
};
