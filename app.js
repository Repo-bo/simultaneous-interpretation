/* =========================================================
 * 字幕台 · THE CAPTION DESK —— 实时同声传译（纯前端）
 * 语音识别：Web Speech API (SpeechRecognition)
 * 翻  译：MyMemory（主） + Google gtx（备），本地缓存
 * 语  音：SpeechSynthesis 译文播报
 * ========================================================= */

/* ---------------- 语言配置（对齐小爱翻译 12 语种） ---------------- */
const LANGS = [
  { id: 'zh-CN', name: '中文（普通话）', short: '中', mm: 'zh-CN' },
  { id: 'en-US', name: '英语 English',   short: 'EN', mm: 'en'    },
  { id: 'ja-JP', name: '日语 日本語',    short: 'JA', mm: 'ja'    },
  { id: 'ko-KR', name: '韩语 한국어',    short: 'KO', mm: 'ko'    },
  { id: 'ru-RU', name: '俄语 Русский',  short: 'RU', mm: 'ru'    },
  { id: 'fr-FR', name: '法语 Français', short: 'FR', mm: 'fr'    },
  { id: 'de-DE', name: '德语 Deutsch',  short: 'DE', mm: 'de'    },
  { id: 'es-ES', name: '西班牙语 Español', short: 'ES', mm: 'es'  },
  { id: 'pt-BR', name: '葡萄牙语 Português', short: 'PT', mm: 'pt-BR' },
  { id: 'it-IT', name: '意大利语 Italiano', short: 'IT', mm: 'it'  },
  { id: 'id-ID', name: '印尼语 Bahasa Indonesia', short: 'ID', mm: 'id' },
  { id: 'hi-IN', name: '印地语 हिन्दी',  short: 'HI', mm: 'hi'    },
];
const byId = id => LANGS.find(l => l.id === id);

/* ---------------- 工具 ---------------- */
const $  = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toast-host').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = '.3s'; setTimeout(() => el.remove(), 300); }, 2600);
}
const pad2 = n => String(n).padStart(2, '0');
const tcStamp = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}:${pad2(Math.floor(d.getMilliseconds() / 40))}`;
function joinSpoken(a, b) {
  const last = a.slice(-1), first = b[0];
  const cjk = ch => /[\u3000-\u9fff\uac00-\ud7af]/.test(ch);
  if (!a) return b;
  return (cjk(last) || cjk(first)) ? a + b : a + ' ' + b;
}
async function fetchTimeout(url, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

/* ---------------- 翻译服务 ---------------- */
const transCache = new Map();

// 按句末标点切句（保留标点），用于细粒度缓存与渐进翻译；超长句硬切保护
function splitSentences(text) {
  const raw = text.split(/(?<=[.!?。！？；;：:\n])/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const p of raw) {
    if (p.length <= 480) out.push(p);
    else for (let i = 0; i < p.length; i += 460) out.push(p.slice(i, i + 460));
  }
  return out;
}

async function viaMyMemory(text, sl, tl) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(sl + '|' + tl)}`;
  const r = await fetchTimeout(url);
  if (!r.ok) throw new Error('MyMemory HTTP ' + r.status);
  const d = await r.json();
  const t = d && d.responseData && d.responseData.translatedText;
  if (!t) throw new Error('MyMemory 无结果');
  if (/MYMEMORY WARNING|INVALID|QUOTA|PLEASE SELECT/i.test(t)) throw new Error('MyMemory 额度或语言异常');
  return t;
}

async function viaGoogle(text, sl, tl) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
  const r = await fetchTimeout(url);
  if (!r.ok) throw new Error('Google HTTP ' + r.status);
  const d = await r.json();
  return d[0].map(seg => seg[0]).join('');
}

// 双引擎竞速：MyMemory 与 Google 并发请求，取最先成功者；全失败才抛错。
// 冷启动下两家延迟差异显著，竞速可直接吃掉最慢的那一段等待。
async function translateRaw(text, fromDef, toDef) {
  const runners = [
    viaMyMemory(text, fromDef.mm, toDef.mm),
    viaGoogle(text, fromDef.id, toDef.id),
  ];
  return new Promise((resolve, reject) => {
    let pending = runners.length;
    let lastErr;
    runners.forEach(p =>
      p.then(resolve, e => {
        lastErr = e;
        if (--pending === 0) reject(lastErr || new Error('翻译引擎均不可用'));
      })
    );
  });
}

