// 16kHz PCM 直通 AudioWorklet：把麦克风声道切片交给主线程送入 Vosk
class PCMPassProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length) {
      this.port.postMessage(input[0].slice(0), []);
    }
    return true;
  }
}
registerProcessor('pcm-pass', PCMPassProcessor);
