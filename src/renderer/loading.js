const stateTitle = document.getElementById('status-title');
const stateDetail = document.getElementById('status-detail');
const actions = document.getElementById('actions');
const retryButton = document.getElementById('retry-button');
const browserButton = document.getElementById('browser-button');
const quitButton = document.getElementById('quit-button');

function getDesignArenaApi() {
  if (!window.designArena) {
    throw new Error('Secure preload bridge unavailable. Restart the app to reinitialize the desktop shell.');
  }

  return window.designArena;
}

function applyState(state) {
  if (!state) {
    return;
  }

  stateTitle.textContent = state.title;
  stateDetail.textContent = state.detail;

  if (state.mode === 'error') {
    document.body.classList.add('is-error');
    document.body.classList.remove('is-loaded');
    actions.hidden = false;
    return;
  }

  if (state.mode === 'loaded') {
    document.body.classList.remove('is-error');
    document.body.classList.add('is-loaded');
    actions.hidden = true;
    return;
  }

  document.body.classList.remove('is-error', 'is-loaded');
  actions.hidden = true;
}

async function bootstrap() {
  const api = getDesignArenaApi();
  const initialState = await api.getBootstrap();
  applyState(initialState.loading);

  api.onAppState((state) => {
    applyState(state);
  });
}

retryButton.addEventListener('click', () => {
  const api = window.designArena;
  if (api) {
    api.retryLoad();
  }
});

browserButton.addEventListener('click', () => {
  const api = window.designArena;
  if (api) {
    api.openExternal();
  }
});

quitButton.addEventListener('click', () => {
  const api = window.designArena;
  if (api) {
    api.quit();
  }
});

bootstrap().catch((error) => {
  applyState({
    mode: 'error',
    title: 'The desktop shell could not initialize',
    detail: error instanceof Error ? error.message : String(error)
  });
});
