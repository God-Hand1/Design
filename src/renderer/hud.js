const itemsRoot = document.getElementById('items');

function getDesignArenaApi() {
  if (!window.designArena) {
    throw new Error('Secure preload bridge unavailable.');
  }

  return window.designArena;
}

function formatStatus(download) {
  if (download.state === 'progressing') {
    return `${download.percent}% · ${download.receivedBytes.toLocaleString()} / ${download.totalBytes.toLocaleString()} bytes`;
  }

  if (download.state === 'completed') {
    return `Saved to ${download.savePath || download.filename}`;
  }

  return download.error || download.state;
}

function renderDownloads(downloads) {
  itemsRoot.textContent = '';

  for (const download of downloads) {
    const card = document.createElement('article');
    card.className = `item is-${download.state}`;

    const header = document.createElement('div');
    header.className = 'item-head';

    const textWrap = document.createElement('div');

    const filename = document.createElement('p');
    filename.className = 'filename';
    filename.textContent = download.filename;

    const status = document.createElement('p');
    status.className = 'status';
    status.textContent = formatStatus(download);

    textWrap.append(filename, status);
    header.append(textWrap);
    card.append(header);

    const progressTrack = document.createElement('div');
    progressTrack.className = 'progress-track';

    const progressBar = document.createElement('div');
    progressBar.className = 'progress-bar';
    progressBar.style.width = `${Math.max(0, Math.min(100, download.percent || 0))}%`;

    progressTrack.append(progressBar);
    card.append(progressTrack);

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    if (download.state === 'progressing') {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'action cancel';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        const api = window.designArena;
        if (api) {
          api.cancelDownload(download.id);
        }
      });
      actions.append(cancel);
    } else {
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'action';
      dismiss.textContent = 'Dismiss';
      dismiss.addEventListener('click', () => {
        const api = window.designArena;
        if (api) {
          api.dismissDownload(download.id);
        }
      });
      actions.append(dismiss);
    }

    card.append(actions);
    itemsRoot.append(card);
  }
}

async function bootstrap() {
  const api = getDesignArenaApi();
  const initial = await api.getBootstrap();
  renderDownloads(initial.downloads || []);

  api.onDownloadState((downloads) => {
    renderDownloads(downloads);
  });
}

bootstrap().catch(() => {
  renderDownloads([]);
});
