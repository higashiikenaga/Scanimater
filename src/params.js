/*
 * パラメータ定義とプリセット。
 * 数値パラメータはすべてキーフレーム A（開始）/ B（終了）を持ち、タイムライン上で補間される。
 * "speed" 系は位相として時間積分されるので、速度を補間しても波が跳ばない。
 */
(function (global) {
  'use strict';

  // [id, ラベル, min, max, step, 既定値, 整数?]
  const GROUPS = [
    {
      id: 'raster', title: 'ラスター（走査線）', params: [
        ['lines', '走査線数', 8, 900, 1, 260, true],
        ['beam', 'ビーム幅（線間比）', 0.05, 3, 0.01, 0.7],
        ['intensity', 'ビーム輝度', 0, 6, 0.01, 1.0],
        ['bias', 'ラスター地明かり', 0, 0.4, 0.001, 0.0],
        ['speedComp', 'ビーム速度→輝度', 0, 1, 0.01, 0.65],
        ['spacing', '線間隔の偏り', 0.3, 3, 0.01, 1],
        ['focus', 'カメラのボケ', 0, 6, 0.01, 0.8],
      ]
    },
    {
      id: 'xform', title: '偏向（位置・サイズ・回転）', params: [
        ['posX', '位置 X', -3, 3, 0.001, 0],
        ['posY', '位置 Y', -3, 3, 0.001, 0],
        ['scale', '全体サイズ', 0, 4, 0.001, 1],
        ['sizeX', 'サイズ X', -3, 3, 0.001, 1],
        ['sizeY', 'サイズ Y', -3, 3, 0.001, 1],
        ['roll', '回転（Z）°', -1440, 1440, 0.1, 0],
        ['pivotX', '回転の中心 X', -3, 3, 0.001, 0],
        ['pivotY', '回転の中心 Y', -3, 3, 0.001, 0],
        ['tiltX', '前後フリップ（X軸）°', -1080, 1080, 0.1, 0],
        ['tiltY', '左右フリップ（Y軸）°', -1080, 1080, 0.1, 0],
        ['persp', 'パース', 0, 2, 0.01, 0.7],
        ['taper', 'テーパー', -2, 2, 0.001, 0],
        ['skew', 'スキュー', -2, 2, 0.001, 0],
      ]
    },
    {
      id: 'waves', title: '波形モジュール', params: [
        ['waveHAmp', '横波 振幅', 0, 1.5, 0.001, 0],
        ['waveHFreq', '横波 周波数', 0, 30, 0.01, 3],
        ['waveHSpeed', '横波 速度 (Hz)', -8, 8, 0.01, 0.5],
        ['waveVAmp', '縦波 振幅', 0, 1.5, 0.001, 0],
        ['waveVFreq', '縦波 周波数', 0, 30, 0.01, 2],
        ['waveVSpeed', '縦波 速度 (Hz)', -8, 8, 0.01, 0.5],
        ['twist', 'リボンねじれ', 0, 12, 0.01, 0],
        ['twistSpeed', 'ねじれ回転 (Hz)', -4, 4, 0.01, 0],
        ['rippleAmp', '波紋 振幅', 0, 0.6, 0.001, 0],
        ['rippleFreq', '波紋 周波数', 0, 30, 0.01, 6],
        ['rippleSpeed', '波紋 速度 (Hz)', -8, 8, 0.01, 1],
        ['bendH', '横曲げ', -2, 2, 0.001, 0],
        ['bendV', '縦曲げ', -2, 2, 0.001, 0],
        ['jitter', 'ラインジッター', 0, 0.3, 0.001, 0],
        ['jitterRate', 'ジッター更新 (Hz)', 0, 60, 0.1, 12],
      ]
    },
    {
      id: 'trails', title: '残像（多重露光・残光）', params: [
        ['echoes', '多重露光 枚数', 0, 48, 1, 0, true],
        ['echoDelay', '露光間隔 (秒)', 0, 0.5, 0.001, 0.04],
        ['echoFall', '露光減衰', 0, 1, 0.01, 0.85],
        ['persist', '蛍光体残光 (秒)', 0, 3, 0.01, 0.08],
        ['extrude', '立体 押し出し量', 0, 2, 0.001, 0],
        ['extrudeAngle', '押し出し方向°', -180, 180, 0.1, -60],
        ['extrudeScale', '奥行きの縮み', -1, 1, 0.001, 0.12],
      ]
    },
    {
      id: 'color', title: 'カラライザー', params: [
        ['gain', '入力ゲイン', 0.05, 8, 0.01, 1.0],
        ['recapBlur', '再撮カメラのボケ', 0, 4, 0.01, 1.2],
        ['keyLevel', '黒レベル（キー）', 0, 0.6, 0.001, 0.04],
        ['levels', '階調バンド数', 2, 16, 1, 6, true],
        ['spread', '色の広がり', 0, 4, 0.01, 1],
        ['cycle', '色相オフセット', -2, 2, 0.001, 0],
        ['cycleSpeed', 'カラーサイクル (Hz)', -3, 3, 0.01, 0],
        ['spatial', '画面縦グラデ', -2, 2, 0.01, 0],
        ['flat', 'フラット塗り', 0, 1, 0.01, 0.35],
        ['hot', 'ホワイトコア', 0, 1, 0.01, 0.45],
      ]
    },
    {
      id: 'output', title: '出力（グロー・ビデオ質感）', params: [
        ['exposure', '露出', 0.1, 4, 0.01, 1.2],
        ['bloom', 'グロー', 0, 3, 0.01, 0.9],
        ['halation', 'ハレーション', 0, 2, 0.01, 0.35],
        ['scan', 'NTSC走査線', 0, 1, 0.01, 0.35],
        ['chroma', '色にじみ', 0, 1, 0.01, 0.35],
        ['noise', 'ノイズ', 0, 1, 0.01, 0.25],
        ['wobble', 'テープの揺れ', 0, 1, 0.01, 0.15],
        ['vignette', '周辺減光', 0, 1, 0.01, 0.45],
        ['bgLevel', '背景の明るさ', 0, 1, 0.01, 0.0],
      ]
    },
  ];

  const DEFS = {};
  for (const g of GROUPS) {
    g.params = g.params.map(([id, label, min, max, step, def, int]) => {
      const d = { id, label, min, max, step, def, int: !!int, group: g.id };
      DEFS[id] = d;
      return d;
    });
  }
  // speed → 積分される位相の名前
  const PHASES = {
    waveHSpeed: 'waveHPhase', waveVSpeed: 'waveVPhase', twistSpeed: 'twistPhase',
    rippleSpeed: 'ripplePhase', cycleSpeed: 'cyclePhase',
  };

  const PALETTES = {
    classic: { name: 'Scanimate クラシック', stops: ['#120a5c', '#2f3bff', '#9b2cff', '#ff2f8a', '#ff8a1c', '#fff3a8'] },
    sunset: { name: '70s サンセット', stops: ['#2a0838', '#9c178e', '#f42a7e', '#ff6f00', '#ffd23f'] },
    neon: { name: 'ネオン シアン', stops: ['#001433', '#0050ff', '#00c8ff', '#8affff', '#ffffff'] },
    chrome: { name: 'クローム', stops: ['#0b1a3a', '#4a6fb5', '#e8f0ff', '#7a4a20', '#ffd890', '#ffffff'] },
    rainbow: { name: 'レインボー（循環）', stops: ['#ff0040', '#ff9000', '#ffee00', '#30ff30', '#00d0ff', '#4040ff', '#d000ff', '#ff0040'], cyclic: true },
    fire: { name: 'ファイア', stops: ['#200000', '#a00000', '#ff4000', '#ffa000', '#ffff80'] },
    p1: { name: 'グリーン蛍光体 P1', stops: ['#001400', '#00a030', '#40ff70', '#d0ffd8'] },
    amber: { name: 'アンバー', stops: ['#1a0800', '#a04000', '#ffa020', '#fff0c0'] },
    mono: { name: 'モノクロ P4', stops: ['#000000', '#8090a0', '#ffffff'] },
  };

  function baseKey() {
    const k = {};
    for (const id in DEFS) k[id] = DEFS[id].def;
    return k;
  }

  // 既定の非アニメーション設定
  function baseSettings() {
    return {
      scanDir: 'h', palette: 'classic', colorMode: 'bands', wrap: 'mirror', bgColor: '#05051a',
      duration: 6, trailHold: false,
      source: {
        type: 'text', text: 'SCANIMATE', font: 'Righteous', weight: '700', style: 'fill',
        size: 0.42, tracking: 0.04, lineHeight: 1.05, pattern: 'stripes', invert: false, contrast: 1,
        imageData: null,
      },
    };
  }

  /*
   * キーフレーム: [{ t: 秒, ease: 次のキーまでのイージング, v: { パラメータ } }]
   * 旧形式（A/B の2点＋開始/終了時刻）からの変換にも使う。
   */
  function keysFromAB(A, B, o) {
    const s = o.animStart ?? 0.5, e = Math.max(s + 0.01, o.animEnd ?? 4.5), ease = o.easing || 'inOut';
    const a = Object.assign(baseKey(), A), b = Object.assign(baseKey(), B);
    if (o.animMode === 'aba') {
      return [{ t: s, ease, v: a }, { t: (s + e) / 2, ease, v: b }, { t: e, ease, v: { ...a } }];
    }
    return [{ t: s, ease, v: a }, { t: e, ease, v: b }];
  }

  function preset(name, settings, a, b) {
    const { animStart, animEnd, easing, animMode, ...rest } = settings;
    return { name, settings: rest, keys: keysFromAB(a, Object.assign({}, a, b), { animStart, animEnd, easing, animMode }) };
  }

  // 複数キーのプリセット。各キーの値は前のキーからの差分で書く
  function presetKeys(name, settings, base, list) {
    let cur = Object.assign(baseKey(), base);
    const keys = list.map(([t, ease, diff]) => {
      cur = Object.assign({}, cur, diff);
      return { t, ease, v: { ...cur } };
    });
    return { name, settings, keys };
  }

  const PRESETS = [
    preset('ライン・ズームイン（定番OP）', { palette: 'classic', easing: 'outBack', animStart: 0.3, animEnd: 3.2 },
      { sizeY: 0.0, sizeX: 1.6, echoes: 10, echoDelay: 0.035, echoFall: 0.82, persist: 0.15, intensity: 1.6, lines: 220, cycleSpeed: 0.15 },
      { sizeY: 1, sizeX: 1, intensity: 1.0 }),
    preset('フライング・ロゴ（奥から手前へ）', { palette: 'chrome', easing: 'out', animStart: 0.2, animEnd: 4 },
      { tiltX: 88, tiltY: -40, sizeX: 0.15, sizeY: 0.15, posY: 0.6, echoes: 14, echoDelay: 0.05, echoFall: 0.84, persist: 0.2, spread: 1.4, cycleSpeed: 0.2 },
      { tiltX: 0, tiltY: 0, sizeX: 1, sizeY: 1, posY: 0 }),
    presetKeys('回転ロゴ（5キー）', { palette: 'classic', duration: 6.5 },
      { echoes: 12, echoDelay: 0.035, echoFall: 0.85, persist: 0.2, cycleSpeed: 0.2 }, [
        [0.0, 'out', { sizeX: 0.08, sizeY: 0.08, tiltY: -540, roll: -90 }],
        [1.8, 'inOut', { sizeX: 1, sizeY: 1, tiltY: 0, roll: 0 }],
        [2.6, 'inOut', {}],
        [4.2, 'outBack', { roll: 360, sizeX: 0.6, sizeY: 0.6, posY: 0.3 }],
        [5.8, 'in', { tiltX: 90, sizeX: 0.25, sizeY: 0.25, posY: 1.2 }],
      ]),
    presetKeys('スイング（回転の中心を左端に）', { palette: 'sunset', duration: 6 },
      { pivotX: -1.45, echoes: 8, echoDelay: 0.04, echoFall: 0.8, persist: 0.15 }, [
        [0.2, 'out', { roll: -100 }],
        [1.4, 'inOut', { roll: 18 }],
        [2.2, 'inOut', { roll: -9 }],
        [2.9, 'out', { roll: 4 }],
        [3.4, 'linear', { roll: 0 }],
        [4.4, 'in', {}],
        [5.6, 'linear', { roll: 95, posY: -0.2 }],
      ]),
    presetKeys('立体ロゴ（押し出し）', { palette: 'classic', duration: 6 },
      { echoes: 28, echoDelay: 0, echoFall: 0.93, extrudeAngle: -55, extrudeScale: 0.1, persist: 0.1, spread: 1.3 }, [
        [0.0, 'out', { sizeX: 0.2, sizeY: 0.2, tiltY: -70, extrude: 0 }],
        [1.8, 'inOut', { sizeX: 1, sizeY: 1, tiltY: 0 }],
        [3.2, 'inOut', { extrude: 0.45 }],
        [4.4, 'inOut', {}],
        [5.6, 'inOut', { extrudeAngle: -125 }],
      ]),
    presetKeys('フライイン→残像固定', { palette: 'sunset', duration: 6, trailHold: true },
      { echoes: 24, echoDelay: 0.04, echoFall: 0.9, persist: 0.1 }, [
        [0.2, 'linear', { sizeX: 0.05, sizeY: 0.05, posX: 1.6, posY: 1.0, tiltY: 60 }],
        [2.2, 'linear', { sizeX: 1, sizeY: 1, posX: 0, posY: 0, tiltY: 0 }],
      ]),
    presetKeys('サイズ切り替え（瞬時）', { palette: 'neon', duration: 6 },
      { echoes: 6, echoDelay: 0.05, echoFall: 0.75, persist: 0.2 }, [
        [0.0, 'step', { scale: 0.45 }],
        [1.0, 'step', { scale: 1.0 }],
        [2.0, 'step', { scale: 0.7, roll: -12 }],
        [3.0, 'step', { scale: 1.3, roll: 0 }],
        [4.0, 'outBack', { scale: 0.3 }],
        [5.0, 'linear', { scale: 1.0 }],
      ]),
    preset('リボン・ツイスト', { palette: 'sunset', animMode: 'aba', easing: 'inOut', animStart: 0, animEnd: 6 },
      { twist: 2.6, twistSpeed: 0.25, echoes: 6, echoDelay: 0.06, echoFall: 0.7, lines: 300, spread: 1.6 },
      { twist: 5.5, sizeX: 1.15 }),
    preset('波打つ文字（ウェーブ）', { palette: 'neon', animMode: 'aba', animStart: 0, animEnd: 6 },
      { waveHAmp: 0.08, waveHFreq: 4, waveHSpeed: 0.8, waveVAmp: 0.05, waveVFreq: 3, waveVSpeed: -0.6, echoes: 4, echoDelay: 0.05, persist: 0.25 },
      { waveHAmp: 0.22, waveVAmp: 0.12 }),
    preset('スピン・トレイル', { palette: 'rainbow', wrap: 'repeat', colorMode: 'smooth', easing: 'inOut', animStart: 0, animEnd: 6 },
      { roll: 0, sizeX: 0.55, sizeY: 0.55, echoes: 18, echoDelay: 0.03, echoFall: 0.9, persist: 0.3, cycleSpeed: 0.4, spread: 0.8 },
      { roll: 720 }),
    preset('ラバー・バウンス', { palette: 'fire', easing: 'bounce', animStart: 0.2, animEnd: 3.5 },
      { posY: 1.9, sizeY: 1.6, sizeX: 0.7, echoes: 8, echoDelay: 0.03, echoFall: 0.75, bendH: 0.3 },
      { posY: 0, sizeY: 1, sizeX: 1, bendH: 0 }),
    preset('スタースクロール（パース奥行き）', { palette: 'amber', easing: 'linear', animStart: 0, animEnd: 6, animMode: 'ab' },
      { tiltX: 62, persp: 1.3, posY: -1.6, sizeX: 1.3, sizeY: 1.3, lines: 360, echoes: 3, echoDelay: 0.08 },
      { posY: 1.2 }),
    preset('ラスター分解（走査線が見える）', { palette: 'p1', colorMode: 'smooth', animMode: 'aba', animStart: 0, animEnd: 6 },
      { lines: 48, beam: 0.35, bias: 0.05, jitter: 0.03, intensity: 1.6, waveHAmp: 0.05, waveHFreq: 1.5, waveHSpeed: 0.4 },
      { lines: 140, jitter: 0.0, waveHAmp: 0.15 }),
    preset('波紋サイケ', { palette: 'rainbow', wrap: 'repeat', colorMode: 'bands', animMode: 'aba', animStart: 0, animEnd: 6 },
      { rippleAmp: 0.05, rippleFreq: 8, rippleSpeed: 1.2, cycleSpeed: 0.5, spatial: 0.6, persist: 0.4, echoes: 5, echoDelay: 0.06 },
      { rippleAmp: 0.16 }),
  ];

  global.ScanParams = { GROUPS, DEFS, PHASES, PALETTES, PRESETS, baseKey, baseSettings, keysFromAB };
})(window);
