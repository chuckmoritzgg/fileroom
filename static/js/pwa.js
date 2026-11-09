/* FileRoom PWA: installation and staged, verified updates (same behaviour as the Vokabeltrainer PWA).
 * Independent of the chat code. Expected (optional) elements:
 *   #pwaVersion #pwaUpdateStatus #pwaCheckBtn #pwaRestartBtn #pwaInstallBtn #pwaInstallHelp
 *   #pwaBanner (.pwa-banner-text) #pwaBannerRestart #pwaBannerLater
 */
(() => {
  'use strict';
  const build = document.querySelector('meta[name="app-build"]')?.content || '';
  const version = document.querySelector('meta[name="app-version"]')?.content || '';
  const CHECK_INTERVAL = 30 * 60 * 1000;
  const $ = (id) => document.getElementById(id);
  const ui = {
    version: $('pwaVersion'), status: $('pwaUpdateStatus'), check: $('pwaCheckBtn'),
    restart: $('pwaRestartBtn'), install: $('pwaInstallBtn'), hint: $('pwaInstallHelp'),
    banner: $('pwaBanner'), bannerRestart: $('pwaBannerRestart'), later: $('pwaBannerLater'),
  };
  const setText = (el, text) => { if (el) el.textContent = text; };
  const toggle = (el, cls, on) => { if (el) el.classList.toggle(cls, on); };
  let registration = null;
  let installEvent = null;
  let installationRequested = false;
  let justInstalled = false;
  let state = { kind: 'idle' };
  let remoteVersion = '';
  let remoteBuild = '';
  let lastCheck = 0;
  let currentCheck = null;
  let restarting = false;
  let dismissedBuild = null;
  const installed = () => window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: window-controls-overlay)').matches ||
    navigator.standalone === true;

  function installHint() {
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) {
      return 'In Safari: Share → Add to Home Screen → Add.';
    }
    if (/SamsungBrowser/.test(ua)) return 'Browser menu: Add page to → Home screen / Install app.';
    if (/Firefox/.test(ua)) return 'Browser menu: Install or Add to Home screen (if supported).';
    if (/Android/.test(ua)) return 'Browser menu (⋮): Install app or Add to Home screen.';
    return 'Browser menu or address bar: Install app (if supported).';
  }

  function draw() {
    const runningInstalled = installed() || justInstalled;
    document.documentElement.classList.toggle('pwa-standalone', installed());
    setText(ui.version, `FileRoom v${version || '?'} · Build ${build || 'unknown'}`);
    toggle(ui.install, 'd-none', runningInstalled || installationRequested);
    if (ui.hint) {
      if (runningInstalled) {
        ui.hint.textContent = justInstalled && !installed()
          ? 'App installed. Start it from its icon.'
          : 'Running as installed app. Other apps can share files to FileRoom.';
      } else if (installationRequested) ui.hint.textContent = 'Installation requested. Open the app from its icon afterwards.';
      else if (installEvent) ui.hint.textContent = 'Install the app to receive files shared from other apps.';
      else ui.hint.textContent = `To install: ${installHint()}`;
    }

    const { kind } = state;
    if (ui.check) {
      ui.check.disabled = restarting || ['checking', 'downloading', 'ready', 'activating', 'unsupported'].includes(kind);
      ui.check.textContent = kind === 'checking' ? 'Checking …' : kind === 'downloading' ? 'Downloading …' : 'Check for updates';
    }
    const ready = kind === 'ready';
    toggle(ui.restart, 'd-none', !ready);
    if (ui.restart) ui.restart.disabled = restarting;
    const showBanner = ready && dismissedBuild !== (state.build || 'waiting');
    toggle(ui.banner, 'd-none', !showBanner);
    const label = state.version
      ? `Version ${state.version} (build ${String(state.build || remoteBuild || '').slice(0, 8)})`
      : 'A new version';
    if (showBanner) setText(ui.banner.querySelector('.pwa-banner-text'), `${label} is ready.`);
    const statusText = {
      idle: 'Updates are checked automatically.',
      checking: 'Looking for a new version …',
      current: state.at ? `Up to date (checked ${new Date(state.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}).` : '',
      downloading: `Downloading and verifying the new version${state.total ? ` (${state.done} of ${state.total} files)` : ''} …`,
      ready: `${label} is downloaded and verified. Restart to activate it.`,
      activating: 'Activating the new version …',
      error: state.message,
      unsupported: 'Offline use and automatic updates need HTTPS (or localhost) and service worker support.',
    }[kind];
    setText(ui.status, statusText || '');
  }
  function setState(next) {
    // Never overwrite the ready-to-restart prompt with a late check result.
    if (state.kind === 'ready' && next.kind !== 'activating' && next.kind !== 'error') return;
    state = next;
    draw();
  }
  function onWaiting() {
    if (!navigator.serviceWorker?.controller || !registration?.waiting) return;
    setState({ kind: 'ready', version: remoteVersion, build: remoteBuild || 'waiting' });
  }
  function watchInstalling(worker) {
    if (!worker) return;
    const changed = () => {
      if (worker.state === 'installed') onWaiting();
      if (worker.state === 'redundant' && state.kind === 'downloading') {
        setState({ kind: 'error', message: 'The download could not be completed. Please try again later.' });
      }
    };
    worker.addEventListener('statechange', changed);
    changed();
  }
  let reloaded = false;
  function reloadOnce() {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  }
  async function applyUpdate() {
    if (restarting) return;
    const waiting = registration?.waiting;
    if (!waiting) {
      setState({ kind: 'error', message: 'The new version is no longer ready. Please check for updates again.' });
      return;
    }
    if (window.fileroomBusy?.()) {
      if (!confirm('An upload or recording is in progress and will be cancelled. Restart anyway?')) return;
    } else if (!confirm('Restart FileRoom with the new version? Messages and files in your rooms are kept.')) return;
    restarting = true;
    state = { kind: 'activating' };
    draw();
    const active = () => waiting.state === 'activated' || navigator.serviceWorker.controller === waiting;
    const poll = setInterval(() => {
      if (!active()) return;
      clearInterval(poll);
      reloadOnce();
    }, 250);
    const timeout = setTimeout(() => {
      clearInterval(poll);
      if (active()) return reloadOnce();
      restarting = false;
      setState({ kind: 'error', message: 'Activation failed. Please check for updates again.' });
    }, 20000);
    waiting.addEventListener('statechange', () => {
      if (active()) {
        clearInterval(poll);
        clearTimeout(timeout);
        reloadOnce();
      }
    });
    try { waiting.postMessage({ type: 'SKIP_WAITING' }); }
    catch (e) {
      clearInterval(poll);
      clearTimeout(timeout);
      restarting = false;
      setState({ kind: 'error', message: `Restart failed: ${e.message}` });
    }
  }

  async function checkForUpdates(manual = false) {
    if (!registration || state.kind === 'unsupported' || state.kind === 'ready' || state.kind === 'activating') return;
    if (currentCheck) return currentCheck;
    lastCheck = Date.now();
    if (manual) setState({ kind: 'checking' });
    const check = async () => {
      try {
        const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const online = await res.json();
        if (typeof online.build !== 'string' || !/^[0-9a-f]{12,64}$/.test(online.build)) throw new Error('invalid version file');
        remoteBuild = online.build;
        remoteVersion = String(online.version || '');
        if (registration.waiting) return onWaiting();
        if (online.build === build) {
          if (state.kind !== 'downloading') setState({ kind: 'current', at: Date.now() });
          return;
        }
        setState({ kind: 'downloading', version: remoteVersion, done: 0, total: 0 });
        await registration.update();
        if (registration.waiting) return onWaiting();
        if (!registration.installing) setState({ kind: 'error', message: 'The server reports a new version but still delivers the old service worker. Try again later.' });
      } catch (err) {
        if (manual || state.kind === 'checking' || state.kind === 'downloading') {
          setState({ kind: 'error', message: navigator.onLine ? `Update check failed: ${err.message}` : 'Offline: cannot check for updates right now.' });
        }
      }
    };
    currentCheck = check().finally(() => { currentCheck = null; });
    return currentCheck;
  }
  async function promptInstall() {
    if (installed()) return;
    if (!installEvent) {
      setText(ui.hint, installHint());
      return;
    }
    const event = installEvent;
    installEvent = null;
    try {
      await event.prompt();
      const choice = await event.userChoice;
      installationRequested = choice?.outcome === 'accepted';
    } catch {
      installationRequested = false;
    }
    draw();
  }

  ui.check?.addEventListener('click', () => checkForUpdates(true));
  ui.restart?.addEventListener('click', applyUpdate);
  ui.bannerRestart?.addEventListener('click', applyUpdate);
  ui.install?.addEventListener('click', promptInstall);
  ui.later?.addEventListener('click', () => { dismissedBuild = state.build || 'waiting'; draw(); });
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installEvent = event;
    justInstalled = false;
    installationRequested = false;
    draw();
  });
  window.addEventListener('appinstalled', () => {
    installEvent = null;
    justInstalled = true;
    installationRequested = false;
    draw();
  });
  for (const mode of ['(display-mode: standalone)', '(display-mode: window-controls-overlay)']) {
    window.matchMedia?.(mode)?.addEventListener?.('change', draw);
  }
  window.fileroomPwa = { checkForUpdates: () => checkForUpdates(true), promptInstall, state: () => state };
  draw();
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    return setState({ kind: 'unsupported' });
  }
  navigator.serviceWorker.addEventListener('message', (event) => {
    const d = event.data || {};
    if (d.build === build) return;
    if (d.type === 'INSTALL_PROGRESS') {
      if (d.version) remoteVersion = d.version;
      if (d.build) remoteBuild = d.build;
      if (state.kind !== 'ready' && state.kind !== 'activating' && navigator.serviceWorker.controller) {
        setState({ kind: 'downloading', version: remoteVersion, done: d.done, total: d.total });
      }
    } else if (d.type === 'INSTALL_FAILED') {
      setState({ kind: 'error', message: `The update could not be verified: ${d.error}` });
    }
  });
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) reloadOnce(); // never reload the page on the first install
  });
  // Remove the worker of older FileRoom versions (registered with scope /static/js/).
  navigator.serviceWorker.getRegistrations?.().then((regs) => regs.forEach((reg) => {
    if (new URL(reg.scope).pathname.startsWith('/static/')) reg.unregister();
  })).catch(() => {});
  navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then((reg) => {
    registration = reg;
    reg.addEventListener('updatefound', () => {
      if (navigator.serviceWorker.controller) setState({ kind: 'downloading', version: remoteVersion, done: 0, total: 0 });
      watchInstalling(reg.installing);
    });
    watchInstalling(reg.installing);
    if (reg.waiting && navigator.serviceWorker.controller) onWaiting();
    setTimeout(() => checkForUpdates(), 1500);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - lastCheck >= CHECK_INTERVAL) checkForUpdates();
    });
    window.addEventListener('online', () => checkForUpdates());
    setInterval(() => {
      if (document.visibilityState === 'visible' && Date.now() - lastCheck >= CHECK_INTERVAL) checkForUpdates();
    }, 5 * 60 * 1000);
  }).catch((err) => setState({ kind: 'error', message: `Service worker registration failed: ${err.message}` }));
})();
