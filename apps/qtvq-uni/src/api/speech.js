import { get, post } from './request.js';

export function transcribeAudio(base64, format = 'mp3', sampleRate = 16000) {
  return post('/api/speech', { audio: base64, format, sampleRate });
}

export async function probeSpeechConfigured() {
  try {
    const health = await get('/api/health');
    return !!health.speechConfigured;
  } catch {
    return false;
  }
}
