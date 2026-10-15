// The trip recap as a picture to share (1080 × 1350, the shape Instagram and WhatsApp show best):
// title and dates, the big numbers, and the group's favourite stops — drawn on a canvas.
export interface RecapCard {
  title: string;
  dates: string;
  stats: { value: string; label: string }[];
  favourites: string[];
}

function wrap(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > max && line) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export async function recapImage(card: RecapCard): Promise<Blob> {
  await document.fonts?.ready;
  const W = 1080, H = 1350, P = 84;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Couldn\'t draw the picture.');
  const font = (w: number, px: number) => `${w} ${px}px Lato, "Segoe UI", Arial, sans-serif`;

  // Dusk sky.
  const g = ctx.createLinearGradient(0, 0, W * 0.4, H);
  g.addColorStop(0, '#0f2240'); g.addColorStop(0.55, '#1f4e79'); g.addColorStop(1, '#e8704f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // A soft sun and the dotted route.
  const sun = ctx.createRadialGradient(W - 200, 260, 10, W - 200, 260, 260);
  sun.addColorStop(0, 'rgba(242,181,68,.55)'); sun.addColorStop(1, 'rgba(242,181,68,0)');
  ctx.fillStyle = sun; ctx.fillRect(0, 0, W, H);
  ctx.setLineDash([14, 18]); ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(255,255,255,.35)';
  ctx.beginPath(); ctx.moveTo(P, H - 210); ctx.bezierCurveTo(W * 0.3, H - 210, W * 0.35, H - 360, W * 0.55, H - 330); ctx.bezierCurveTo(W * 0.78, H - 300, W * 0.8, H - 420, W - P, H - 430); ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = 'rgba(255,255,255,.75)';
  ctx.font = font(700, 30);
  ctx.fillText('TRIP RECAP', P, 150);
  ctx.fillStyle = '#fff';
  ctx.font = font(900, 84);
  let y = 250;
  for (const line of wrap(ctx, card.title, W - P * 2).slice(0, 3)) { ctx.fillText(line, P, y); y += 96; }
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.font = font(400, 36);
  ctx.fillText(card.dates, P, y + 4);

  // Big numbers, two by two.
  y += 70;
  const cw = (W - P * 2 - 30) / 2, ch = 170;
  card.stats.slice(0, 4).forEach((s, i) => {
    const x = P + (i % 2) * (cw + 30), yy = y + Math.floor(i / 2) * (ch + 26);
    ctx.fillStyle = 'rgba(255,255,255,.12)';
    ctx.beginPath(); ctx.roundRect(x, yy, cw, ch, 28); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = font(900, 66);
    ctx.fillText(s.value, x + 34, yy + 92, cw - 60);
    ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.font = font(700, 28);
    ctx.fillText(s.label.toUpperCase(), x + 34, yy + 138, cw - 60);
  });
  y += 2 * (ch + 26) + 30;

  if (card.favourites.length) {
    ctx.fillStyle = '#f2b544'; ctx.font = font(900, 34);
    ctx.fillText('★ GROUP FAVOURITES', P, y);
    ctx.fillStyle = '#fff'; ctx.font = font(700, 38);
    card.favourites.slice(0, 3).forEach((f, i) => ctx.fillText(`${i + 1}. ${f}`, P, y + 62 + i * 56, W - P * 2));
  }

  ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.font = font(900, 34);
  ctx.fillText('GoWander', P, H - 80);
  ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.font = font(400, 28);
  ctx.fillText('Planned together · Followed live', P + 190, H - 80);

  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Couldn\'t draw the picture.'))), 'image/jpeg', 0.9));
}
