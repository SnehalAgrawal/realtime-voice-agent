// Audio format conversions. Inside the pipeline audio is mono 16-bit PCM (Int16Array);
// speech models want Float32 samples in [-1, 1]; phone calls carry 8 kHz mu-law.

export function int16ToFloat32(samples) {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32768;
  return out;
}

/** The inverse of int16ToFloat32 (the same 32768 scale both ways), clamped to 16 bits. */
export function float32ToInt16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768)));
  }
  return out;
}

/**
 * Linear-interpolation resampler. Good enough for speech between 8, 16, and 24 kHz;
 * downsampling first averages over each output step to limit aliasing.
 */
export function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const length = Math.floor(samples.length / ratio);
  const Out = samples instanceof Int16Array ? Int16Array : Float32Array;
  const out = new Out(length);
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    let value;
    if (ratio > 1) {
      const start = Math.floor(position);
      const end = Math.min(samples.length, Math.floor(position + ratio));
      let sum = 0;
      for (let j = start; j < end; j++) sum += samples[j];
      value = sum / Math.max(1, end - start);
    } else {
      const left = Math.floor(position);
      const right = Math.min(left + 1, samples.length - 1);
      const fraction = position - left;
      value = samples[left] * (1 - fraction) + samples[right] * fraction;
    }
    out[i] = Out === Int16Array ? Math.round(value) : value;
  }
  return out;
}

/** Converts an Audio object ({ samples: Int16Array, sampleRate }) to another rate. */
export function toRate(audio, sampleRate) {
  return { samples: resample(audio.samples, audio.sampleRate, sampleRate), sampleRate };
}

export function durationMs(audio) {
  return (audio.samples.length / audio.sampleRate) * 1000;
}

// G.711 mu-law, as used by telephone networks and Plivo's audio/x-mulaw.
const BIAS = 0x84;
const CLIP = 32635;

export function encodeMuLaw(samples) {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    const sign = s < 0 ? 0x80 : 0;
    if (sign) s = -s;
    if (s > CLIP) s = CLIP;
    s += BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
    const mantissa = (s >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

export function decodeMuLaw(bytes) {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const u = ~bytes[i] & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
    out[i] = sign ? -magnitude : magnitude;
  }
  return out;
}

/** A 16-bit mono WAV file as a Buffer. */
export function encodeWav({ samples, sampleRate }) {
  const header = Buffer.alloc(44);
  const dataBytes = samples.length * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, dataBytes)]);
}

/** Reads a 16-bit PCM mono WAV file (the format encodeWav writes). */
export function decodeWav(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file");
  }
  let offset = 12;
  let format;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!format || format.audioFormat !== 1 || format.channels !== 1 || format.bitsPerSample !== 16) {
        throw new Error("Only 16-bit PCM mono WAV files are supported");
      }
      const bytes = buffer.subarray(body, body + size);
      const samples = new Int16Array(bytes.length / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2);
      return { samples, sampleRate: format.sampleRate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV file has no data chunk");
}
