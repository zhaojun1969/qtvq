import { post } from './request.js';

export function askChat(message, clientId, followUp = false) {
  return post('/api/chat', { message, clientId, followUp });
}