// 预热翻译服务：首个请求承担服务端冷启动（~5s），完成后再确认一次进入热状态，
// 随后定时保活，避免用户开口时撞上“每 IP 首请求排队”。
let keepAliveTimer = null;
function scheduleKeepAlive() {
  clearTimeout(keepAliveTimer);
  keepAliveTimer = setTimeout(() =>
    viaMyMemory('ok', 'en', 'zh-CN').catch(() => {}).finally(scheduleKeepAlive),
  45000);
}
function warmTranslation() {
  const st = $('#sim-status');
  st && $('.oa-txt', st) && ($('.oa-txt', st).textContent = 'WARMING · 引擎预热中');
  viaMyMemory('hi', 'en', 'zh-CN')
    .catch(() => {})
    .finally(() => {
      setTimeout(() => {
        viaMyMemory('ok', 'en', 'zh-CN')
          .catch(() => {})
          .finally(() => {
            scheduleKeepAlive();
            if (!sim.running) $('.oa-txt', $('#sim-status')).textContent = 'READY · 就绪';
          });
      }, 150);
    });
}

// 单句翻译（缓存粒度 = 句子），识别中途预译与最终提交共享同一缓存
async function translateSentence(s, fromId, toId) {
  const key = `${fromId}>${toId}:${s}`;
  if (transCache.has(key)) return transCache.get(key);
  const out = (await translateRaw(s, byId(fromId), byId(toId))).trim();
  transCache.set(key, out);
  if (transCache.size > 500) transCache.delete(transCache.keys().next().value);
  return out;
}

/**
 * 流式翻译：句子并发请求，但按句序回调。
 * onPartial(accumulatedText) 每当前缀句子就绪即触发 → 首句译文可立即上屏/播报。
 * 返回完整译文；任一句失败则抛错（调用方可据是否已部分渲染决定 UI）。
 */
async function translateStream(text, fromId, toId, onPartial) {
  const sents = splitSentences(text);
  const outs = new Array(sents.length);
  let next = 0;
  const flush = () => {
    while (next < sents.length && outs[next] !== undefined) next++;
    if (onPartial && next > 0) onPartial(outs.slice(0, next).join(''));
  };
  await Promise.all(sents.map(async (s, i) => {
    outs[i] = await translateSentence(s, fromId, toId);
    flush();
  }));
  flush();
  return outs.join('');
}

async function translate(text, fromId, toId) {
  text = text.trim();
  if (!text || fromId === toId) return text;
  return translateStream(text, fromId, toId, null);
}

/* ---------------- TTS 译文播报 ---------------- */
let ttsVoices = [];
function loadVoices() { ttsVoices = window.speechSynthesis ? speechSynthesis.getVoices() : []; }
if ('speechSynthesis' in window) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}
function speak(text, langId, queue = false) {
  if (!('speechSynthesis' in window) || !state.autoSpeak) return;
  if (!queue) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const norm = v => (v || '').replace('_', '-').toLowerCase();
  const v = ttsVoices.find(x => norm(x.lang).startsWith(langId.toLowerCase()))
         || ttsVoices.find(x => norm(x.lang).slice(0, 2) === langId.slice(0, 2));
  if (v) u.voice = v;
  u.lang = langId; u.rate = 1; u.pitch = 1;
  speechSynthesis.speak(u);
}
// 预热 TTS 引擎：首次用户手势时触发，消除第一句译文的冷启动延迟
function warmTts() {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  speechSynthesis.speak(u);
}

