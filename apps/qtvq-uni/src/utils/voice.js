/**
 * 小程序录音 → /api/speech（mp3/pcm）
 * 微信 / 支付宝均走 uni.getRecorderManager
 */

import { transcribeAudio, probeSpeechConfigured } from '../api/speech.js';

const MAX_MS = 30000;

let recorder = null;
let recording = false;
let stopResolve = null;

function getRecorder() {
  if (!recorder) recorder = uni.getRecorderManager();
  return recorder;
}

function readFileBase64(filePath) {
  return new Promise((resolve, reject) => {
    uni.getFileSystemManager().readFile({
      filePath,
      encoding: 'base64',
      success: (res) => resolve(res.data),
      fail: reject,
    });
  });
}

export function isRecording() {
  return recording;
}

export async function checkSpeechAvailable() {
  return probeSpeechConfigured();
}

export function startRecording() {
  return new Promise((resolve, reject) => {
    if (recording) {
      resolve();
      return;
    }
    const rm = getRecorder();
    rm.onStart(() => {
      recording = true;
      resolve();
    });
    rm.onError((err) => {
      recording = false;
      reject(err);
    });
    rm.start({
      duration: MAX_MS,
      sampleRate: 16000,
      numberOfChannels: 1,
      format: 'mp3',
    });
  });
}

export function stopRecording() {
  return new Promise((resolve, reject) => {
    if (!recording) {
      reject(new Error('未在录音'));
      return;
    }
    const rm = getRecorder();
    rm.onStop(async (res) => {
      recording = false;
      try {
        const b64 = await readFileBase64(res.tempFilePath);
        resolve({ base64: b64, format: 'mp3', sampleRate: 16000 });
      } catch (e) {
        reject(e);
      }
    });
    rm.onError(reject);
    rm.stop();
  });
}

export async function recordAndTranscribe() {
  await startRecording();
  const audio = await stopRecording();
  const result = await transcribeAudio(audio.base64, audio.format, audio.sampleRate);
  return result.text || '';
}
