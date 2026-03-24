# SnapShot.pro — Manifesto Completo do Produto

> Documento gerado em 2026-03-22. Descreve exatamente o que existe no código — não o que deveria existir.
> Para análise estratégica: leia tudo antes de sugerir qualquer mudança.

---

## 1. O QUE É O PRODUTO

**SnapShot.pro** é um micro-SaaS B2B que gera screenshots profissionais de sites, envolve a imagem num template visual e entrega um ZIP com PNGs prontos para usar em apresentações, portfólios, propostas e decks.

**Fluxo completo do usuário:**
```
URL input → Crawl → Seleção de páginas → Escolha de template → Captura → Download ZIP
```

**Stack:**
- Backend: Node.js 18 + Express 4 (CommonJS, sem TypeScript)
- Screenshots: Puppeteer com pool de 2 browsers persistentes
- Frontend: SPA vanilla JS (index.html ~56 KB, sem framework)
- Pagamento: AbacatePay (PIX QR code transparente)
- Erros: Sentry
- Alertas: Telegram Bot
- Persistência: JSON files em disco (sem banco de dados)

---

## 2. ARQUITETURA — MÓDULOS E RESPONSABILIDADES

### server.js — Servidor principal
Orquestra tudo. Express na porta 3001.

**Middleware crítico:**
- Rate limiter: 10 req/60s por IP (cleanup a cada 5 min)
- Plan middleware: lê header `X-Access-Code`, valida via `resolveAccessCode()`, injeta `req.plan`, `req.planKey`, `req.planName`, `req.accessCode` em TODAS as rotas

**`resolveAccessCode(code)`:** distingue dois formatos de código:
- `SNAP-XXXX-XXXX-XXXX` → chama `validateSubscription()` de subscriptions.js (mensal, com limite de capturas)
- Hex 16 chars → chama `validateCode()` de codes.js (pré-pago, créditos por captura)

**Rotas existentes:**

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | /api/webhook/abacatepay | Webhook PIX pago → gera código SNAP- |
| POST | /api/webhook | Legado vazio (compat) |
| GET | /health | `{ok:true, ts}` |
| GET | /api/stats | `{total: N}` contador de capturas |
| GET | /api/plans | Array com info dos 3 planos pagos |
| GET | /api/packages | Alias de /api/plans |
| POST | /api/validate-code | Verifica código SNAP- ou hex |
| POST | /api/create-pix | Gera QR Code PIX via AbacatePay |
| GET | /api/pix-status | Polling: está pago? retorna accessCode |
| POST | /api/simulate-pix | Dev only — simula pagamento |
| POST | /api/validate-url | HEAD request p/ verificar se URL existe |
| POST | /api/crawl | Inicia crawl (assíncrono) → retorna jobId |
| GET | /api/crawl-status/:jobId | Estado atual do job de crawl |
| GET | /api/crawl-stream/:jobId | SSE — logs do crawl em tempo real |
| POST | /api/select-pages | Confirma URLs selecionadas pelo usuário |
| POST | /api/start-capture | Inicia captura assíncrona |
| GET | /api/capture-progress/:jobId | Progresso da captura (percent, gallery) |
| POST | /api/compare | Modo A/B (Pro+) |
| POST | /api/create-checkout | Libera download (só marca como paid) |
| GET | /api/download/:jobId | Serve ZIP e deleta pasta |
| GET | /api/templates | Lista templates com flag `locked` baseado no plano |
| GET | /api/plan-status | Estado completo do plano do requester |
| GET | /api/share-token/:jobId | Retorna share token |
| GET | /share/:token | Página HTML pública de preview (expira em 48h) |

**Lógica de watermark (server.js linha 468):**
```js
applyWatermark = !(subValid && subValid.valid)
// Regra: watermark SE não tem código OU código inválido
// Sem código = free tier = watermark queimada no PNG
```

**Lógica de crédito (linha 527):**
```js
// UMA captura por job (independente de quantas páginas)
consumeAccessCredit(subCode);
// SNAP-: incrementCaptures() (conta capturas mensais)
// hex: decrementCode() (conta créditos pré-pagos)
```

---

### jobs.js — Estado de jobs em memória

Armazena todos os jobs em `Map<jobId, job>`.

