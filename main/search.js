// Turns what an agent passes as "url" into a page to load. Search words go to
// DuckDuckGo, and Google search pages are swapped for DuckDuckGo too: Google
// answers automated browsers with a CAPTCHA, which agents may not solve.
const SEARCH = 'https://duckduckgo.com/';

function agentUrl(input) {
  let url = String(input || '').trim();
  if (!url) return SEARCH;
  if (!/^[a-z]+:/i.test(url)) url = /\s/.test(url) || !/\./.test(url) ? `${SEARCH}?q=${encodeURIComponent(url)}` : `https://${url}`;
  let u;
  try { u = new URL(url); } catch { return url; }
  if (/^(www\.)?google\.[a-z.]+$/i.test(u.hostname) && (u.pathname === '/' || u.pathname === '/search' || u.pathname === '/webhp')) {
    const q = u.searchParams.get('q');
    return q ? `${SEARCH}?q=${encodeURIComponent(q)}` : SEARCH;
  }
  return url;
}

module.exports = { agentUrl, SEARCH };
