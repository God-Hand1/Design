'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { pathToFileURL } = require('node:url');

function resolveOriginalHome() {
  return process.env.HOME || os.homedir();
}

function resolveLinuxUserDir(originalHome, envVarName, fallbackLeaf) {
  const directValue = process.env[envVarName];
  if (directValue) {
    return directValue;
  }

  try {
    const output = childProcess.execFileSync('xdg-user-dir', [fallbackLeaf.toUpperCase()], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();

    if (output) {
      return output;
    }
  } catch {
    // Fall back to conventional XDG leaf directory names.
  }

  return path.join(originalHome, fallbackLeaf);
}

function prepareLinuxNssIsolation() {
  if (process.platform !== 'linux' || process.env.DESIGN_ARENA_USE_SYSTEM_NSS === '1') {
    return null;
  }

  const originalHome = resolveOriginalHome();
  const originalPaths = {
    home: originalHome,
    appData: process.env.XDG_CONFIG_HOME || path.join(originalHome, '.config'),
    cache: process.env.XDG_CACHE_HOME || path.join(originalHome, '.cache'),
    downloads: resolveLinuxUserDir(originalHome, 'XDG_DOWNLOAD_DIR', 'Downloads')
  };

  const runtimeRoot = path.join(originalHome, '.local', 'share', 'design-arena-desktop');
  const runtimeHome = path.join(runtimeRoot, 'runtime-home');
  const runtimePkiRoot = path.join(runtimeHome, '.local', 'share', 'pki');

  try {
    fs.mkdirSync(runtimePkiRoot, { recursive: true });
  } catch (error) {
    console.error('Failed to create NSS isolation directory:', error.message);
    return null;
  }

  process.env.HOME = runtimeHome;

  return {
    originalPaths,
    runtimeHome,
    runtimeNssDbPath: path.join(runtimePkiRoot, 'nssdb')
  };
}

const linuxNssIsolation = prepareLinuxNssIsolation();

const {
  app,
  BrowserWindow,
  WebContentsView,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
  shell
} = require('electron');

const {
  APP_ENTRY_URL,
  APP_ID,
  APP_NAME,
  APP_ORIGIN,
  APP_PROTOCOL,
  HUD_MARGIN,
  HUD_MAX_HEIGHT,
  HUD_MIN_HEIGHT,
  HUD_WIDTH,
  IPC_CHANNELS,
  OVERLAY_FADE_MS,
  PRELOAD_PATH,
  REMOTE_BACKGROUND,
  SESSION_PARTITION,
  SOURCE_ROOT,
  WINDOW_BACKGROUND,
  resolveAppUrl
} = require('./constants');
const { createDownloadManager } = require('./download-manager');
const { createLogger } = require('./logger');
const { createApplicationMenu } = require('./menu');
const {
  attachNavigationGuard,
  isSafeExternalOpen,
  isTrustedLocalPage,
  registerSessionSecurity,
  shouldIgnoreLoadFailure
} = require('./security');

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
]);

app.commandLine.appendSwitch('autoplay-policy', 'document-user-activation-required');
app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);

