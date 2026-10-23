/*
 * AudioWorklet: converts microphone audio to 16 kHz mono 16-bit little-endian PCM
 * (the input format required by the Gemini Live API) and posts ~100 ms chunks.
 * Also reports a smoothed input level for the microphone meter.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = (options && options.processorOptions && options.processorOptions.targetRate) || 16000;
    this.ratio = sampleRate / this.targetRate;
    this.chunkSamples = Math.round(this.targetRate * 0.1);
    this.buffer = new Int16Array(this.chunkSamples);
    this.filled = 0;
    this.position = 0; // fractional read position for resampling
    this.level = 0;
    this.levelCounter = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    let sum = 0;
    for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
    this.level = 0.8 * this.level + 0.2 * Math.sqrt(sum / channel.length);
    if (++this.levelCounter % 8 === 0) this.port.postMessage({ type: "level", value: this.level });

    // Linear-interpolation resampling from the context rate to 16 kHz.
    while (this.position < channel.length - 1) {
      const i = Math.floor(this.position);
      const frac = this.position - i;
      const sample = channel[i] * (1 - frac) + channel[i + 1] * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.buffer[this.filled++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      if (this.filled === this.chunkSamples) {
        this.port.postMessage({ type: "pcm", buffer: this.buffer.buffer }, [this.buffer.buffer]);
        this.buffer = new Int16Array(this.chunkSamples);
        this.filled = 0;
      }
      this.position += this.ratio;
    }
    this.position -= channel.length;
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
