// The browser client: microphone → server, server audio → speakers, and a live view of
// each turn with its latency. Every message is also kept in window.voiceLog, which the
// automated browser check reads.

const $ = (selector) => document.querySelector(selector);
const startButton = $("#start");
const statusLine = $("#status");
const providersLine = $("#providers");
const turnsList = $("#turns");

window.voiceLog = [];
/** Microphone frames sent and their peak level (0 to 1), for the automated check. */
window.voiceStats = { micFrames: 0, micPeak: 0 };
let connection = null;

startButton.addEventListener("click", () => (connection ? stop() : start()));

async function start() {
  startButton.disabled = true;
  setStatus("Starting…");
  try {
    connection = await connect();
    startButton.textContent = "End conversation";
    setStatus("Listening");
  } catch (error) {
    setStatus(error.name === "NotAllowedError" ? "Microphone access was blocked." : `Could not start: ${error.message}`);
    await stop();
  } finally {
    startButton.disabled = false;
  }
}

async function connect() {
  // Created on a click, so the browser allows audio to play.
  const context = new AudioContext({ latencyHint: "interactive" });
  await context.audioWorklet.addModule("worklets.js");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const mic = new AudioWorkletNode(context, "mic-capture", {
    numberOfOutputs: 0,
    processorOptions: { targetRate: 16000, frameSamples: 320 },
  });
  context.createMediaStreamSource(stream).connect(mic);
  const player = new AudioWorkletNode(context, "player", { outputChannelCount: [1] });
  player.connect(context.destination);

  const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/browser`);
  socket.binaryType = "arraybuffer";
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("the server is not reachable"));
  });
  socket.onclose = (event) => {
    if (connection?.socket === socket) {
      setStatus(event.reason || "Disconnected.");
      stop();
    }
  };
  socket.onmessage = ({ data }) => {
    if (data instanceof ArrayBuffer) return playAudio(player, data);
    const message = JSON.parse(data);
    window.voiceLog.push({ at: performance.now(), ...message });
    if (message.type === "clear") player.port.postMessage({ type: "clear" });
    render(message);
  };
  mic.port.onmessage = ({ data }) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(data);
    const frame = new Int16Array(data);
    window.voiceStats.micFrames++;
    for (const v of frame) window.voiceStats.micPeak = Math.max(window.voiceStats.micPeak, Math.abs(v) / 32768);
  };
  player.port.onmessage = ({ data }) => {
    window.voiceLog.push({ at: performance.now(), type: "played", ...data });
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "played", ...data }));
  };
  socket.send(JSON.stringify({ type: "start" }));
  return { context, stream, socket };
}

async function stop() {
  const current = connection;
  connection = null;
  startButton.textContent = "Start conversation";
  if (!current) return;
  current.socket.close();
  current.stream.getTracks().forEach((track) => track.stop());
  await current.context.close();
  if (statusLine.textContent === "Listening") setStatus("Conversation ended.");
}

/** A reply piece: 12-byte header (turn, index, sample rate), then 16-bit samples. */
function playAudio(player, buffer) {
  const header = new DataView(buffer, 0, 12);
  const turn = header.getUint32(0, true);
  const index = header.getUint32(4, true);
  const sampleRate = header.getUint32(8, true);
  const pcm = new Int16Array(buffer, 12);
  const samples = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
  window.voiceLog.push({ at: performance.now(), type: "audio", turn, index, sampleRate, samples: samples.length });
  player.port.postMessage({ type: "audio", turn, index, sampleRate, samples }, [samples.buffer]);
}

// --- Rendering ---------------------------------------------------------------

const turns = new Map();

function turnView(id) {
  if (!turns.has(id)) {
    const item = document.createElement("li");
    item.className = "turn";
    item.innerHTML = `<p class="you" hidden></p><p class="assistant"></p><div class="latency" hidden></div>`;
    turnsList.prepend(item);
    turns.set(id, { item, pieces: [] });
  }
  return turns.get(id);
}

function render(message) {
  switch (message.type) {
    case "ready": {
      const { providers, settings } = message;
      providersLine.textContent = `LLM ${providers.llm} · speech-to-text ${providers.stt} · voice ${providers.tts} · ends a turn after ${settings.silenceMs} ms of silence${settings.bargeIn ? " · you can interrupt" : ""}`;
      break;
    }
    case "speech_start":
      setStatus("Hearing you…");
      break;
    case "transcript": {
      const view = turnView(message.turn);
      const you = view.item.querySelector(".you");
      you.hidden = false;
      you.textContent = message.text || "(nothing recognised)";
      setStatus("Thinking…");
      break;
    }
    case "reply_piece": {
      const view = turnView(message.turn);
      view.pieces[message.index] = message.text;
      view.item.querySelector(".assistant").textContent = view.pieces.filter(Boolean).join(" ");
      setStatus("Speaking");
      break;
    }
    case "interrupted": {
      const view = turnView(message.turn);
      const assistant = view.item.querySelector(".assistant");
      assistant.classList.add("cut");
      assistant.textContent = message.heard ? `${message.heard} …` : "…";
      assistant.title = "Interrupted: only the part you heard is kept in the conversation.";
      setStatus("Hearing you…");
      break;
    }
    case "turn_end":
      if (message.endpoint && message.fromSpeechEnd.first_audio_sent !== undefined) {
        showLatency(turnView(message.turn), message);
      }
      if (connection) setStatus("Listening");
      break;
    case "ignored":
      setStatus("Still speaking: interrupting is turned off.");
      break;
    case "stage_error":
      setStatus(`Error (${message.stage}): ${message.message}`);
      break;
  }
}

const STAGES = [
  ["silence", "waiting for silence", (t, e) => e.silenceWaitMs],
  ["stt", "speech-to-text", (t) => t.stt_final],
  ["llm", "first token", (t) => t.llm_first_token - t.stt_final],
  ["chunk", "first sentence", (t) => t.first_chunk - t.llm_first_token],
  ["tts", "voice", (t) => t.first_audio_sent - t.first_chunk],
];

function showLatency(view, { fromSpeechEnd: t, endpoint: e }) {
  const parts = STAGES.map(([key, label, value]) => ({ key, label, ms: Math.max(0, Math.round(value(t, e))) }));
  const total = parts.reduce((sum, p) => sum + p.ms, 0);
  const box = view.item.querySelector(".latency");
  box.hidden = false;
  box.innerHTML = `
    <p><strong>${total.toLocaleString()} ms</strong> from the end of your speech to the first reply audio</p>
    <div class="bar" role="img" aria-label="Latency by stage">${parts
      .map((p) => `<span class="seg ${p.key}" style="flex-grow:${p.ms}" title="${p.label}: ${p.ms} ms"></span>`)
      .join("")}</div>
    <p class="legend">${parts.map((p) => `<span><i class="${p.key}"></i>${p.label} ${p.ms.toLocaleString()} ms</span>`).join("")}</p>`;
}

function setStatus(text) {
  statusLine.textContent = text;
}
