const fs = require('fs');
const path = require('path');

const TEMPLATES_FILE = path.join(__dirname, 'data', 'templates.json');
const templates = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));

function generateSvg(t) {
  const name = t.name || t.id;
  const id = t.id;

  // Estilos base por palavras-chave
  if (id.includes('dark') || id.includes('noir') || id.includes('night')) {
    return `<svg viewBox='0 0 160 120' xmlns='http://www.w3.org/2000/svg'><rect width='160' height='120' fill='#0a0a0a'/><rect x='20' y='15' width='120' height='90' rx='4' fill='#1a1a1a' stroke='#333' stroke-width='1'/><text x='80' y='65' font-family='sans-serif' font-size='8' fill='#555' text-anchor='middle'>${name}</text></svg>`;
  }
  
  if (id.includes('light') || id.includes('white') || id.includes('paper')) {
    return `<svg viewBox='0 0 160 120' xmlns='http://www.w3.org/2000/svg'><rect width='160' height='120' fill='#f5f5f5'/><rect x='20' y='15' width='120' height='90' rx='2' fill='#fff' stroke='#ddd' stroke-width='1'/><text x='80' y='65' font-family='sans-serif' font-size='8' fill='#aaa' text-anchor='middle'>${name}</text></svg>`;
  }

  if (id.includes('neon') || id.includes('glow') || id.includes('glitch')) {
    return `<svg viewBox='0 0 160 120' xmlns='http://www.w3.org/2000/svg'><rect width='160' height='120' fill='#000'/><rect x='20' y='15' width='120' height='90' rx='2' fill='#050505' stroke='#0ff' stroke-width='1.5' opacity='0.8'/><text x='80' y='65' font-family='sans-serif' font-size='8' fill='#0ff' text-anchor='middle' opacity='0.6'>${name}</text></svg>`;
  }

  if (id.includes('banner') || id.includes('header')) {
    return `<svg viewBox='0 0 160 120' xmlns='http://www.w3.org/2000/svg'><rect width='160' height='120' fill='#111'/><rect x='10' y='40' width='140' height='40' rx='2' fill='#222' stroke='#444'/><text x='80' y='65' font-family='sans-serif' font-size='8' fill='#666' text-anchor='middle'>${name}</text></svg>`;
  }

  if (id.includes('mobile') || id.includes('phone') || id.includes('instagram') || id.includes('story') || id.includes('whatsapp')) {
    return `<svg viewBox='0 0 160 120' xmlns='http://www.w3.org/2000/svg'><rect width='160' height='120' fill='#0a0a0a'/><rect x='55' y='10' width='50' height='100' rx='8' fill='#1a1a1a' stroke='#333'/><rect x='58' y='13' width='44' height='94' rx='6' fill='#222'/><text x='80' y='65' font-family='sans-serif' font-size='6' fill='#555' text-anchor='middle'>${name}</text></svg>`;
  }

  // Fallback Modern/Minimal
  return `<svg viewBox='0 0 160 120' xmlns='http://www.w3.org/2000/svg'><defs><linearGradient id='grad-${id}' x1='0' y1='0' x2='1' y2='1'><stop offset='0%' stop-color='#1a1a1a'/><stop offset='100%' stop-color='#0a0a0a'/></linearGradient></defs><rect width='160' height='120' fill='url(#grad-${id})'/><rect x='25' y='20' width='110' height='80' rx='4' fill='rgba(255,255,255,0.03)' stroke='rgba(255,255,255,0.1)'/><text x='80' y='65' font-family='sans-serif' font-size='7' fill='rgba(255,255,255,0.2)' text-anchor='middle'>${name}</text></svg>`;
}

let updatedCount = 0;
templates.forEach(t => {
  if (!t.previewSvg || t.previewSvg.length < 100) {
    t.previewSvg = generateSvg(t);
    updatedCount++;
  }
});

fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2));
console.log(`Sucesso: ${updatedCount} templates atualizados com novos previews SVG.`);
