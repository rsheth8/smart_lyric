// OAuth token storage for streaming services.

const PREFIX = 'bar4bar_';

export function saveToken(service, token) {
  try {
    sessionStorage.setItem(`${PREFIX}${service}`, JSON.stringify(token));
  } catch {
    /* ignore quota errors */
  }
}

export function loadToken(service) {
  try {
    const raw = sessionStorage.getItem(`${PREFIX}${service}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearToken(service) {
  sessionStorage.removeItem(`${PREFIX}${service}`);
}

export function isExpired(token) {
  if (!token?.expires_at) return false;
  return Date.now() >= token.expires_at - 30_000;
}
