const TOKEN_KEY = 'qtvq_auth_token';
const USER_KEY = 'qtvq_auth_user';

export function getAuthToken() {
  return uni.getStorageSync(TOKEN_KEY) || '';
}

export function getAuthUser() {
  try {
    const raw = uni.getStorageSync(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setAuthSession(token, user) {
  uni.setStorageSync(TOKEN_KEY, token);
  uni.setStorageSync(USER_KEY, JSON.stringify(user));
}

export function clearAuthSession() {
  uni.removeStorageSync(TOKEN_KEY);
  uni.removeStorageSync(USER_KEY);
}

export function bindAccountClientId(clientId) {
  if (clientId) uni.setStorageSync('qtvq_client_id', clientId);
}

export function isLoggedIn() {
  return !!getAuthToken();
}

export function authHeader() {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