/* ---------------- 语音识别封装（断线自动重连） ---------------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

class Recognizer {
  constructor(lang, handlers) {
    this.lang = lang;
    this.h = handlers;   // {onInterim,onFinal,onState,onError}
    this.wantRun = false;
    this.rState = 'idle';
    this.rec = null;
  }
  _build() {
    const r = new SR();
    r.lang = this.lang;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;

    r.onresult = e => {
      let interim = '', final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) final += res[0].transcript;
        else interim += res[0].transcript;
      }
      if (interim) this.h.onInterim && this.h.onInterim(interim);
      if (final.trim()) this.h.onFinal && this.h.onFinal(final.trim());
    };
    r.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.wantRun = false;
        this.h.onState && this.h.onState('denied');
      }
      if (e.error === 'network') {
        // 在线识别服务不可达：停止自动重连（会反复报同样的错），交由上层切换离线引擎
        this.netFailed = true;
        this.wantRun = false;
        this.h.onNetwork && this.h.onNetwork();
        return;
      }
      this.h.onError && this.h.onError(e.error);
    };
    r.onend = () => {
      this.rState = 'idle';
      if (this.wantRun) setTimeout(() => this._start(), 130);
      else this.h.onState && this.h.onState('stopped');
    };
    return r;
  }
  _start() {
    if (!this.wantRun || this.rState !== 'idle') return;
    try {
      this.rec = this._build();
      this.rState = 'starting';
      this.rec.start();
      this.rState = 'active';
      this.h.onState && this.h.onState('listening');
    } catch (e) {
      this.rState = 'idle';
      setTimeout(() => this._start(), 260);
    }
  }
  start() {
    if (!SR) throw new Error('UNSUPPORTED');
    this.wantRun = true;
    if (this.rState === 'idle') this._start();
  }
  stop() {
    this.wantRun = false;
    if (this.rec && this.rState !== 'idle') { try { this.rec.stop(); } catch (e) {} }
  }
  applyLang(lang) {
    if (lang === this.lang) return;
    this.lang = lang;
    if (this.wantRun && this.rec) { try { this.rec.stop(); } catch (e) {} }
  }
}

/* ---------------- VAD 灵敏度配置（集中可调） ---------------- */
const VAD_CFG = {
  noiseInit: 0.012,      // 初始底噪估计
  noiseLearnBelow: 2.0,  // level 低于底噪×此倍数时更新底噪
  noiseAdapt: 0.05,      // 底噪学习率（越大越快适应环境）
  threshMult: 2.3,       // 有声判定 = 底噪×此倍数（越小越灵敏）
  threshFloor: 0.018,    // 阈值下限，防止过度敏感导致误触发
  voicedFrames: 2,       // 连续有声帧数确认开口（60fps 下 ≈33ms）
  silentFrames: 12,      // 连续静音帧数判定句尾（60fps 下 ≈200ms）
};
// 可观测：运行时状态挂到 window，便于在控制台 __vad 检查调参效果
const __vad = { level: 0, noise: VAD_CFG.noiseInit, threshold: VAD_CFG.threshFloor, voiced: false };
window.__vad = __vad;

/* ---------------- 麦克风 VU + VAD ---------------- */
let micStream = null, micCtx = null, meterRaf = null;
async function startMeter(onLevel, stream, onVoiced) {
  micStream = stream || await navigator.mediaDevices.getUserMedia({ audio: true });
  micCtx = new (window.AudioContext || window.webkitAudioContext)();
  const an = micCtx.createAnalyser();
  an.fftSize = 512;
  micCtx.createMediaStreamSource(micStream).connect(an);
  const buf = new Uint8Array(an.fftSize);

  // 自适应 VAD：估计环境底噪，超过动态阈值即判为有声
  let noise = VAD_CFG.noiseInit, voicedFrames = 0, silentFrames = 0, voiced = false;
  (function loop() {
    an.getByteTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) { const x = (buf[i] - 128) / 128; s += x * x; }
    const level = Math.min(1, Math.sqrt(s / buf.length) * 4.2);
    onLevel(level);

    if (level < noise * VAD_CFG.noiseLearnBelow) noise = noise * (1 - VAD_CFG.noiseAdapt) + level * VAD_CFG.noiseAdapt;
    const thresh = Math.max(VAD_CFG.threshFloor, noise * VAD_CFG.threshMult);
    if (level > thresh) { voicedFrames++; silentFrames = 0; }
    else { silentFrames++; voicedFrames = 0; }
    if (!voiced && voicedFrames >= VAD_CFG.voicedFrames) { voiced = true; onVoiced && onVoiced(true); }
    else if (voiced && silentFrames >= VAD_CFG.silentFrames) { voiced = false; onVoiced && onVoiced(false); }

    __vad.level = level; __vad.noise = noise; __vad.threshold = thresh; __vad.voiced = voiced;
    meterRaf = requestAnimationFrame(loop);
  })();
}
function stopMeter() {
  cancelAnimationFrame(meterRaf); meterRaf = null;
  document.body.classList.remove('voicing');
  if (micStream) micStream.getTracks().forEach(t => t.stop());
  micStream = null;
  if (micCtx) micCtx.close().catch(() => {});
  micCtx = null;
  $$('#sim-meter i').forEach(b => (b.style.height = '5px'));
}
function driveMeter(level) {
  $$('#sim-meter i').forEach((b, i) => {
    const wobble = 0.45 + 0.55 * Math.abs(Math.sin(i * 1.3 + performance.now() / 140));
    b.style.height = (5 + level * 24 * wobble).toFixed(0) + 'px';
  });
}

