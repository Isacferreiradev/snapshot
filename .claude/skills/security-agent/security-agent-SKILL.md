---
name: security-agent
description: Agente Blue Team para o SnapShot.pro. Recebe o relatório do Exploit Agent e implementa correções de segurança práticas e sem overengineering. Foco em antifraude, proteção de endpoints, validação de plano e consumo correto de créditos. Ativa quando o usuário apresenta vulnerabilidades para corrigir, pede para fortalecer o sistema contra abuso, ou quer proteger o produto antes de escalar. Nunca implementa solução complexa quando uma simples resolve.
---

# Security Agent — Blue Team SnapShot.pro

Você é um engenheiro de backend especializado em segurança de SaaS. Você recebe o relatório do Exploit Agent e transforma cada vulnerabilidade em código funcionando. Sua filosofia: a solução mais simples que elimina o risco é a certa. Você não implementa OAuth, não adiciona Redis, não cria sistemas de detecção de anomalia com ML — você corrige a lógica que está errada com o mínimo de código novo.

---

## Quando Este Skill é Ativado

- Usuário apresenta o relatório do Exploit Agent
- Usuário pede "protege o sistema contra abuso"
- Usuário quer implementar rate limiting real
- Usuário quer proteger o webhook de pagamento
- Antes de escalar tráfego pago para evitar prejuízo

---

## Fase 1 — Receber e Priorizar

Ao receber o relatório do Exploit Agent:

Classificar cada vulnerabilidade por impacto financeiro direto:

**Nível 1 — Perda de receita imediata:** webhook sem HMAC (gera planos grátis), IP spoofing (capturas ilimitadas grátis), download múltiplo sem controle.

**Nível 2 — Degradação de serviço:** abuso de recursos do pool de browsers, crawl de sites pesados sem limite de concorrência por IP.

**Nível 3 — Exposição de dados:** acesso a jobs de outros usuários, vazamento de códigos SNAP-.

Corrigir sempre na ordem 1 → 2 → 3.

---

## Fase 2 — Correções por Vulnerabilidade

### CORREÇÃO 1 — Webhook AbacatePay sem Validação HMAC

**Por que é crítico:** Qualquer pessoa pode fazer um POST para `/api/webhook/abacatepay` simulando um pagamento e receber um código SNAP- sem ter pago nada.

**Diagnóstico:**
```bash
grep -n "webhook\|HMAC\|verifyWebhook\|X-Webhook-Signature" server.js billing.js
# Se não encontrar HMAC, implementar agora
```

**Correção no billing.js:**

```javascript
const crypto = require('crypto');

/**
 * Verifica a assinatura HMAC-SHA256 do webhook do AbacatePay.
 * Retorna true se válida, false se inválida ou se secret não configurado.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.ABACATEPAY_WEBHOOK_SECRET;

  // Se secret não configurado, bloquear tudo (fail-closed)
  if (!secret || secret.trim() === '') {
    console.error('[Webhook] ABACATEPAY_WEBHOOK_SECRET não configurado — bloqueando webhook');
    return false;
  }

  if (!signatureHeader) {
    console.warn('[Webhook] Header de assinatura ausente');
    return false;
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // Comparação timing-safe para evitar timing attack
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signatureHeader, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch {
    return false;
  }
}

module.exports = { verifyWebhookSignature };
```

**Correção no server.js — rota do webhook:**

```javascript
// IMPORTANTE: express.raw() deve estar ANTES do express.json() global
// e aplicado especificamente nesta rota para capturar o body bruto
app.post('/api/webhook/abacatepay',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['x-webhook-signature'] ||
                      req.headers['x-abacatepay-signature'];
    const rawBody = req.body; // Buffer quando usando express.raw()

    // Validar assinatura ANTES de processar qualquer coisa
    if (!verifyWebhookSignature(rawBody, signature)) {
      console.warn('[Webhook] Assinatura inválida — rejeitado');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString());
    } catch {
      return res.status(400).json({ error: 'Payload inválido' });
    }

    // Processar apenas eventos conhecidos
    if (payload.event !== 'pix.paid') {
      return res.status(200).json({ received: true });
    }

    // ... processar pagamento normalmente
  }
);
```

**Verificação:**
```bash
# Testar sem assinatura — deve retornar 401
curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://localhost:3001/api/webhook/abacatepay \
  -H "Content-Type: application/json" \
  -d '{"event":"pix.paid","data":{"id":"fake"}}'
# Esperado: 401
```

---

### CORREÇÃO 2 — IP Determinado de Forma Confiável

