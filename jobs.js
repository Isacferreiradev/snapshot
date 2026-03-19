'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const jobs = new Map();
const shareIndex = new Map(); // shareToken → jobId

const TWO_HOURS_MS    = 2  * 60 * 60 * 1000;
const FORTY_EIGHT_H   = 48 * 60 * 60 * 1000;
const CLEANUP_MS      = 30 * 60 * 1000;
const COUNTER_FILE    = path.join(__dirname, 'counter.json');

// ── Capture counter ───────────────────────────────────────────────────────────
let captureCount = 0;
try { captureCount = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8')).total || 0; } catch {}

function incrementCounter() {
  captureCount++;
  fs.writeFile(COUNTER_FILE, JSON.stringify({ total: captureCount }), () => {});
}
function getCounter() { return captureCount; }

// ── Job CRUD ──────────────────────────────────────────────────────────────────
function createJob(jobId, options) {
  const opts = options || {};
  jobs.set(jobId, {
    jobId,
    createdAt: Date.now(),
    status: 'crawling',
    // Payment / access
    paid: false,
    paidAt: null,
    downloaded: false,
    accessCode: opts.accessCode || null,        // legacy compat
    subscriptionCode: opts.subscriptionCode || null,  // SNAP-XXXX-XXXX-XXXX
    pkg: opts.pkg || null,                 // 'starter' | 'pro' | 'agency'
    // Crawl results
    pages: [],
    selectedPages: [],
    // Render
    renderConfig: {
      template: 'obsidian',
      smartCrop: false,
      socialExport: false,
      scheduleEmail: null,
    },
    captureProgress: { total: 0, completed: 0, current: '', percent: 0 },
    // Compare mode
    compareMode: false,
    compareUrls: null,
    // Share
    shareToken: null,
    shareExpiry: null,
    // Session gallery (list of completed capture results)
    gallery: [],
    // SSE crawl log (array of { ts, message } for streaming)
    crawlLog: [],
  });
}

function markPaid(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.paid    = true;
  job.paidAt  = Date.now();
  const token = uuidv4();
  job.shareToken  = token;
  job.shareExpiry = Date.now() + FORTY_EIGHT_H;
  shareIndex.set(token, jobId);
}

function markDownloaded(jobId) {
  const job = jobs.get(jobId);
  if (job) { job.downloaded = true; job.status = 'downloaded'; }
}

function markReady(jobId) {
  const job = jobs.get(jobId);
  if (job) job.status = 'ready';
}

function markFailed(jobId, reason) {
  const job = jobs.get(jobId);
  if (job) { job.status = 'failed'; job.failReason = reason || 'Erro ao processar.'; }
}

function updateCrawlResult(jobId, pages) {
  const job = jobs.get(jobId);
  if (job) { job.pages = pages; job.status = 'selecting'; }
}

function appendCrawlLog(jobId, message) {
  const job = jobs.get(jobId);
  if (job) job.crawlLog.push({ ts: Date.now(), message });
}

function addGalleryItem(jobId, item) {
  const job = jobs.get(jobId);
  if (job) job.gallery.push(item);
}

function updateSelectedPages(jobId, selectedPages) {
  const job = jobs.get(jobId);
  if (job) { job.selectedPages = selectedPages; job.status = 'configuring'; }
}

function updateRenderConfig(jobId, renderConfig) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.renderConfig = Object.assign({}, job.renderConfig, renderConfig);
  job.captureProgress = {
    total:     job.compareMode ? 2 : job.selectedPages.length,
    completed: 0, current: '', percent: 0,
  };
  job.status = 'capturing';
}

function setCompareMode(jobId, compareUrls) {
  const job = jobs.get(jobId);
  if (job) { job.compareMode = true; job.compareUrls = compareUrls; job.status = 'configuring'; }
}

function updateCaptureProgress(jobId, updates) {
  const job = jobs.get(jobId);
  if (!job) return;
  Object.assign(job.captureProgress, updates);
  const { completed, total } = job.captureProgress;
  if (total > 0) job.captureProgress.percent = Math.floor((completed / total) * 100);
}

function isPaid(jobId) { const j = jobs.get(jobId); return j ? j.paid : false; }
function jobExists(jobId) { return jobs.has(jobId); }
function getJob(jobId) { return jobs.get(jobId) || null; }

function getJobByShareToken(token) {
  const jobId = shareIndex.get(token);
  if (!jobId) return null;
  const job = jobs.get(jobId);
  if (!job || !job.shareExpiry || Date.now() > job.shareExpiry) return null;
  return job;
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - TWO_HOURS_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) {
      if (job.shareToken) shareIndex.delete(job.shareToken);
      jobs.delete(id);
    }
  }
}, CLEANUP_MS);

module.exports = {
  createJob, markPaid, markDownloaded, markReady, markFailed,
  updateCrawlResult, updateSelectedPages, updateRenderConfig,
  updateCaptureProgress, setCompareMode,
  appendCrawlLog, addGalleryItem,
  isPaid, jobExists, getJob, getJobByShareToken,
  incrementCounter, getCounter,
};
