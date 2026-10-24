class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.frames = o.frames || 4096;
    this.buffer = new Float32Array(this.frames * 2);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const left = input[0];
    const right = input[1] ?? input[0];
    if (!left) return true;
    for (let i = 0; i < left.length; i++) {
      this.buffer[this.offset++] = left[i] ?? 0;
      this.buffer[this.offset++] = right[i] ?? 0;
      if (this.offset >= this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(this.frames * 2);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