**Estrutura completa de um job:**
```js
{
  jobId,            // UUID
  createdAt,        // timestamp
  status,           // 'crawling' | 'selecting' | 'configuring' | 'capturing' | 'ready' | 'paid' | 'downloaded' | 'failed'
  failReason,
  paid,             // boolean
  paidAt,
  downloaded,

  // Acesso
  accessCode,       // código original submetido
  subscriptionCode, // código validado (SNAP- ou hex)
  pkg,              // pacote (starter/pro/agency)

  // Crawl
  pages[],          // [{url, title, pageType, thumbnail, recommended, score}]
  crawlLog[],       // linhas de texto para SSE
  totalFound,       // total de URLs descobertas antes do limite
  planLimit,        // limite de páginas do plano

  // Seleção
  selectedPages[],  // URLs escolhidas pelo usuário

  // Render
  renderConfig,     // {template, mobile, deviceScaleFactor, planName, ...}
  applyWatermark,
  capturedWithPlan,

  // Progresso de captura
  captureProgress,  // {total, completed, current, percent}
  pageStatuses,     // {url → {status, duration}}

  // Por-página
  pageTemplates,    // {url → templateId} — EXISTE MAS NÃO É APLICADO NO RENDER
  pageOrder,        // [url, url, ...] ordenação manual
  pageSettings,     // {url → {aboveFoldOnly, captureStrategy}}
  manualPagesAdded, // contador de páginas adicionadas manualmente

  // Comparação
  compareMode,
  compareUrls[],

  // Galeria
  gallery[],        // [{index, url, title, previewUrl}]

  // Compartilhamento
  shareToken,       // UUID
  shareExpiry,      // timestamp +48h
}
```

**Cleanup automático:** a cada 30 min, deleta jobs com `createdAt` > 2h atrás.

---

### crawler.js — Descoberta de páginas

**`crawlSite(url, jobId, maxPages)`:**
1. Abre browser do pool
2. Navega para a URL seed (`domcontentloaded`, timeout 10s)
3. Extrai todos os `<a href>` + links de nav (prioridade)
4. Filtra: mesmo domínio, sem extensões de arquivo, sem fragmentos
5. Rankeia por pageType score
6. Captura thumbnail (800x500 JPEG q50) para as top N páginas
7. Retorna `{pages[], totalFound}`

**`rankPages(pages)`:** adiciona flag `recommended` nas top 4.

**`groupPages(pages)`:** agrupa por categoria: `homepage`, `produto`, `blog`, `legal`, `outros`.

---

### screenshotter.js — Captura e renderização

**`captureJobPages(urls, jobId, cfg, onProgress, applyWatermark, pageOptions)`:**
- Captura até 3 páginas em paralelo (semáforo)
- Para cada página: captura desktop + mobile
- Aplica template via `renderProfessional()`
- Salva em `screenshots/{jobId}/page-NN/desktop-professional.png` e `mobile-professional.png`
- Gera `preview.png` (thumbnail 400x250 JPEG q60)
- Chama `onProgress(i, result, err)` após cada página

**Viewport desktop:** 1440x900, DSF=2
**Viewport mobile:** 390x844, DSF=3, isMobile=true

**6 estratégias de captura em cascata:**
1. networkidle0 (mais pesada, mais completa)
2. networkidle2
3. domcontentloaded
4. load
5. Full render com scroll
6. Fallback: screenshot direto

**Stealth features:**
- Remove `navigator.webdriver`
- Bloqueia: tracking scripts (GA, Facebook, HotJar, Intercom, etc.), vídeos, fontes de terceiros
- Permite: CSS, imagens, recursos do mesmo domínio

---

### browser-pool.js — Pool de browsers Puppeteer

- 2 browsers persistentes pré-iniciados
- Keep-alive a cada 60s (cria e fecha page em branco)
- Se um browser cair, recria automaticamente
- Overflow: cria browser temporário, fecha após uso
- Flags: `--no-sandbox`, `--disable-dev-shm-usage`, `--disable-gpu`, `--disable-blink-features=AutomationControlled`, `--disable-web-security`

---

### renderer.js — 12 templates

**`renderTemplate(templateId, screenshotPath, deviceType, options)`** → retorna `Buffer` (PNG)

Cada template é uma função async que retorna `{html, renderConfig}`:
- Lê o PNG como base64 e embute diretamente no HTML (`data:image/png;base64,...`)
- HTML completo sem dependências externas
- renderConfig = `{width, height, deviceScaleFactor}`

**Os 12 templates:**

