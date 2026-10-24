(function () {
  'use strict';
  const { GROUPS, DEFS, PHASES, PALETTES, PRESETS, baseKey, baseSettings, keysFromAB } = window.ScanParams;
  const $ = (id) => document.getElementById(id);
  const STORE = 'scanimater.project.v1';

  // ------------------------------------------------------------ 状態
  // keys: [{ t: 秒, ease: 次のキーまでのイージング, v: {パラメータ} }]（時刻順）
  let state = { keys: [], settings: baseSettings() };
  let sel = 'all'; // 編集対象: 'all'（全キー共通）またはキーの番号
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

  const keyName = (i) => i < 26 ? String.fromCharCode(65 + i) : `K${i + 1}`;
  function sortKeys() { state.keys.sort((a, b) => a.t - b.t); }

  // 時刻 time のキー区間と、その区間内の進み具合（イージング後）
  function segmentAt(time) {
    const K = state.keys;
    if (K.length === 1 || time <= K[0].t) return { i: 0, e: 0 };
    const last = K.length - 1;
    if (time >= K[last].t) return { i: last, e: 0 };
    let i = 0;
    while (i < last - 1 && time >= K[i + 1].t) i++;
    const span = K[i + 1].t - K[i].t;
    const x = span > 1e-6 ? (time - K[i].t) / span : 1;
    return { i, e: (EASE[K[i].ease] || EASE.linear)(x) };
  }

  function valueAt(seg, id) {
    const K = state.keys;
    const a = K[seg.i].v[id];
    if (seg.e === 0 || seg.i >= K.length - 1) return a;
    return a + (K[seg.i + 1].v[id] - a) * seg.e;
  }

  function valuesAt(time) {
    const seg = segmentAt(time);
    const P = {};
    for (const id in DEFS) P[id] = valueAt(seg, id);
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
      const seg = segmentAt(i * h);
      const cur = ids.map(id => valueAt(seg, id));
      if (prev) ids.forEach((id, k) => { out[PHASES[id]] += (prev[k] + cur[k]) * 0.5 * h; });
      prev = cur;
    }
    return out;
  }

  function evalAt(time) {
    const P = valuesAt(time);
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
    const seg = segmentAt(t), K = state.keys;
    const where = t < K[0].t ? `${keyName(0)} の前` : seg.i >= K.length - 1 ? `${keyName(K.length - 1)} 以降` : `${keyName(seg.i)}→${keyName(seg.i + 1)}`;
    $('badge').textContent = `プレビュー ${w}×${h} ・ ${fpsAvg.toFixed(0)} fps ・ ${where}`;
    drawPlayhead();
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
    if (sel === 'all') {
      if (absolute) for (const k of state.keys) k.v[id] = v;
      else {
        // キー同士の差を保ったまま全キーを動かす
        const delta = v - state.keys[0].v[id];
        for (const k of state.keys) k.v[id] += delta;
      }
    } else {
      state.keys[sel].v[id] = v;
    }
    refreshParam(id);
    save();
  }

  function refreshParam(id) {
    const r = rows[id];
    const v = state.keys[sel === 'all' ? 0 : sel].v[id];
    r.range.value = v;
    r.num.value = +v.toFixed(4);
    const v0 = state.keys[0].v[id];
    r.row.classList.toggle('anim', state.keys.some(k => Math.abs(k.v[id] - v0) > 1e-9));
  }
  function refreshAllParams() { for (const id in rows) refreshParam(id); }

  // ------------------------------------------------------------ キーフレーム
  function select(k, seek) {
    sel = k === 'all' || state.keys.length === 0 ? 'all' : Math.max(0, Math.min(state.keys.length - 1, k));
    if (sel !== 'all' && seek) {
      setPlaying(false);
      t = Math.min(state.keys[sel].t, state.settings.duration);
    }
    refreshAllParams();
    renderKeybar();
  }

  function renderKeybar() {
    const bar = $('keybar');
    const dur = state.settings.duration;
    bar.querySelectorAll('.kf').forEach(e => e.remove());
    state.keys.forEach((k, i) => {
      const m = document.createElement('button');
      m.className = 'kf' + (sel === i ? ' on' : '');
      m.textContent = keyName(i);
      m.title = `${keyName(i)}: ${k.t.toFixed(2)} 秒（ドラッグで移動）`;
      m.style.left = `${Math.min(100, k.t / dur * 100)}%`;
      m.dataset.i = i;
      bar.appendChild(m);
    });
    $('keyAll').classList.toggle('on', sel === 'all');
    const one = sel !== 'all';
    $('keyName').textContent = one ? keyName(sel) : '全キー';
    $('keyTime').disabled = !one;
    $('keyEase').disabled = !one || sel === state.keys.length - 1;
    $('keyDel').disabled = !one || state.keys.length <= 1;
    $('keyDup').disabled = !one;
    if (one) {
      $('keyTime').value = +state.keys[sel].t.toFixed(3);
      $('keyEase').value = state.keys[sel].ease;
    } else {
      $('keyTime').value = '';
    }
  }

  function drawPlayhead() {
    $('playhead').style.left = `${Math.min(100, t / state.settings.duration * 100)}%`;
  }

  function addKey(time) {
    const v = valuesAt(time);
    for (const id in DEFS) if (DEFS[id].int) v[id] = Math.round(v[id]);
    const seg = segmentAt(time);
    const k = { t: +time.toFixed(3), ease: state.keys[seg.i].ease || 'inOut', v };
    state.keys.push(k);
    sortKeys();
    select(state.keys.indexOf(k), true);
    save();
  }

  function bindKeybar() {
    const bar = $('keybar');
    const timeFromX = (x) => {
      const r = bar.getBoundingClientRect();
      return Math.max(0, Math.min(1, (x - r.left) / r.width)) * state.settings.duration;
    };
    let drag = null;
    bar.addEventListener('pointerdown', (e) => {
      const m = e.target.closest('.kf');
      bar.setPointerCapture(e.pointerId);
      if (m) {
        const k = state.keys[+m.dataset.i];
        drag = { k, x0: e.clientX, moved: false };
        select(+m.dataset.i, true);
      } else {
        drag = { seek: true };
        setPlaying(false);
        t = timeFromX(e.clientX);
      }
    });
    bar.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (drag.seek) { t = timeFromX(e.clientX); return; }
      if (!drag.moved && Math.abs(e.clientX - drag.x0) < 3) return;
      drag.moved = true;
      drag.k.t = +timeFromX(e.clientX).toFixed(3);
      sortKeys();
      sel = state.keys.indexOf(drag.k);
      t = drag.k.t;
      renderKeybar();
    });
    const end = () => { if (drag && drag.moved) save(); drag = null; };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);

    $('keyAll').addEventListener('click', () => select('all'));
    $('keyPrev').addEventListener('click', () => {
      const i = sel === 'all' ? state.keys.length - 1 : (sel - 1 + state.keys.length) % state.keys.length;
      select(i, true);
    });
    $('keyNext').addEventListener('click', () => select(sel === 'all' ? 0 : (sel + 1) % state.keys.length, true));
    $('keyAdd').addEventListener('click', () => addKey(t));
    $('keyDup').addEventListener('click', () => {
      if (sel === 'all') return;
      const src = state.keys[sel];
      const k = { t: Math.min(state.settings.duration, +(src.t + 0.5).toFixed(3)), ease: src.ease, v: { ...src.v } };
      state.keys.push(k);
      sortKeys();
      select(state.keys.indexOf(k), true);
      save();
    });
    $('keyDel').addEventListener('click', () => {
      if (sel === 'all' || state.keys.length <= 1) return;
      state.keys.splice(sel, 1);
      select(Math.min(sel, state.keys.length - 1), true);
      save();
    });
    $('keyTime').addEventListener('change', () => {
      const v = parseFloat($('keyTime').value);
      if (sel === 'all' || !isFinite(v)) return;
      const k = state.keys[sel];
      k.t = Math.max(0, Math.min(state.settings.duration, v));
      sortKeys();
      select(state.keys.indexOf(k), true);
      save();
    });
    $('keyEase').addEventListener('input', () => {
      if (sel === 'all') return;
      state.keys[sel].ease = $('keyEase').value;
      save();
    });
  }

  // プレビューを直接ドラッグして位置（Shift で回転）を決める
  function bindViewDrag() {
    const vp = $('viewport');
    let drag = null;
    vp.addEventListener('pointerdown', (e) => {
      if (exporting) return;
      vp.setPointerCapture(e.pointerId);
      const r = vp.getBoundingClientRect();
      const ar = canvas.width / canvas.height;
      const contentH = Math.min(r.height, r.width / ar);
      drag = { x: e.clientX, y: e.clientY, unit: 2 / contentH };
      vp.classList.add('dragging');
    });
    vp.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      const targets = sel === 'all' ? state.keys : [state.keys[sel]];
      for (const k of targets) {
        if (e.shiftKey) k.v.roll += dx * 0.5;
        else { k.v.posX += dx * drag.unit; k.v.posY -= dy * drag.unit; }
      }
      refreshParam('posX'); refreshParam('posY'); refreshParam('roll');
    });
    const end = () => { if (drag) save(); drag = null; vp.classList.remove('dragging'); };
    vp.addEventListener('pointerup', end);
    vp.addEventListener('pointercancel', end);
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
      ['duration', 'duration', 'num'], ['scanDir', 'scanDir', 'value'],
      ['palette', 'palette', 'value'], ['colorMode', 'colorMode', 'value'], ['wrap', 'wrap', 'value'],
      ['bgColor', 'bgColor', 'value'],
    ];
    for (const [el, key, kind] of setFields) {
      $(el).addEventListener('input', () => {
        const v = kind === 'num' ? parseFloat($(el).value) : $(el).value;
        if (kind === 'num' && !isFinite(v)) return;
        S()[key] = v;
        if (key === 'palette') applyPalette();
        if (key === 'duration') { if (t > v) t = 0; renderKeybar(); }
        save();
      });
    }

    $('aspect').addEventListener('input', () => {
      aspect = $('aspect').value;
      $('viewport').style.setProperty('--ar', aspect.replace(':', ' / '));
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
    for (const k of ['duration', 'scanDir', 'palette', 'colorMode', 'wrap', 'bgColor']) $(k).value = S[k];
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

  const cloneKeys = (keys) => keys.map(k => ({ t: k.t, ease: k.ease, v: Object.assign(baseKey(), k.v) }));

  function applyPreset(p) {
    applyPresetSilently(p);
    applyPalette();
    refreshSettingsUI();
    select('all');
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
    if (!obj) return false;
    const settings = Object.assign(baseSettings(), obj.settings || {});
    settings.source = Object.assign(baseSettings().source, (obj.settings || {}).source || {});
    let keys;
    if (Array.isArray(obj.keys) && obj.keys.length) keys = cloneKeys(obj.keys);
    else if (obj.A && obj.B) keys = keysFromAB(obj.A, obj.B, obj.settings || {}); // 旧 A/B 形式
    else return false;
    for (const k of keys) { k.t = +k.t || 0; k.ease = k.ease || 'inOut'; }
    for (const key of ['animStart', 'animEnd', 'easing', 'animMode']) delete settings[key];
    state.keys = keys;
    state.settings = settings;
    sortKeys();
    sel = 'all';
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
    state.keys = cloneKeys(p.keys);
    state.settings = Object.assign(baseSettings(), p.settings, { source: src });
    sortKeys();
    sel = 'all';
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
      state = { keys: [], settings: baseSettings() };
      applyPresetSilently(PRESETS[0]);
      afterStateChange();
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement.tagName)) {
        e.preventDefault(); setPlaying(!playing);
      }
    });
  }

  function afterStateChange() {
    applyPalette();
    refreshSettingsUI();
    refreshAllParams();
    renderKeybar();
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
  bindKeybar();
  bindViewDrag();
  $('viewport').style.setProperty('--ar', aspect.replace(':', ' / '));
  afterStateChange();
  setPlaying(true);
  requestAnimationFrame(frame);
  // Web フォントの読み込みが終わったら原稿を描き直す
  if (document.fonts) document.fonts.ready.then(() => rebuildSource());

  // 自動テスト・外部操作用
  window.scanimater = { state: () => state, engine, layersAt, exportVideo, applyPreset: (i) => applyPreset(PRESETS[i]), setTime: (x) => { t = x; }, freeze: (b) => { frozen = b; } };
})();
