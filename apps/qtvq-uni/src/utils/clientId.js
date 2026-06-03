const CLIENT_KEY = 'qtvq_client_id';

export function getClientId() {
  let id = uni.getStorageSync(CLIENT_KEY);
  if (!id) {
    id = `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    uni.setStorageSync(CLIENT_KEY, id);
  }
  return id;
}