| ID | Dimensões (CSS px) | Plano | Categoria | Descrição |
|----|-------------------|-------|-----------|-----------|
| void | 2400×1600 | free | device | Screenshot flutuando no preto absoluto |
| chrome | 2400×1720 | free | professional | Janela macOS com dots coloridos e URL bar |
| float | 2400×1600 | free | device | Card elevado em gradiente escuro profundo |
| macbook | 2400×1700 | starter | device | MacBook Pro realista com base e stand |
| iphone-pro | 900×1900 | starter | device | iPhone 15 Pro com Dynamic Island e botões |
| browser-dark | 2400×1720 | starter | device | Browser dark com glow violeta sutil |
| terminal | 2400×1720 | starter | device | Janela zsh com prompt verde |
| paper | 2400×1800 | starter | professional | Folha branca sobre fundo bege |
| presentation-slide | 1920×1080 | starter | professional | Editorial 16:9, texto à esq, screenshot à dir |
| cinematic | 2520×1080 | starter | creative | Barras pretas 2.35:1, crédito no rodapé |
| gradient-mesh | 2400×1600 | starter | creative | 4 gradientes radiais nos cantos |
| noir | 2400×1600 | starter | creative | B&W com grain cinematográfico e vinheta |

Todos renderizados em `deviceScaleFactor: 2`, então o PNG de saída tem o dobro de pixels.

**Wrappers para backward compat com screenshotter.js:**
- `renderProfessional({...})` → escreve arquivo no disco, retorna path
- `renderSocialExport({...})` → retorna Buffer
- `renderComparison({...})` → side-by-side 2800×1600

---

### billing.js — Pagamento PIX (AbacatePay)

**`createPixPayment(plan, customer)`:** chama AbacatePay API, salva em `data/billing.json`, retorna QR.

**`checkPixStatus(pixId)`:** polling — verifica local, depois API se pending.

**`activatePayment(pixId, plan)`:** idempotente — gera `SNAP-XXXX-XXXX-XXXX` se ainda não existe.

**`verifyWebhookSignature(rawBody, sig)`:** HMAC-SHA256 com `ABACATEPAY_WEBHOOK_SECRET`.

**Preços:** Starter R$19,90 / Pro R$49,90 / Agency R$129,90 /mês

---

### subscriptions.js — Códigos SNAP- (assinaturas mensais)

- Formato: `SNAP-XXXX-XXXX-XXXX`
- Limites mensais: starter=100, pro=ilimitado, agency=ilimitado
- Reset automático a cada hora (verifica `monthResetAt`)
- Limite diário free por IP: **in-memory** (perdido no restart)
- Validade: 30 dias (renovável via webhook)

---

### codes.js — Códigos hex (pré-pagos)

- Formato: hex 16 chars
- N créditos por código, 1 crédito = 1 job (independente de páginas)
- TTL: 1 ano
- Sem API de geração via admin no server.js

---

### config.js — Planos

Lê `data/config.json`. Expõe `getPlanConfig()`, `isTemplateUnlocked()`, `getLimit()`.

---

### telegram.js — Alertas

`sendAlert(message)` → Telegram Bot API. Falha silenciosamente se não configurado.

Dispara em: pagamento confirmado, 3 falhas consecutivas de captura, simulação de pagamento.

---

### instrument.js — Sentry

Inicializa Sentry com DSN hardcoded. `sendDefaultPii: true` (problema LGPD).

---

## 3. DADOS E CONFIGURAÇÃO

### data/config.json — Planos completos

```
free:
  watermark: true
  templatesUnlocked: ["void", "chrome", "float"]
  crawlLimit: 4
  capturesPerDay: 3         ← verificado em /api/crawl, in-memory
  capturesPerMonth: -1      ← ilimitado (nunca checado)
  mobileCapture: false      ← sem captura mobile
  deviceScaleFactor: 1      ← resolução 1x (qualidade menor)
  manualPagesPerJob: 0
  compareMode: false
  cssSelector: false
  shareLink: false

starter:
  watermark: false
  templatesUnlocked: "all"
  crawlLimit: 10
  capturesPerDay: -1
  capturesPerMonth: 60
  mobileCapture: true
  deviceScaleFactor: 2
  manualPagesPerJob: 2
  compareMode: false
  cssSelector: false
  shareLink: false

pro:
  watermark: false
  templatesUnlocked: "all"
  crawlLimit: 20
  capturesPerMonth: -1
  mobileCapture: true
  deviceScaleFactor: 2
  manualPagesPerJob: 8
  compareMode: true
  cssSelector: true
  socialExport: true
  shareLink: true (7 dias)
  smartCrop: true
  templatePresets: true

agency:
  watermark: false
  templatesUnlocked: "all"
  crawlLimit: 999
  capturesPerMonth: -1
  mobileCapture: true
  deviceScaleFactor: 2
  manualPagesPerJob: -1 (ilimitado)
  compareMode: true
  cssSelector: true
  apiAccess: true
  shareLink: true (30 dias)
  maxCodes: 3
```

