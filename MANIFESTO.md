# SnapShot.pro — Manifesto do MVP

---

## O que é

SnapShot.pro é uma ferramenta de utilidade pura. O usuário chega com um problema específico — precisa de screenshots profissionais de um site — e sai com o problema resolvido em menos de dois minutos, sem criar conta, sem assinar plano, sem instalar nada.

O produto captura dois formatos simultaneamente: desktop em resolução de monitor moderno e mobile emulando um iPhone atual. Entrega ambos num arquivo ZIP organizado, prontos para usar em portfólio, pitch deck, documentação técnica ou proposta comercial.

Não há cadastro porque cadastro é atrito. Não há dashboard porque não há nada para gerenciar. O modelo pay-per-use é o produto. A ausência de fricção é a feature.

---

## Por que existe

Screenshots profissionais são difíceis de tirar manualmente:

- Navegadores não capturam o pixel exato certo
- Resolução varia por monitor
- Mobile exige emulação ou dispositivo físico
- Ferramentas gratuitas têm marca d'água, limite de uso ou exigem cadastro
- O resultado raramente está pronto para uso profissional

SnapShot.pro resolve isso com um único clique e $4,99. A alternativa custa 20 minutos de trabalho manual e ainda assim fica ruim.

---

## Fluxo completo do produto

```
Usuário cola URL
       ↓
POST /api/capture
       ↓
Puppeteer abre Chrome headless
       ↓
Captura desktop (1440×900 @2x)
Captura mobile (390×844 iPhone)
Gera preview com blur + marca d'água
       ↓
Frontend exibe preview borrado
       ↓
Usuário clica em "Pagar"
       ↓
POST /api/create-checkout
       ↓
[Stripe Checkout — desativado no MVP atual]
       ↓
Job marcado como "pago"
Redirect para /?success=true&jobId=...
       ↓
Frontend detecta params na URL
Aguarda 1,5 segundo
Dispara download automático
       ↓
GET /api/download/:jobId
       ↓
Server monta ZIP via streaming
Envia desktop.png + mobile.png
Deleta arquivos temporários
       ↓
Usuário recebe ZIP com 2 PNGs
```

---

## Arquitetura

O projeto tem **zero dependências externas além do Stripe** (desativado agora). Sem banco de dados, sem fila, sem cloud storage, sem serviço de terceiros. Tudo roda num único processo Node.js.

```
readyscreen/
├── server.js          ← Ponto de entrada. Todas as rotas e middlewares.
├── screenshotter.js   ← Lógica do Puppeteer. Captura e preview.
├── stripe.js          ← Integração Stripe (inativa no momento).
├── jobs.js            ← Estado em memória. Controle dos jobs.
├── public/
│   └── index.html     ← Frontend inteiro. HTML + CSS + JS num único arquivo.
├── screenshots/       ← Pasta temporária. Arquivos vivem por minutos.
│   └── .gitkeep
├── .env               ← Variáveis de ambiente (não vai pro git).
├── .env.example       ← Template documentado do .env.
├── .gitignore
├── package.json
└── README.md
```

### Por que essa estrutura

Cada arquivo tem uma responsabilidade única e não mistura contextos. `server.js` sabe de rotas. `screenshotter.js` sabe de Puppeteer. `jobs.js` sabe de estado. `stripe.js` sabe de pagamento. Nenhum deles sabe do negócio do outro além do mínimo necessário.

---

## Cada arquivo explicado

---

### `jobs.js` — O cérebro de estado

O coração do sistema. Mantém um `Map` JavaScript em memória com o estado de cada job.

**Estrutura de um job:**
```js
{
  jobId: 'uuid-v4',
  createdAt: 1710000000000,  // timestamp em ms
  paid: false,               // true após pagamento confirmado
  paidAt: null,              // timestamp do pagamento
  downloaded: false          // true após ZIP entregue
}
```

**Funções exportadas:**

| Função | O que faz |
|---|---|
| `createJob(jobId)` | Cria entrada no Map com estado inicial |
| `markPaid(jobId)` | Seta `paid: true` e registra `paidAt` |
| `markDownloaded(jobId)` | Seta `downloaded: true` |
| `isPaid(jobId)` | Retorna boolean — job está pago? |
| `jobExists(jobId)` | Retorna boolean — job existe? |
| `getJob(jobId)` | Retorna o objeto completo do job |

**Limpeza automática:**
A cada 30 minutos, um `setInterval` varre o Map e deleta jobs com mais de 2 horas de vida. Isso evita vazamento de memória em produção. O intervalo começa quando o módulo é importado — sem necessidade de chamada explícita.

