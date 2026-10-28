/**
 * 浏览器录音 + 阿里云 ASR（/api/speech）
 */

import { apiFetch } from './api-fetch.js';

const MAX_RECORD_MS = 30000;

function pickMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function encodeWav(samples, sampleRate) {
  const dataLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    view.setInt16(offset, samples[i], true);
  }
  return new Uint8Array(buffer);
}

export async function blobToWav16k(blob) {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    const channel = rendered.getChannelData(0);
    const samples = new Int16Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      samples[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return encodeWav(samples, 16000);
  } finally {
    await ctx.close().catch(() => {});
  }
}

function uint8ToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function createVoiceRecorder() {
  let stream = null;
  let recorder = null;
  let chunks = [];
  let stopTimer = null;
  let mimeType = '';

  async function start() {
    if (recorder?.state === 'recording') return;
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mimeType = pickMimeType();
    chunks = [];
    recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);

    return new Promise((resolve, reject) => {
      recorder.ondataavailable = (e) => {
        if (e.data?.size) chunks.push(e.data);
      };
      recorder.onerror = () => reject(new Error('录音失败'));
      recorder.onstart = () => {
        stopTimer = setTimeout(() => {
          if (recorder?.state === 'recording') recorder.stop();
        }, MAX_RECORD_MS);
        resolve();
      };
      recorder.start();
    });
  }

  function stop() {
    return new Promise((resolve, reject) => {
      if (!recorder || recorder.state === 'inactive') {
        reject(new Error('未在录音'));
        return;
      }
      clearTimeout(stopTimer);
      recorder.onstop = () => {
        stream?.getTracks().forEach((t) => t.stop());
        stream = null;
        const type = mimeType || recorder.mimeType || 'audio/webm';
        resolve(new Blob(chunks, { type }));
      };
      recorder.stop();
    });
  }

  function isRecording() {
    return recorder?.state === 'recording';
  }

  return { start, stop, isRecording };
}

export async function transcribeBlob(blob) {
  const wav = await blobToWav16k(blob);
  const res = await apiFetch('/api/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audio: uint8ToBase64(wav),
      format: 'wav',
      sampleRate: 16000,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || data.message || '语音识别失败');
    err.code = data.code;
    // 把诊断信息一并带出：控制台里能看到具体原因（如 40020503 缺 NLS 权限），
    // 而给用户看的 toast 保持简短。
    err.nlsCode = data.nlsCode || null;
    err.hint = data.hint || null;
    err.raw = data.raw || null;
    err.status = res.status;
    throw err;
  }
  return data.text || '';
}

/**
 * 语音是否**真的可用**。
 * 用 /api/speech 的 GET 探测（会真去换一次 token），而不是 /api/health 的
 * `speechConfigured` —— 后者只证明环境变量存在，本项目实际遇到过
 * "变量齐全但 AccessKey 无 NLS 权限"：那时 configured 为 true、按钮亮着，点了才失败。
 * @returns {Promise<{ready: boolean, reason: string|null, configured: boolean, nlsCode: string|null}>}
 */
export async function probeSpeechApiDetailed() {
  try {
    const res = await apiFetch('/api/speech', { method: 'GET' });
    const data = await res.json();
    return {
      configured: !!data.configured,
      ready: !!data.ready,
      reason: data.reason || null,
      nlsCode: data.nlsCode || null,
    };
  } catch (err) {
    return { configured: false, ready: false, reason: err?.message || '探测失败', nlsCode: null };
  }
}

export async function probeSpeechApi() {
  try {
    const res = await apiFetch('/api/health', { method: 'GET' });
    const data = await res.json();
    return !!data.speechConfigured;
  } catch {
    return false;
  }
}