/* ---------------- 全局状态 ---------------- */
const state = {
  autoSpeak: true,
  cueNo: 0,
  log: [],
};

/* =========================================================
 * 台词本：镜号卡片
 * ========================================================= */
const sim = {
  rec: null,
  offline: null,
  stream: null,
  switching: false,
  spec: { prefix: '' },
  running: false,
};

// 识别服务可达性：null=未探测，true/false=探测结果
const netInfo = { googleReachable: null };

// interim 字幕用 rAF 合帧：高频识别回调只触发一次绘制，杜绝卡顿
let capLatest = '', capScheduled = false;
function scheduleInterim(t) {
  capLatest = t;
  if (capScheduled) return;
  capScheduled = true;
  requestAnimationFrame(() => {
    capScheduled = false;
    const cap = $('#sim-caption');
    cap.classList.remove('idle');
    cap.textContent = capLatest;
    maybeSpeculate(capLatest);
  });
}

function fillSelects() {
  const opts = LANGS.map(l => `<option value="${l.id}">${l.name}</option>`).join('');
  $('#sim-source').innerHTML = opts;
  $('#sim-target').innerHTML = opts;
  $('#sim-source').value = 'en-US';
  $('#sim-target').value = 'zh-CN';
}

function createCue(text, from, to) {
  const sheet = $('#sim-transcript');
  $('#sim-empty') && $('#sim-empty').remove();

  const no = String(++state.cueNo).padStart(3, '0');
  const date = new Date();
  const el = document.createElement('article');
  el.className = 'cue';
  el.innerHTML = `
    <span class="cue-no">#${no}</span>
    <div class="cue-meta">
      <span class="cue-pair">${byId(from).short} → ${byId(to).short}</span>
      <span class="cue-time">${tcStamp(date)}</span>
    </div>
    <div class="cue-body">
      <p class="cue-orig"></p>
      <p class="cue-trans translating">TRANSLATING 翻译中 …</p>
    </div>`;
  sheet.appendChild(el);
  sheet.scrollTop = sheet.scrollHeight;
  return {
    no, date, el,
    origEl: $('.cue-orig', el),
    transEl: $('.cue-trans', el),
  };
}

async function commitCue(cue) {
  const { text, from, to, transEl } = cue;

  let rendered = false, spokenLen = 0;
  try {
    const t = await translateStream(text, from, to, acc => {
      if (!rendered) { transEl.classList.remove('translating'); rendered = true; }
      transEl.textContent = acc;
      if (acc.length > spokenLen) {
        speak(acc.slice(spokenLen), to, true);
        spokenLen = acc.length;
      }
    });

    transEl.textContent = t;
    const sp = document.createElement('span');
    sp.className = 'speak-one';
    sp.textContent = '↗ 朗读';
    sp.onclick = e => { e.stopPropagation(); speak(t, to); };
    transEl.appendChild(sp);
    if (!rendered) transEl.classList.remove('translating');
    state.log.push({ time: tcStamp(cue.date), from, text, to, translation: t });
  } catch (err) {
    if (rendered) {
      transEl.classList.add('failed');
      toast('部分句子翻译失败，可点“清空”后重试', 'err');
    } else {
      transEl.classList.remove('translating');
      transEl.classList.add('failed');
      transEl.textContent = '× 翻译失败（网络异常），点击此条重试';
      transEl.onclick = async () => {
        transEl.classList.remove('failed');
        transEl.classList.add('translating');
        transEl.textContent = 'TRANSLATING 翻译中 …';
        transEl.onclick = null;
        await commitCue(cue);
      };
    }
  }
}

