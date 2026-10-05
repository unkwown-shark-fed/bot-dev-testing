// Renders the /mee6rank image card.
// Requires:  npm install @napi-rs/canvas
// Assets:    assets/rank-bg.webp  (background)  +  assets/fonts/inter-latin-*.woff
const path = require('path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const { fmt, avatarUrl, levelProgress, rewardInfo } = require('./mee6');

// ---- Assets -------------------------------------------------------------
const ASSETS = path.join(__dirname, '..', 'assets');
const FONT = 'Inter';
for (const w of [400, 600, 700, 800]) {
  GlobalFonts.registerFromPath(path.join(ASSETS, 'fonts', `inter-latin-${w}-normal.woff`), FONT);
}

let bgPromise = null;
const getBackground = () => (bgPromise ??= loadImage(path.join(ASSETS, 'rank-bg.webp')));

// ---- Layout constants ---------------------------------------------------
const W = 1100;
const H = 380;
const PAD = 28;               // outer margin around the glass panel
const DEFAULT_COLOR = 0xf1c40f;

// ---- Small drawing helpers ----------------------------------------------
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

function rgba(n, a) {
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function lighten(n, amt) {
  const mix = (c) => Math.round(c + (255 - c) * amt);
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// Shrink the font until the text fits maxWidth
function fitText(ctx, text, maxWidth, weight, startSize, minSize = 26) {
  let size = startSize;
  do {
    ctx.font = `${weight} ${size}px ${FONT}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  } while (size > minSize);
  return size;
}

function truncate(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

async function getAvatar(player) {
  try {
    const res = await fetch(avatarUrl(player).replace('size=128', 'size=256'), {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await loadImage(Buffer.from(await res.arrayBuffer()));
  } catch {
    return null; // we draw an initial-letter placeholder instead
  }
}

// ---- Main ---------------------------------------------------------------
/**
 * @param {{player, rank, guild, roleRewards}} data  result of findPlayer()
 * @param {{avatar?: Image}} [opts]                  optional pre-loaded avatar (used for testing)
 * @returns {Promise<Buffer>} PNG buffer
 */
async function renderRankCard({ player, rank, guild, roleRewards }, opts = {}) {
  const { current } = rewardInfo(player.level, roleRewards);
  const { into, needed, pct } = levelProgress(player);
  const accent = current?.role?.color || DEFAULT_COLOR;
  const toGo = Math.max(0, needed - into);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // ---- Background: cover-fit image, darkened ----
  const bg = await getBackground();
  const scale = Math.max(W / bg.width, H / bg.height);
  const sw = W / scale;
  const sh = H / scale;
  ctx.drawImage(bg, (bg.width - sw) / 2, (bg.height - sh) * 0.55, sw, sh, 0, 0, W, H);

  ctx.fillStyle = 'rgba(8, 8, 12, 0.30)';
  ctx.fillRect(0, 0, W, H);

  const vignette = ctx.createLinearGradient(0, 0, W, 0);
  vignette.addColorStop(0, 'rgba(0, 0, 0, 0.45)');
  vignette.addColorStop(1, 'rgba(0, 0, 0, 0.05)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);

  // ---- Glass panel (darker on the left for text contrast, lighter on the right) ----
  roundRect(ctx, PAD, PAD, W - PAD * 2, H - PAD * 2, 28);
  const panel = ctx.createLinearGradient(PAD, 0, W - PAD, 0);
  panel.addColorStop(0, 'rgba(10, 10, 14, 0.70)');
  panel.addColorStop(1, 'rgba(10, 10, 14, 0.42)');
  ctx.fillStyle = panel;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
  ctx.stroke();

  // Accent line along the top edge of the panel
  ctx.save();
  roundRect(ctx, PAD, PAD, W - PAD * 2, H - PAD * 2, 28);
  ctx.clip();
  const topLine = ctx.createLinearGradient(PAD, 0, W - PAD, 0);
  topLine.addColorStop(0, hex(accent));
  topLine.addColorStop(1, rgba(accent, 0));
  ctx.fillStyle = topLine;
  ctx.fillRect(PAD, PAD, W - PAD * 2, 4);
  ctx.restore();

  // ---- Avatar ----
  const AV = 190;
  const avCx = PAD + 40 + AV / 2 + 10;
  const avCy = H / 2;

  // soft glow
  const glow = ctx.createRadialGradient(avCx, avCy, AV / 2 - 10, avCx, avCy, AV / 2 + 38);
  glow.addColorStop(0, rgba(accent, 0.35));
  glow.addColorStop(1, rgba(accent, 0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(avCx, avCy, AV / 2 + 38, 0, Math.PI * 2);
  ctx.fill();

  const avatar = opts.avatar === undefined ? await getAvatar(player) : opts.avatar;
  ctx.save();
  ctx.beginPath();
  ctx.arc(avCx, avCy, AV / 2, 0, Math.PI * 2);
  ctx.clip();
  if (avatar) {
    ctx.drawImage(avatar, avCx - AV / 2, avCy - AV / 2, AV, AV);
  } else {
    ctx.fillStyle = '#23252b';
    ctx.fillRect(avCx - AV / 2, avCy - AV / 2, AV, AV);
    ctx.fillStyle = hex(accent);
    ctx.font = `800 90px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((player.username || '?')[0].toUpperCase(), avCx, avCy + 4);
  }
  ctx.restore();

  ctx.beginPath();
  ctx.arc(avCx, avCy, AV / 2 + 5, 0, Math.PI * 2);
  ctx.lineWidth = 5;
  ctx.strokeStyle = hex(accent);
  ctx.stroke();

  // ---- Right-hand stats (RANK / LEVEL) ----
  const right = W - PAD - 44;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'right';

  const levelText = String(player.level);
  const rankText = `#${fmt(rank)}`;
  const NUM_Y = 128;
  const LABEL_Y = 82;

  // Level column (right-most): small label on top, big number below
  ctx.font = `800 58px ${FONT}`;
  const levelColW = Math.max(ctx.measureText(levelText).width, 70);
  ctx.fillStyle = hex(accent);
  ctx.fillText(levelText, right, NUM_Y);
  ctx.font = `600 16px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText('LEVEL', right, LABEL_Y);

  // Rank column, to the left of the level column
  ctx.font = `800 58px ${FONT}`;
  const rankColW = Math.max(ctx.measureText(rankText).width, 70);
  const rankRight = right - levelColW - 56;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(rankText, rankRight, NUM_Y);
  ctx.font = `600 16px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText('RANK', rankRight, LABEL_Y);

  // ---- Name block ----
  const left = avCx + AV / 2 + 48;
  const maxNameW = rankRight - rankColW - 40 - left;
  ctx.textAlign = 'left';

  ctx.font = `600 16px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  const serverName = truncate(ctx, String(guild.name || 'Server').toUpperCase(), maxNameW);
  ctx.fillText(serverName, left, LABEL_Y);

  const nameSize = fitText(ctx, player.username, maxNameW, 800, 54);
  ctx.font = `800 ${nameSize}px ${FONT}`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(truncate(ctx, player.username, maxNameW), left, NUM_Y);

  // ---- Tier pill + activity line ----
  const pillY = 160;
  let cursorX = left;
  if (current) {
    ctx.font = `700 17px ${FONT}`;
    const label = current.role.name.toUpperCase();
    const pillW = ctx.measureText(label).width + 34;
    roundRect(ctx, cursorX, pillY, pillW, 34, 17);
    ctx.fillStyle = rgba(accent, 0.18);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = rgba(accent, 0.75);
    ctx.stroke();
    ctx.fillStyle = lighten(accent, 0.25);
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cursorX + 17, pillY + 18);
    cursorX += pillW + 22;
  }
  ctx.textBaseline = 'middle';
  ctx.font = `600 19px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.78)';
  ctx.fillText(
    `${fmt(player.xp)} XP   •   ${fmt(player.message_count)} messages`,
    cursorX,
    pillY + 18,
  );

  // ---- Progress bar ----
  const barX = left;
  const barW = right - left;
  const barY = 250;
  const barH = 30;

  ctx.textBaseline = 'alphabetic';
  ctx.font = `600 17px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.textAlign = 'left';
  ctx.fillText(`PROGRESS TO LEVEL ${player.level + 1}`, barX, barY - 14);
  ctx.textAlign = 'right';
  ctx.font = `800 20px ${FONT}`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`${Math.round(pct * 100)}%`, right, barY - 13);

  roundRect(ctx, barX, barY, barW, barH, barH / 2);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fill();

  const fillW = Math.max(barH, barW * pct); // never narrower than the cap radius
  const fillGrad = ctx.createLinearGradient(barX, 0, barX + fillW, 0);
  fillGrad.addColorStop(0, rgba(accent, 0.85));
  fillGrad.addColorStop(1, lighten(accent, 0.3));
  ctx.save();
  ctx.shadowColor = rgba(accent, 0.55);
  ctx.shadowBlur = 16;
  roundRect(ctx, barX, barY, fillW, barH, barH / 2);
  ctx.fillStyle = fillGrad;
  ctx.fill();
  ctx.restore();

  ctx.textBaseline = 'alphabetic';
  ctx.font = `600 18px ${FONT}`;
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.textAlign = 'left';
  ctx.fillText(`${fmt(into)} / ${fmt(needed)} XP`, barX, barY + barH + 30);
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText(`${fmt(toGo)} XP to go`, right, barY + barH + 30);

  return canvas.toBuffer('image/png');
}

module.exports = { renderRankCard };
