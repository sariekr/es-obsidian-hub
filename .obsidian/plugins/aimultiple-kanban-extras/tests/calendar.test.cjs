const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const calendarPath=path.join(__dirname,'../calendar.js');
function api(){assert.ok(fs.existsSync(calendarPath),'Local calendar reader must exist');return require(calendarPath);}
const wrap=body=>'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Home test//EN\r\n'+body+'\r\nEND:VCALENDAR';
const event=body=>'BEGIN:VEVENT\r\n'+body+'\r\nEND:VEVENT';
const start=new Date('2026-10-16T00:00:00Z'),end=new Date('2026-10-20T00:00:00Z');
test('iCal Agenda keeps recurrence meeting links and uses changed occurrence links',()=>{
 const ics=wrap([
  event('UID:links\r\nDTSTART:20261016T090000Z\r\nDTEND:20261016T100000Z\r\nRRULE:FREQ=DAILY;COUNT=2\r\nX-GOOGLE-CONFERENCE:https://meet.google.com/aaa-bbbb-ccc'),
  event('UID:links\r\nRECURRENCE-ID:20261017T090000Z\r\nDTSTART:20261017T090000Z\r\nDTEND:20261017T100000Z\r\nDESCRIPTION:Join https://us02web.zoom.us/j/123?pwd=abc'),
 ].join('\r\n'));
 assert.deepEqual(api().calendarAgenda(ics,start,end).map(e=>e.joinUrl),['https://meet.google.com/aaa-bbbb-ccc','https://us02web.zoom.us/j/123?pwd=abc']);
});
test('Google feed accepts only HTTPS calendar.google.com iCal URLs, never arbitrary hosts',()=>{
 const {validateGoogleCalendarUrl}=api();
 assert.equal(validateGoogleCalendarUrl('https://calendar.google.com/calendar/ical/test%40example.com/private-abc/basic.ics'),'https://calendar.google.com/calendar/ical/test%40example.com/private-abc/basic.ics');
 for(const url of ['http://calendar.google.com/calendar/ical/x/basic.ics','https://calendar.google.com.evil.test/calendar/ical/x/basic.ics','https://calendar.google.com@evil.test/a.ics','file:///etc/passwd','https://calendar.google.com/calendar/ical/x/basic.ics?secret=x']) assert.throws(()=>validateGoogleCalendarUrl(url),/Google Calendar/i);
});
test('Agenda expands recurrence, excludes EXDATE and cancelled exceptions, honours moved occurrences',()=>{
 const {calendarAgenda}=api();
 const ics=wrap([
 event('UID:series\r\nDTSTART:20261015T090000Z\r\nDTEND:20261015T093000Z\r\nRRULE:FREQ=DAILY;COUNT=6\r\nEXDATE:20261017T090000Z\r\nSUMMARY:Standup'),
 event('UID:series\r\nRECURRENCE-ID:20261018T090000Z\r\nDTSTART:20261018T110000Z\r\nDTEND:20261018T113000Z\r\nSUMMARY:Moved standup'),
 event('UID:series\r\nRECURRENCE-ID:20261019T090000Z\r\nDTSTART:20261019T090000Z\r\nDTEND:20261019T093000Z\r\nSTATUS:CANCELLED\r\nSUMMARY:Cancelled'),
 ].join('\r\n'));
 const result=calendarAgenda(ics,start,end);assert.equal(result.length,2);
 assert.equal(result[0].start,'2026-10-16T09:00:00.000Z');assert.equal(result[1].start,'2026-10-18T11:00:00.000Z');assert.equal(result[1].title,'Moved standup');
});
test('Agenda handles all-day ranges, folded UTF-8 titles, overlap and cancelled events',()=>{
 const {calendarAgenda}=api();
 const ics=wrap([
 event('UID:all\r\nDTSTART;VALUE=DATE:20261015\r\nDTEND;VALUE=DATE:20261018\r\nSUMMARY:Konferans'),
 event('UID:call\r\nDTSTART:20261016T120000Z\r\nDTEND:20261016T130000Z\r\nSUMMARY:Araştırma\r\n  toplantısı'),
 event('UID:cancel\r\nDTSTART:20261016T120000Z\r\nSTATUS:CANCELLED\r\nSUMMARY:No'),
 ].join('\r\n'));
 const result=calendarAgenda(ics,start,end);assert.equal(result.length,2);assert.equal(result[0].allDay,true);assert.equal(result[0].day,'2026-10-15');assert.equal(result[1].title,'Araştırma toplantısı');
});
test('Agenda applies embedded time zones and fails explicitly on unknown time zones',()=>{
 const {calendarAgenda}=api();
 const zone='BEGIN:VTIMEZONE\r\nTZID:Europe/Istanbul\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0300\r\nTZOFFSETTO:+0300\r\nEND:STANDARD\r\nEND:VTIMEZONE';
 const body=event('UID:tz\r\nDTSTART;TZID=Europe/Istanbul:20261016T120000\r\nDTEND;TZID=Europe/Istanbul:20261016T130000\r\nSUMMARY:Meeting');
 assert.equal(calendarAgenda(wrap(zone+'\r\n'+body),start,end)[0].start,'2026-10-16T09:00:00.000Z');
 assert.throws(()=>calendarAgenda(wrap(body),start,end),/timezone/i);
});
test('Agenda rejects invalid, oversized and excessive recurrence data instead of silent partial results',()=>{
 const {calendarAgenda}=api();
 assert.throws(()=>calendarAgenda('<html>Sign in</html>',start,end),/calendar/i);
 assert.throws(()=>calendarAgenda('x'.repeat(5*1024*1024+1),start,end),/large/i);
 const ics=wrap(event('UID:busy\r\nDTSTART:20000101T000000Z\r\nRRULE:FREQ=MINUTELY\r\nSUMMARY:Busy'));
 assert.throws(()=>calendarAgenda(ics,start,end,{maxIterations:100}),/complex/i);
});
