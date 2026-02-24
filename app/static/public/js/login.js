const publicKeyInput = document.getElementById('public-key-input');
if (publicKeyInput) {
  publicKeyInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') login();
  });
}

async function requestPublicLogin(key) {
  const headers = key ? { 'Authorization': `Bearer ${key}` } : {};
  const res = await fetch('/v1/public/verify', {
    method: 'GET',
    headers
  });
  return res.ok;
}

async function login() {
  const input = (publicKeyInput ? publicKeyInput.value : '').trim();
  try {
    const ok = await requestPublicLogin(input);
    if (ok) {
      await storePublicKey(input);
      window.location.href = '/chat';
    } else {
      showToast('密钥无效', 'error');
    }
  } catch (e) {
    showToast('连接失败', 'error');
  }
}

function loginWithLinuxDo() {
  window.location.href = '/v1/public/oauth/linuxdo/login';
}

(async () => {
  // Handle OAuth callback token
  const params = new URLSearchParams(window.location.search);
  const oauthToken = params.get('oauth_token');
  if (oauthToken) {
    try {
      const ok = await requestPublicLogin(oauthToken);
      if (ok) {
        await storePublicKey(oauthToken);
        // Clean URL then redirect
        window.history.replaceState({}, '', '/login');
        window.location.href = '/chat';
        return;
      } else {
        showToast('OAuth 登录失败，请重试', 'error');
        window.history.replaceState({}, '', '/login');
      }
    } catch (e) {
      showToast('OAuth 验证失败', 'error');
      window.history.replaceState({}, '', '/login');
    }
  }

  // Check OAuth config and show/hide button
  try {
    const res = await fetch('/v1/public/oauth/config');
    if (res.ok) {
      const data = await res.json();
      if (data.linuxdo_enabled) {
        const section = document.getElementById('oauth-section');
        if (section) section.classList.remove('hidden');
      }
    }
  } catch (e) { /* ignore */ }

  // Auto-login with stored key
  try {
    const stored = await getStoredPublicKey();
    if (stored) {
      const ok = await requestPublicLogin(stored);
      if (ok) {
        window.location.href = '/chat';
        return;
      }
      clearStoredPublicKey();
    }

    const ok = await requestPublicLogin('');
    if (ok) {
      window.location.href = '/chat';
    }
  } catch (e) {
    return;
  }
})();