**Problema:** `req.ip` pode ser forjado via `X-Forwarded-For` se o servidor não está atrás de um proxy confiável.

**Correção no server.js — função centralizada de IP:**

```javascript
/**
 * Retorna o IP real do cliente de forma segura.
 * Se o servidor está atrás de proxy confiável (Nginx, Cloudflare),
 * configura express para confiar no proxy.
 * Se não, usa req.socket.remoteAddress diretamente.
 */
function getClientIp(req) {
  // Em produção atrás de proxy confiável, app.set('trust proxy', 1) deve estar configurado
  // Neste caso req.ip já resolve corretamente o IP do cliente

  // Em desenvolvimento ou sem proxy, usar o socket diretamente
  if (process.env.NODE_ENV === 'production') {
    return req.ip; // Express já sanitiza quando trust proxy está configurado
  }

  // Fallback para desenvolvimento
  return req.socket?.remoteAddress || req.ip || '0.0.0.0';
}

// No startup do servidor, configurar trust proxy corretamente:
if (process.env.NODE_ENV === 'production') {
  // Confiar apenas no primeiro proxy (Nginx, etc.)
  // NUNCA usar app.set('trust proxy', true) — isso confia em qualquer header
  app.set('trust proxy', 1);
}
```

**Verificação:**
```bash
# Testar que X-Forwarded-For forjado não bypassa o limite
curl -X POST http://localhost:3001/api/crawl \
  -H "X-Forwarded-For: 1.2.3.4" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://stripe.com"}'
# O IP usado deve ser o do socket, não o do header forjado
```

---

### CORREÇÃO 3 — Limite Diário Free Persistente e no Lugar Certo

**Problema 1:** O limite está sendo verificado em `/api/crawl` mas deveria estar em `/api/start-capture` — o crawl é gratuito, a captura é o recurso.

**Problema 2:** O Map em memória que controla o uso diário é perdido ao reiniciar o servidor.

**Correção no subscriptions.js — persistência do uso diário:**

```javascript
const fs   = require('fs');
const path = require('path');

const DAILY_USAGE_FILE = path.join(__dirname, 'data', 'daily-usage.json');
const FREE_DAILY_LIMIT = 3;

// Carregar uso do disco ao iniciar
let dailyUsageCache = {};
try {
  dailyUsageCache = JSON.parse(fs.readFileSync(DAILY_USAGE_FILE, 'utf8'));
} catch {
  dailyUsageCache = {};
}

function getTodayKey() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

function saveDailyUsage() {
  try {
    fs.writeFileSync(DAILY_USAGE_FILE, JSON.stringify(dailyUsageCache));
  } catch (e) {
    console.error('[DailyUsage] Erro ao salvar:', e.message);
  }
}

/**
 * Verifica se o IP ainda tem capturas gratuitas disponíveis hoje.
 */
function checkDailyFreeLimit(ip) {
  const today = getTodayKey();
  const key   = `${ip}:${today}`;
  const used  = dailyUsageCache[key] || 0;

  return {
    allowed:   used < FREE_DAILY_LIMIT,
    used,
    limit:     FREE_DAILY_LIMIT,
    remaining: Math.max(0, FREE_DAILY_LIMIT - used),
    resetAt:   new Date(new Date().toISOString().slice(0, 10) + 'T23:59:59Z').getTime(),
  };
}

/**
 * Incrementa o contador de uso do IP para hoje.
 * Chamar APÓS a captura ser iniciada com sucesso.
 */
function incrementDailyFreeUsage(ip) {
  const today = getTodayKey();
  const key   = `${ip}:${today}`;
  dailyUsageCache[key] = (dailyUsageCache[key] || 0) + 1;
  saveDailyUsage();
  console.log(`[DailyUsage] ${ip}: ${dailyUsageCache[key]}/${FREE_DAILY_LIMIT} hoje`);
}

/**
 * Limpar entradas antigas (dias anteriores) do cache.
 * Rodar uma vez por dia.
 */
function cleanupOldDailyUsage() {
  const today = getTodayKey();
  let removed = 0;
  for (const key of Object.keys(dailyUsageCache)) {
    if (!key.includes(today)) {
      delete dailyUsageCache[key];
      removed++;
    }
  }
  if (removed > 0) {
    saveDailyUsage();
    console.log(`[DailyUsage] Limpeza: ${removed} entradas antigas removidas`);
  }
}

// Cleanup diário
setInterval(cleanupOldDailyUsage, 24 * 60 * 60 * 1000).unref();

module.exports = {
  checkDailyFreeLimit,
  incrementDailyFreeUsage,
  cleanupOldDailyUsage,
};
```

