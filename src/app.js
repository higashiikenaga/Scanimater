(function () {
  'use strict';
  const { GROUPS, DEFS, PHASES, PALETTES, PRESETS, baseKey, baseSettings } = window.ScanParams;
  const $ = (id) => document.getElementById(id);
  const STORE = 'scanimater.project.v1';

  // ------------------------------------------------------------ 状態
  let state = { A: baseKey(), B: baseKey(), settings: baseSettings() };
  let editKey = 'both';
  let image = null;
  let t = 0, playing = true, exporting = null, frozen = false;

  const RES = {
    '16:9': [[640, 360], [1280, 720], [1920, 1080], [2560, 1440], [3840, 2160]],
    '4:3': [[640, 480], [960, 720], [1440, 1080], [2880, 2160]],
  };
  let aspect = '16:9';
  let resIndex = 2;

  // ------------------------------------------------------------ 時間評価
  const EASE = {
    linear: x => x,
    in: x => x * x * x,
    out: x => 1 - Math.pow(1 - x, 3),
    inOut: x => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2,
    outBack: x => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); },
    bounce: x => {
      const n1 = 7.5625, d1 = 2.75;
      if (x < 1 / d1) return n1 * x * x;
      if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
      if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
      return n1 * (x -= 2.625 / d1) * x + 0.984375;
    },
    elastic: x => x === 0 || x === 1 ? x : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * (2 * Math.PI / 3)) + 1,
  };

  function progress(time) {
    const S = state.settings;
    const span = Math.max(1e-3, S.animEnd - S.animStart);
    let x = Math.min(1, Math.max(0, (time - S.animStart) / span));
    const ease = EASE[S.easing] || EASE.linear;
    if (S.animMode === 'aba') return x < 0.5 ? ease(x * 2) : ease((1 - x) * 2);
    return ease(x);
  }

  function lerpKey(e) {
    const P = {};
    for (const id in DEFS) {
      const a = state.A[id], b = state.B[id];
      P[id] = a + (b - a) * e;
    }
    return P;
  }

  // 速度パラメータを 0〜time で積分して位相にする（台形則）
  function phasesAt(time) {
    const out = {};
    const ids = Object.keys(PHASES);
    for (const id of ids) out[PHASES[id]] = 0;
    const steps = Math.min(240, Math.max(8, Math.ceil(Math.abs(time) * 12)));
    const h = time / steps;
    let prev = null;
    for (let i = 0; i <= steps; i++) {
      const e = progress(i * h);
      const cur = ids.map(id => state.A[id] + (state.B[id] - state.A[id]) * e);
      if (prev) ids.forEach((id, k) => { out[PHASES[id]] += (prev[k] + cur[k]) * 0.5 * h; });
      prev = cur;
    }
    return out;
  }

  function evalAt(time) {
    const P = lerpKey(progress(time));
    Object.assign(P, phasesAt(time));
    P.jitterSeed = P.jitterRate > 0 ? Math.floor(time * P.jitterRate) : 0;
    return P;
  }

  function layersAt(time) {
    const main = evalAt(time);
    const layers = [{ P: main, weight: 1 }];
    const n = Math.round(main.echoes);
    for (let k = 1; k <= n; k++) {
      layers.push({ P: evalAt(time - k * main.echoDelay), weight: Math.pow(main.echoFall, k) });
    }
    return { main, layers };
  }

  // ------------------------------------------------------------ エンジン
  const canvas = $('view');
  let engine;
  try {
    engine = new ScanEngine(canvas);
  } catch (e) {
    document.body.innerHTML = `<p style="padding:24px">${e.message}</p>`;
    return;
  }
  const srcCanvas = document.createElement('canvas');

  function exportSize() { return RES[aspect][resIndex]; }
  function previewSize() {
    const [w, h] = exportSize();
    const q = parseFloat($('previewQ').value);
    const vp = $('viewport').getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const fit = Math.min(vp.width * dpr / w, vp.height * dpr / h, 1) * q * 1.25;
    const s = Math.min(1, Math.max(0.2, fit));
    return [Math.round(w * s / 2) * 2, Math.round(h * s / 2) * 2];
  }
  function segsFor(w, final) { return Math.max(160, Math.min(1600, Math.round(w * (final ? 0.6 : 0.4)))); }

  let srcDirty = true, srcBusy = false;
  async function rebuildSource() {
    if (srcBusy) { srcDirty = true; return; }
    srcBusy = true; srcDirty = false;
    const [w, h] = exportSize();
    const scale = Math.min(1, 2048 / w);
    srcCanvas.width = Math.round(w * scale);
    srcCanvas.height = Math.round(h * scale);
    await ScanSource.render(srcCanvas, state.settings.source, image);
    engine.setSource(srcCanvas);
    srcBusy = false;
    if (srcDirty) rebuildSource();
  }

  function applyPalette() {
    const p = PALETTES[state.settings.palette] || PALETTES.classic;
    engine.setPalette(p.stops);
  }

  // ------------------------------------------------------------ プレビュー
  let last = performance.now();
  let fpsAvg = 60;
  function frame(now) {
    requestAnimationFrame(frame);
    if (exporting || frozen) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    fpsAvg = fpsAvg * 0.95 + (dt > 0 ? 1 / dt : 60) * 0.05;
    const S = state.settings;
    if (playing) {
      t += dt;
      if (t >= S.duration) { t = 0; engine.reset(); }
    }
    const [w, h] = previewSize();
    engine.setSize(w, h);
    engine.segs = segsFor(w, false);
    const { main, layers } = layersAt(t);
    engine.render(layers, main, { dt: playing ? dt : 1 / 60, time: t, settings: S });
    $('scrub').max = S.duration;
    $('scrub').value = t;
    $('time').textContent = `${t.toFixed(2)} / ${S.duration.toFixed(2)}s`;
    $('badge').textContent = `プレビュー ${w}×${h} ・ ${fpsAvg.toFixed(0)} fps ・ 進行 ${(progress(t) * 100).toFixed(0)}%`;
  }

  function setPlaying(p) {
    playing = p;
    $('play').textContent = p ? '❚❚ 停止' : '▶ 再生';
  }

  // ------------------------------------------------------------ パラメータ UI
  const rows = {};
  function buildParamUI() {
    const host = $('paramGroups');
    for (const g of GROUPS) {
      const det = document.createElement('details');
      if (g.id === 'xform' || g.id === 'raster') det.open = true;
      det.innerHTML = `<summary>${g.title}</summary>`;
      for (const d of g.params) {
        const row = document.createElement('div');
        row.className = 'prow';
        row.innerHTML = `<label title="${d.label}（ダブルクリックで初期値）">${d.label}</label>
          <input type="range" min="${d.min}" max="${d.max}" step="${d.step}">
          <input type="number" min="${d.min}" max="${d.max}" step="${d.step}">`;
        const [lab, range, num] = row.children;
        const onInput = (v) => { setParam(d.id, parseFloat(v)); };
        range.addEventListener('input', () => onInput(range.value));
        num.addEventListener('change', () => onInput(num.value));
        lab.addEventListener('dblclick', () => setParam(d.id, d.def, true));
        rows[d.id] = { row, range, num };
        det.appendChild(row);
      }
      host.appendChild(det);
    }
  }

  function setParam(id, v, absolute) {
    if (!isFinite(v)) return;
    const d = DEFS[id];
    if (d.int) v = Math.round(v);
    if (editKey === 'both') {
      if (absolute) { state.A[id] = v; state.B[id] = v; }
      else {
        // A と B の差を保ったまま両方を動かす
        const delta = v - state.A[id];
        state.A[id] = v;
        state.B[id] += delta;
      }
    } else {
      state[editKey][id] = v;
    }
    refreshParam(id);
    save();
  }

  function refreshParam(id) {
    const r = rows[id];
    const key = editKey === 'B' ? 'B' : 'A';
    const v = state[key][id];
    r.range.value = v;
    r.num.value = +v.toFixed(4);
    r.row.classList.toggle('anim', Math.abs(state.A[id] - state.B[id]) > 1e-9);
  }
  function refreshAllParams() { for (const id in rows) refreshParam(id); }

  function setEditKey(k) {
    editKey = k;
    for (const b of $('keys').children) b.classList.toggle('on', b.dataset.k === k);
    if (k !== 'both') {
      // 編集中のキーの姿を見せる
      setPlaying(false);
      const S = state.settings;
      t = k === 'A' ? Math.min(S.animStart, S.duration) : (S.animMode === 'aba' ? (S.animStart + S.animEnd) / 2 : Math.min(S.animEnd, S.duration));
      engine.reset();
    }
    refreshAllParams();
  }

  // ------------------------------------------------------------ 設定 UI
  function bindSettings() {
    const S = () => state.settings;
    const src = () => state.settings.source;

    const fontSel = $('srcFont');
    for (const [v, label] of ScanSource.FONTS) fontSel.add(new Option(label, v));
    const palSel = $('palette');
    for (const k in PALETTES) palSel.add(new Option(PALETTES[k].name, k));

    const srcFields = [
      ['srcType', 'type', 'value'], ['srcText', 'text', 'value'], ['srcFont', 'font', 'value'],
      ['srcStyle', 'style', 'value'], ['srcSize', 'size', 'num'], ['srcTracking', 'tracking', 'num'],
      ['srcLineHeight', 'lineHeight', 'num'], ['srcPattern', 'pattern', 'value'],
      ['srcContrast', 'contrast', 'num'], ['srcInvert', 'invert', 'checked'],
    ];
    for (const [el, key, kind] of srcFields) {
      $(el).addEventListener('input', () => {
        const e = $(el);
        src()[key] = kind === 'num' ? parseFloat(e.value) : kind === 'checked' ? e.checked : e.value;
        showSourceBoxes();
        rebuildSource(); save();
      });
    }
    $('srcFile').addEventListener('change', (ev) => {
      const f = ev.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => { src().imageData = r.result; loadImage(r.result); save(); };
      r.readAsDataURL(f);
    });

    const setFields = [
      ['duration', 'duration', 'num'], ['animStart', 'animStart', 'num'], ['animEnd', 'animEnd', 'num'],
      ['animMode', 'animMode', 'value'], ['easing', 'easing', 'value'], ['scanDir', 'scanDir', 'value'],
      ['palette', 'palette', 'value'], ['colorMode', 'colorMode', 'value'], ['wrap', 'wrap', 'value'],
      ['bgColor', 'bgColor', 'value'],
    ];
    for (const [el, key, kind] of setFields) {
      $(el).addEventListener('input', () => {
        const v = kind === 'num' ? parseFloat($(el).value) : $(el).value;
        if (kind === 'num' && !isFinite(v)) return;
        S()[key] = v;
        if (key === 'palette') applyPalette();
        if (key === 'duration' && t > v) t = 0;
        save();
      });
    }

    $('aspect').addEventListener('input', () => {
      aspect = $('aspect').value;
      fillResolutions();
      rebuildSource();
    });
    $('resolution').addEventListener('input', () => { resIndex = +$('resolution').value; rebuildSource(); });
    fillResolutions();
  }

  function fillResolutions() {
    const sel = $('resolution');
    sel.innerHTML = '';
    RES[aspect].forEach(([w, h], i) => sel.add(new Option(`${w}×${h}${h === 1080 ? '（フルHD）' : h === 2160 ? '（4K・重い）' : ''}`, i)));
    resIndex = Math.min(resIndex, RES[aspect].length - 1);
    if (aspect === '4:3' && resIndex > 2) resIndex = 2;
    sel.value = resIndex;
  }

  function showSourceBoxes() {
    const ty = state.settings.source.type;
    $('srcTextBox').hidden = ty !== 'text';
    $('srcImageBox').hidden = ty !== 'image';
    $('srcPatternBox').hidden = ty !== 'pattern';
  }

  function refreshSettingsUI() {
    const S = state.settings, src = S.source;
    $('srcType').value = src.type; $('srcText').value = src.text; $('srcFont').value = src.font;
    $('srcStyle').value = src.style; $('srcSize').value = src.size; $('srcTracking').value = src.tracking;
    $('srcLineHeight').value = src.lineHeight; $('srcPattern').value = src.pattern;
    $('srcContrast').value = src.contrast; $('srcInvert').checked = !!src.invert;
    for (const k of ['duration', 'animStart', 'animEnd', 'animMode', 'easing', 'scanDir', 'palette', 'colorMode', 'wrap', 'bgColor']) $(k).value = S[k];
    showSourceBoxes();
  }

  function loadImage(url) {
    if (!url) { image = null; rebuildSource(); return; }
    const img = new Image();
    img.onload = () => { image = img; rebuildSource(); };
    img.src = url;
  }

  function buildPresets() {
    const host = $('presets');
    PRESETS.forEach((p) => {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = p.name;
      b.addEventListener('click', () => applyPreset(p));
      host.appendChild(b);
    });
  }

  function applyPreset(p) {
    const keepSource = state.settings.source;
    state.A = Object.assign(baseKey(), p.A);
    state.B = Object.assign(baseKey(), p.B);
    state.settings = Object.assign(baseSettings(), p.settings, { source: keepSource });
    applyPalette();
    refreshSettingsUI();
    setEditKey('both');
    t = 0; engine.reset(); setPlaying(true);
    save();
  }

  // ------------------------------------------------------------ 保存
  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* 容量超過などは無視 */ }
    }, 300);
  }
  function loadState(obj) {
    if (!obj || !obj.A || !obj.B) return false;
    state.A = Object.assign(baseKey(), obj.A);
    state.B = Object.assign(baseKey(), obj.B);
    const base = baseSettings();
    state.settings = Object.assign(base, obj.settings || {});
    state.settings.source = Object.assign(baseSettings().source, (obj.settings || {}).source || {});
    return true;
  }
  function restore() {
    try {
      const raw = localStorage.getItem(STORE);
      if (raw && loadState(JSON.parse(raw))) return;
    } catch (e) { /* 読めなければ既定値 */ }
    applyPresetSilently(PRESETS[0]);
  }
  function applyPresetSilently(p) {
    const src = state.settings.source;
    state.A = Object.assign(baseKey(), p.A);
    state.B = Object.assign(baseKey(), p.B);
    state.settings = Object.assign(baseSettings(), p.settings, { source: src });
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    return url;
  }
  function stamp() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  // ------------------------------------------------------------ 書き出し
  const status = (html) => { $('status').innerHTML = html; };
  const bar = (f) => { $('progressBar').style.width = `${(f * 100).toFixed(1)}%`; };

  async function pickEncoder(w, h, fps, bitrate, format) {
    const avc = ['avc1.640034', 'avc1.640033', 'avc1.640028', 'avc1.4d0033', 'avc1.42e033', 'avc1.42e01f'];
    const vp = ['vp09.00.51.08', 'vp09.00.41.08', 'vp09.00.31.08', 'vp8'];
    const order = format === 'mp4' ? [['mp4', avc], ['webm', vp]] : [['webm', vp], ['mp4', avc]];
    for (const [kind, codecs] of order) {
      for (const codec of codecs) {
        const cfg = { codec, width: w, height: h, bitrate, framerate: fps, latencyMode: 'quality', bitrateMode: 'variable' };
        if (kind === 'mp4') cfg.avc = { format: 'avc' };
        try {
          const r = await VideoEncoder.isConfigSupported(cfg);
          if (r.supported) return { kind, config: cfg };
        } catch (e) { /* 次の候補へ */ }
      }
    }
    return null;
  }

  async function exportVideo() {
    if (exporting) return;
    const fps = parseFloat($('fps').value);
    const [w, h] = exportSize();
    const bitrate = parseFloat($('bitrate').value) * 1e6;
    const S = state.settings;
    const total = Math.max(1, Math.round(S.duration * fps));
    if (typeof VideoEncoder === 'undefined') return exportRealtime(w, h, fps, bitrate);

    const pick = await pickEncoder(w, h, fps, bitrate, $('format').value);
    if (!pick) return exportRealtime(w, h, fps, bitrate);

    exporting = { cancel: false };
    setUIBusy(true);
    const writer = pick.kind === 'mp4' ? new Mp4Writer({ width: w, height: h, fps }) : new WebmWriter({ width: w, height: h, fps, codec: pick.config.codec });
    let encErr = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => writer.addChunk(chunk, meta),
      error: (e) => { encErr = e; },
    });
    encoder.configure(pick.config);

    const wasPlaying = playing;
    setPlaying(false);
    engine.setSize(w, h);
    engine.segs = segsFor(w, true);
    engine.reset();
    const t0 = performance.now();
    const dt = 1 / fps;
    const gop = Math.max(1, Math.round(fps * 2));
    try {
      for (let i = 0; i < total; i++) {
        if (exporting.cancel || encErr) break;
        const time = i * dt;
        const { main, layers } = layersAt(time);
        engine.render(layers, main, { dt, time, settings: S });
        const vf = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
        encoder.encode(vf, { keyFrame: i % gop === 0 });
        vf.close();
        while (encoder.encodeQueueSize > 3) await new Promise(r => setTimeout(r, 1));
        if (i % 4 === 0) {
          bar((i + 1) / total);
          const el = (performance.now() - t0) / 1000;
          const eta = el / (i + 1) * (total - i - 1);
          status(`レンダリング中… ${i + 1}/${total} フレーム（残り約 ${eta.toFixed(0)} 秒）`);
          await new Promise(r => setTimeout(r, 0));
        }
      }
      if (!exporting.cancel && !encErr) {
        status('エンコードを仕上げています…');
        await encoder.flush();
      }
      encoder.close();
      if (encErr) throw encErr;
      if (exporting.cancel) { status('中止しました'); bar(0); return; }
      const blob = writer.finalize();
      const name = `scanimate-${stamp()}.${pick.kind}`;
      const url = download(blob, name);
      bar(1);
      status(`完了: <a href="${url}" download="${name}">${name}</a>（${(blob.size / 1048576).toFixed(1)} MB・${pick.config.codec}・${((performance.now() - t0) / 1000).toFixed(1)} 秒）`);
    } catch (e) {
      console.error(e);
      status(`書き出しに失敗しました: ${e.message || e}`);
      try { encoder.close(); } catch (_) { }
    } finally {
      exporting = null;
      setUIBusy(false);
      engine.reset();
      t = 0;
      setPlaying(wasPlaying);
    }
  }

  // WebCodecs 非対応ブラウザ向け：実時間で MediaRecorder 録画
  async function exportRealtime(w, h, fps, bitrate) {
    const types = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm'];
    const type = types.find(x => window.MediaRecorder && MediaRecorder.isTypeSupported(x));
    if (!type) { status('このブラウザは動画書き出しに対応していません（Chrome / Edge 推奨）'); return; }
    exporting = { cancel: false };
    setUIBusy(true);
    const S = state.settings;
    engine.setSize(w, h);
    engine.segs = segsFor(w, true);
    engine.reset();
    const stream = canvas.captureStream(fps);
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: bitrate });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise(r => { rec.onstop = r; });
    rec.start(250);
    status('実時間で録画中（このブラウザは WebCodecs 非対応のためコマ落ちの可能性あり）…');
    const start = performance.now();
    let prev = start;
    await new Promise((resolve) => {
      const step = (now) => {
        const time = (now - start) / 1000;
        if (time >= S.duration || exporting.cancel) return resolve();
        const { main, layers } = layersAt(time);
        engine.render(layers, main, { dt: (now - prev) / 1000, time, settings: S });
        prev = now;
        bar(time / S.duration);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    rec.stop();
    await done;
    const cancelled = exporting.cancel;
    exporting = null;
    setUIBusy(false);
    engine.reset(); t = 0;
    if (cancelled) { status('中止しました'); bar(0); return; }
    const ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type: type.split(';')[0] });
    const name = `scanimate-${stamp()}.${ext}`;
    const url = download(blob, name);
    bar(1);
    status(`完了: <a href="${url}" download="${name}">${name}</a>（${(blob.size / 1048576).toFixed(1)} MB）`);
  }

  function setUIBusy(b) {
    $('exportBtn').disabled = b;
    $('cancelBtn').hidden = !b;
    $('pngBtn').disabled = b;
  }

  function exportPNG() {
    const [w, h] = exportSize();
    const S = state.settings;
    engine.setSize(w, h);
    engine.segs = segsFor(w, true);
    engine.reset();
    // 残光と多重露光を正しく出すため、少し前から積み上げる
    const fps = 30;
    const start = Math.max(0, t - 1);
    for (let time = start; time <= t + 1e-6; time += 1 / fps) {
      const { main, layers } = layersAt(time);
      engine.render(layers, main, { dt: 1 / fps, time, settings: S });
    }
    canvas.toBlob((blob) => {
      const name = `scanimate-${stamp()}.png`;
      download(blob, name);
      status(`静止画を保存しました: ${name}`);
    }, 'image/png');
  }

  // ------------------------------------------------------------ 起動
  function bindTransport() {
    $('play').addEventListener('click', () => setPlaying(!playing));
    $('rewind').addEventListener('click', () => { t = 0; engine.reset(); });
    $('scrub').addEventListener('input', () => { t = parseFloat($('scrub').value); setPlaying(false); });
    for (const b of $('keys').children) b.addEventListener('click', () => setEditKey(b.dataset.k));
    $('copyAB').addEventListener('click', () => { state.B = { ...state.A }; refreshAllParams(); save(); });
    $('copyBA').addEventListener('click', () => { state.A = { ...state.B }; refreshAllParams(); save(); });
    $('swapAB').addEventListener('click', () => { [state.A, state.B] = [state.B, state.A]; refreshAllParams(); save(); });
    $('exportBtn').addEventListener('click', exportVideo);
    $('cancelBtn').addEventListener('click', () => { if (exporting) exporting.cancel = true; });
    $('pngBtn').addEventListener('click', exportPNG);
    $('saveProj').addEventListener('click', () => {
      download(new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' }), `scanimate-${stamp()}.json`);
    });
    $('loadProj').addEventListener('change', (ev) => {
      const f = ev.target.files[0];
      if (!f) return;
      f.text().then((txt) => {
        try {
          if (!loadState(JSON.parse(txt))) throw new Error('形式が違います');
          afterStateChange();
          status(`読み込みました: ${f.name}`);
        } catch (e) { status(`読み込めませんでした: ${e.message}`); }
      });
    });
    $('resetProj').addEventListener('click', () => {
      state = { A: baseKey(), B: baseKey(), settings: baseSettings() };
      applyPresetSilently(PRESETS[0]);
      afterStateChange();
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
        e.preventDefault(); setPlaying(!playing);
      }
    });
  }

  function afterStateChange() {
    applyPalette();
    refreshSettingsUI();
    refreshAllParams();
    loadImage(state.settings.source.type === 'image' ? state.settings.source.imageData : null);
    rebuildSource();
    t = 0; engine.reset();
    save();
  }

  restore();
  buildParamUI();
  buildPresets();
  bindSettings();
  bindTransport();
  afterStateChange();
  setPlaying(true);
  requestAnimationFrame(frame);
  // Web フォントの読み込みが終わったら原稿を描き直す
  if (document.fonts) document.fonts.ready.then(() => rebuildSource());

  // 自動テスト・外部操作用
  window.scanimater = { state: () => state, engine, layersAt, exportVideo, applyPreset: (i) => applyPreset(PRESETS[i]), setTime: (x) => { t = x; }, freeze: (b) => { frozen = b; } };
})();
