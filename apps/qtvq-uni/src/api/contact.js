import { post } from './request.js';

export function submitContact({ message, replyEmail, images, clientId }) {
  return post('/api/contact', {
    message,
    replyEmail: replyEmail || '',
    images: images || [],
    clientId,
  });
}
