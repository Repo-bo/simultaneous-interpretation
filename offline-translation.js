/* =========================================================
 * 离线翻译引擎 OfflineMT —— transformers.js + opus-mt ONNX
 * 英中互译（en↔zh）本地推理兜底：所有在线翻译引擎均失败时启用。
 * 模型自托管于仓库 models/mt/（GitHub Pages 同源分发，无 CORS 问题），
 * 首次使用需联网下载（~114MB/方向，带进度），之后走浏览器 Cache 零下载。
 * 库源：jsDelivr → unpkg 兜底。
 * ========================================================= */

/* 语言对 → 本地模型目录名（相对 models/mt/） */
const OFFLINE_MT_REPO = {
  'en-US>zh-CN': 'opus-mt-en-zh',
  'zh-CN>en-US': 'opus-mt-zh-en',
};

/* 懒加载 transformers.js ESM 库（多 CDN 兜底），init 时后台预热 */
let tfMod = null;
let tfLibPromise = null;
async function loadTransformersLib() {
  if (tfMod) return tfMod;
  if (tfLibPromise) return tfLibPromise;
  tfLibPromise = (async () => {
    const urls = [
      'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2',
      'https://unpkg.com/@xenova/transformers@2.17.2',
    ];
    let lastErr;
    for (const url of urls) {
      try {
        const mod = await import(url);
        if (mod && mod.pipeline) {
          // 模型仅从本站同源加载（GitHub Pages 自托管），禁用远程 Hub；
          // 注意 Pages 站点在子路径下，必须以 baseURI 解析，不能用根路径 '/models/'
          mod.env.allowLocalModels = true;
          mod.env.allowRemoteModels = false;
          mod.env.localModelPath = new URL('models/mt/', document.baseURI).href;
          mod.env.useBrowserCache = true;
          // 注意：必须保持主线程推理（proxy=false）。
          // ORT 的 proxy worker 需从 CDN 跨域创建，会静默卡死；且 ORT 初始化后禁止切换
          // proxy 模式（报 "WebAssembly is not initialized yet"），故从首次加载就固定 false。
          try { mod.env.backends.onnx.wasm.numThreads = 1; } catch (e) {}
          tfMod = mod;
          return tfMod;
        }
      } catch (e) { lastErr = e; }
    }
    tfLibPromise = null; // 允许下次重试
    throw new Error('OFFLINE_MT_LIB_FAIL: ' + (lastErr && lastErr.message));
  })();
  return tfLibPromise;
}

class OfflineMT {
  constructor() {
    this.pipes = new Map();      // pair → pipeline（进程内复用，避免重复加载）
    this.loadPromises = new Map(); // pair → 加载 Promise（防并发重复下载）
    this.queue = Promise.resolve(); // 串行队列：seq2seq 推理吃内存，禁止并发生成
    this.onProgress = null;      // (percent 0-100) 模型下载进度回调
  }

  supported(fromId, toId) {
    return !!OFFLINE_MT_REPO[`${fromId}>${toId}`];
  }

  /* 字节加权进度：汇总当前 pair 各文件的下载量 */
  _makeProgressTracker() {
    const files = new Map(); // file → {loaded, total}
    return event => {
      if (!event || !event.file) return;
      if (event.status === 'progress') {
        files.set(event.file, { loaded: event.loaded || 0, total: event.total || 0 });
        let loaded = 0, total = 0;
        files.forEach(f => { loaded += f.loaded; total += f.total; });
        if (total > 0 && this.onProgress) this.onProgress(Math.round((loaded / total) * 100));
      }
    };
  }

  async _getPipeline(pair) {
    if (this.pipes.has(pair)) return this.pipes.get(pair);
    if (this.loadPromises.has(pair)) return this.loadPromises.get(pair);
    const p = (async () => {
      const mod = await loadTransformersLib();
      const pipe = await mod.pipeline(
        'translation',
        OFFLINE_MT_REPO[pair],
        { quantized: true, progress_callback: this._makeProgressTracker() },
      );
      this.pipes.set(pair, pipe);
      this.loadPromises.delete(pair);
      return pipe;
    })();
    this.loadPromises.set(pair, p);
    p.catch(() => this.loadPromises.delete(pair)); // 失败允许重试
    return p;
  }

  /** 翻译一句话；仅支持 en↔zh，其他语言对抛 OFFLINE_MT_PAIR_UNSUPPORTED */
  async translate(text, fromId, toId) {
    const pair = `${fromId}>${toId}`;
    if (!OFFLINE_MT_REPO[pair]) throw new Error('OFFLINE_MT_PAIR_UNSUPPORTED');
    const pipe = await this._getPipeline(pair);
    // 串行执行：排队等待前一个生成完成，避免并发推理导致内存溢出
    const run = this.queue.then(async () => {
      const out = await pipe(text, { max_new_tokens: 256, num_beams: 1 });
      const t = (Array.isArray(out) ? out[0] : out);
      return ((t && t.translation_text) || '').trim();
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

const offlineMT = new OfflineMT();
window.offlineMT = offlineMT; // 供 app.js 降级链与控制台测试使用
