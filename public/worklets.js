// Audio worklets: they run on the browser's audio thread, so capture and playback are
// not delayed by work on the page.

/**
 * Microphone capture: downsamples to 16 kHz (averaging each output step, which also
 * filters out frequencies the lower rate cannot carry) and posts 20 ms Int16 frames.
 */
class MicCapture extends AudioWorkletProcessor {
  constructor({ processorOptions: { targetRate = 16000, frameSamples = 320 } = {} } = {}) {
    super();
    this.ratio = sampleRate / targetRate;
    this.frameSamples = frameSamples;
    this.frame = new Int16Array(frameSamples);
    this.filled = 0;
    this.sum = 0;
    this.count = 0;
    this.position = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.sum += channel[i];
      this.count++;
      this.position += 1;
      if (this.position < this.ratio) continue;
      this.position -= this.ratio;
      const value = this.sum / this.count;
      this.sum = 0;
      this.count = 0;
      this.frame[this.filled++] = Math.max(-32768, Math.min(32767, Math.round(value * 32768)));
      if (this.filled === this.frameSamples) {
        // Transferring detaches the buffer (its length becomes 0), so size the next
        // frame from the stored setting, not from this.frame.
        this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
        this.frame = new Int16Array(this.frameSamples);
        this.filled = 0;
      }
    }
    return true;
  }
}

/**
 * Reply playback: plays pieces in the order they arrive, resampling each from its own
 * rate, and reports progress (in the piece's samples) about every 80 ms and when a piece
 * ends. "clear" stops at once, reports how far the current piece got, and drops the rest.
 */
class Player extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.blocks = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === "audio") {
        this.queue.push({ ...data, position: 0, step: data.sampleRate / sampleRate });
      } else if (data.type === "clear") {
        if (this.current) this.report(this.current, false);
        this.queue = [];
        this.current = null;
      }
    };
  }

  report(piece, done) {
    const samples = done ? piece.samples.length : Math.min(piece.samples.length, Math.floor(piece.position));
    this.port.postMessage({ turn: piece.turn, index: piece.index, samples, done });
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      if (!this.current) {
        this.current = this.queue.shift() ?? null;
        if (!this.current) {
          out.fill(0, i);
          break;
        }
      }
      const piece = this.current;
      const k = Math.floor(piece.position);
      const fraction = piece.position - k;
      const a = piece.samples[k] ?? 0;
      const b = piece.samples[k + 1] ?? a;
      out[i] = a + (b - a) * fraction;
      piece.position += piece.step;
      if (piece.position >= piece.samples.length) {
        this.report(piece, true);
        this.current = null;
      }
    }
    if (this.current && ++this.blocks % 30 === 0) this.report(this.current, false);
    return true;
  }
}

registerProcessor("mic-capture", MicCapture);
registerProcessor("player", Player);