**Por que não banco de dados:**
Jobs são efêmeros por design. Existem por minutos, não horas. Um banco adicionaria latência, complexidade de setup e um ponto de falha sem nenhum benefício real. Se o servidor reiniciar, jobs em andamento são perdidos — isso é aceitável no MVP porque o fluxo é rápido e o usuário está ativo na sessão.

---

### `screenshotter.js` — O motor de captura

Controla o Puppeteer (Chrome headless) e produz três arquivos para cada job.

**Função principal:** `captureScreenshots(url, jobId)`

**Etapa 1 — Validação:**
Antes de abrir qualquer browser, valida a URL. Verifica se existe, se é string, se começa com `http://` ou `https://`, e se é uma URL válida (`new URL()`). Erros aqui são rápidos e não consomem recursos.

**Etapa 2 — Desktop:**
- Viewport: 1440×900 pixels
- Device scale factor: 2 (equivale a uma tela Retina)
- Screenshot final: 2880×1800px
- Arquivo: `screenshots/{jobId}/desktop.png`
- Tenta `networkidle2` primeiro (aguarda a rede estabilizar), cai para `domcontentloaded` se timeout

**Etapa 3 — Mobile:**
- Viewport: 390×844 pixels (iPhone 14)
- Device scale factor: 3 (Retina do iPhone)
- Screenshot final: 1170×2532px
- User-Agent real de iPhone com iOS 17
- Touch e mobile mode habilitados
- Arquivo: `screenshots/{jobId}/mobile.png`

**Etapa 4 — Preview:**
O preview não é gerado com CSS no navegador — é um novo page do Puppeteer que renderiza um HTML completo com:
- A imagem desktop embutida em base64 (sem depender de URL)
- Filtro `blur(6px)` via CSS
- Overlay semitransparente escuro
- Texto "SnapShot.pro Preview" em diagonal com `transform: rotate(-18deg)`
- Viewport fixo de 800×500px @2x

Esse approach garante que o preview seja pixel-perfect e independente de qualquer estado externo.

**Cleanup de erros:**
Se qualquer etapa falhar, os arquivos parciais são deletados e o erro é relançado com mensagem legível para o usuário. O browser é sempre fechado no bloco `finally` — sem vazamento de processos.

**Timeout:** 30 segundos por navegação. Sites lentos ou inacessíveis recebem uma mensagem descritiva, não um erro genérico.

---

### `stripe.js` — O módulo de pagamento

Atualmente inativo no fluxo principal, mas completamente implementado.

**`createCheckoutSession(jobId)`:**
Cria uma sessão de pagamento único no Stripe com:
- Produto: "Screenshot Pack — Desktop + Mobile"
- Preço: lido de `PRICE_CENTS` no `.env` (padrão: 499 = $4,99)
- Moeda: USD
- `success_url`: redireciona de volta com `?success=true&jobId={jobId}`
- `cancel_url`: volta para a raiz sem parâmetros
- `metadata.jobId`: armazenado na sessão para recuperação no webhook

**`handleWebhook(rawBody, signature)`:**
Verifica a assinatura criptográfica do Stripe para garantir que o evento é legítimo (não pode ser forjado). Extrai o `jobId` dos metadados do evento `checkout.session.completed` e retorna para o `server.js` marcar o job como pago.

**Por que a verificação de assinatura importa:**
Sem ela, qualquer pessoa poderia fazer um POST para `/api/webhook` fingindo que um pagamento foi feito e baixar os arquivos de graça.

---

### `server.js` — O centro de controle

Express rodando na porta 3001 (configurável via `PORT` no `.env`).

**Ordem dos middlewares — isso é crítico:**

```
1. express.raw() — APENAS para /api/webhook
2. express.json() — para todas as outras rotas
3. express.static('public') — serve o index.html
4. express.static('screenshots') — serve os previews
```

A ordem importa porque o Stripe precisa do body **cru** (raw bytes) para verificar a assinatura. Se `express.json()` processar primeiro, os bytes mudam e a verificação falha. Por isso o webhook é registrado antes do parser global.

**Rotas:**

---

**`POST /api/capture`**

Recebe `{ url }`, valida, gera um `jobId` via UUID v4, chama o Puppeteer e retorna o caminho do preview.

Validações:
- `url` deve existir e ser string
- Deve começar com `http://` ou `https://`
- Deve ter no máximo 500 caracteres

Retorna `{ jobId, previewUrl }` em caso de sucesso, `422` se o Puppeteer falhar.

