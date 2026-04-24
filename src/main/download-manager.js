'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');

function throttle(fn, waitMs) {
  let timeoutId = null;
  let queued = false;

  return function throttled() {
    if (timeoutId) {
      queued = true;
      return;
    }

    fn();
    timeoutId = setTimeout(() => {
      timeoutId = null;
      if (queued) {
        queued = false;
        fn();
      }
    }, waitMs);
  };
}

function sanitizeFilename(filename) {
  const cleaned = String(filename || 'download')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');

  if (!cleaned) {
    return 'download';
  }

  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned)) {
    return `_${cleaned}`;
  }

  return cleaned;
}

function validateSavePath(targetPath) {
  if (typeof targetPath !== 'string' || targetPath.includes('\0')) {
    return null;
  }

  const normalized = path.resolve(targetPath);
  const basename = path.basename(normalized);

  if (!basename || basename === '.' || basename === '..') {
    return null;
  }

  return normalized;
}

class DownloadManager {
  constructor(options) {
    this.logger = options.logger;
    this.session = options.session;
    this.windowProvider = options.windowProvider;
    this.dialog = options.dialog;
    this.downloadsPathProvider = options.downloadsPathProvider;
    this.onSnapshot = options.onSnapshot;
    this.items = new Map();
    this.snapshotThrottle = throttle(() => this.emitSnapshot(), 120);
    this.handleWillDownload = this.handleWillDownload.bind(this);
  }

  pruneHistory() {
    const maxHistory = 50;
    const itemsArray = [...this.items.values()].sort((a, b) => b.startedAt - a.startedAt);
    const completedItems = itemsArray.filter(i => i.state !== 'progressing' && i.state !== 'prompting');
    if (completedItems.length > maxHistory) {
      const toRemove = completedItems.slice(maxHistory);
      for (const item of toRemove) {
        this.items.delete(item.id);
      }
    }
  }

  attach() {
    this.session.on('will-download', this.handleWillDownload);
  }

  dispose() {
    this.session.removeListener('will-download', this.handleWillDownload);
  }

  getSnapshot() {
    return [...this.items.values()]
      .map((item) => ({
        id: item.id,
        filename: item.filename,
        savePath: item.savePath,
        totalBytes: item.totalBytes,
        receivedBytes: item.receivedBytes,
        percent: item.percent,
        state: item.state,
        error: item.error,
        startedAt: item.startedAt,
        isCancellable: item.isCancellable
      }))
      .sort((left, right) => right.startedAt - left.startedAt);
  }

  cancelDownload(id) {
    const item = this.items.get(id);
    if (!item || !item.downloadItem || item.state !== 'progressing') {
      return false;
    }

    item.downloadItem.cancel();
    return true;
  }

  dismissDownload(id) {
    const item = this.items.get(id);
    if (!item) {
      return false;
    }

    if (item.state === 'progressing') {
      return false;
    }

    this.items.delete(id);
    this.emitSnapshot();
    return true;
  }

  emitSnapshot() {
    const snapshot = this.getSnapshot();
    const activeItems = snapshot.filter((item) => item.state === 'progressing');
    const progressValue =
      activeItems.length === 0
        ? -1
        : activeItems.reduce((sum, item) => sum + item.percent, 0) / activeItems.length / 100;

    const mainWindow = this.windowProvider();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setProgressBar(progressValue);
    }

    this.onSnapshot(snapshot);
  }

  async handleWillDownload(event, downloadItem) {
    const mainWindow = this.windowProvider();
    const id = randomUUID();
    const safeFilename = sanitizeFilename(downloadItem.getFilename());
    const defaultPath = path.join(this.downloadsPathProvider(), safeFilename);

    this.items.set(id, {
      id,
      filename: safeFilename,
      savePath: null,
      totalBytes: downloadItem.getTotalBytes(),
      receivedBytes: 0,
      percent: 0,
      state: 'prompting',
      error: null,
      startedAt: Date.now(),
      isCancellable: false,
      downloadItem
    });
    this.pruneHistory();
    this.emitSnapshot();

    downloadItem.pause();

    let selection;
    try {
      selection = await this.dialog.showSaveDialog(mainWindow, {
        title: 'Save Download',
        defaultPath,
        buttonLabel: 'Save'
      });
    } catch (error) {
      this.logger.error('Save dialog failed for download', {
        filename: safeFilename,
        error: error.message
      });
      downloadItem.cancel();
      this.finalizePromptFailure(id, 'Could not open the save dialog.');
      return;
    }

    if (selection.canceled || !selection.filePath) {
      downloadItem.cancel();
      this.finalizePromptFailure(id, 'Cancelled by user.', 'cancelled');
      return;
    }

    const validatedPath = validateSavePath(selection.filePath);
    if (!validatedPath) {
      downloadItem.cancel();
      this.finalizePromptFailure(id, 'Rejected unsafe download path.', 'failed');
      return;
    }

    const state = this.items.get(id);
    if (!state) {
      downloadItem.cancel();
      return;
    }

    downloadItem.setSavePath(validatedPath);
    downloadItem.resume();

    state.filename = path.basename(validatedPath);
    state.savePath = validatedPath;
    state.state = 'progressing';
    state.isCancellable = true;
    this.emitSnapshot();

    downloadItem.on('updated', (updatedEvent, downloadState) => {
      const current = this.items.get(id);
      if (!current) {
        return;
      }

      current.receivedBytes = downloadItem.getReceivedBytes();
      current.totalBytes = downloadItem.getTotalBytes();
      current.percent =
        current.totalBytes > 0
          ? Math.min(100, Math.round((current.receivedBytes / current.totalBytes) * 100))
          : 0;

      if (downloadState === 'interrupted') {
        current.state = 'interrupted';
        current.error = 'Download interrupted.';
        current.isCancellable = false;
      }

      this.snapshotThrottle();
    });

    downloadItem.once('done', (doneEvent, stateName) => {
      const current = this.items.get(id);
      if (!current) {
        return;
      }

      current.receivedBytes = downloadItem.getReceivedBytes();
      current.totalBytes = downloadItem.getTotalBytes();
      current.percent =
        current.totalBytes > 0
          ? Math.min(100, Math.round((current.receivedBytes / current.totalBytes) * 100))
          : 100;
      current.isCancellable = false;
      current.downloadItem = null;

      if (stateName === 'completed') {
        current.state = 'completed';
      } else if (stateName === 'cancelled') {
        current.state = 'cancelled';
        current.error = 'Cancelled by user.';
      } else {
        current.state = 'failed';
        current.error = 'Download failed.';
      }

      this.logger.info('Download completed', {
        filename: current.filename,
        state: current.state,
        savePath: current.savePath
      });

      this.pruneHistory();
      this.emitSnapshot();
    });
  }

  finalizePromptFailure(id, message, stateName = 'failed') {
    const current = this.items.get(id);
    if (!current) {
      return;
    }

    current.state = stateName;
    current.error = message;
    current.isCancellable = false;
    current.downloadItem = null;
    this.pruneHistory();
    this.emitSnapshot();
  }
}

function createDownloadManager(options) {
  return new DownloadManager(options);
}

module.exports = {
  createDownloadManager
};
