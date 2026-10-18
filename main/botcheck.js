'use strict';
// Bot checks (reCAPTCHA, hCaptcha, Turnstile, Cloudflare, Google's "unusual traffic"
// page) are for the person watching the app. When one shows up we hand that browser
// to the user and keep the agent's hands off until they press "I'm done".

// Pages that are a check by address alone.
const URL_MARKS = [
  [/^https?:\/\/(www\.)?google\.[a-z.]+\/sorry\//i, 'Google "unusual traffic" check'],
  [/\/cdn-cgi\/challenge-platform\/|[?&]__cf_chl_/i, 'Cloudflare check'],
];

// Only a challenge the user can actually see counts. Many normal login and contact
// forms carry an invisible reCAPTCHA or a badge; those must not lock the agent out.
const DETECT_SCRIPT = `(() => {
  const shown = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 30 && r.height > 30 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.1; };
  const any = sel => [...document.querySelectorAll(sel)].some(shown);
  if (any('iframe[src*="/recaptcha/"][src*="bframe"]')) return 'reCAPTCHA';
  if (any('iframe[src*="/recaptcha/"][src*="anchor"]:not([src*="size=invisible"])')) return 'reCAPTCHA';
  if (any('iframe[src*="hcaptcha.com"]:not([src*="size=invisible"])')) return 'hCaptcha';
  if (any('iframe[src*="challenges.cloudflare.com"], #cf-challenge-running, #challenge-stage')) return 'Cloudflare check';
  if (any('#px-captcha, iframe[src*="arkoselabs"], iframe[src*="funcaptcha"]')) return 'Bot check';
  // Challenge pages are short. Matching phrases on long pages would flag articles about them.
  const text = (document.body?.innerText || '');
  if (text.length > 2500) return null;
  const t = text.toLowerCase();
  const phrases = ['unusual traffic from your computer network', 'verify you are human', 'verifying you are human',
    'are you a robot', 'checking your browser before accessing', 'enable javascript and cookies to continue'];
  return phrases.some(p => t.includes(p)) ? 'Bot check' : null;
})()`;

function fromUrl(url = '') {
  for (const [re, label] of URL_MARKS) if (re.test(url)) return label;
  return null;
}

const message = (kind, url) => {
  let host = url;
  try { host = new URL(url).hostname; } catch { /* keep the raw string */ }
  return `${kind} on ${host}. Complete it in that browser window, then press "I'm done". The AI waits and won't touch it.`;
};

module.exports = { DETECT_SCRIPT, fromUrl, message };