---

**`POST /api/create-checkout`**

Recebe `{ jobId }`, verifica se o job existe e:

- **Modo atual (sem Stripe):** marca o job como pago imediatamente e retorna a URL de sucesso diretamente
- **Modo produção (com Stripe):** cria sessão no Stripe e retorna a URL do Checkout

O frontend não precisa saber qual modo está ativo — ele sempre recebe `{ checkoutUrl }` e redireciona.

---

**`POST /api/webhook`**

Endpoint para o Stripe notificar que um pagamento foi concluído.

- Atualmente: retorna `200 {}` sem fazer nada (o bypass já cuida do `markPaid`)
- Em produção: verifica assinatura, extrai `jobId`, chama `markPaid`

Nunca retorna 5xx para o Stripe — isso causaria retentativas infinitas.

---

**`GET /api/download/:jobId`**

A rota mais importante. Verificações em sequência:

1. Job existe? → 404 se não
2. Job está pago? → 402 se não
3. Arquivos existem no disco? → 410 se já foram deletados

Se tudo ok:
- Configura headers de ZIP com nome do arquivo
- Cria um archive com `archiver`
- Adiciona `desktop.png` e `mobile.png` com nomes descritivos
- Faz pipe do archive direto para o response (streaming — sem salvar ZIP em disco)
- Quando o archive termina: deleta a pasta do job e marca como downloaded

**Por que streaming:**
Um ZIP de dois screenshots em alta resolução pode ter 5-15 MB. Streaming evita acumular tudo em memória antes de enviar.

---

**Handler de erro global:**
Qualquer exceção não tratada em rotas async cai aqui. Retorna `500` com mensagem genérica — nunca expõe stack traces para o usuário.

---

### `public/index.html` — O frontend inteiro

Um único arquivo com HTML, CSS e JavaScript. Sem framework, sem bundler, sem transpilação. O que você vê é o que o browser executa.

**Identidade visual:**
- Fonte: Outfit (Google Fonts) — moderna, geométrica, caráter próprio
- Fundo: `#0a0a0f` — quase preto, não preto puro
- Acento: `#6c47ff` — índigo-violeta
- Texto: `rgba(255,255,255,0.92)` — branco com leve transparência para não estourar
- Texto secundário: `rgba(255,255,255,0.45)` — hierarquia visual sem mudar a cor
- Bordas: `rgba(255,255,255,0.08)` — sutis, quase invisíveis

Todas as cores em variáveis CSS no `:root`. Mudar o tema é trocar 8 linhas.

**Seções da página:**

`#hero` — estado inicial. Título, subtítulo, campo de URL e botão de captura. Visível quando a página carrega sem parâmetros na URL.

`#preview-section` — aparece após captura. Mostra o preview borrado com watermark, as dimensões dos dois formatos, e o card de pagamento com o CTA.

`#success-section` — aparece quando a URL tem `?success=true&jobId=...`. Animação de check, mensagem de confirmação e disparo automático do download.

**Máquina de estados em JavaScript:**

O JS não usa frameworks — controla a visibilidade das seções manipulando a classe `.hidden` diretamente no DOM. As transições são via CSS `opacity + visibility` para não ocupar espaço quando invisível.

Estados:
1. **Inicial** — hero visível, resto oculto
2. **Capturando** — botão desabilitado com spinner, input bloqueado
3. **Erro de captura** — mensagem vermelha abaixo do input, some quando o usuário digita
4. **Preview** — hero some, seção de preview aparece com fade
5. **Redirecionando para pagamento** — botão de pagamento com spinner
6. **Sucesso** — seção de sucesso visível, download automático após 1,5s

**Por que 1,5 segundo de delay no download:**
O Stripe precisa de tempo para processar o webhook depois de redirecionar o usuário. O delay dá margem para o servidor receber e processar o `checkout.session.completed` antes de tentar o download. No modo atual (sem Stripe), o delay é irrelevante mas não prejudica nada.

**O preview borrado:**
O blur existe por razão de negócio: mostrar que a captura funcionou sem entregar o produto. O usuário vê o suficiente para confirmar que está certo antes de pagar. A watermark é gerada no servidor via Puppeteer — não é CSS que o usuário pode remover inspecionando o elemento.

---

## Decisões de arquitetura

### Sem banco de dados

O estado do job (pago ou não, baixado ou não) vive em memória no `Map` do `jobs.js`. Isso funciona porque:

