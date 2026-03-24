const fs = require('fs');
const path = require('path');

const TEMPLATES_FILE = path.join(__dirname, 'data', 'templates.json');
const templates = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));

const dist = {
  free: [
    'void', 'chrome', 'float', 'annotation', 'paper', 'story', 
    'tablet', 'minimal-dark', 'white-space', 'spread', 'zine', 'newspaper'
  ],
  device: [
    'macbook', 'iphone-pro', 'browser-dark', 'terminal', 'ipad', 'slate', 
    'duo', 'arcade', 'watch', 'isometric', 'dashboard-panel', 'code-review'
  ],
  creative: [
    'cinematic', 'gradient-mesh', 'noir', 'neon', 'glitch', 'vaporwave', 
    'aurora', 'retro-wave', 'duo-split', 'device-glow', 'duotone', 'color-block'
  ],
  professional: [
    'magazine-cover', 'poster-a4', 'film-frame', 'grid-lines', 'ruled', 
    'dot-matrix', 'mono-line', 'neon-border', 'blueprint', 'schematic', 
    'polaroid', 'diorama', 'linkedin-banner', 'twitter-card', 'instagram-post', 
    'og-image', 'whatsapp-preview'
  ]
};

templates.forEach(t => {
  for (const [cat, ids] of Object.entries(dist)) {
    if (ids.includes(t.id)) {
      t.category = cat;
      t.plan = (cat === 'free') ? 'free' : 'starter';
      break;
    }
  }
});

fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2));
console.log('Sucesso: Templates redistribuídos e planos atualizados.');
