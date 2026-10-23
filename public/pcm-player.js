// Reproduce PCM f32 estereo entrelazado que llega por el puerto (audio de
// internet de los eventos). Espera a tener colchon antes de sonar y vuelve a
// esperar si se vacia (corte de red). Informa de cuanto ha consumido para que
// el hilo principal no envie mas de la cuenta.
class PcmPlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.cap = o.capacity || sampleRate * 2 * 30;
    this.pre = o.prebuffer || sampleRate * 2;
    this.buf = new Float32Array(this.cap);
    this.r = 0;
    this.w = 0;
    this.fill = 0;
    this.playing = false;
    this.consumed = 0;
    this.lastReport = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d instanceof Float32Array) {
        for (let i = 0; i < d.length; i++) {
          if (this.fill >= this.cap) break; // lleno: se descarta (no deberia pasar)
          this.buf[this.w] = d[i];
          this.w = (this.w + 1) % this.cap;
          this.fill++;
        }
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || out[0];
    const n = L.length;
    if (!this.playing && this.fill >= this.pre) this.playing = true;
    if (this.playing) {
      for (let i = 0; i < n; i++) {
        if (this.fill < 2) {
          this.playing = false;
          for (let j = i; j < n; j++) {
            L[j] = 0;
            R[j] = 0;
          }
          break;
        }
        L[i] = this.buf[this.r];
        this.r = (this.r + 1) % this.cap;
        R[i] = this.buf[this.r];
        this.r = (this.r + 1) % this.cap;
        this.fill -= 2;
        this.consumed += 2;
      }
    }
    if (currentTime - this.lastReport > 0.1) {
      this.lastReport = currentTime;
      this.port.postMessage({ consumed: this.consumed, fill: this.fill, playing: this.playing });
    }
    return true;
  }
}

registerProcessor("pcm-player", PcmPlayerProcessor);
