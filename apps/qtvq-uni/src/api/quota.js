import { get, post } from './request.js';

export function fetchQuota(clientId) {
  return get('/api/quota', { clientId });
}

export function recordQuota(clientId) {
  return post(`/api/quota?clientId=${encodeURIComponent(clientId)}`, {
    action: 'record',
    clientId,
  });
}

export function fetchPaymentInfo() {
  return get('/api/payment');
}

export function submitPayment(payload) {
  return post('/api/payment', payload);
}
