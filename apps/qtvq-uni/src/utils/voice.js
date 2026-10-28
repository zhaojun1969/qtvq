/**
 * 小程序录音 → /api/speech
 * 微信用 PCM 16k，与阿里云一句话识别匹配
 */

import { probeSpeechConfigured } from '../api/speech.js';
import { ensurePrivacyAuthorize, privacyDeniedError } from './privacy.js';

const MAX_MS = 30000;

// #ifdef MP-WEIXIN
const RECORD_FORMAT = 'pcm';
const RECORDER_FORMAT = 'PCM';
// #endif
// #ifndef MP-WEIXIN
const RECORD_FORMAT = 'mp3';
const RECORDER_FORMAT = 'mp3';
// #endif

let recorder = null;
let recording = false;

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
    /*
     * 隐私授权必须**在拿到录音管理器之前**完成。
     *
     * `getRecorderManager()` 本身不弹窗，真正触发校验的是 `start()`，
     * 而那时错误只会落到 `onError`，与"麦克风坏了"混在一起分不出来。
     * 先问一次授权，被拒时抛带 code 的错误，调用方才能给出可操作的提示。
     */
    ensurePrivacyAuthorize().then((ok) => {
      if (!ok) {
        reject(privacyDeniedError('使用语音输入'));
        return;
      }
      const rm = getRecorder();
      const onStart = () => {
        rm.offStart?.(onStart);
        recording = true;
        resolve();
      };
      const onError = (err) => {
        rm.offStart?.(onStart);
        rm.offError?.(onError);
        recording = false;
        reject(err);
      };
      rm.onStart(onStart);
      rm.onError(onError);
      rm.start({
        duration: MAX_MS,
        sampleRate: 16000,
        numberOfChannels: 1,
        encodeBitRate: 48000,
        format: RECORDER_FORMAT,
      });
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
    const onStop = async (res) => {
      rm.offStop?.(onStop);
      rm.offError?.(onError);
      recording = false;
      try {
        const b64 = await readFileBase64(res.tempFilePath);
        resolve({ base64: b64, format: RECORD_FORMAT, sampleRate: 16000 });
      } catch (e) {
        reject(e);
      }
    };
    const onError = (err) => {
      rm.offStop?.(onStop);
      rm.offError?.(onError);
      recording = false;
      reject(err);
    };
    rm.onStop(onStop);
    rm.onError(onError);
    rm.stop();
  });
}