/* 投机预译：说话过程中，对 interim 中“已完成的句子”在后台预热缓存。
 * 最终提交按相同句子取缓存 → 命中即零等待。仅当出现新的完整句时触发，避免浪费额度。 */
function maybeSpeculate(fullText) {
  const from = $('#sim-source').value, to = $('#sim-target').value;
  if (from === to) return;
  const sents = splitSentences(fullText);
  const complete = /[.!?。！？；;：:\n]\s*$/.test(fullText) ? sents : sents.slice(0, -1);
  const prefix = complete.join('');
  if (prefix.length < 3 || prefix === sim.spec.prefix) return;
  sim.spec.prefix = prefix;
  translateStream(prefix, from, to, null).catch(() => {});
}

function onFinal(text) {
  const from = $('#sim-source').value, to = $('#sim-target').value;
  // Each final result = its own independent cue, translation starts immediately.
  // Recognition is never blocked by translation — they run fully in parallel.
  const cue = { ...createCue(text, from, to), text, from, to };
  cue.origEl.textContent = text;
  // Clear live subtitle for next utterance
  capLatest = '';
  const cap = $('#sim-caption');
  cap.classList.add('idle'); cap.textContent = '';
  // Fire-and-forget: translation runs in background, recognition continues
  commitCue(cue);
}

/* =========================================================
 * 开始 / 停止
 * ========================================================= */
async function simStart() {
  if (!SR) { toast('当前浏览器不支持语音识别，请使用 Chrome / Edge', 'err'); return; }
  const from = $('#sim-source').value, to = $('#sim-target').value;
  if (from === to) { toast('声源语言与目标语言不能相同', 'err'); return; }

  sim.spec.prefix = '';
  capLatest = '';
  warmTts();

  // 1) 在点击手势内优先获取麦克风 —— 决定权限弹窗时机，也给出准确的拒绝原因
  // 源端处理：回声消除 + 噪声抑制 + 自动增益，提升送进识别引擎前的音质
  const micConstraints = {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(micConstraints);
  } catch (e) {
    // 个别设备不支持约束组合，退回最简音频请求
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e2) { e = e2; }
  }
  if (!stream) {
    hideMicBanner();
    if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
      showMicBanner('麦克风权限已被拒绝。恢复方法：点击地址栏左侧「锁形 / 调音」图标 → 网站设置 → 麦克风 → 改为「允许」，然后刷新本页重试。');
      toast('麦克风权限被拒绝，请按页面提示恢复', 'err');
    } else if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') {
      toast('未检测到可用的麦克风设备', 'err');
    } else {
      toast('无法获取麦克风：' + (e.message || e.name), 'err');
    }
    return;
  }

  // 2) 麦克风电平（先于引擎，保证 VAD/VU 立刻工作）
  try { await startMeter(driveMeter, stream, on => document.body.classList.toggle('voicing', on)); }
  catch (e) { stream.getTracks().forEach(t => t.stop()); toast('电平监听异常：' + e.message, 'err'); return; }
  hideMicBanner();
  sim.stream = stream;
  sim.running = true;
  document.body.classList.add('listening');

  // 3) 选择识别引擎：在线服务不可达（探测失败 / 已报 network）→ Vosk 本地离线引擎
  const offlineOK = !!window.OFFLINE_MODELS && OFFLINE_MODELS[from];
  const useOffline = (!SR || netInfo.googleReachable === false) && offlineOK;
  try {
    if (useOffline) await startOfflineEngine(from, stream);
    else {
      if (!SR) throw new Error('浏览器不支持在线识别，且该语言未安装离线模型');
      await startOnlineEngine(from, stream);
    }
  } catch (e) {
    await simStop();
    toast(e.message, 'err');
  }
}

/* ---------------- 引擎状态显示 ---------------- */
function setEngineStatus(text, live = true) {
  const st = $('#sim-status');
  st.classList.toggle('live', live);
  st.classList.remove('error');
  $('.oa-txt', st).textContent = text;
}

