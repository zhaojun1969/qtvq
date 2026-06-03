import { apiUrl } from './config.js';

export function request(options) {
  return new Promise((resolve, reject) => {
    uni.request({
      ...options,
      url: options.url,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          const err = new Error(res.data?.error || `HTTP ${res.statusCode}`);
          err.code = res.data?.code;
          err.data = res.data;
          err.statusCode = res.statusCode;
          reject(err);
        }
      },
      fail: reject,
    });
  });
}

export function get(path, data) {
  const qs = data
    ? '?' +
      Object.entries(data)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')
    : '';
  return request({ url: apiUrl(path + qs), method: 'GET' });
}

export function post(path, data) {
  return request({
    url: apiUrl(path),
    method: 'POST',
    header: { 'Content-Type': 'application/json' },
    data,
  });
}
