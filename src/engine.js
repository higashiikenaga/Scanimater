/*
 * Scanimate エミュレーション・エンジン（WebGL2）
 *
 * 実機の信号経路をそのままパスに対応させている:
 *   1. 原稿カメラ  … 原稿テクスチャ（ミップマップでピントのボケ）
 *   2. 高解像度CRT … 走査線を1本ずつ帯状ポリゴンとして描き、頂点シェーダーで
 *                    水平/垂直偏向電圧（ランプ＋波形モジュール）を加算して曲げる。
 *                    ビームが速く動くほど暗く、遅いほど明るい（速度補償）。
 *                    重なった線は加算されて明るくなる。
 *   3. 多重露光    … 過去時刻のパラメータで同じラスターを減衰させて重ね描き
 *   4. 蛍光体残光  … 前フレームを指数減衰させて足し込む
 *   5. カラライザー… 再撮像した輝度を階調ごとに色へ割り当てる
 *   6. 光学系      … グロー／ハレーション
 *   7. ビデオ出力  … NTSC走査線・色にじみ・ノイズ・テープの揺れ・周辺減光
 */
(function (global) {
  'use strict';

  const FS_TRI = `#version 300 es
  out vec2 vUV;
  void main(){
    vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2);
    vUV = p;
    gl_Position = vec4(p*2.0-1.0, 0.0, 1.0);
  }`;

  const RASTER_VS = `#version 300 es
  precision highp float;
  uniform int uLines, uSegs, uVertical;
  uniform vec2 uRes;
  uniform float uAspect, uBeam, uSpacing;
  uniform vec2 uPos, uSize;
  uniform float uRoll, uTiltX, uTiltY, uPersp, uTaper, uSkew;
  uniform vec3 uWaveH, uWaveV, uRipple;
  uniform vec2 uTwist, uBend, uJitter;
  out vec2 vUV;
  out float vSide;
  out float vSpeed;
  const float PI = 3.14159265359;
  float hash(float n){ return fract(sin(n*12.9898 + 4.1414)*43758.5453); }

  vec2 deflect(float a, float b, float lineId){
    vec2 uv = uVertical==1 ? vec2(b,a) : vec2(a,b);
    float x = (uv.x-0.5)*2.0*uAspect;
    float y = (0.5-uv.y)*2.0;
    // 線間隔の偏り（走査線の詰まり）
    if (uVertical==1) { float s = x/uAspect; x = sign(s)*pow(abs(s), uSpacing)*uAspect; }
    else { y = sign(y)*pow(abs(y), uSpacing); }
    // ラインごとのジッター（走査方向へずれる）
    float j = (hash(lineId*1.37 + uJitter.y) - 0.5) * 2.0 * uJitter.x;
    if (uVertical==1) y += j; else x += j;
    // 波形モジュール
    x += uWaveH.x * sin(uWaveH.y*PI*y + uWaveH.z*2.0*PI);
    y += uWaveV.x * sin(uWaveV.y*PI*x/uAspect + uWaveV.z*2.0*PI);
    float r = length(vec2(x/uAspect, y));
    if (r > 1e-5) {
      float d = uRipple.x * sin(uRipple.y*PI*r - uRipple.z*2.0*PI);
      x += x/r/uAspect * d * uAspect; y += y/r * d;
    }
    x += uBend.x * y*y;
    y += uBend.y * (x/uAspect)*(x/uAspect);
    x *= 1.0 + uTaper*y*0.5;
    x += uSkew*y;
    x *= uSize.x; y *= uSize.y;
    // リボンねじれ（Y軸まわりに行ごとに回転）
    float tw = uTwist.x*y + uTwist.y*2.0*PI;
    float z = x*sin(tw); x = x*cos(tw);
    // 3D フリップ
    float cx = cos(uTiltX), sx = sin(uTiltX);
    float y2 = y*cx - z*sx; z = y*sx + z*cx; y = y2;
    float cy = cos(uTiltY), sy = sin(uTiltY);
    float x2 = x*cy + z*sy; z = -x*sy + z*cy; x = x2;
    float w = max(1.0 + z*uPersp*0.45, 0.04);
    x /= w; y /= w;
    // ロール
    float cr = cos(uRoll), sr = sin(uRoll);
    vec2 p = vec2(x*cr - y*sr, x*sr + y*cr) + uPos;
    return vec2(p.x/uAspect, p.y);
  }

  void main(){
    // 1本の走査線 = 三角形ストリップ。前後に縮退頂点を置いて全ラインを1回で描く
    int per = (uSegs+1)*2 + 2;
    int id = gl_VertexID;
    int line = id / per;
    int k = clamp(id - line*per - 1, 0, (uSegs+1)*2 - 1);
    int seg = k >> 1;
    float side = (k & 1) == 1 ? 1.0 : -1.0;
    float a = float(seg) / float(uSegs);
    float b = (float(line)+0.5) / float(uLines);
    float lid = float(line);
    vec2 p = deflect(a, b, lid);
    float da = (a < 0.999 ? 1.0 : -1.0) * 0.5/float(uSegs);
    vec2 t = (deflect(a+da, b, lid) - p) * uRes * 0.5 * sign(da);
    float len = length(t);
    vec2 dir = len > 1e-6 ? t/len : vec2(1.0, 0.0);
    vec2 n = vec2(-dir.y, dir.x);
    float alongPx = uVertical==1 ? uRes.y : uRes.x;
    float pitchPx = (uVertical==1 ? uRes.x : uRes.y) / float(uLines);
    float hw = max(uBeam*pitchPx*0.5, 0.7);
    float ext = hw*1.6 + 1.0;
    vec2 ppx = p*uRes*0.5 + n*side*ext;
    gl_Position = vec4(ppx/(uRes*0.5), 0.0, 1.0);
    vSide = side*ext/hw;
    vUV = uVertical==1 ? vec2(b, a) : vec2(a, b);
    vSpeed = (abs(da)*alongPx) / max(len, 1e-4);
  }`;

  const RASTER_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uSrc;
  uniform float uFocus, uIntensity, uBias, uSpeedComp;
  in vec2 vUV; in float vSide; in float vSpeed;
  out vec4 o;
  void main(){
    float s = textureLod(uSrc, vUV, uFocus).r;
    float prof = exp(-vSide*vSide*1.6);
    float sp = mix(1.0, clamp(vSpeed, 0.0, 3.5), uSpeedComp);
    float e = (s + uBias) * uIntensity * prof * sp;
    o = vec4(e, 0.0, 0.0, 1.0);
  }`;

  const PERSIST_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uNew, uEcho, uPrev;
  uniform float uDecay;
  in vec2 vUV; out vec4 o;
  void main(){
    // 本体と多重露光は明るい方を採用、残光はピークホールドしながら指数減衰
    float e = max(texture(uNew, vUV).r, texture(uEcho, vUV).r);
    e = max(e, texture(uPrev, vUV).r * uDecay);
    o = vec4(e, 0.0, 0.0, 1.0);
  }`;

  const COLOR_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uEnergy, uLut;
  uniform float uGain, uKey, uLevels, uSpread, uCycle, uSpatial, uFlat, uHot;
  uniform int uBands, uWrap;
  uniform vec2 uBlur; // 再撮カメラのボケ（走査線と直交方向、uv 単位）
  in vec2 vUV; out vec4 o;
  vec3 toLin(vec3 c){ return pow(c, vec3(2.2)); }
  void main(){
    float e = texture(uEnergy, vUV).r;
    // 色の判定はボケた映像で行い、明るさは生のラスターから取る
    float eb = e*0.2270;
    eb += (texture(uEnergy, vUV + uBlur*0.333).r + texture(uEnergy, vUV - uBlur*0.333).r)*0.1946;
    eb += (texture(uEnergy, vUV + uBlur*0.667).r + texture(uEnergy, vUV - uBlur*0.667).r)*0.1216;
    eb += (texture(uEnergy, vUV + uBlur).r + texture(uEnergy, vUV - uBlur).r)*0.0700;
    eb *= 1.6;
    float g = 1.0 - exp(-e*uGain);
    float gb = 1.0 - exp(-eb*uGain);
    float mask = smoothstep(uKey, uKey + 0.04 + uKey*0.3, max(g, gb));
    float lv = gb;
    if (uBands==1) lv = (floor(g*uLevels) + 0.5) / uLevels;
    float coord = lv*uSpread + uCycle + uSpatial*(vUV.y-0.5);
    if (uWrap==0) coord = clamp(coord, 0.0, 1.0);
    else if (uWrap==1) coord = fract(coord);
    else coord = 1.0 - abs(1.0 - mod(coord, 2.0));
    coord = clamp(coord, 0.002, 0.998);
    vec3 col = toLin(texture(uLut, vec2(coord, 0.5)).rgb);
    float bright = mix(g, max(g, gb)*0.4 + 0.6, uFlat);
    col *= bright * mask;
    float hot = smoothstep(1.0 - uHot*0.5, 1.0, g) * uHot;
    col = mix(col, vec3(1.0, 0.97, 0.92)*1.4, hot);
    o = vec4(col, 1.0);
  }`;

  const DOWN_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uTex; uniform vec2 uHalf;
  in vec2 vUV; out vec4 o;
  void main(){
    vec3 s = texture(uTex, vUV).rgb*4.0;
    s += texture(uTex, vUV + vec2(-uHalf.x, -uHalf.y)).rgb;
    s += texture(uTex, vUV + vec2( uHalf.x, -uHalf.y)).rgb;
    s += texture(uTex, vUV + vec2(-uHalf.x,  uHalf.y)).rgb;
    s += texture(uTex, vUV + vec2( uHalf.x,  uHalf.y)).rgb;
    o = vec4(s/8.0, 1.0);
  }`;

  const UP_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uTex; uniform vec2 uHalf;
  in vec2 vUV; out vec4 o;
  void main(){
    vec3 s = vec3(0.0);
    s += texture(uTex, vUV + vec2(-uHalf.x*2.0, 0.0)).rgb;
    s += texture(uTex, vUV + vec2(-uHalf.x, uHalf.y)).rgb*2.0;
    s += texture(uTex, vUV + vec2(0.0, uHalf.y*2.0)).rgb;
    s += texture(uTex, vUV + vec2(uHalf.x, uHalf.y)).rgb*2.0;
    s += texture(uTex, vUV + vec2(uHalf.x*2.0, 0.0)).rgb;
    s += texture(uTex, vUV + vec2(uHalf.x, -uHalf.y)).rgb*2.0;
    s += texture(uTex, vUV + vec2(0.0, -uHalf.y*2.0)).rgb;
    s += texture(uTex, vUV + vec2(-uHalf.x, -uHalf.y)).rgb*2.0;
    o = vec4(s/12.0, 1.0);
  }`;

  const FINAL_FS = `#version 300 es
  precision highp float;
  uniform sampler2D uColor, uBloom, uHalo;
  uniform float uBloomAmt, uHaloAmt, uExposure, uScan, uChroma, uNoise, uWobble, uVignette, uTime, uBgLevel;
  uniform vec3 uBg;
  uniform vec2 uRes;
  in vec2 vUV; out vec4 o;
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7)))*43758.5453); }
  vec3 scene(vec2 uv){
    return texture(uColor, uv).rgb + texture(uBloom, uv).rgb*uBloomAmt + texture(uHalo, uv).rgb*uHaloAmt;
  }
  void main(){
    vec2 uv = vUV;
    // テープの揺れ（水平同期の乱れ）
    float fr = floor(uTime*29.97);
    uv.x += uWobble*(0.0025*sin(uv.y*35.0 + uTime*2.7) + 0.0015*sin(uv.y*7.0 - uTime*1.1)
            + 0.0012*(hash(vec2(fr, 1.0))-0.5));
    float band = smoothstep(0.0, 0.02, abs(fract(uv.y*0.5 - uTime*0.11) - 0.5)) ;
    uv.x += uWobble*0.004*(1.0-band);
    // 色にじみ：輝度は鋭く、色差は横に広がる（コンポジット映像の帯域）
    float off = uChroma*2.5/uRes.x;
    vec3 c0 = scene(uv);
    vec3 cl = scene(uv - vec2(off*2.0, 0.0)), cr = scene(uv + vec2(off*2.0, 0.0));
    vec3 cl2 = scene(uv - vec2(off*4.0, 0.0)), cr2 = scene(uv + vec2(off*4.0, 0.0));
    vec3 blur = (c0*2.0 + cl + cr + (cl2 + cr2)*0.5)/5.0;
    float Y = dot(c0, vec3(0.299, 0.587, 0.114));
    float Yb = dot(blur, vec3(0.299, 0.587, 0.114));
    vec3 c = mix(c0, blur - Yb + Y, uChroma);
    c.r = mix(c.r, scene(uv + vec2(off, 0.0)).r, uChroma*0.6);
    c = max(c, 0.0);
    // 背景
    vec2 q = vUV - 0.5;
    float vig = 1.0 - dot(q*vec2(1.0, 1.25), q*vec2(1.0, 1.25))*1.6;
    c += pow(uBg, vec3(2.2)) * uBgLevel * (0.55 + 0.45*clamp(vig, 0.0, 1.0)) * 2.0;
    // 露出・トーンマップ
    c = 1.0 - exp(-c*uExposure*1.6);
    // NTSC 走査線（約480本）
    float sl = 0.5 + 0.5*cos(vUV.y*uRes.y*3.14159265 * (480.0/uRes.y));
    c *= 1.0 - uScan*0.45*(1.0 - sl);
    // 周辺減光
    c *= mix(1.0, clamp(vig, 0.0, 1.0)*0.85 + 0.15, uVignette);
    c = pow(c, vec3(1.0/2.2));
    // ノイズ（スノー）
    float n = hash(floor(vUV*uRes/1.5) + fract(uTime*7.31)*vec2(91.7, 37.3)) - 0.5;
    c += n*uNoise*0.07;
    o = vec4(c, 1.0);
  }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src);
    return s;
  }
  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }

  function hexToRgb(h) {
    const v = parseInt(h.replace('#', ''), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  const D2R = Math.PI / 180;

  class ScanEngine {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
      if (!gl) throw new Error('WebGL2 に対応していないブラウザです');
      this.gl = gl;
      this.floatOk = !!gl.getExtension('EXT_color_buffer_float');
      gl.getExtension('OES_texture_float_linear');
      this.progs = {
        raster: program(gl, RASTER_VS, RASTER_FS),
        persist: program(gl, FS_TRI, PERSIST_FS),
        color: program(gl, FS_TRI, COLOR_FS),
        down: program(gl, FS_TRI, DOWN_FS),
        up: program(gl, FS_TRI, UP_FS),
        final: program(gl, FS_TRI, FINAL_FS),
      };
      this.vao = gl.createVertexArray();
      this.srcTex = gl.createTexture();
      this.lutTex = gl.createTexture();
      this.segs = 384;
      this.w = 0; this.h = 0;
    }

    _target(w, h) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (this.floatOk) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fb, w, h };
    }

    _free() {
      const gl = this.gl;
      for (const t of this.targets || []) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
      this.targets = [];
    }

    setSize(w, h) {
      if (w === this.w && h === this.h) return;
      this._free();
      this.w = w; this.h = h;
      this.canvas.width = w; this.canvas.height = h;
      const mk = (a, b) => { const t = this._target(Math.max(1, a), Math.max(1, b)); this.targets.push(t); return t; };
      this.raster = mk(w, h);
      this.echoT = mk(w, h);
      this.acc = [mk(w, h), mk(w, h)];
      this.colorT = mk(w, h);
      this.mips = [];
      let mw = w, mh = h;
      for (let i = 0; i < 6; i++) { mw = Math.ceil(mw / 2); mh = Math.ceil(mh / 2); this.mips.push(mk(mw, mh)); }
      this.reset();
    }

    reset() {
      const gl = this.gl;
      for (const t of this.acc || []) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      this.cur = 0;
    }

    setSource(canvas2d) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas2d);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    setPalette(stops) {
      const N = 256;
      const data = new Uint8Array(N * 4);
      const cols = stops.map(hexToRgb);
      for (let i = 0; i < N; i++) {
        const f = i / (N - 1) * (cols.length - 1);
        const k = Math.min(cols.length - 2, Math.floor(f));
        const t = f - k;
        for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(cols[k][c] * (1 - t) + cols[k + 1][c] * t);
        data[i * 4 + 3] = 255;
      }
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, N, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    _pass(prog, target) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
      gl.viewport(0, 0, target ? target.w : this.w, target ? target.h : this.h);
      gl.useProgram(prog.p);
      return prog.u;
    }
    _bind(unit, tex) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      return unit;
    }
    _tri() { this.gl.drawArrays(this.gl.TRIANGLES, 0, 3); }

    /*
     * layers : [{ P, weight }]  P は時刻評価済みのパラメータ（位相含む）
     * main   : 現在時刻の P（ポスト処理用）
     * opts   : { dt, time, settings }
     */
    render(layers, main, opts) {
      const gl = this.gl;
      const S = opts.settings;
      gl.bindVertexArray(this.vao);
      gl.disable(gl.DEPTH_TEST);

      // --- 2+3. ラスター描画
      // 本体は加算（線が重なると明るくなる）、多重露光は MAX で別バッファへ
      gl.clearColor(0, 0, 0, 1);
      let u = this._pass(this.progs.raster, this.echoT);
      gl.clear(gl.COLOR_BUFFER_BIT);
      u = this._pass(this.progs.raster, this.raster);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1i(u.uSrc, this._bind(0, this.srcTex));
      gl.uniform2f(u.uRes, this.w, this.h);
      gl.uniform1f(u.uAspect, this.w / this.h);
      gl.uniform1i(u.uVertical, S.scanDir === 'v' ? 1 : 0);
      gl.uniform1i(u.uSegs, this.segs);
      layers.forEach(({ P, weight }, li) => {
        if (weight <= 0.002) return;
        if (li === 1) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.echoT.fb);
          gl.blendEquation(gl.MAX);
        }
        const lines = Math.max(1, Math.round(P.lines));
        gl.uniform1i(u.uLines, lines);
        gl.uniform1f(u.uBeam, P.beam);
        gl.uniform1f(u.uSpacing, P.spacing);
        gl.uniform1f(u.uFocus, P.focus);
        gl.uniform1f(u.uIntensity, P.intensity * weight);
        gl.uniform1f(u.uBias, P.bias);
        gl.uniform1f(u.uSpeedComp, P.speedComp);
        gl.uniform2f(u.uPos, P.posX, P.posY);
        gl.uniform2f(u.uSize, P.sizeX, P.sizeY);
        gl.uniform1f(u.uRoll, P.roll * D2R);
        gl.uniform1f(u.uTiltX, P.tiltX * D2R);
        gl.uniform1f(u.uTiltY, P.tiltY * D2R);
        gl.uniform1f(u.uPersp, P.persp);
        gl.uniform1f(u.uTaper, P.taper);
        gl.uniform1f(u.uSkew, P.skew);
        gl.uniform3f(u.uWaveH, P.waveHAmp, P.waveHFreq, P.waveHPhase);
        gl.uniform3f(u.uWaveV, P.waveVAmp, P.waveVFreq, P.waveVPhase);
        gl.uniform3f(u.uRipple, P.rippleAmp, P.rippleFreq, P.ripplePhase);
        gl.uniform2f(u.uTwist, P.twist, P.twistPhase);
        gl.uniform2f(u.uBend, P.bendH, P.bendV);
        gl.uniform2f(u.uJitter, P.jitter, P.jitterSeed);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, lines * ((this.segs + 1) * 2 + 2));
      });
      gl.blendEquation(gl.FUNC_ADD);
      gl.disable(gl.BLEND);

      // --- 4. 蛍光体残光
      const prev = this.acc[this.cur], next = this.acc[1 - this.cur];
      u = this._pass(this.progs.persist, next);
      gl.uniform1i(u.uNew, this._bind(0, this.raster.tex));
      gl.uniform1i(u.uEcho, this._bind(1, this.echoT.tex));
      gl.uniform1i(u.uPrev, this._bind(2, prev.tex));
      const decay = main.persist > 0.001 ? Math.pow(0.5, opts.dt / main.persist) : 0;
      gl.uniform1f(u.uDecay, decay);
      this._tri();
      this.cur = 1 - this.cur;

      // --- 5. カラライザー
      u = this._pass(this.progs.color, this.colorT);
      gl.uniform1i(u.uEnergy, this._bind(0, next.tex));
      gl.uniform1i(u.uLut, this._bind(1, this.lutTex));
      gl.uniform1f(u.uGain, main.gain);
      gl.uniform1f(u.uKey, main.keyLevel);
      gl.uniform1f(u.uLevels, Math.round(main.levels));
      gl.uniform1f(u.uSpread, main.spread);
      gl.uniform1f(u.uCycle, main.cycle + main.cyclePhase);
      gl.uniform1f(u.uSpatial, main.spatial);
      gl.uniform1f(u.uFlat, main.flat);
      gl.uniform1f(u.uHot, main.hot);
      gl.uniform1i(u.uBands, S.colorMode === 'bands' ? 1 : 0);
      gl.uniform1i(u.uWrap, { clamp: 0, repeat: 1, mirror: 2 }[S.wrap] ?? 2);
      const pitch = main.recapBlur / Math.max(1, Math.round(main.lines));
      if (S.scanDir === 'v') gl.uniform2f(u.uBlur, pitch, 0); else gl.uniform2f(u.uBlur, 0, pitch);
      this._tri();

      // --- 6. グロー（dual filter）
      let src = this.colorT;
      for (const m of this.mips) {
        u = this._pass(this.progs.down, m);
        gl.uniform1i(u.uTex, this._bind(0, src.tex));
        gl.uniform2f(u.uHalf, 0.5 / src.w, 0.5 / src.h);
        this._tri();
        src = m;
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = this.mips.length - 1; i > 0; i--) {
        const from = this.mips[i], to = this.mips[i - 1];
        u = this._pass(this.progs.up, to);
        gl.uniform1i(u.uTex, this._bind(0, from.tex));
        gl.uniform2f(u.uHalf, 0.5 / from.w, 0.5 / from.h);
        this._tri();
      }
      gl.disable(gl.BLEND);

      // --- 7. ビデオ出力
      u = this._pass(this.progs.final, null);
      gl.uniform1i(u.uColor, this._bind(0, this.colorT.tex));
      gl.uniform1i(u.uBloom, this._bind(1, this.mips[0].tex));
      gl.uniform1i(u.uHalo, this._bind(2, this.mips[3].tex));
      gl.uniform1f(u.uBloomAmt, main.bloom * 0.12);
      gl.uniform1f(u.uHaloAmt, main.halation * 0.15);
      gl.uniform1f(u.uExposure, main.exposure);
      gl.uniform1f(u.uScan, main.scan);
      gl.uniform1f(u.uChroma, main.chroma);
      gl.uniform1f(u.uNoise, main.noise);
      gl.uniform1f(u.uWobble, main.wobble);
      gl.uniform1f(u.uVignette, main.vignette);
      gl.uniform1f(u.uBgLevel, main.bgLevel);
      gl.uniform1f(u.uTime, opts.time);
      gl.uniform2f(u.uRes, this.w, this.h);
      const bg = hexToRgb(S.bgColor || '#000000').map(v => v / 255);
      gl.uniform3f(u.uBg, bg[0], bg[1], bg[2]);
      this._tri();
    }
  }

  global.ScanEngine = ScanEngine;
})(window);
