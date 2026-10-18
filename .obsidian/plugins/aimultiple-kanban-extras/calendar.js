'use strict';
// A read-only iCalendar adapter. Parsing stays local; this module makes no requests.
const ICAL = require('./vendor/ical.cjs');
const { meetingLink } = require('./meeting-links.js');

function validateGoogleCalendarUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch (_) { /* safe error below */ }
  if (!url || url.protocol !== 'https:' || url.hostname !== 'calendar.google.com' || url.port ||
      url.username || url.password || url.search || url.hash ||
      !/^\/calendar\/ical\/[^/]+\/(private-[^/]+|public)\/(basic|full)\.ics$/.test(url.pathname)) {
    throw new Error('Use the Google Calendar Secret address in iCal format (HTTPS).');
  }
  return url.href;
}

function calendarAgenda(text, from, until, { maxIterations = 50000 } = {}) {
  if (typeof text !== 'string' || text.length > 5 * 1024 * 1024) throw new Error('Calendar feed is too large. Use a smaller calendar.');
  if (!text.trimStart().startsWith('BEGIN:VCALENDAR')) throw new Error('Google did not return a calendar feed. Check the iCal address.');
  const controlled = message => { const error = new Error(message); error.calendarSafe = true; throw error; };
  try {
    ICAL.TimezoneService.reset();
    const root = new ICAL.Component(ICAL.parse(text));
    for (const zone of root.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(zone);
    const components = root.getAllSubcomponents('vevent');
    if (components.length > 10000) controlled('Calendar feed is too large. Use a smaller calendar.');
    for (const component of components) {
      for (const key of ['dtstart', 'dtend', 'recurrence-id', 'exdate', 'rdate']) {
        for (const prop of component.getAllProperties(key)) {
          const tzid = prop.getParameter('tzid');
          if (tzid && !ICAL.TimezoneService.get(tzid)) controlled('Calendar timezone is missing from the feed. Export a feed with VTIMEZONE data.');
          if (key === 'recurrence-id' && prop.getParameter('range')) controlled('This calendar uses unsupported future-series exceptions. Open Google Calendar for the complete schedule.');
        }
      }
    }
    const exceptions = new Map();
    for (const comp of components.filter(c => c.hasProperty('recurrence-id'))) {
      const uid = comp.getFirstPropertyValue('uid');
      if (!exceptions.has(uid)) exceptions.set(uid, new Map());
      exceptions.get(uid).set(comp.getFirstPropertyValue('recurrence-id').toString(), comp);
    }
    const result = [], seen = new Set(); let iterations = 0;
    const deadline = Date.now() + 500;
    const add = (event, begin, finish, key) => {
      if (event.component.getFirstPropertyValue('status') === 'CANCELLED' || !begin || seen.has(key)) return;
      const start = begin.toJSDate(), end = finish?.toJSDate() || start;
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) controlled('Calendar contains an invalid event date.');
      if (start >= until || (end > start ? end <= from : start < from)) return;
      seen.add(key);
      const prop = name => event.component.getFirstPropertyValue(name);
      const joinUrl = meetingLink([prop('x-google-conference')], [prop('url'), prop('location'), prop('description')]);
      result.push({ id: key, title: String(event.summary || 'Untitled event'), start: start.toISOString(), end: end.toISOString(),
        allDay: !!begin.isDate, day: `${begin.year}-${String(begin.month).padStart(2, '0')}-${String(begin.day).padStart(2, '0')}`, joinUrl });
    };
    for (const comp of components) {
      if (comp.getFirstPropertyValue('status') === 'CANCELLED') continue;
      const event = new ICAL.Event(comp, { exceptions: [] });
      if (!event.startDate) continue;
      if (event.isRecurrenceException()) {
        add(event, event.startDate, event.endDate, `${event.uid}/${event.recurrenceId}`); continue;
      }
      if (!event.isRecurring()) { add(event, event.startDate, event.endDate, event.uid); continue; }
      const iterator = event.iterator();
      for (let next; (next = iterator.next());) {
        if (++iterations > maxIterations || Date.now() > deadline) controlled('Calendar recurrence is too complex to display safely. Open Google Calendar for the complete schedule.');
        if (next.toJSDate() >= until) break;
        if (exceptions.get(event.uid)?.has(next.toString())) continue;
        const details = event.getOccurrenceDetails(next);
        add(event, details.startDate, details.endDate, `${event.uid}/${next}`);
      }
    }
    return result.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  } catch (error) {
    if (error.calendarSafe) throw error;
    // Never expose raw feed content or parser data in a notice or log.
    throw new Error('Calendar feed could not be read. Check its iCal format.');
  }
}
module.exports = { validateGoogleCalendarUrl, calendarAgenda };
