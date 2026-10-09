# 聆川 · Lingchuan

> 语音如川流，聆听无国界。

**聆川**是一款纯前端实时同声传译网页应用：语音实时转写为字幕，句间停顿即自动翻译，支持 12 种语言互译、译文语音播报与记录导出。无需安装、无需后端服务器，打开浏览器即可使用。

🔗 **在线体验**：<https://repo-bo.github.io/simultaneous-interpretation/>

![tech](https://img.shields.io/badge/stack-pure%20frontend-0E86A3) ![offline](https://img.shields.io/badge/offline-Vosk%20WASM-0A5C7D) ![languages](https://img.shields.io/badge/languages-12-2AB9D4)

---

## 功能特性

- **实时同声传译**：边说边出字幕，识别与翻译完全并行，翻译不阻塞语音识别
- **12 种语言互译**：中文、英语、日语、韩语、俄语、法语、德语、西班牙语、葡萄牙语、意大利语、印尼语、印地语
- **三级翻译引擎，自动降级**
  1. **Gemini 大模型**（可选配置 API Key）——结合上下文翻译，术语与表达更连贯
  2. **MyMemory** / **Google gtx** 免费引擎——无 Key 或大模型失败时自动兜底
- **在线 / 离线双语音引擎**
  - 在线：Web Speech API（Chrome / Edge）
  - 离线：Vosk WASM 本地推理，网络不通时自动切换，内置中文、英文模型
- **译文自动播报**：基于 SpeechSynthesis 的 TTS 朗读
- **同传记录**：逐句卡片归档（镜号、语种对、时间码），支持一键导出 `.txt`
- **VAD 语音活动检测**：开口瞬间 UI 即时反馈，自适应环境噪声
- **隐私安全**：API Key 仅存于浏览器 localStorage，不经过任何第三方服务器

## 技术栈

| 层 | 技术 |
|---|---|
| 语音识别（在线） | Web Speech API (`SpeechRecognition`) |
| 语音识别（离线） | [Vosk](https://alphacephei.com/vosk/) WASM（vosk-browser） |
| 翻译 | Gemini REST API · MyMemory API · Google Translate (gtx) |
| 语音合成 | Web Speech API (`SpeechSynthesis`) |
| 音频处理 | AudioWorklet（PCM 采集）+ 自研 VAD |
| 前端 | 原生 HTML / CSS / JavaScript，零构建、零运行时依赖 |

## 目录结构

```
.
├── index.html           # 页面结构
├── style.css            # 聆川设计系统（品牌色/组件/响应式）
├── app.js               # 主程序：识别、翻译、TTS、VAD、UI 编排
├── offline-engine.js    # Vosk 离线引擎封装、模型加载与合并
├── assets/              # 品牌图标（SVG + 16/32/48/128/256 PNG）
├── lib/
│   ├── vosk.js          # Vosk WASM 运行库
│   └── pcm-worklet.js   # AudioWorklet PCM 处理模块
└── models/              # 离线语音模型
    ├── en.tar.gz        # 英语模型（约 41MB）
    ├── cn.part1.bin     # 中文模型分片 1（约 22MB）
    └── cn.part2.bin     # 中文模型分片 2（约 22MB，加载时合并）
```

## 快速开始

本项目为纯静态站点，无需安装依赖。

```bash
# 任选一种静态服务器（不能直接 file:// 打开，浏览器会限制麦克风与 Worker）
python3 -m http.server 8765
# 或
npx serve .
```

然后访问 <http://127.0.0.1:8765>。

## 使用说明

1. 用 **Chrome / Edge** 打开页面，允许麦克风权限
2. 选择 **声源语言** 与 **目标语言**（点 ⇄ 可快速交换）
3. 按下红色 **REC** 键开始讲话，字幕实时显示在下方横条
4. 翻译结果逐句归档到记录区，可点「↗ 朗读」单句播报
5. 控制台可切换：播报开关、导出记录、清空、全屏、设置

### 配置 Gemini（可选，翻译质量更佳）

1. 到 <https://aistudio.google.com/app/apikey> 免费创建 API Key
2. 点击页面「**设置**」→ 粘贴 Key → 保存
3. 设置按钮旁出现指示点即已启用；可先点「测试连接」确认
4. 网络受限时，可在设置中填写可用的 API 反代地址

## 浏览器支持

| 浏览器 | 在线识别 | 离线识别 | 文字翻译 |
|---|---|---|---|
| Chrome / Edge（推荐） | ✅ | ✅ | ✅ |
| Safari / Firefox | ❌ | ✅ | ✅ |
| 移动端 Chrome | ✅ | — | ✅ |

> 离线模型较大（中/英约 40MB），首次加载需要一些时间，之后由浏览器 Cache 缓存。

## 隐私说明

- 应用不包含后端服务，除调用各翻译 / 识别服务的公开接口外，不上传任何用户数据
- Gemini API Key 仅保存在本地浏览器 `localStorage`，可随时在设置中清除
- 离线识别全程在浏览器本地完成，音频不离开设备

## 许可

MIT License
