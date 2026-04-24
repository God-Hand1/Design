'use strict';

const {
  ALLOWED_PERMISSIONS,
  APP_ORIGIN,
  APP_PROTOCOL,
  APP_PROTOCOL_HOST,
  SAFE_EXTERNAL_PROTOCOLS,
  TRUSTED_POPUP_HOSTS,
  TRUSTED_ROOT_DOMAINS
} = require('./constants');

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function hostMatchesRule(hostname, rule) {
  return hostname === rule || hostname.endsWith(`.${rule}`);
}

function isTrustedRemoteUrl(value) {
  const parsed = parseUrl(value);
  if (!parsed || parsed.protocol !== 'https:') {
    return false;
  }

  return TRUSTED_ROOT_DOMAINS.some((rule) => hostMatchesRule(parsed.hostname, rule));
}

function isTrustedPopupUrl(value) {
  const parsed = parseUrl(value);
  if (!parsed || parsed.protocol !== 'https:') {
    return false;
  }

  return TRUSTED_POPUP_HOSTS.some((rule) => hostMatchesRule(parsed.hostname, rule));
}

function isTrustedLocalPage(value) {
  const parsed = parseUrl(value);
  if (!parsed) {
    return false;
  }

  if (parsed.origin === APP_ORIGIN) {
    return true;
  }

  return parsed.protocol === `${APP_PROTOCOL}:` && parsed.hostname === APP_PROTOCOL_HOST;
}

function isSafeExternalOpen(value) {
  const parsed = parseUrl(value);
  if (!parsed) {
    return false;
  }

  if (!SAFE_EXTERNAL_PROTOCOLS.includes(parsed.protocol)) {
    return false;
  }

  if (parsed.protocol === 'https:') {
    return Boolean(parsed.hostname);
  }

  return true;
}

function shouldAllowPermission(permission, requestingOrigin) {
  if (!ALLOWED_PERMISSIONS.includes(permission)) {
    return false;
  }

  if (permission === 'notifications') {
    return isTrustedRemoteUrl(requestingOrigin);
  }

  return isTrustedRemoteUrl(requestingOrigin);
}

function buildRemoteCsp() {
  return [
    "default-src 'self' https: data: blob:",
    "script-src 'self' https: 'unsafe-inline'",
    "style-src 'self' https: 'unsafe-inline'",
    "img-src 'self' https: data: blob:",
    "font-src 'self' https: data:",
    "connect-src 'self' https: wss:",
    "media-src 'self' https: blob: data:",
    "frame-src 'self' https:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://designarena.ai https://www.designarena.ai",
    'upgrade-insecure-requests'
  ].join('; ');
}

function registerSessionSecurity(ses, logger) {
  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return shouldAllowPermission(permission, requestingOrigin);
  });

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingOrigin = details?.requestingUrl ?? details?.embeddingOrigin ?? '';
    const allowed = shouldAllowPermission(permission, requestingOrigin);

    logger.info('Permission request evaluated', {
      permission,
      requestingOrigin,
      allowed
    });

    callback(allowed);
  });

  if (typeof ses.setDevicePermissionHandler === 'function') {
    ses.setDevicePermissionHandler(() => false);
  }

  const allowedRequestProtocols = new Set(['https:', 'wss:', 'data:', 'blob:', 'about:', 'devtools:']);

  ses.webRequest.onBeforeRequest((details, callback) => {
    const parsed = parseUrl(details.url);
    if (!parsed) {
      callback({ cancel: true });
      return;
    }

    if (!allowedRequestProtocols.has(parsed.protocol)) {
      logger.warn('Blocked non-secure request protocol', {
        url: details.url,
        resourceType: details.resourceType
      });
      callback({ cancel: true });
      return;
    }

    callback({});
  });

  ses.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...(details.responseHeaders ?? {}) };

    if (details.resourceType === 'mainFrame' && isTrustedRemoteUrl(details.url)) {
      responseHeaders['Content-Security-Policy'] = [buildRemoteCsp()];
      responseHeaders['X-Content-Type-Options'] = ['nosniff'];
      responseHeaders['Referrer-Policy'] = ['strict-origin-when-cross-origin'];
    }

    callback({ responseHeaders });
  });
}

function attachNavigationGuard(webContents, options) {
  const { logger, onOpenExternal, popupOptionsFactory } = options;

  webContents.on('will-navigate', (event, url) => {
    if (isTrustedRemoteUrl(url)) {
      return;
    }

    if (isSafeExternalOpen(url)) {
      event.preventDefault();
      onOpenExternal(url);
      return;
    }

    logger.warn('Blocked navigation attempt', { url });
    event.preventDefault();
  });

  webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedPopupUrl(url) || isTrustedRemoteUrl(url)) {
      logger.info('Allowed trusted popup', { url });
      return {
        action: 'allow',
        overrideBrowserWindowOptions: popupOptionsFactory(url)
      };
    }

    if (isSafeExternalOpen(url)) {
      onOpenExternal(url);
      return { action: 'deny' };
    }

    logger.warn('Blocked popup attempt', { url });
    return { action: 'deny' };
  });
}

function shouldIgnoreLoadFailure(errorCode, validatedURL, isMainFrame) {
  if (!isMainFrame) {
    return true;
  }

  if (errorCode === -3) {
    return true;
  }

  return !validatedURL;
}

module.exports = {
  attachNavigationGuard,
  buildRemoteCsp,
  isSafeExternalOpen,
  isTrustedLocalPage,
  isTrustedPopupUrl,
  isTrustedRemoteUrl,
  registerSessionSecurity,
  shouldIgnoreLoadFailure
};