### data/billing.json

Registros de pagamento PIX. Campos: `pixId, plan, status, accessCode, createdAt, paidAt, expiresAt, customer`. Cleanup automático a cada 6h (remove expirados).

---

## 4. FRONTEND — public/index.html

SPA vanilla JS com máquina de estados. Seções mostradas/escondidas por JS.

### Seções (estados da UI)

| Seção | Estado | Descrição |
|-------|--------|-----------|
| s1 | Hero | Input de URL, botão de crawl, validação inline |
| s2 | Crawling | Log em tempo real via SSE + EventSource |
| s3 | Page Selection | Grid de páginas descobertas com thumbnails |
| s4 | Template + Config | Seleção de template, opções de captura |
| s5 | Capturing | Barra de progresso, galeria em tempo real |
| s6 | Ready | Download ZIP, galeria completa, share link |
| s7 | Compare | Modo A/B (Pro+) |

### Fluxo de estado frontend

```
s1 → POST /api/crawl → s2
s2 → SSE crawl-stream + polling crawl-status → s3 (status=selecting)
s3 → POST /api/select-pages → s4
s4 → POST /api/start-capture → s5
s5 → polling capture-progress → s6 (status=ready)
s6 → GET /api/download/:jobId
```

### Seção s4 — Template e Configurações

**Tabs de templates (3 categorias):**
- Dispositivo: void, float, macbook, iphone-pro, browser-dark, terminal
- Profissional: chrome, paper, presentation-slide
- Criativo: cinematic, gradient-mesh, noir

**Panes dinâmicos** preenchidos por `loadTemplates()` → `GET /api/templates`.

**Quando template está `locked`:** clique abre modal de upgrade.

**Seção "Modelo por página" (BUGADA):** div `#per-page-tmpl-section` aparece fixo abaixo da grade de templates. Deveria aparecer APENAS ao clicar num card de template específico, e APENAS para planos pagos.

### Modais existentes

| ID | Propósito |
|----|-----------|
| #modal-pix | Checkout PIX — QR code + polling de status |
| #modal-code | Input de código de acesso |
| #modal-upgrade | Upgrade de plano |
| #modal-share | Link de compartilhamento (48h) |
| #modal-preview | Preview de template em tamanho maior |

### Autenticação/plano no frontend

- `X-Access-Code` header enviado em todas as chamadas de API quando tem código salvo
- `loadPlanStatus()` chama `GET /api/plan-status` → atualiza badge no header
- Badge mostra: nome do plano, capturas restantes (se SNAP-), watermark status
- Código salvo em `localStorage`

---

## 5. FEATURES — STATUS REAL

### Funcionando de ponta a ponta

| Feature | Observação |
|---------|-----------|
| Crawl com SSE em tempo real | Funciona |
| Captura Puppeteer com 6 estratégias | Funciona |
| 12 templates gerando PNGs de alta qualidade | Testado, 12/12 OK |
| Download ZIP com PNGs | Funciona |
| Pagamento PIX QR (AbacatePay) | Integração real |
| Webhook AbacatePay → gera código SNAP- | Implementado |
| Polling de status PIX | Funciona |
| Validação de código SNAP- e hex | Funciona |
| Watermark queimada no PNG | Funciona |
| Rate limiter por IP (10 req/60s) | Funciona |
| Pool de 2 browsers com keep-alive | Funciona |
| Galeria em tempo real durante captura | Funciona |
| Share link temporário (48h) | Implementado |
| Alertas Telegram | Funciona se configurado |
| Sentry error tracking | Funciona |
| Modo compare A/B (Pro+) | Implementado |
| Landing page | Existe |
| Admin panel (admin.html) | Existe, sem auth real |

### Implementado mas quebrado / inconsistente

