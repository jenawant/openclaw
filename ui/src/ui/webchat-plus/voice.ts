export type VoiceRecorderSession = {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: BlobPart[];
  startedAt: number;
  mimeType: string;
};

export type VoiceTranscribeAudioInput = {
  content: string;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
  durationMs: number;
};

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function canUseVoiceRecording(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

function resolveRecorderMimeType(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "audio/webm";
  }
  for (const mime of [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ]) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return "audio/webm";
}

export async function startVoiceRecorder(): Promise<VoiceRecorderSession> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = resolveRecorderMimeType();
  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(stream, { mimeType });
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  });
  recorder.start();
  return {
    recorder,
    stream,
    chunks,
    startedAt: Date.now(),
    mimeType: recorder.mimeType || mimeType,
  };
}

export async function stopVoiceRecorder(
  session: VoiceRecorderSession,
): Promise<VoiceTranscribeAudioInput> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    session.recorder.addEventListener("stop", () => {
      resolve(new Blob(session.chunks, { type: session.mimeType }));
    });
    session.recorder.addEventListener("error", () => {
      reject(new Error("Recorder failed"));
    });
    if (session.recorder.state !== "inactive") {
      session.recorder.stop();
      return;
    }
    resolve(new Blob(session.chunks, { type: session.mimeType }));
  });
  for (const track of session.stream.getTracks()) {
    track.stop();
  }
  const buffer = await blob.arrayBuffer();
  const durationMs = Math.max(1, Date.now() - session.startedAt);
  return {
    content: arrayBufferToBase64(buffer),
    mimeType: blob.type || session.mimeType || "audio/webm",
    fileName: `webchat-voice-${Date.now()}.webm`,
    sizeBytes: blob.size,
    durationMs,
  };
}