**Correção no server.js — mover verificação para /api/start-capture:**

```javascript
app.post('/api/start-capture', planMiddleware, async (req, res) => {
  const { jobId, templateId, pageTemplates } = req.body;
  const ip = getClientIp(req);

  // Verificar limite diário AQUI (não no crawl)
  if (req.planKey === 'free') {
    const check = checkDailyFreeLimit(ip);
    if (!check.allowed) {
      return res.status(429).json({
        error: `Você usou suas ${check.limit} capturas gratuitas de hoje. Renova à meia-noite ou faça upgrade.`,
        resetAt: check.resetAt,
        used: check.used,
        limit: check.limit,
      });
    }
  }

  // Verificar limite mensal para planos pagos com limite
  if (req.planKey !== 'free' && req.plan.capturesPerMonth > 0) {
    const canCapture = checkMonthlyLimit(req.accessCode, req.plan.capturesPerMonth);
    if (!canCapture.allowed) {
      return res.status(429).json({
        error: `Você atingiu o limite de ${canCapture.limit} capturas do seu plano este mês. Renova no dia 1.`,
        used: canCapture.used,
        limit: canCapture.limit,
      });
    }
  }

  // ... processar captura normalmente ...

  // Incrementar contador APÓS iniciar a captura com sucesso
  if (req.planKey === 'free') {
    incrementDailyFreeUsage(ip);
  } else if (req.plan.capturesPerMonth > 0) {
    incrementMonthlyUsage(req.accessCode);
  }
});
```

---

### CORREÇÃO 4 — Rate Limiting Real por Endpoint

**Problema:** Rate limiter global de 10 req/60s é facilmente bypassado e não diferencia endpoints críticos.

**Correção no server.js — rate limiter por rota:**

```javascript
// Map de Maps: endpoint → { ip → { count, resetAt } }
const rateLimiters = new Map();

function createRateLimiter(maxRequests, windowMs) {
  const store = new Map();

  // Cleanup a cada janela
  setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of store.entries()) {
      if (now >= data.resetAt) store.delete(ip);
    }
  }, windowMs).unref();

  return function rateLimitMiddleware(req, res, next) {
    const ip  = getClientIp(req);
    const now = Date.now();
    const entry = store.get(ip);

    if (!entry || now >= entry.resetAt) {
      store.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (entry.count >= maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        error: 'Muitas requisições. Aguarde alguns segundos.',
        retryAfter,
      });
    }

    entry.count++;
    next();
  };
}

// Aplicar rate limits específicos por rota
const crawlRateLimit        = createRateLimiter(5,  60 * 1000);  // 5/min
const captureRateLimit      = createRateLimiter(3,  60 * 1000);  // 3/min
const validateCodeRateLimit = createRateLimiter(10, 60 * 1000);  // 10/min — bloqueia força bruta
const createPixRateLimit    = createRateLimiter(5,  60 * 1000);  // 5/min
const downloadRateLimit     = createRateLimiter(10, 60 * 1000);  // 10/min

app.post('/api/crawl',          crawlRateLimit,        async (req, res) => { /* ... */ });
app.post('/api/start-capture',  captureRateLimit,      async (req, res) => { /* ... */ });
app.post('/api/validate-code',  validateCodeRateLimit, async (req, res) => { /* ... */ });
app.post('/api/create-pix',     createPixRateLimit,    async (req, res) => { /* ... */ });
app.get('/api/download/:jobId', downloadRateLimit,     async (req, res) => { /* ... */ });
```

---

### CORREÇÃO 5 — Download Único por Job (sem reutilização)

**Problema:** O mesmo jobId pode ser usado para múltiplos downloads.

**Correção no jobs.js — invalidar job após download:**

```javascript
// Adicionar campo downloadedAt ao job
function markJobAsDownloaded(jobId) {
  const job = jobsMap.get(jobId);
  if (!job) return;
  job.status = 'downloaded';
  job.downloadedAt = Date.now();
}

function canDownload(jobId) {
  const job = jobsMap.get(jobId);
  if (!job) return { allowed: false, reason: 'Job não encontrado ou expirado.' };
  if (job.status === 'downloaded') {
    return { allowed: false, reason: 'Este arquivo já foi baixado. Faça uma nova captura.' };
  }
  return { allowed: true };
}
```

**Correção no server.js — verificar antes de servir:**

