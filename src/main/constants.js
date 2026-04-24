'use strict';

const path = require('node:path');

const APP_NAME = 'Design Arena';
const APP_ID = 'com.designarena.desktop';
const APP_ENTRY_URL = 'https://www.designarena.ai/';
const APP_PROTOCOL = 'app';
const APP_PROTOCOL_HOST = 'local';
const APP_ORIGIN = `${APP_PROTOCOL}://${APP_PROTOCOL_HOST}`;
const SESSION_PARTITION = 'persist:design-arena';
const SOURCE_ROOT = path.resolve(__dirname, '..');
const PRELOAD_PATH = path.join(SOURCE_ROOT, 'preload', 'preload.js');
const WINDOW_BACKGROUND = '#0f1319';
const REMOTE_BACKGROUND = '#11161c';
const HUD_WIDTH = 360;
const HUD_MIN_HEIGHT = 96;
const HUD_MAX_HEIGHT = 320;
const HUD_MARGIN = 20;
const OVERLAY_FADE_MS = 360;

const IPC_CHANNELS = Object.freeze({
  APP_GET_BOOTSTRAP: 'app:get-bootstrap',
  APP_STATE: 'app:state',
  APP_RETRY_LOAD: 'app:retry-load',
  APP_OPEN_EXTERNAL: 'app:open-external',
  APP_QUIT: 'app:quit',
  DOWNLOAD_STATE: 'download:state',
  DOWNLOAD_CANCEL: 'download:cancel',
  DOWNLOAD_DISMISS: 'download:dismiss'
});

const TRUSTED_ROOT_DOMAINS = Object.freeze(['designarena.ai']);
const TRUSTED_POPUP_HOSTS = Object.freeze([
  'accounts.google.com',
  'oauth.googleusercontent.com',
  'content.googleapis.com',
  'apis.google.com',
  'challenges.cloudflare.com'
]);
const SAFE_EXTERNAL_PROTOCOLS = Object.freeze(['https:', 'mailto:', 'tel:']);
const ALLOWED_PERMISSIONS = Object.freeze([
  'clipboard-sanitized-write',
  'fullscreen',
  'notifications'
]);

function resolveAppUrl(relativePath) {
  const normalizedPath = String(relativePath).replace(/^\/+/, '');
  return `${APP_ORIGIN}/${normalizedPath}`;
}

module.exports = {
  ALLOWED_PERMISSIONS,
  APP_ENTRY_URL,
  APP_ID,
  APP_NAME,
  APP_ORIGIN,
  APP_PROTOCOL,
  APP_PROTOCOL_HOST,
  HUD_MARGIN,
  HUD_MAX_HEIGHT,
  HUD_MIN_HEIGHT,
  HUD_WIDTH,
  IPC_CHANNELS,
  OVERLAY_FADE_MS,
  PRELOAD_PATH,
  REMOTE_BACKGROUND,
  SAFE_EXTERNAL_PROTOCOLS,
  SESSION_PARTITION,
  SOURCE_ROOT,
  TRUSTED_POPUP_HOSTS,
  TRUSTED_ROOT_DOMAINS,
  WINDOW_BACKGROUND,
  resolveAppUrl
};
