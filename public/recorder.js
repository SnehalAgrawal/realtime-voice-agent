// Records a conversation for a demo: your microphone and the assistant's voice, mixed into
// one audio track inside the page (so it works with headphones, where a screen recorder
// would only hear the microphone), plus this tab's video if you allow screen sharing.
//
// The file downloads when the recording stops. MP4 is preferred (QuickTime and GitHub play
// it); browsers that cannot record MP4 (Firefox) save WebM.

const VIDEO_TYPES = ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
const AUDIO_TYPES = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/webm"];

/**
 * @param {object} parts
 * @param {AudioContext} parts.context
 * @param {MediaStream} parts.microphone
 * @param {AudioNode} parts.assistant  the node that plays the assistant's audio
 */
export function createRecordingMix({ context, microphone, assistant }) {
  const mix = context.createMediaStreamDestination();
  context.createMediaStreamSource(microphone).connect(mix);
  assistant.connect(mix);
  return mix.stream;
}

/**
 * Starts recording. Asks to share this tab first; if that is declined or not supported,
 * records audio only.
 * @param {MediaStream} audio  from createRecordingMix
 * @param {{ onStop?: (result: { blob: Blob, video: boolean }) => void }} [options]
 */
export async function startRecording(audio, { onStop = () => {} } = {}) {
  let screen = null;
  try {
    screen = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser", frameRate: 30 },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: "include",
    });
  } catch {
    // Declined, or no screen capture in this browser: audio only.
  }
  const tracks = [...(screen?.getVideoTracks() ?? []), ...audio.getAudioTracks()];
  const mimeType = (screen ? VIDEO_TYPES : AUDIO_TYPES).find((type) => MediaRecorder.isTypeSupported(type));
  const recorder = new MediaRecorder(new MediaStream(tracks), mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.ondataavailable = ({ data }) => {
    if (data.size) chunks.push(data);
  };
  const stopped = new Promise((resolve) => {
    recorder.onstop = () => {
      screen?.getTracks().forEach((track) => track.stop());
      const result = { blob: new Blob(chunks, { type: recorder.mimeType }), video: Boolean(screen) };
      onStop(result);
      resolve(result);
    };
  });
  // Stopping the share from the browser's own bar also ends the recording.
  screen?.getVideoTracks()[0]?.addEventListener("ended", () => {
    if (recorder.state !== "inactive") recorder.stop();
  });
  recorder.start(1000);
  return {
    video: Boolean(screen),
    stop: () => {
      if (recorder.state !== "inactive") recorder.stop();
      return stopped;
    },
  };
}

/** Saves a recording with a timestamped name. */
export function download(blob) {
  const extension = blob.type.startsWith("audio/mp4") ? "m4a" : blob.type.includes("mp4") ? "mp4" : "webm";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: `voice-agent-${stamp}.${extension}` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