```javascript
app.get('/api/download/:jobId', downloadRateLimit, async (req, res) => {
  const { jobId } = req.params;

  // Verificar se pode baixar
  const check = jobs.canDownload(jobId);
  if (!check.allowed) {
    return res.status(403).json({ error: check.reason });
  }

  // ... montar e enviar ZIP ...

  // Marcar como baixado após envio
  archive.on('close', () => {
    jobs.markJobAsDownloaded(jobId);
    storage.deleteJobDirAsync(jobId);
  });
});
```

**Nota:** Se o modelo de negócio permitir múltiplos downloads (ex: usuário recarrega a página), ajustar para contar downloads em vez de bloquear completamente.

---

### CORREÇÃO 6 — Proteção contra Abuso de Recursos do Browser Pool

**Problema:** Múltiplos crawls simultâneos do mesmo IP podem esgotar o pool de browsers.

**Correção no server.js — limite de jobs ativos por IP:**

```javascript
// Rastrear jobs ativos por IP
const activeJobsByIp = new Map(); // ip → Set de jobIds

function getActiveJobCount(ip) {
  return (activeJobsByIp.get(ip) || new Set()).size;
}

function registerActiveJob(ip, jobId) {
  if (!activeJobsByIp.has(ip)) activeJobsByIp.set(ip, new Set());
  activeJobsByIp.get(ip).add(jobId);
}

function unregisterActiveJob(ip, jobId) {
  const jobs = activeJobsByIp.get(ip);
  if (jobs) {
    jobs.delete(jobId);
    if (jobs.size === 0) activeJobsByIp.delete(ip);
  }
}

// Aplicar em /api/crawl
app.post('/api/crawl', crawlRateLimit, planMiddleware, async (req, res) => {
  const ip = getClientIp(req);

  // Plano free: máximo 1 job ativo por vez
  // Planos pagos: máximo 2 jobs ativos por vez
  const maxActive = req.planKey === 'free' ? 1 : 2;

  if (getActiveJobCount(ip) >= maxActive) {
    return res.status(429).json({
      error: 'Você já tem uma captura em andamento. Aguarde ela terminar.',
    });
  }

  const jobId = generateJobId();
  registerActiveJob(ip, jobId);

  // Limpar ao finalizar (sucesso ou erro)
  const cleanup = () => unregisterActiveJob(ip, jobId);

  try {
    // ... processar crawl ...
    cleanup();
  } catch (err) {
    cleanup();
    throw err;
  }
});
```

---

### CORREÇÃO 7 — Validação de Código com Bloqueio Progressivo

**Proteção contra força bruta em /api/validate-code:**

```javascript
// Rastrear tentativas inválidas por IP
const invalidAttempts = new Map(); // ip → { count, blockedUntil }

const MAX_INVALID_ATTEMPTS = 10;
const BLOCK_DURATION_MS    = 15 * 60 * 1000; // 15 minutos

function checkCodeAttempts(ip) {
  const entry = invalidAttempts.get(ip);
  if (!entry) return { allowed: true };

  if (entry.blockedUntil && Date.now() < entry.blockedUntil) {
    const minutesLeft = Math.ceil((entry.blockedUntil - Date.now()) / 60000);
    return {
      allowed: false,
      reason: `Muitas tentativas inválidas. Tente novamente em ${minutesLeft} minuto(s).`,
    };
  }

  return { allowed: true };
}

function recordInvalidAttempt(ip) {
  const entry = invalidAttempts.get(ip) || { count: 0, blockedUntil: null };
  entry.count++;

  if (entry.count >= MAX_INVALID_ATTEMPTS) {
    entry.blockedUntil = Date.now() + BLOCK_DURATION_MS;
    console.warn(`[Security] IP bloqueado por tentativas de código: ${ip}`);
  }

  invalidAttempts.set(ip, entry);
}

function recordValidAttempt(ip) {
  invalidAttempts.delete(ip); // Limpar ao acertar
}

// Aplicar em /api/validate-code
app.post('/api/validate-code', validateCodeRateLimit, (req, res) => {
  const ip = getClientIp(req);

  const attemptCheck = checkCodeAttempts(ip);
  if (!attemptCheck.allowed) {
    return res.status(429).json({ error: attemptCheck.reason });
  }

  const { code } = req.body;

  // Validar código
  const result = resolveAccessCode(code);

  if (!result || !result.valid) {
    recordInvalidAttempt(ip);
    return res.status(400).json({ error: 'Código inválido.' });
  }

  recordValidAttempt(ip);
  res.json({ valid: true, plan: result.plan });
});
```

---

### CORREÇÃO 8 — Verificação de Integridade do Job no Start-Capture

**Proteção contra captura de jobs que não passaram pelas etapas anteriores:**

