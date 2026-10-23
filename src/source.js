/*
 * 原稿（Scanimate で言うライトボックス上のハイコントラスト・アートワーク）を生成する。
 * 白＝ビームが光る部分、黒＝光らない部分。
 */
(function (global) {
  'use strict';

  const FONTS = [
    ['Righteous', 'Righteous（70s）'],
    ['Monoton', 'Monoton（インライン）'],
    ['Bungee', 'Bungee'],
    ['Audiowide', 'Audiowide'],
    ['Michroma', 'Michroma'],
    ['Orbitron', 'Orbitron'],
    ['Bebas Neue', 'Bebas Neue'],
    ['Zen Kaku Gothic New', 'Zen 角ゴシック（日本語）'],
    ['Dela Gothic One', 'Dela Gothic（日本語）'],
    ['sans-serif', 'システム ゴシック'],
    ['serif', 'システム 明朝'],
  ];

  function fontStack(f) {
    return /serif$/.test(f) ? f : `"${f}", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif`;
  }

  async function ensureFont(src, px) {
    if (!document.fonts || /serif$/.test(src.font)) return;
    try {
      await document.fonts.load(`${src.weight} ${px}px ${fontStack(src.font)}`, src.text || 'A');
    } catch (e) { /* オフライン時はフォールバックフォント */ }
  }

  function drawText(ctx, w, h, src) {
    const lines = (src.text || '').split('\n');
    const n = Math.max(1, lines.length);
    let px = h * src.size;
    ctx.font = `${src.weight} ${px}px ${fontStack(src.font)}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${src.tracking * px}px`;
    // 幅に収まるよう縮小
    let maxW = 0;
    for (const l of lines) maxW = Math.max(maxW, ctx.measureText(l).width);
    const limit = w * 0.92;
    if (maxW > limit) {
      px *= limit / maxW;
      ctx.font = `${src.weight} ${px}px ${fontStack(src.font)}`;
      if ('letterSpacing' in ctx) ctx.letterSpacing = `${src.tracking * px}px`;
    }
    const lh = px * src.lineHeight;
    const total = lh * (n - 1);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const y0 = h / 2 - total / 2;

    const path = (fn) => lines.forEach((l, i) => fn(l, w / 2, y0 + i * lh));
    ctx.lineJoin = 'round';
    if (src.style === 'fill' || src.style === 'fillOutline') {
      ctx.fillStyle = '#fff';
      path((l, x, y) => ctx.fillText(l, x, y));
    }
    if (src.style === 'outline' || src.style === 'fillOutline') {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = px * 0.035;
      if (src.style === 'fillOutline') {
        // 外側にもう一本の輪郭（70s の二重ライン）
        ctx.save();
        ctx.lineWidth = px * 0.16;
        ctx.strokeStyle = '#fff';
        path((l, x, y) => ctx.strokeText(l, x, y));
        ctx.globalCompositeOperation = 'destination-out';
        ctx.lineWidth = px * 0.1;
        path((l, x, y) => ctx.strokeText(l, x, y));
        ctx.restore();
        ctx.fillStyle = '#fff';
        path((l, x, y) => ctx.fillText(l, x, y));
      } else {
        path((l, x, y) => ctx.strokeText(l, x, y));
      }
    }
    if (src.style === 'stripes') {
      // 文字の中に横ストライプ（レトロロゴの定番）
      ctx.fillStyle = '#fff';
      path((l, x, y) => ctx.fillText(l, x, y));
      ctx.globalCompositeOperation = 'destination-out';
      const step = px * 0.13;
      for (let y = 0; y < h; y += step) ctx.fillRect(0, y + step * 0.55, w, step * 0.45);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  function drawPattern(ctx, w, h, kind) {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    const cx = w / 2, cy = h / 2, r = h * 0.38;
    switch (kind) {
      case 'stripes': {
        const n = 9;
        for (let i = 0; i < n; i++) ctx.fillRect(w * 0.12, h * (0.15 + i * 0.7 / n), w * 0.76, h * 0.7 / n * 0.55);
        break;
      }
      case 'circle':
        ctx.lineWidth = h * 0.05;
        for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(cx, cy, r * (1 - i * 0.24), 0, Math.PI * 2); ctx.stroke(); }
        break;
      case 'star': {
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.42 : r;
          ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
        }
        ctx.closePath(); ctx.fill();
        break;
      }
      case 'grid': {
        ctx.lineWidth = h * 0.012;
        for (let i = 0; i <= 12; i++) {
          const x = w * 0.1 + i * w * 0.8 / 12; ctx.beginPath(); ctx.moveTo(x, h * 0.1); ctx.lineTo(x, h * 0.9); ctx.stroke();
        }
        for (let i = 0; i <= 8; i++) {
          const y = h * 0.1 + i * h * 0.8 / 8; ctx.beginPath(); ctx.moveTo(w * 0.1, y); ctx.lineTo(w * 0.9, y); ctx.stroke();
        }
        break;
      }
      case 'burst': {
        for (let i = 0; i < 24; i++) {
          const a0 = i * Math.PI * 2 / 24, a1 = a0 + Math.PI / 24;
          ctx.beginPath(); ctx.moveTo(cx, cy);
          ctx.arc(cx, cy, w, a0, a1); ctx.closePath(); ctx.fill();
        }
        ctx.globalCompositeOperation = 'destination-out';
        ctx.beginPath(); ctx.arc(cx, cy, r * 0.25, 0, Math.PI * 2); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        break;
      }
      case 'checker': {
        const s = h / 8;
        for (let y = 0; y < 8; y++) for (let x = 0; x < Math.ceil(w / s); x++) if ((x + y) % 2 === 0) ctx.fillRect(x * s, y * s, s, s);
        break;
      }
    }
  }

  function drawImage(ctx, w, h, img) {
    const s = Math.min(w / img.width, h / img.height) * 0.95;
    const iw = img.width * s, ih = img.height * s;
    ctx.drawImage(img, (w - iw) / 2, (h - ih) / 2, iw, ih);
  }

  // 輝度化・コントラスト・反転
  function finish(ctx, w, h, src, isImage) {
    if (!isImage && !src.invert && src.contrast === 1) return;
    const id = ctx.getImageData(0, 0, w, h);
    const d = id.data;
    const c = src.contrast;
    for (let i = 0; i < d.length; i += 4) {
      let l = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
      if (isImage) l *= d[i + 3] / 255;
      l = (l - 0.5) * c + 0.5;
      if (src.invert) l = 1 - l;
      l = Math.max(0, Math.min(1, l)) * 255;
      d[i] = d[i + 1] = d[i + 2] = l; d[i + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
  }

  async function render(canvas, src, image) {
    const w = canvas.width, h = canvas.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    if (src.type === 'text') {
      await ensureFont(src, h * src.size);
      drawText(ctx, w, h, src);
    } else if (src.type === 'image' && image) {
      drawImage(ctx, w, h, image);
    } else {
      drawPattern(ctx, w, h, src.pattern);
    }
    ctx.globalCompositeOperation = 'source-over';
    finish(ctx, w, h, src, src.type === 'image');
  }

  global.ScanSource = { FONTS, render };
})(window);
