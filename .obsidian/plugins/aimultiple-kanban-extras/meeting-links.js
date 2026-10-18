'use strict';
// Links stay in the in-memory calendar cache. No requests, HTML rendering or logging.
function safeMeetingUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f\\]/.test(value)) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url.href : '';
  } catch (_) { return ''; }
}
function meetingProvider(value) {
  const safe = safeMeetingUrl(value); if (!safe) return '';
  const host = new URL(safe).hostname;
  if (host === 'meet.google.com') return 'Google Meet';
  if (['zoom.us', 'zoom.com'].some(domain => host === domain || host.endsWith('.' + domain))) return 'Zoom';
  return '';
}
function meetingLink(structured = [], textFields = []) {
  for (const value of structured) { const safe = safeMeetingUrl(value); if (safe) return safe; }
  for (const value of textFields) {
    if (typeof value !== 'string') continue;
    // Decode HTML entities locally; never insert descriptions as HTML.
    const text = value.slice(0, 100000).replace(/&amp;|&#0*38;|&#x0*26;/gi, '&');
    for (const raw of text.match(/https:\/\/[^\s<>"']+/gi) || []) {
      const safe = safeMeetingUrl(raw.replace(/[).,;\]}]+$/, ''));
      if (safe && meetingProvider(safe)) return safe;
    }
  }
  return '';
}
module.exports = { safeMeetingUrl, meetingProvider, meetingLink };