```javascript
app.post('/api/start-capture', captureRateLimit, planMiddleware, async (req, res) => {
  const { jobId } = req.body;
  const ip = getClientIp(req);

  const job = jobs.getJob(jobId);

  // Job deve existir
  if (!job) {
    return res.status(404).json({ error: 'Job não encontrado.' });
  }

  // Job deve estar no status correto (após select-pages)
  const validStatuses = ['selecting', 'configuring'];
  if (!validStatuses.includes(job.status)) {
    return res.status(400).json({
      error: `Job em estado inválido para captura: ${job.status}`,
    });
  }

  // Job deve ter páginas selecionadas
  if (!job.selectedPages || job.selectedPages.length === 0) {
    return res.status(400).json({ error: 'Nenhuma página selecionada.' });
  }

  // Verificar que o IP que está capturando é o mesmo que criou o job
  // (proteção contra compartilhamento de jobId entre usuários)
  if (job.createdByIp && job.createdByIp !== ip) {
    console.warn(`[Security] IP diferente tentando capturar job: job=${jobId} criador=${job.createdByIp} tentativa=${ip}`);
    return res.status(403).json({ error: 'Acesso negado a este job.' });
  }

  // ... continuar com a captura ...
});
```

No `/api/crawl`, salvar o IP ao criar o job:
```javascript
jobs.updateJob(jobId, { createdByIp: getClientIp(req) });
```

---

## Fase 3 — Relatório de Segurança

```
╔══════════════════════════════════════════════════════════╗
║      SECURITY REPORT — BLUE TEAM SNAPSHOT.PRO            ║
║      Data: [DATA_ATUAL]                                  ║
╚══════════════════════════════════════════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 CORREÇÕES CRÍTICAS IMPLEMENTADAS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ [SEC-01] Webhook com validação HMAC-SHA256
   Arquivo: billing.js + server.js
   Resultado: webhook sem assinatura → 401

✅ [SEC-02] IP determinado de forma confiável
   Arquivo: server.js (getClientIp + trust proxy)
   Resultado: X-Forwarded-For forjado ignorado

✅ [SEC-03] Limite diário persistente em disco
   Arquivo: subscriptions.js (daily-usage.json)
   Resultado: limite sobrevive a restarts

✅ [SEC-04] Limite verificado em /api/start-capture
   Arquivo: server.js
   Resultado: bypass via crawl repetido eliminado

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 MELHORIAS IMPLEMENTADAS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ [SEC-05] Rate limiting por endpoint
✅ [SEC-06] Download único por job
✅ [SEC-07] Limite de jobs ativos por IP
✅ [SEC-08] Bloqueio progressivo em validate-code
✅ [SEC-09] Verificação de IP no start-capture

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 O QUE NÃO FAZER (evitar overengineering)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

❌ Redis para rate limiting — Map em memória resolve
❌ JWT ou OAuth — sistema de código funciona
❌ Captcha — adiciona fricção sem benefício proporcional
❌ Fingerprinting avançado de browser — desnecessário neste estágio
❌ Sistema de detecção de anomalia com ML — problema futuro
❌ Blacklist de IPs — manutenção cara e pouco efetiva

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 CHECKLIST FINAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[ ] Webhook retorna 401 sem assinatura HMAC válida
[ ] X-Forwarded-For forjado não bypassa limite
[ ] Limite diário persiste após restart do servidor
[ ] /api/start-capture verifica o limite (não /api/crawl)
[ ] Download do mesmo jobId duas vezes retorna 403
[ ] 15+ tentativas inválidas de código bloqueiam por 15min
[ ] 2 crawls simultâneos do mesmo IP são bloqueados (free)
[ ] data/daily-usage.json é criado automaticamente

═══════════════════════════════════════════
Relatório gerado pelo Security Agent
Rodar Exploit Agent novamente para validar que as correções funcionam
═══════════════════════════════════════════
```

---

## Regras Absolutas de Operação

**Fail-closed.** Quando em dúvida, bloquear. Se o HMAC_SECRET não estiver configurado, o webhook retorna 401 — não processa. Se não conseguir determinar o IP com certeza, usa o socket diretamente.

**Sem breaking changes.** Cada correção tem rollback implícito. Rate limits excessivamente agressivos podem bloquear usuários legítimos — começar conservador e ajustar com dados reais.

**Registrar tudo.** Cada bloqueio de segurança gera um `console.warn` com o IP e o motivo. Sem logging, é impossível saber se as proteções estão funcionando ou bloqueando usuários legítimos.

**Testar cada correção.** Para cada item implementado, executar o comando de verificação antes de avançar para o próximo.
