"use client";

/** Base64 helpers that avoid call-stack limits on large buffers. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function parseSampleRate(mimeType: string | undefined, fallback = 24000): number {
  const match = /rate=(\d+)/.exec(mimeType ?? "");
  return match ? Number(match[1]) : fallback;
}

const loadedContexts = new WeakSet<AudioContext>();

/** Preload the PCM capture worklet module into an AudioContext once. */
export async function preloadAudioWorklet(ctx: AudioContext): Promise<void> {
  if (loadedContexts.has(ctx)) return;
  try {
    await ctx.audioWorklet.addModule("/worklets/pcm-capture.js");
    loadedContexts.add(ctx);
  } catch {
    if (ctx.audioWorklet) loadedContexts.add(ctx);
  }
}

/**
 * Captures the microphone as 16 kHz PCM via an AudioWorklet.
 * `muted` stops sending audio without releasing the device (used for typed answers).
 */
export class MicCapture {
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  muted = false;

  constructor(
    private readonly ctx: AudioContext,
    private readonly stream: MediaStream,
    private readonly onChunk: (base64Pcm: string) => void,
    private readonly onLevel?: (level: number) => void,
  ) {}

  async start(): Promise<void> {
    await preloadAudioWorklet(this.ctx);
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "pcm-capture", { processorOptions: { targetRate: 16000 } });
    this.node.port.onmessage = (e: MessageEvent<{ type: string; buffer?: ArrayBuffer; value?: number }>) => {
      if (e.data.type === "level") {
        this.onLevel?.(this.muted ? 0 : (e.data.value ?? 0));
        return;
      }
      if (e.data.type === "pcm" && e.data.buffer && !this.muted) {
        this.onChunk(bytesToBase64(new Uint8Array(e.data.buffer)));
      }
    };
    this.source.connect(this.node);
    // The worklet must be pulled by the graph; route it to a silent sink.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    this.node.connect(sink).connect(this.ctx.destination);
  }

  stop(): void {
    try {
      this.source?.disconnect();
      this.node?.disconnect();
      this.node?.port.close();
    } catch {
      /* already disconnected */
    }
    this.node = null;
    this.source = null;
  }
}

/**
 * Gapless playback of 16-bit PCM chunks from the interviewer, with instant
 * interruption (when the candidate starts talking) and a tap that the
 * recorder mixes into the recording.
 */
export class PcmPlayer {
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  readonly output: GainNode;
  readonly recordTap: MediaStreamAudioDestinationNode;
  private speakingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ctx: AudioContext,
    private readonly onSpeaking?: (speaking: boolean) => void,
  ) {
    this.output = ctx.createGain();
    this.output.connect(ctx.destination);
    this.recordTap = ctx.createMediaStreamDestination();
    this.output.connect(this.recordTap);
  }

  enqueue(base64: string, sampleRate: number): void {
    const bytes = base64ToBytes(base64);
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    if (samples.length === 0) return;
    const buffer = this.ctx.createBuffer(1, samples.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = (samples[i] ?? 0) / 0x8000;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output);
    const isFirst = this.nextTime <= this.ctx.currentTime;
    const startAt = isFirst ? this.ctx.currentTime : Math.max(this.ctx.currentTime + 0.03, this.nextTime);
    source.start(startAt);
    this.nextTime = startAt + buffer.duration;
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
    this.onSpeaking?.(true);
    if (this.speakingTimer) clearTimeout(this.speakingTimer);
    this.speakingTimer = setTimeout(
      () => this.onSpeaking?.(false),
      Math.max(0, (this.nextTime - this.ctx.currentTime) * 1000) + 150,
    );
  }

  /** Stop everything queued (barge-in or interrupted turn). */
  clear(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* not started */
      }
    }
    this.sources.clear();
    this.nextTime = this.ctx.currentTime;
    if (this.speakingTimer) clearTimeout(this.speakingTimer);
    this.onSpeaking?.(false);
  }

  get isPlaying(): boolean {
    return this.nextTime > this.ctx.currentTime + 0.05;
  }
}
