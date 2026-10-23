/*
 * 依存ライブラリなしの最小限コンテナ書き出し。
 *   Mp4Writer  : WebCodecs の H.264 (avc フォーマット) チャンクを faststart MP4 にまとめる
 *   WebmWriter : WebCodecs の VP9 / VP8 チャンクを WebM (Matroska) にまとめる
 * どちらも映像1トラックのみ・一定フレームレート前提。
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- MP4
  function u8(...a) { return new Uint8Array(a); }
  function u16(v) { return u8((v >>> 8) & 255, v & 255); }
  function u32(v) { return u8((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); }
  function str(s) { return new Uint8Array([...s].map(c => c.charCodeAt(0))); }
  function concat(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function box(type, ...payload) {
    const body = concat(payload);
    return concat([u32(body.length + 8), str(type), body]);
  }
  function fullBox(type, version, flags, ...payload) {
    return box(type, u8(version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255), ...payload);
  }
  const MATRIX = concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

  class Mp4Writer {
    constructor({ width, height, fps }) {
      this.width = width; this.height = height; this.fps = fps;
      this.timescale = Math.round(fps * 1000);
      this.delta = 1000; // timescale / fps
      this.samples = []; // {data, key}
      this.avcC = null;
    }
    addChunk(chunk, meta) {
      if (meta && meta.decoderConfig && meta.decoderConfig.description && !this.avcC) {
        const d = meta.decoderConfig.description;
        this.avcC = new Uint8Array(d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d);
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      this.samples.push({ data, key: chunk.type === 'key' });
    }
    _moov(mdatOffset) {
      const n = this.samples.length;
      const dur = n * this.delta;
      const movieDur = Math.round(n / this.fps * 1000);
      const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(movieDur), u32(0x00010000), u16(0x0100),
        new Uint8Array(10), MATRIX, new Uint8Array(24), u32(2));
      const tkhd = fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(movieDur), new Uint8Array(8),
        u16(0), u16(0), u16(0), u16(0), MATRIX, u32(this.width << 16), u32(this.height << 16));
      const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(this.timescale), u32(dur), u16(0x55C4), u16(0));
      const hdlr = fullBox('hdlr', 0, 0, u32(0), str('vide'), new Uint8Array(12), str('ScanimaterVideo\0'));
      const vmhd = fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0));
      const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
      const compressor = new Uint8Array(32);
      const avc1 = box('avc1', new Uint8Array(6), u16(1), u16(0), u16(0), new Uint8Array(12),
        u16(this.width), u16(this.height), u32(0x00480000), u32(0x00480000), u32(0), u16(1),
        compressor, u16(0x0018), u16(0xFFFF), box('avcC', this.avcC));
      const stsd = fullBox('stsd', 0, 0, u32(1), avc1);
      const stts = fullBox('stts', 0, 0, u32(1), u32(n), u32(this.delta));
      const keys = [];
      this.samples.forEach((s, i) => { if (s.key) keys.push(i + 1); });
      const stss = fullBox('stss', 0, 0, u32(keys.length), ...keys.map(u32));
      const stsc = fullBox('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1));
      const stsz = fullBox('stsz', 0, 0, u32(0), u32(n), ...this.samples.map(s => u32(s.data.length)));
      const stco = fullBox('stco', 0, 0, u32(1), u32(mdatOffset));
      const stbl = box('stbl', stsd, stts, stss, stsc, stsz, stco);
      const minf = box('minf', vmhd, dinf, stbl);
      const mdia = box('mdia', mdhd, hdlr, minf);
      const trak = box('trak', tkhd, mdia);
      return box('moov', mvhd, trak);
    }
    finalize() {
      if (!this.avcC) throw new Error('H.264 decoder config (avcC) が得られませんでした');
      const ftyp = box('ftyp', str('isom'), u32(512), str('isom'), str('iso2'), str('avc1'), str('mp41'));
      let mdatSize = 8;
      for (const s of this.samples) mdatSize += s.data.length;
      const probe = this._moov(0);
      const moov = this._moov(ftyp.length + probe.length + 8);
      const parts = [ftyp, moov, concat([u32(mdatSize), str('mdat')])];
      for (const s of this.samples) parts.push(s.data);
      return new Blob(parts, { type: 'video/mp4' });
    }
  }

  // ---------------------------------------------------------------- WebM
  function idBytes(id) {
    const out = [];
    let v = id;
    while (v > 0) { out.unshift(v & 255); v = Math.floor(v / 256); }
    return new Uint8Array(out);
  }
  function sizeVint(n) {
    // 常に8バイト長の可変長整数で書く（仕様上有効）
    const b = new Uint8Array(8);
    b[0] = 0x01;
    let v = n;
    for (let i = 7; i >= 1; i--) { b[i] = v & 255; v = Math.floor(v / 256); }
    return b;
  }
  function uintBytes(v) {
    const out = [];
    do { out.unshift(v & 255); v = Math.floor(v / 256); } while (v > 0);
    return new Uint8Array(out);
  }
  function el(id, payload) {
    const data = payload instanceof Uint8Array ? payload : concat(payload);
    return concat([idBytes(id), sizeVint(data.length), data]);
  }
  const elUint = (id, v) => el(id, uintBytes(v));
  const elStr = (id, s) => el(id, str(s));
  function elFloat(id, v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v);
    return el(id, b);
  }

  class WebmWriter {
    constructor({ width, height, fps, codec }) {
      this.width = width; this.height = height; this.fps = fps;
      this.codecId = codec.startsWith('vp8') ? 'V_VP8' : 'V_VP9';
      this.frames = []; // {data, key, ms}
      this.index = 0;
    }
    addChunk(chunk) {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      this.frames.push({ data, key: chunk.type === 'key', ms: Math.round(this.index * 1000 / this.fps) });
      this.index++;
    }
    finalize() {
      const ebml = el(0x1A45DFA3, [elUint(0x4286, 1), elUint(0x42F7, 1), elUint(0x42F2, 4), elUint(0x42F3, 8),
        elStr(0x4282, 'webm'), elUint(0x4287, 2), elUint(0x4285, 2)]);
      const durationMs = this.frames.length * 1000 / this.fps;
      const info = el(0x1549A966, [elUint(0x2AD7B1, 1000000), elStr(0x4D80, 'Scanimater'), elStr(0x5741, 'Scanimater'), elFloat(0x4489, durationMs)]);
      const tracks = el(0x1654AE6B, [el(0xAE, [elUint(0xD7, 1), elUint(0x73C5, 1), elUint(0x9C, 0), elUint(0x83, 1),
        elStr(0x86, this.codecId), elUint(0x23E383, Math.round(1e9 / this.fps)),
        el(0xE0, [elUint(0xB0, this.width), elUint(0xBA, this.height)])])]);

      // キーフレームごと（最長約30秒）にクラスタを切る
      const clusters = [];
      let cur = null;
      for (const f of this.frames) {
        if (!cur || f.key || f.ms - cur.start > 30000) {
          cur = { start: f.ms, blocks: [] };
          clusters.push(cur);
        }
        const rel = f.ms - cur.start;
        const head = u8(0x81, (rel >> 8) & 255, rel & 255, f.key ? 0x80 : 0x00);
        cur.blocks.push(el(0xA3, [head, f.data]));
      }
      const segParts = [info, tracks];
      let offset = info.length + tracks.length;
      const cuePoints = [];
      for (const c of clusters) {
        const cl = el(0x1F43B675, [elUint(0xE7, c.start), ...c.blocks]);
        cuePoints.push(el(0xBB, [elUint(0xB3, c.start), el(0xB7, [elUint(0xF7, 1), elUint(0xF1, offset)])]));
        segParts.push(cl);
        offset += cl.length;
      }
      segParts.push(el(0x1C53BB6B, cuePoints));
      let segSize = 0;
      for (const p of segParts) segSize += p.length;
      const segHead = concat([idBytes(0x18538067), sizeVint(segSize)]);
      return new Blob([ebml, segHead, ...segParts], { type: 'video/webm' });
    }
  }

  global.Mp4Writer = Mp4Writer;
  global.WebmWriter = WebmWriter;
})(window);