/* ---------------- 在线引擎（Web Speech） ---------------- */
function startOnlineEngine(from, stream) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    setEngineStatus('CONNECTING · 连接识别服务');

    const rec = new Recognizer(from, {
      onInterim: scheduleInterim,
      onFinal,
      onState: s => {
        if (s === 'listening') { setEngineStatus('ON AIR · 在线引擎'); done(resolve); }
        else if (s === 'denied') done(reject, new Error('麦克风权限被拒绝，请在地址栏允许'));
      },
      onNetwork: () => handleNetworkFallback(from, stream),
      onError: code => {
        if (code === 'audio-capture') toast('未检测到麦克风设备', 'err');
      },
    });
    sim.rec = rec;
    sim.offline = null;
    rec.start();

    // 超时保护：迟迟未进入 listening（且没有 network 事件）
    setTimeout(() => done(reject, new Error('在线识别服务连接超时，将在下次尝试离线引擎')), 9000);
  });
}

/* ---------------- 离线引擎（Vosk WASM，本地推理） ---------------- */
async function startOfflineEngine(from, stream) {
  setEngineStatus('LOADING · 加载离线模型 0%');
  const eng = new OfflineStt({
    onInterim: scheduleInterim,
    onFinal,
    onProgress: p => setEngineStatus(`LOADING · 加载离线模型 ${p}%`),
    onReady: () => setEngineStatus('ON AIR · 本地离线引擎'),
  });
  sim.offline = eng;
  sim.rec = null;
  await eng.start(from, stream);
}

/* ---------------- network 错误 → 无缝切换离线引擎 ---------------- */
async function handleNetworkFallback(from, stream) {
  if (sim.switching) return;
  sim.switching = true;
  if (sim.rec) { sim.rec.stop(); sim.rec = null; }

  if (!window.OFFLINE_MODELS || !OFFLINE_MODELS[from]) {
    sim.switching = false;
    toast('在线识别服务不可达；该语言未安装离线模型（离线引擎目前支持中、英）', 'err');
    await simStop();
    return;
  }
  toast('在线识别服务不可达，已切换本地离线引擎');
  try { await startOfflineEngine(from, stream); }
  catch (e) { toast('离线引擎启动失败：' + e.message, 'err'); await simStop(); }
  sim.switching = false;
}

/* ---------------- 引擎切换声源语言 ---------------- */
async function engineApplyLang(lang) {
  if (sim.offline && sim.running) {
    if (!window.OFFLINE_MODELS || !OFFLINE_MODELS[lang]) { toast('本地离线引擎仅支持中文、英语', 'err'); return false; }
    setEngineStatus('LOADING · 切换离线模型 …');
    await sim.offline.applyLang(lang, sim.stream, true);
    setEngineStatus('ON AIR · 本地离线引擎');
    return true;
  }
  if (sim.rec) sim.rec.applyLang(lang);
  return true;
}

async function simStop() {
  if (sim.rec) sim.rec.stop();
  if (sim.offline) sim.offline.stop();
  sim.rec = null;
  sim.offline = null;
  stopMeter();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  sim.running = false;
  document.body.classList.remove('listening');
  const cap = $('#sim-caption');
  cap.classList.add('idle'); cap.textContent = '';
  const st = $('#sim-status');
  st.classList.remove('live');
  $('.oa-txt', st).textContent = 'STANDBY · 待机';
}

/* =========================================================
 * 记录操作
 * ========================================================= */
function clearAll() {
  if (sim.running) { toast('请先停止同传再清空', 'err'); return; }
  $('#sim-transcript').innerHTML = `
    <div class="empty-tip" id="sim-empty">
      <p class="et-mark">CUE&nbsp;SHEET</p>
      <p class="et-line">选择 CH-A 声源与 CH-B 目标语言，按下红色 <b>REC</b> 键开始同传。</p>
      <p class="et-sub">语音实时转写为下横条字幕，句间停顿即自动翻译，并按镜号编号归档。</p>
    </div>`;
  const cap = $('#sim-caption');
  cap.classList.add('idle'); cap.textContent = '';
  state.log = [];
  toast('台词本已清空');
}