if (linuxNssIsolation) {
  const restoredUserData = path.join(linuxNssIsolation.originalPaths.appData, APP_NAME);
  const restoredSessionData = path.join(restoredUserData, 'session');
  const restoredLogs = path.join(restoredUserData, 'logs');

  try {
    fs.mkdirSync(linuxNssIsolation.originalPaths.appData, { recursive: true });
    fs.mkdirSync(linuxNssIsolation.originalPaths.cache, { recursive: true });
    fs.mkdirSync(restoredUserData, { recursive: true });
    fs.mkdirSync(restoredSessionData, { recursive: true });
    fs.mkdirSync(restoredLogs, { recursive: true });
  } catch (error) {
    console.error('Failed to create isolated user data directories:', error.message);
  }

  app.setPath('home', linuxNssIsolation.originalPaths.home);
  app.setPath('appData', linuxNssIsolation.originalPaths.appData);
  app.setPath('cache', linuxNssIsolation.originalPaths.cache);
  app.setPath('downloads', linuxNssIsolation.originalPaths.downloads);
  app.setPath('userData', restoredUserData);
  app.setPath('sessionData', restoredSessionData);
  app.setAppLogsPath(restoredLogs);
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

let logger;
let mainController;
const configuredContents = new Set();

function throttle(fn, waitMs) {
  let timeoutId = null;

  return function throttled(...args) {
    if (timeoutId) {
      return;
    }

    timeoutId = setTimeout(() => {
      timeoutId = null;
      fn(...args);
    }, waitMs);
  };
}

function safeSend(webContents, channel, payload) {
  if (!webContents || webContents.isDestroyed()) {
    return;
  }

  webContents.send(channel, payload);
}

function openExternalSafely(url) {
  if (!isSafeExternalOpen(url)) {
    logger?.warn('Rejected unsafe external URL', { url });
    return;
  }

  shell.openExternal(url).catch((error) => {
    logger?.error('Failed to open external URL', {
      url,
      error: error.message
    });
  });
}

function resolveProtocolPath(requestUrl) {
  let relativePath;
  try {
    const parsed = new URL(requestUrl);
    relativePath = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  } catch (error) {
    return null;
  }
  
  const normalizedPath = path.normalize(relativePath);
  const absolutePath = path.join(SOURCE_ROOT, normalizedPath);
  const safeRoot = `${SOURCE_ROOT}${path.sep}`;

  if (!absolutePath.startsWith(safeRoot) && absolutePath !== SOURCE_ROOT) {
    return null;
  }

  return absolutePath;
}

function registerAppProtocol() {
  protocol.handle(APP_PROTOCOL, async (request) => {
    const targetPath = resolveProtocolPath(request.url);

    if (!targetPath) {
      return new Response('Not Found', { status: 404 });
    }

    try {
      await fs.promises.access(targetPath, fs.constants.R_OK);
      return await net.fetch(pathToFileURL(targetPath).toString()).catch(() => {
        return new Response('Internal Server Error', { status: 500 });
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}

function createLocalView() {
  const view = new WebContentsView({
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      spellcheck: false,
      webSecurity: true
    }
  });

  view.setBackgroundColor('#00000000');
  return view;
}

function createRemoteView() {
  const view = new WebContentsView({
    webPreferences: {
      partition: SESSION_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      spellcheck: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: true,
      safeDialogs: true
    }
  });

  view.setBackgroundColor(REMOTE_BACKGROUND);
  return view;
}

function moveViewToFront(window, view) {
  if (!window || !view) {
    return;
  }

  try {
    window.contentView.removeChildView(view);
  } catch {
    // Ignore if not attached yet.
  }

  window.contentView.addChildView(view);
}

class DesignArenaController {
  constructor() {
    this.window = null;
    this.remoteView = null;
    this.loadingView = null;
    this.hudView = null;
    this.remoteSession = session.fromPartition(SESSION_PARTITION, { cache: true });
    this.loadingState = {
      mode: 'loading',
      title: 'Preparing Design Arena',
      detail: 'Starting a hardened browser session.'
    };
    this.downloads = [];
    this.remoteReady = false;
    this.layoutViews = throttle(() => this.updateViewBounds(), 16);
    this.downloadManager = createDownloadManager({
      session: this.remoteSession,
      dialog,
      logger,
      windowProvider: () => this.window,
      downloadsPathProvider: () => app.getPath('downloads'),
      onSnapshot: (snapshot) => {
        this.downloads = snapshot;
        this.syncHudState();
      }
    });
  }

  async create() {
    registerSessionSecurity(this.remoteSession, logger);

    this.window = new BrowserWindow({
      width: 1440,
      height: 960,
      minWidth: 1100,
      minHeight: 720,
      show: false,
      backgroundColor: WINDOW_BACKGROUND,
      title: APP_NAME,
      autoHideMenuBar: process.platform !== 'darwin',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: !app.isPackaged
      }
    });

    this.installWindowEvents();
    await this.createViews();
    this.downloadManager.attach();

    createApplicationMenu({
      getPrimaryContents: () => this.remoteView?.webContents ?? null
    });

    this.window.show();
    this.window.focus();
    this.loadRemote();
  }

  installWindowEvents() {
    this.window.on('resize', this.layoutViews);
    this.window.on('maximize', this.layoutViews);
    this.window.on('unmaximize', this.layoutViews);
    this.window.on('enter-full-screen', this.layoutViews);
    this.window.on('leave-full-screen', this.layoutViews);
    this.window.on('app-command', (event, command) => {
      if (!this.remoteView || this.remoteView.webContents.isDestroyed()) {
        return;
      }

      if (command === 'browser-backward' && this.remoteView.webContents.canGoBack()) {
        this.remoteView.webContents.goBack();
      }

      if (command === 'browser-forward' && this.remoteView.webContents.canGoForward()) {
        this.remoteView.webContents.goForward();
      }
    });

    this.window.on('closed', () => {
      this.downloadManager.dispose();
      this.destroyView(this.loadingView);
      this.destroyView(this.hudView);
      this.destroyView(this.remoteView);
      this.loadingView = null;
      this.hudView = null;
      this.remoteView = null;
      this.window = null;
    });
  }

  async createViews() {
    this.remoteView = createRemoteView();
    moveViewToFront(this.window, this.remoteView);
    this.configureRemoteWebContents(this.remoteView.webContents);

    this.hudView = createLocalView();
    moveViewToFront(this.window, this.hudView);
    await this.hudView.webContents.loadURL(resolveAppUrl('renderer/hud.html'));

    this.loadingView = createLocalView();
    moveViewToFront(this.window, this.loadingView);
    await this.loadingView.webContents.loadURL(resolveAppUrl('renderer/loading.html'));

    this.updateViewBounds();
    this.syncLoadingState();
    this.syncHudState();
  }

  configureRemoteWebContents(contents) {
    if (configuredContents.has(contents.id)) {
      return;
    }

    configuredContents.add(contents.id);
    contents.once('destroyed', () => {
      configuredContents.delete(contents.id);
    });

    attachNavigationGuard(contents, {
      logger,
      onOpenExternal: openExternalSafely,
      popupOptionsFactory: () => ({
        width: 1180,
        height: 860,
        minWidth: 860,
        minHeight: 640,
        show: false,
        parent: this.window,
        modal: false,
        autoHideMenuBar: true,
        backgroundColor: WINDOW_BACKGROUND,
        title: APP_NAME,
        webPreferences: {
          partition: SESSION_PARTITION,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          devTools: !app.isPackaged,
          spellcheck: false,
          safeDialogs: true
        }
      })
    });

    contents.on('page-title-updated', (event, title) => {
      event.preventDefault();
      this.window?.setTitle(title ? `${title} - ${APP_NAME}` : APP_NAME);
    });

    contents.on('did-start-loading', () => {
      this.setLoadingState({
        mode: 'loading',
        title: 'Connecting to Design Arena',
        detail: 'Negotiating a secure session with the live platform.'
      });
    });

    contents.on('dom-ready', () => {
      this.setLoadingState({
        mode: 'loading',
        title: 'Rendering the arena',
        detail: 'The interface is loading and warming up.'
      });
    });

    contents.on('did-finish-load', () => {
      this.remoteReady = true;
      this.setLoadingState({
        mode: 'loaded',
        title: 'Welcome to Design Arena',
        detail: 'The desktop shell is ready.'
      });
      setTimeout(() => {
        this.destroyLoadingOverlay();
      }, OVERLAY_FADE_MS);
    });

    contents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (shouldIgnoreLoadFailure(errorCode, validatedURL, isMainFrame)) {
        return;
      }

      logger.error('Main frame failed to load', {
        errorCode,
        errorDescription,
        validatedURL
      });

      this.showFailureOverlay({
        title: 'We could not reach Design Arena',
        detail: `${errorDescription || 'The page failed to load.'} Retry the secure wrapper, or open the site in your default browser.`
      });
    });

    contents.on('render-process-gone', (event, details) => {
      logger.error('Remote renderer crashed', details);
      this.remoteReady = false;
      this.showFailureOverlay({
        title: 'The embedded Design Arena view stopped unexpectedly',
        detail: 'The secure session can be rebuilt without restarting the app.'
      });
    });

    contents.on('unresponsive', () => {
      logger.warn('Remote view became unresponsive');
    });

    contents.on('did-create-window', (childWindow) => {
      this.configureRemoteWebContents(childWindow.webContents);
      childWindow.once('ready-to-show', () => childWindow.show());
      childWindow.setMenuBarVisibility(false);
    });
  }

  updateViewBounds() {
    if (!this.window || this.window.isDestroyed()) {
      return;
    }

    const bounds = this.window.getContentBounds();

    if (this.remoteView) {
      this.remoteView.setBounds({
        x: 0,
        y: 0,
        width: bounds.width,
        height: bounds.height
      });
    }

    if (this.loadingView) {
      this.loadingView.setBounds({
        x: 0,
        y: 0,
        width: bounds.width,
        height: bounds.height
      });
    }

    if (this.hudView) {
      if (this.downloads.length === 0) {
        this.hudView.setBounds({
          x: bounds.width + 32,
          y: 0,
          width: 1,
          height: 1
        });
        return;
      }

      const rowHeight = 86;
      const targetHeight = Math.min(
        HUD_MAX_HEIGHT,
        Math.max(HUD_MIN_HEIGHT, 58 + Math.min(this.downloads.length, 3) * rowHeight)
      );

      this.hudView.setBounds({
        x: bounds.width - HUD_WIDTH - HUD_MARGIN,
        y: HUD_MARGIN,
        width: HUD_WIDTH,
        height: targetHeight
      });
    }
  }

  syncLoadingState() {
    safeSend(this.loadingView?.webContents, IPC_CHANNELS.APP_STATE, this.loadingState);
  }

  syncHudState() {
    safeSend(this.hudView?.webContents, IPC_CHANNELS.DOWNLOAD_STATE, this.downloads);
    this.updateViewBounds();
  }

  setLoadingState(nextState) {
    this.loadingState = Object.freeze({ ...nextState });
    this.syncLoadingState();
  }

  showFailureOverlay(nextState) {
    this.ensureLoadingOverlay()
      .then(() => {
        this.setLoadingState({
          mode: 'error',
          title: nextState.title,
          detail: nextState.detail
        });
      })
      .catch((error) => {
        logger.error('Failed to restore loading overlay', { error: error.message });
      });
  }

  async ensureLoadingOverlay() {
    if (this.loadingView && !this.loadingView.webContents.isDestroyed()) {
      moveViewToFront(this.window, this.loadingView);
      this.updateViewBounds();
      return;
    }

    this.loadingView = createLocalView();
    moveViewToFront(this.window, this.loadingView);
    await this.loadingView.webContents.loadURL(resolveAppUrl('renderer/loading.html'));
    this.updateViewBounds();
    this.syncLoadingState();
  }

  destroyLoadingOverlay() {
    if (!this.loadingView) {
      return;
    }

    this.destroyView(this.loadingView);
    this.loadingView = null;
  }

  destroyView(view) {
    if (!view) {
      return;
    }

    try {
      this.window?.contentView.removeChildView(view);
    } catch {
      // Ignore teardown races during shutdown.
    }

    const contents = view.webContents;
    if (contents && !contents.isDestroyed()) {
      contents.removeAllListeners();
      contents.close();
    }
  }

  loadRemote(forceReload = false) {
    if (!this.remoteView || this.remoteView.webContents.isDestroyed()) {
      this.remoteView = createRemoteView();
      moveViewToFront(this.window, this.remoteView);
      this.configureRemoteWebContents(this.remoteView.webContents);
      this.updateViewBounds();
    }

    this.remoteReady = false;
    this.setLoadingState({
      mode: 'loading',
      title: 'Preparing Design Arena',
      detail: 'Launching the secure site container.'
    });

    this.remoteView.webContents.loadURL(APP_ENTRY_URL).catch((error) => {
      logger.error('Failed to start remote load', { error: error.message });
      this.showFailureOverlay({
        title: 'Design Arena could not be opened',
        detail: 'The secure wrapper failed before the first page load completed.'
      });
    });
  }

  retryLoad() {
    this.ensureLoadingOverlay()
      .then(() => {
        this.destroyView(this.remoteView);

        this.remoteView = createRemoteView();
        moveViewToFront(this.window, this.remoteView);
        this.configureRemoteWebContents(this.remoteView.webContents);
        moveViewToFront(this.window, this.hudView);
        moveViewToFront(this.window, this.loadingView);
        this.updateViewBounds();
        this.loadRemote(true);
      })
      .catch((error) => {
        logger.error('Retry flow failed', { error: error.message });
      });
  }

  openSiteInBrowser() {
    openExternalSafely(APP_ENTRY_URL);
  }
}

function validateIpcSender(event) {
  const frameUrl = event.senderFrame?.url ?? '';
  const contentsUrl = event.sender.getURL();
  return {
    allowed: isTrustedLocalPage(frameUrl) || isTrustedLocalPage(contentsUrl),
    frameUrl,
    contentsUrl
  };
}

function registerIpcHandlers() {
  ipcMain.handle(IPC_CHANNELS.APP_GET_BOOTSTRAP, (event) => {
    const sender = validateIpcSender(event);
    if (!sender.allowed) {
      logger?.warn('Rejected IPC bootstrap request from untrusted sender', sender);
      throw new Error('Untrusted IPC sender');
    }

    return {
      appName: APP_NAME,
      loading: mainController?.loadingState ?? null,
      downloads: mainController?.downloads ?? [],
      platform: process.platform
    };
  });

  ipcMain.on(IPC_CHANNELS.APP_RETRY_LOAD, (event) => {
    if (!validateIpcSender(event).allowed) {
      return;
    }

    mainController?.retryLoad();
  });

  ipcMain.on(IPC_CHANNELS.APP_OPEN_EXTERNAL, (event) => {
    if (!validateIpcSender(event).allowed) {
      return;
    }

    mainController?.openSiteInBrowser();
  });

  ipcMain.on(IPC_CHANNELS.APP_QUIT, (event) => {
    if (!validateIpcSender(event).allowed) {
      return;
    }

    app.quit();
  });

  ipcMain.on(IPC_CHANNELS.DOWNLOAD_CANCEL, (event, id) => {
    if (!validateIpcSender(event).allowed || typeof id !== 'string') {
      return;
    }

    mainController?.downloadManager.cancelDownload(id);
  });

  ipcMain.on(IPC_CHANNELS.DOWNLOAD_DISMISS, (event, id) => {
    if (!validateIpcSender(event).allowed || typeof id !== 'string') {
      return;
    }

    mainController?.downloadManager.dismissDownload(id);
  });
}

function registerGlobalFailureHandlers() {
  process.on('uncaughtException', (error) => {
    logger?.error('Uncaught exception', {
      message: error.message,
      stack: error.stack
    });
  });

  process.on('unhandledRejection', (reason) => {
    logger?.error('Unhandled rejection', {
      reason: reason instanceof Error ? reason.message : String(reason)
    });
  });

  app.on('render-process-gone', (event, webContents, details) => {
    logger?.error('Renderer process gone', {
      url: webContents.getURL(),
      details
    });
  });

  app.on('child-process-gone', (event, details) => {
    logger?.error('Child process gone', details);
  });

  app.on('web-contents-created', (event, contents) => {
    if (contents.session !== mainController?.remoteSession) {
      return;
    }

    mainController?.configureRemoteWebContents(contents);
  });
}

async function bootstrap() {
  const logFilePath = path.join(app.getPath('userData'), 'logs', 'main.log');
  logger = createLogger(logFilePath);
  logger.info('Bootstrapping Design Arena desktop shell', {
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  });

  if (linuxNssIsolation) {
    logger.info('Using app-private Linux NSS shared DB runtime', {
      runtimeHome: linuxNssIsolation.runtimeHome,
      runtimeNssDbPath: linuxNssIsolation.runtimeNssDbPath,
      originalHome: linuxNssIsolation.originalPaths.home
    });
  }

  registerAppProtocol();
  registerGlobalFailureHandlers();
  registerIpcHandlers();

  mainController = new DesignArenaController();
  await mainController.create();
}

if (singleInstanceLock) {
  app.on('second-instance', () => {
    const window = mainController?.window;
    if (!window) {
      return;
    }

    if (window.isMinimized()) {
      window.restore();
    }

    window.focus();
  });

  app.whenReady().then(bootstrap).catch((error) => {
    dialog.showErrorBox(APP_NAME, `Failed to start the app: ${error.message}`);
    app.exit(1);
  });

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length > 0) {
      mainController?.window?.focus();
      return;
    }

    mainController = new DesignArenaController();
    await mainController.create();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
