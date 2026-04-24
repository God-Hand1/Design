'use strict';

const { contextBridge, ipcRenderer } = require('electron');

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

const listenerMap = new WeakMap();

function freezePayload(payload) {
  if (Array.isArray(payload)) {
    return Object.freeze(payload.map((value) => freezePayload(value)));
  }

  if (payload && typeof payload === 'object') {
    const frozen = {};
    for (const [key, value] of Object.entries(payload)) {
      frozen[key] = freezePayload(value);
    }
    return Object.freeze(frozen);
  }

  return payload;
}

function subscribe(channel, listener) {
  if (typeof listener !== 'function') {
    throw new TypeError('Listener must be a function.');
  }

  const wrapped = (_event, payload) => {
    listener(freezePayload(payload));
  };

  listenerMap.set(listener, wrapped);
  ipcRenderer.on(channel, wrapped);

  return () => {
    const registered = listenerMap.get(listener);
    if (registered) {
      ipcRenderer.removeListener(channel, registered);
      listenerMap.delete(listener);
    }
  };
}

const api = Object.freeze({
  getBootstrap() {
    return ipcRenderer.invoke(IPC_CHANNELS.APP_GET_BOOTSTRAP);
  },
  onAppState(listener) {
    return subscribe(IPC_CHANNELS.APP_STATE, listener);
  },
  onDownloadState(listener) {
    return subscribe(IPC_CHANNELS.DOWNLOAD_STATE, listener);
  },
  retryLoad() {
    ipcRenderer.send(IPC_CHANNELS.APP_RETRY_LOAD);
  },
  openExternal() {
    ipcRenderer.send(IPC_CHANNELS.APP_OPEN_EXTERNAL);
  },
  quit() {
    ipcRenderer.send(IPC_CHANNELS.APP_QUIT);
  },
  cancelDownload(id) {
    if (typeof id === 'string') {
      ipcRenderer.send(IPC_CHANNELS.DOWNLOAD_CANCEL, id);
    }
  },
  dismissDownload(id) {
    if (typeof id === 'string') {
      ipcRenderer.send(IPC_CHANNELS.DOWNLOAD_DISMISS, id);
    }
  }
});

contextBridge.exposeInMainWorld('designArena', api);