function exportLog() {
  if (!state.log.length) { toast('暂无可导出的翻译记录', 'err'); return; }
  const lines = ['# 字幕台 · THE CAPTION DESK — 同声传译记录', '# 导出时间：' + new Date().toLocaleString(), ''];
  state.log.forEach((r, i) => {
    lines.push(`#${String(i + 1).padStart(3, '0')}  [${r.time}]  ${byId(r.from).short} → ${byId(r.to).short}`);
    lines.push(`原文：${r.text}`);
    lines.push(`译文：${r.translation}`);
    lines.push('');
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `字幕台-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('台词本已导出');
}

/* ---------------- 麦克风权限指引 ---------------- */
function showMicBanner(msg) {
  const b = $('#mic-banner');
  b.textContent = msg;
  b.classList.remove('hidden');
}
function hideMicBanner() {
  $('#mic-banner').classList.add('hidden');
}
async function checkMicPermission() {
  if (!navigator.permissions || !navigator.permissions.query) return;
  try {
    const p = await navigator.permissions.query({ name: 'microphone' });
    if (p.state === 'denied') {
      showMicBanner('当前站点的麦克风处于「禁止」状态。点击地址栏左侧「锁形 / 调音」图标 → 网站设置 → 麦克风 → 改为「允许」，然后刷新页面。');
    }
    p.onchange = () => { if (p.state === 'granted') hideMicBanner(); };
  } catch (e) { /* 部分浏览器不支持 microphone 权限描述符，忽略 */ }
}

/* =========================================================
 * 时间码（25fps 演播时钟）
 * ========================================================= */
function startTimecode() {
  const el = $('#timecode');
  (function tick() {
    el.textContent = tcStamp(new Date());
    setTimeout(tick, 25);
  })();
}

/* =========================================================
 * 事件绑定
 * ========================================================= */
function bind() {
  $('#btn-speak').addEventListener('click', () => {
    state.autoSpeak = !state.autoSpeak;
    $('#btn-speak').setAttribute('aria-pressed', String(state.autoSpeak));
    $('#btn-speak').textContent = state.autoSpeak ? '播报 · ON' : '播报 · OFF';
    toast(state.autoSpeak ? '译文自动播报已开启' : '译文自动播报已关闭');
    if (!state.autoSpeak && 'speechSynthesis' in window) speechSynthesis.cancel();
  });

  $('#btn-export').addEventListener('click', exportLog);
  $('#btn-clear').addEventListener('click', clearAll);
  $('#btn-fullscreen').addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => toast('无法进入全屏', 'err'));
    else document.exitFullscreen();
  });

  $('#sim-mic').addEventListener('click', () => (sim.running ? simStop() : simStart()));

  $('#sim-swap').addEventListener('click', async () => {
    const a = $('#sim-source'), b = $('#sim-target');
    [a.value, b.value] = [b.value, a.value];
    await engineApplyLang(a.value);
  });

  $('#sim-source').addEventListener('change', async () => {
    await engineApplyLang($('#sim-source').value);
  });

  $('#sim-textform').addEventListener('submit', async e => {
    e.preventDefault();
    const input = $('#sim-text');
    const text = input.value.trim();
    if (!text) return;
    const from = $('#sim-source').value, to = $('#sim-target').value;
    if (from === to) { toast('声源语言与目标语言不能相同', 'err'); return; }
    input.value = '';
    const cue = { ...createCue(text, from, to), text, from, to };
    cue.origEl.textContent = text;
    commitCue(cue);
  });
}

/* ---------------- 识别服务网络探测（no-cors，可达即 resolve） ---------------- */
function probeRecognizerService() {
  if (location.protocol === 'file:') return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4500);
  fetch('https://www.google.com/generate_204', { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
    .then(() => { netInfo.googleReachable = true; })
    .catch(() => { netInfo.googleReachable = false; })
    .finally(() => clearTimeout(timer));
}

/* ---------------- 启动 ---------------- */
function init() {
  fillSelects();
  bind();
  startTimecode();
  checkMicPermission();
  warmTranslation();
  probeRecognizerService();
  if (typeof loadVosk === 'function') loadVosk(); // 后台加载离线引擎库，不阻塞页面
  if (!SR) $('#unsupported').classList.remove('hidden');
}
init();
