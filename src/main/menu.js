'use strict';

const { Menu, shell } = require('electron');

const { APP_ENTRY_URL, APP_NAME } = require('./constants');

function createApplicationMenu(context) {
  const { getPrimaryContents } = context;
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload Design Arena',
          accelerator: 'CmdOrCtrl+R',
          click: () => getPrimaryContents()?.reload()
        },
        {
          label: 'Force Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => getPrimaryContents()?.reloadIgnoringCache()
        },
        {
          label: 'Back',
          accelerator: 'Alt+Left',
          click: () => {
            const contents = getPrimaryContents();
            if (contents?.canGoBack()) {
              contents.goBack();
            }
          }
        },
        {
          label: 'Forward',
          accelerator: 'Alt+Right',
          click: () => {
            const contents = getPrimaryContents();
            if (contents?.canGoForward()) {
              contents.goForward();
            }
          }
        },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [isMac ? { role: 'minimize' } : { role: 'minimize' }, { role: 'zoom' }]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Open Design Arena in Browser',
          click: () => {
            shell.openExternal(APP_ENTRY_URL).catch(() => {});
          }
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = {
  createApplicationMenu
};