| Feature | Problema detalhado |
|---------|-------------------|
| **Limite diário free (3/dia)** | Verificado em /api/crawl (não em /api/start-capture). Perdido no restart (in-memory). |
| **Template por página** | State existe (`pageTemplates`), UI existe, mas screenshotter usa só o template global. Não funciona. |
| **Re-renderização após compra** | Usuário compra depois de ver resultado com watermark → PNG não é re-renderizado. Precisa recomeçar tudo. |
| **Endpoint admin generate-code** | admin.html tem botão, mas rota `/admin/generate-code` não existe no server.js. |
| **Códigos hex sem geração por API** | codes.js funciona, mas não há rota REST para criar códigos. |
| **Above fold only** | Flag em `pageSettings`, mas screenshotter ignora. |
| **Manual pages** | jobs.js tem `incrementManualPages()`, mas UI não tem campo para o usuário adicionar URL manual. |

### Flags no config sem nenhuma implementação

| Flag | Config | Código |
|------|--------|--------|
| cssSelector | ✅ | ❌ Nenhum input de seletor CSS na UI, nenhum uso no screenshotter |
| socialExport | ✅ | ❌ `renderSocialExport()` existe no renderer mas nunca é chamado pelo fluxo |
| priorityQueue | ✅ | ❌ Nenhuma fila de prioridade implementada |
| templatePresets | ✅ | ❌ Sem UI e sem implementação |
| smartCrop | ✅ | ❌ Sem implementação |
| apiAccess | ✅ | ❌ Sem endpoints de API pública |
| multipleUrls | ✅ | ❌ Sem UI para múltiplas URLs no mesmo job |

---

## 6. INCONSISTÊNCIAS LÓGICAS CRÍTICAS

### 6.1 — Watermark: quem paga depois não consegue remover

Usuário usa free → vê resultado com watermark → compra plano → recebe código. Os PNGs já foram gerados com watermark queimada. Não existe endpoint de re-renderização. Precisa refazer do zero.

### 6.2 — Onde fica o limite de 3/dia do free?

O limite é verificado em `POST /api/crawl`, não em `POST /api/start-capture`. Um usuário free pode fazer 3 crawls mas capturar 0 vezes e "gastar" o limite. Ou fazer 1 crawl e capturar 10 vezes (se conseguir reusar o jobId).

### 6.3 — Template por página: existe na UI e no state, não funciona no render

A seção "Modelo por página" (`#per-page-tmpl-section`) aparece SEMPRE no HTML da s4. Deveria aparecer só ao clicar num template específico. E mesmo que o usuário configure templates por página, o screenshotter usa apenas `renderConfig.template` (global). `getPageTemplate()` nunca é chamado.

### 6.4 — Dois sistemas de código sem separação na UI

- SNAP-XXXX-XXXX-XXXX: gerado pelo webhook de pagamento, mensal
- hex 16 chars: gerado manualmente (sem rota no server), créditos absolutos

O frontend trata os dois da mesma forma ao validar. O badge de capturas restantes só funciona para SNAP-. Para hex, `capturesRemaining` existe mas a UI pode não exibir corretamente.

### 6.5 — 1 job = 1 crédito independente de quantas páginas

Um job com 10 páginas custa o mesmo que 1 página: 1 crédito de captura mensal. Starter tem 100 capturas/mês — na prática isso é 100 jobs, cada um podendo ter até 12 páginas. É generoso demais ou proposital?

### 6.6 — DSF=1 para free, DSF=2 para starter (sem comunicar ao usuário)

Free tier captura em resolução 1x. Starter em 2x. O usuário free não sabe que a qualidade é menor.

### 6.7 — Admin panel sem autenticação no servidor

admin.html usa MD5 do password no frontend para "verificar". Quem abrir o HTML pode ver o hash e acessar. Não existem rotas `/admin/*` no server.js. O admin chama as mesmas rotas `/api/*` abertas a todos.

### 6.8 — Webhook: plano default é 'starter' se não encontrar no metadata

```js
// server.js linha 160
if (!plan) plan = 'starter';
```

Se o webhook chegar sem metadata de plano, gera código starter. Isso pode acontecer se o AbacatePay não enviar o metadata corretamente.

### 6.9 — Share link sem expiração visível na UI

Token expira em 48h mas nenhum lugar na UI exibe isso. Usuário pode enviar o link e ele expirar sem aviso.

---

## 7. FLUXO DE PAGAMENTO COMPLETO (como existe hoje)

