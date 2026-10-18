// Appearance + mode preferences and the wording that changes with them.
export const prefs = { theme: 'pro', appearance: 'system', mode: 'simple', cursor: { show: true, speed: 'normal', follow: false, captions: true } };

const WORDS = {
  base: {
    library: 'Library', keys: 'API keys', trading: 'Trading', activity: 'Activity', agent: 'Local API', agents: 'Agents',
    stop: 'Stop agent', stopped: 'Agent stopped', resume: 'Resume agent', settings: 'Settings', status: 'Status',
    browser: 'Browser', note: 'Note', file: 'File', folder: 'Folder', fit: 'Fit', organize: 'Organise', chat: 'Assistant', features: 'Features', connectors: 'Connectors',
    pausedBanner: 'Agent stopped. Agent tools and auto-trading are paused.',
  },
  simple: {
    keys: 'Keys', agent: 'Connect AI', agents: 'AI helpers', connectors: 'Phone', activity: 'History', stop: 'Stop AI', stopped: 'AI stopped', resume: 'Let the AI continue',
    folder: 'Folder', fit: 'Show all', chat: 'Ask AI', features: 'What can it do?',
    pausedBanner: 'The AI is stopped. It can’t do anything until you let it continue.',
  },
  game: {
    library: 'Inventory', activity: 'Log', status: 'Status', agents: 'Party', agent: 'Gateway', chat: 'Companion', features: 'Skills',
    pausedBanner: 'Companion halted. All actions and auto-trading are frozen.',
  },
};

export function t(key) {
  return (prefs.theme === 'game' && WORDS.game[key])
    || (prefs.mode === 'simple' && WORDS.simple[key])
    || WORDS.base[key] || key;
}

export const isSimple = () => prefs.mode === 'simple';
export const isGame = () => prefs.theme === 'game';

const media = window.matchMedia('(prefers-color-scheme: dark)');

export function resolvedAppearance() {
  if (prefs.theme === 'game') return 'dark';
  if (prefs.appearance === 'system') return media.matches ? 'dark' : 'light';
  return prefs.appearance;
}

const listeners = new Set();
export function onPrefsChange(fn) { listeners.add(fn); }

export function applyPrefs() {
  const root = document.documentElement;
  root.dataset.theme = prefs.theme;
  root.dataset.appearance = resolvedAppearance();
  root.dataset.mode = prefs.mode;
  for (const el of document.querySelectorAll('[data-word]')) el.textContent = t(el.dataset.word);
  for (const fn of listeners) fn(prefs);
}

export async function setPrefs(patch) {
  Object.assign(prefs, patch);
  applyPrefs();
  await window.ac.setUi({ theme: prefs.theme, appearance: prefs.appearance, mode: prefs.mode, cursor: prefs.cursor });
}

export function loadPrefs(ui = {}) {
  if (['pro', 'game'].includes(ui.theme)) prefs.theme = ui.theme;
  if (['system', 'light', 'dark'].includes(ui.appearance)) prefs.appearance = ui.appearance;
  if (['simple', 'technical'].includes(ui.mode)) prefs.mode = ui.mode;
  if (ui.cursor && typeof ui.cursor === 'object') prefs.cursor = { ...prefs.cursor, ...ui.cursor };
  applyPrefs();
}

media.addEventListener('change', () => { if (prefs.appearance === 'system') applyPrefs(); });
