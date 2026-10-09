/* =========================================================
 * 离线语音引擎 OfflineStt —— 基于 Vosk (WASM)，浏览器本地推理
 * 不访问任何在线识别服务，彻底解决 Web Speech 的 network 报错。
 * 当前内置：英语(en-US)、中文(zh-CN) 小模型，模型经本地服务读取，
 * 首次加载后写入 Cache，后续打开零下载。
 * ========================================================= */

/* 通过 fetch + Blob URL 动态加载 Vosk 库（绕过 HTTP/2 脚本加载问题） */
async function loadVosk() {
  if (window.Vosk) return true;
  const urls = [
    'lib/vosk.js',
    'https://cdn.jsdelivr.net/npm/vosk-browser@0.0.6/dist/vosk.js',
    'https://unpkg.com/vosk-browser@0.0.6/dist/vosk.js',
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const code = await res.text();
      if (!code || code.length < 1000) continue;
      const blob = new Blob([code], { type: 'application/javascript' });
      const objUrl = URL.createObjectURL(blob);
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = objUrl;
        s.onload = () => { URL.revokeObjectURL(objUrl); resolve(); };
        s.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error('exec failed')); };
        document.head.appendChild(s);
      });
      if (window.Vosk) return true;
    } catch (e) { /* try next source */ }
  }
  return false;
}

const OFFLINE_MODELS = {
  'en-US': ['models/en.tar.gz'],
  // 中文模型原始 44MB，超过 GitHub Blob API 请求体上限，拆为两片，加载时合并
  'zh-CN': ['models/cn.part1.bin', 'models/cn.part2.bin'],
};
const OFFLINE_RATE = 16000;

// 去除汉字之间因词格产生的多余空格
function cleanCnSpaces(t) {
  return t.replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1').replace(/\s+([，。！？、；：])/g, '$1');
}

class OfflineStt {
  /** handlers: { onInterim, onFinal, onProgress(0-100), onReady, onError } */
  constructor(handlers = {}) {
    this.h = handlers;
    this.model = null;
    this.recognizer = null;
    this.ctx = null;
    this.node = null;
    this.workletOk = false;
    this.running = false;
    this.lang = null;
  }

  /* ---- 模型：先查 Cache，否则带进度下载，多片按序合并，再交给 vosk-browser ---- */
  async _fetchPart(url, onProgress) {
    try {
      const cached = await caches.match(url);
      if (cached) return await cached.blob();
    } catch (e) { /* Cache 不可用时退回直连 */ }

    const res = await fetch(url);
    if (!res.ok) throw new Error('模型下载 HTTP ' + res.status);
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total) onProgress && onProgress(received, total);
    }
    const blob = new Blob(chunks);
    try {
      const cache = await caches.open('vosk-models');
      cache.put(url, new Response(blob));
    } catch (e) { /* 存储已满等，忽略，不影响本次使用 */ }
    return blob;
  }

  async _loadModel(lang) {
    const parts = OFFLINE_MODELS[lang];
    if (!parts || !parts.length) throw new Error('NO_MODEL');
    if (this._modelPromise && this.lang === lang) return this._modelPromise;
    this.lang = lang;
    this._modelPromise = (async () => {
      const blobs = [];
      for (let i = 0; i < parts.length; i++) {
        const partStart = i / parts.length, partSpan = 1 / parts.length;
        const blob = await this._fetchPart(parts[i], (rec, tot) => {
          this.h.onProgress && this.h.onProgress(
            Math.round((partStart + partSpan * (tot ? Math.min(1, rec / tot) : 0)) * 96));
        });
        blobs.push(blob);
      }
      const blob = new Blob(blobs);
      const objUrl = URL.createObjectURL(blob);
      try {
        this.model = await Vosk.createModel(objUrl);
      } finally {
        // 保留 objectURL 直到模型使用完毕（worker 异步初始化），延迟回收
        setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
      }
      this.h.onProgress && this.h.onProgress(100);
    })();
    return this._modelPromise;
  }

  /* ---- 音频接线：16kHz 上下文 + AudioWorklet（降级 ScriptProcessor） ---- */
  async _wire(stream) {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: OFFLINE_RATE });
    const source = this.ctx.createMediaStreamSource(stream);

    const feed = f32 => {
      if (this.recognizer) this.recognizer.acceptWaveformFloat(f32, OFFLINE_RATE);
    };

    try {
      await this.ctx.audioWorklet.addModule('lib/pcm-worklet.js');
      this.node = new AudioWorkletNode(this.ctx, 'pcm-pass');
      this.node.port.onmessage = e => feed(e.data);
      source.connect(this.node);
      // 工作流不要求出声，但部分浏览器自动挂起未连接的图；接到一个静音目的地更稳
      if (!this.ctx.sinkId && this.ctx.createMediaStreamDestination) {
        try { this.node.connect(this.ctx.createMediaStreamDestination()); } catch (e) {}
      }
      this.workletOk = true;
    } catch (e) {
      // 降级：ScriptProcessor（16k 上下文下缓冲，2048 样本=128ms，兼顾延迟与性能）
      const sp = this.ctx.createScriptProcessor(2048, 1, 1);
      sp.onaudioprocess = ev => {
        const ch = ev.inputBuffer.getChannelData(0);
        if (ch.some(v => v !== 0)) feed(ch.slice(0));
      };
      source.connect(sp);
      sp.connect(this.ctx.destination);
      this.node = sp;
      this.workletOk = false;
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  async start(lang, stream) {
    await this._loadModel(lang);
    await this._wire(stream);

    this.recognizer = new this.model.KaldiRecognizer(OFFLINE_RATE);
    this.recognizer.setWords(false);

    this.recognizer.on('partialresult', message => {
      const t = (message.result && message.result.partial) || '';
      if (t) this.h.onInterim && this.h.onInterim(lang === 'zh-CN' ? cleanCnSpaces(t) : t);
    });
    this.recognizer.on('result', message => {
      let t = (message.result && message.result.text) || '';
      t = t.trim();
      if (!t) return;
      if (lang === 'zh-CN') t = cleanCnSpaces(t);
      this.h.onFinal && this.h.onFinal(t);
    });

    this.running = true;
    this.h.onReady && this.h.onReady();
  }

  stop() {
    this.running = false;
    try { this.recognizer && this.recognizer.remove && this.recognizer.remove(); } catch (e) {}
    this.recognizer = null;
    try { this.node && this.node.disconnect(); } catch (e) {}
    this.node = null;
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
  }

  /* 切换识别语言：离线模型按语言区分，需要重新加载模型与识别器 */
  async applyLang(lang, stream, duringRun) {
    if (!OFFLINE_MODELS[lang]) throw new Error('NO_MODEL');
    if (lang === this.lang && this.running) return;
    const wasRunning = duringRun || this.running;
    this.stop();
    this.model = null;
    this._modelPromise = null;
    if (wasRunning) await this.start(lang, stream);
    else this.lang = lang;
  }
}