```
1. Usuário clica "Ativar plano" no frontend
2. Modal PIX abre → POST /api/create-pix {plan, customer?}
3. AbacatePay API cria cobrança → retorna brCode + QR base64
4. billing.js salva em data/billing.json com status=pending
5. Frontend exibe QR code + código copia-cola
6. Frontend polling: GET /api/pix-status?pixId=...
7a. Webhook AbacatePay chega em POST /api/webhook/abacatepay
    → verifica HMAC (se secret configurado)
    → extrai plan do metadata
    → activatePayment(pixId, plan) → gera SNAP-XXXX-XXXX-XXXX
    → sendAlert() Telegram
7b. (OU) polling detecta pago → checkPixStatus → activatePayment
8. /api/pix-status retorna {status:'paid', accessCode:'SNAP-...'}
9. Frontend exibe o código → usuário copia
10. Usuário insere no campo de código
11. POST /api/validate-code → {valid:true, info:{plan, remaining}}
12. Frontend salva em localStorage, próximas requests incluem X-Access-Code
```

---

## 8. ESTRUTURA DE ARQUIVOS

```
snapshot/
├── server.js              # Express + todas as rotas (~800 linhas)
├── jobs.js                # Estado de jobs in-memory
├── crawler.js             # Puppeteer crawl
├── screenshotter.js       # Puppeteer screenshots + renderização
├── renderer.js            # 12 templates HTML → PNG Buffer (~350 linhas)
├── browser-pool.js        # Pool de browsers Puppeteer
├── billing.js             # AbacatePay PIX one-shot
├── abacatepay.js          # AbacatePay billing recorrente (não usado no fluxo)
├── codes.js               # Códigos hex pré-pagos
├── subscriptions.js       # Códigos SNAP- mensais
├── config.js              # Loader do config.json
├── telegram.js            # Alertas
├── instrument.js          # Sentry
├── qa-reviewer.js         # Dev: Claude API code review
├── test-templates.js      # Dev: testa os 12 templates
├── package.json
├── .env.example
├── data/
│   ├── config.json        # Configuração dos 4 planos
│   ├── templates.json     # 12 templates (id, name, category, plan, previewSvg)
│   ├── billing.json       # Registros de pagamento PIX
│   ├── subscriptions.json # Códigos SNAP- ativos
│   └── codes.json         # Códigos hex ativos
├── public/
│   ├── index.html         # App principal SPA (~56KB)
│   ├── landing.html       # Landing page marketing (~11KB)
│   └── admin.html         # Admin panel (~14KB, sem auth real)
└── screenshots/           # Deletado após download
    └── {jobId}/page-NN/
        ├── desktop-professional.png
        ├── mobile-professional.png
        └── preview.png
```

---

## 9. VARIÁVEIS DE AMBIENTE

```env
PORT=3001
NODE_ENV=development
BASE_URL=http://localhost:3001
ABACATEPAY_API_KEY=abc_dev_...
ABACATEPAY_WEBHOOK_SECRET=     # obrigatório em produção
ADMIN_PASSWORD=changeme        # usado no admin.html
SENTRY_DSN=https://...
TELEGRAM_BOT_TOKEN=            # opcional
TELEGRAM_CHAT_ID=              # opcional
ANTHROPIC_API_KEY=             # só para qa-reviewer.js
```

---

## 10. DEPENDÊNCIAS

```json
"@sentry/node":  "^10.45.0",
"archiver":      "^5.3.2",     (ZIP)
"dotenv":        "^16.4.5",
"express":       "^4.18.2",
"puppeteer":     "^21.11.0",
"stripe":        "^14.21.0",   ← instalado MAS NÃO USADO
"uuid":          "^9.0.1"
```

---

## 11. RESUMO EXECUTIVO

### O que funciona de verdade
O fluxo principal funciona: crawl → selecionar → capturar → baixar ZIP. Os 12 templates geram PNGs de alta qualidade. O pagamento PIX funciona. Watermark queimada funciona.

### O que está implementado pela metade
- Template por página: existe no state e na UI, não é aplicado no render
- Limite diário free: verificado no lugar errado, perdido no restart
- Re-renderização pós-compra: não existe
- Admin panel: sem autenticação real no servidor
- Geração de códigos hex: sem rota REST

### O que não existe (só flags no config)
CSS selector, social export automático, priority queue, template presets, smart crop, API pública, múltiplas URLs por job, above-fold-only capture.

### Dívida técnica estrutural
- Sem banco de dados: tudo em JSON files (race conditions, sem backup)
- State em memória: jobs e limite diário perdidos no restart
- Browser pool fixo em 2: sem auto-scaling
- Sem testes automatizados
- Admin sem auth real

---

*Manifesto gerado em 2026-03-22. Reflete o estado exato do código nesta data.*