- Jobs são criados e consumidos em minutos
- Um restart de servidor invalida jobs antigos — aceitável porque o usuário está ativo
- Sem banco = sem latência, sem conexão, sem schema, sem migration
- Em escala real, um Redis com TTL seria o próximo passo natural

### Sem autenticação

O produto não sabe quem é o usuário e não precisa. O `jobId` é um UUID v4 aleatório — 122 bits de entropia. É impossível adivinhar o UUID de outro usuário. A "autenticação" é o próprio ID.

### Sem framework de frontend

React, Vue e similares adicionam um build step, um node_modules no cliente, um bundle que precisa ser servido. Para uma página com três seções e uma API, isso é overhead puro. JavaScript vanilla roda direto no browser sem compilação, sem dependência, sem nada para quebrar.

### Sem TypeScript

TypeScript requer compilação. A regra do projeto é zero build steps. JS puro com CommonJS (`require/module.exports`) é consistente em todo o codebase e compatível com todas as versões do Node 18+.

### Sem CSS framework

Tailwind, Bootstrap e afins são abstrações. O CSS desse projeto cabe em 350 linhas e faz exatamente o que precisa. Mais rápido de carregar, mais simples de depurar, mais fácil de entender.

### Streaming do ZIP

O `archiver` faz pipe do arquivo comprimido diretamente para o response HTTP sem materializar o ZIP em disco. O servidor nunca tem que armazenar o arquivo comprimido — ele vai do disco de origem direto para o cliente.

---

## Variáveis de ambiente

| Variável | Obrigatória | Padrão | Descrição |
|---|---|---|---|
| `PORT` | Não | `3000` | Porta HTTP do servidor |
| `BASE_URL` | Sim | — | URL base sem barra final. Ex: `http://localhost:3001` |
| `STRIPE_SECRET_KEY` | Não* | — | Chave secreta do Stripe |
| `STRIPE_PUBLISHABLE_KEY` | Não* | — | Chave pública do Stripe |
| `STRIPE_WEBHOOK_SECRET` | Não* | — | Segredo de verificação de webhook |
| `PRICE_CENTS` | Não | `499` | Preço em centavos (499 = $4,99) |

*Não obrigatórias enquanto o pagamento estiver bypassed.

---

## Estado atual do MVP

| Funcionalidade | Status |
|---|---|
| Captura de screenshot desktop | ✅ Funcionando |
| Captura de screenshot mobile | ✅ Funcionando |
| Preview com blur e watermark | ✅ Funcionando |
| Download do ZIP | ✅ Funcionando |
| Interface visual completa | ✅ Funcionando |
| Limpeza automática de jobs | ✅ Funcionando |
| Pagamento via Stripe | ⏸ Desativado (bypass ativo) |
| Webhook do Stripe | ⏸ Desativado |

O produto está funcional end-to-end. O único componente inativo é o pagamento real — que está mockado para facilitar desenvolvimento e testes.

---

## Próximos passos quando o pagamento for ativado

1. Preencher `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` e `STRIPE_WEBHOOK_SECRET` no `.env`
2. Reverter o `/api/create-checkout` para chamar `createCheckoutSession(jobId)` do `stripe.js`
3. Reativar o handler real do `/api/webhook` com verificação de assinatura
4. Em produção: configurar o endpoint de webhook no painel do Stripe apontando para a URL pública

---

## Limites conhecidos do MVP

**Sem fila de processamento:** se 50 usuários capturarem ao mesmo tempo, o servidor abre 50 instâncias do Chromium simultâneas. Isso consome ~150 MB de RAM por instância. Em escala, o próximo passo é uma fila simples com processamento sequencial ou com limite de concorrência.

**Sem persistência:** restart do servidor perde todos os jobs em andamento. Usuários que estejam no meio do fluxo precisam começar de novo.

**Sem rate limiting:** qualquer IP pode fazer quantas capturas quiser. Em produção, adicionar rate limiting por IP na rota `/api/capture` é essencial.

**Timeout de 30 segundos:** sites extremamente lentos ou pesados podem não carregar completamente. O produto captura o que estiver disponível no timeout.

**Sites com proteção anti-bot:** alguns sites detectam o Chromium headless e bloqueiam ou mostram conteúdo diferente. Isso é uma limitação do Puppeteer, não do produto.

---

## Como rodar

```bash
# Instalar dependências (inclui download do Chromium ~170MB)
npm install

# Iniciar servidor
npm start

# Abrir no browser
http://localhost:3001
```

Não é necessário configurar nenhuma variável de ambiente para testar localmente no estado atual (pagamento bypassed).
