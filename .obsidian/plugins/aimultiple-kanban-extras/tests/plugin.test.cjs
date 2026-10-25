const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const taxonomy = JSON.parse(fs.readFileSync(path.join(root, '../../../Hub/_kanban/taxonomy.md'), 'utf8').match(/^```json\n([\s\S]*?)\n```/m)[1]);
Object.assign(taxonomy,{folder_to_category:{Data:'data',MSc:'msc',Personal:'personal',Other:'other'},view_to_folder:{Data:'Hub/Data',MSc:'Hub/MSc',Benchmark:'Hub/Benchmark'}});
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };


function refreshClock() {
 const clock={now:Date.now()};
 clock.Date=class extends Date {static now(){return clock.now;}};
 return clock;
}

test('The Home timer reaches due automatic reads and unload clears its scheduled callback',async()=>{
 const clock=refreshClock(),timers=new Map();let timerId=0;
 const f=fixture([],{}, {Date:clock.Date,setTimeout:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id)});
 await f.start();const p=f.plugin;p.refreshHomes=()=>{};
 p.toolbars.set({}, {home:{isConnected:true,ownerDocument:{},getClientRects:()=>[{}]},homePanel:'calendar',widgets:{youtrack:{isConnected:true}}});
 p.calendarEnabled=true;f.secrets.set('es-hub-google-ical','https://calendar.google.com/calendar/ical/example/basic.ics');
 p.calendarNextRefresh=clock.now+600000;let calendars=0,youtracks=0;
 p.fetchCalendarFeed=async()=>{calendars++;return {fetchedAt:clock.now,events:[]};};
 const snapshot={...widgetSnapshot(),fetchedAt:new Date(clock.now).toISOString()};
 f.app.vault.adapter.read=async()=>JSON.stringify(snapshot);
 p.fetchYouTrackSnapshot=async()=>{youtracks++;return {...snapshot,fetchedAt:new Date(clock.now).toISOString()};};p.persistYouTrackSnapshot=async()=>{};
 clock.now+=600000;const tick=timers.get(p.homeTimer);assert.equal(tick.delay,60000);timers.delete(p.homeTimer);tick.fn();await flush();
 assert.equal(calendars,1);assert.equal(youtracks,0);
 clock.now+=6*3600000;const next=timers.get(p.homeTimer);timers.delete(p.homeTimer);next.fn();await flush();assert.equal(youtracks,1);
 const pending=p.homeTimer;p.toolbars.clear();p.unload();assert.equal(timers.has(pending),false);
});

test('YouTrack auto refresh waits six hours, defers hidden views and shares manual busy state',async()=>{
 const clock=refreshClock(),f=fixture([],{}, {Date:clock.Date});await f.start();const p=f.plugin;
 assert.equal(typeof p.autoRefreshYouTrack,'function');p.refreshHomes=()=>{};
 const entry={home:{isConnected:true,ownerDocument:{visibilityState:'visible'},getClientRects:()=>[{}]},widgets:{youtrack:{isConnected:true}}};
 p.toolbars.set({},entry);p.youtrackSnapshot={...widgetSnapshot(),fetchedAt:new Date(clock.now).toISOString()};
 let calls=0,release;p.fetchYouTrackSnapshot=()=>{calls++;return new Promise(r=>release=r);};p.persistYouTrackSnapshot=async()=>{};
 clock.now+=6*3600000-1;assert.equal(p.autoRefreshYouTrack(),false);
 clock.now++;const profile=p.youtrackProfile;p.youtrackProfile=null;assert.equal(p.autoRefreshYouTrack(),false);p.youtrackProfile=profile;
 p.youtrackModal={};assert.equal(p.autoRefreshYouTrack(),false);p.youtrackModal=null;p.youtrackSetupBusy=true;assert.equal(p.autoRefreshYouTrack(),false);p.youtrackSetupBusy=false;
 p.homeCollapsed=true;assert.equal(p.autoRefreshYouTrack(),false);p.homeCollapsed=false;
 entry.home.ownerDocument.visibilityState='hidden';assert.equal(p.autoRefreshYouTrack(),false);entry.home.ownerDocument.visibilityState='visible';
 p.youtrackImports.set('DEMO-1',true);assert.equal(p.autoRefreshYouTrack(),false);p.youtrackImports.clear();
 assert.equal(p.autoRefreshYouTrack(),true);assert.equal(p.autoRefreshYouTrack(),false);await p.refreshYouTrack();assert.equal(calls,1);
 release({...widgetSnapshot(),fetchedAt:new Date(clock.now).toISOString()});await flush();
 assert.equal(p.youtrackNextRefresh,clock.now+6*3600000);assert.equal(p.autoRefreshYouTrack(),false);
 p.toolbars.clear();p.unload();clock.now+=6*3600000;assert.equal(p.autoRefreshYouTrack(),false);assert.equal(f.saves.length,0);
});

test('Failed YouTrack auto reads retain the snapshot and wait six hours before retrying',async()=>{
 const clock=refreshClock(),f=fixture([],{}, {Date:clock.Date});await f.start();const p=f.plugin;
 assert.equal(typeof p.autoRefreshYouTrack,'function');p.refreshHomes=()=>{};
 p.toolbars.set({}, {home:{isConnected:true,ownerDocument:{},getClientRects:()=>[{}]},widgets:{youtrack:{isConnected:true}}});
 const old={...widgetSnapshot(),fetchedAt:new Date(clock.now-7*3600000).toISOString()};p.youtrackSnapshot=old;
 let calls=0;p.fetchYouTrackSnapshot=async()=>{calls++;throw Error('PRIVATE_FAILURE');};
 assert.equal(p.autoRefreshYouTrack(),true);await flush();assert.equal(p.youtrackSnapshot,old);
 clock.now+=60000;assert.equal(p.autoRefreshYouTrack(),false);assert.equal(calls,1);assert.ok(!p.youtrackRefreshError.includes('PRIVATE_FAILURE'));
 clock.now+=6*3600000;assert.equal(p.autoRefreshYouTrack(),true);await flush();assert.equal(calls,2);p.toolbars.clear();p.unload();
});

test('Calendar auto refresh waits ten minutes after completion and only runs on its visible tab',async()=>{
 const clock=refreshClock(),f=fixture([],{}, {Date:clock.Date});await f.start();const p=f.plugin;
 assert.equal(typeof p.autoRefreshCalendar,'function');const entry=groupedHomeEntry(f);p.refreshHomes=()=>{};
 p.calendarEnabled=true;p.calendarSource='ical';f.secrets.set('es-hub-google-ical','https://calendar.google.com/calendar/ical/example/basic.ics');
 // The adapter is stubbed; no token or external request is needed.
 p.fetchCalendarFeed=async()=>({fetchedAt:clock.now,events:[]});
 let calls=0;const read=p.refreshCalendar.bind(p);p.refreshCalendar=(...args)=>{calls++;return read(...args);};
 assert.equal(p.autoRefreshCalendar(),true);await flush();assert.equal(p.calendarNextRefresh,clock.now+600000);
 clock.now+=599999;assert.equal(p.autoRefreshCalendar(),false);clock.now++;
 entry.homePanel='mail';assert.equal(p.autoRefreshCalendar(),false);entry.homePanel='calendar';
 p.calendarModal={};assert.equal(p.autoRefreshCalendar(),false);p.calendarModal=null;
 assert.equal(p.autoRefreshCalendar(),true);await flush();assert.equal(calls,2);p.toolbars.clear();p.unload();
});

test('A freshly connected Calendar waits ten minutes before its first automatic read',async()=>{
 const clock=refreshClock(),f=fixture([],{}, {Date:clock.Date});await f.start();const p=f.plugin;p.refreshHomes=()=>{};
 groupedHomeEntry(f);p.calendarEnabled=true;p.calendarCache={fetchedAt:clock.now,events:[]};
 let reads=0;p.refreshCalendar=async()=>{reads++;};
 clock.now+=599999;assert.equal(p.autoRefreshCalendar(),false);assert.equal(reads,0);
 clock.now++;assert.equal(p.autoRefreshCalendar(),true);assert.equal(reads,1);p.toolbars.clear();p.unload();
});

test('Mail uses a ten-minute completion interval and preserves permission-denial suppression',async()=>{
 const clock=refreshClock(),f=fixture([],{}, {Date:clock.Date});await f.start();const p=f.plugin;p.refreshHomes=()=>{};
 p.mailSupported=()=>true;p.mailEnabled=true;p.fetchMailSnapshot=async()=>mailFixtureSnapshot();
 await p.refreshMail();assert.equal(p.mailNextRefresh,clock.now+600000);
 const entry=groupedHomeEntry(f);entry.homePanel='mail';clock.now+=600000;p.mailPermissionError=true;
 assert.equal(p.autoRefreshMail(),false);p.toolbars.clear();p.unload();
});

test('Refresh all widgets reads connected sources once, including an inactive Mail tab, and waits for every source',async()=>{
 const f=fixture();await f.start();const p=f.plugin;assert.equal(typeof p.refreshAllWidgets,'function');
 p.refreshHomes=()=>{};p.calendarEnabled=true;p.mailEnabled=true;p.mailSupported=()=>true;p.slackConnected=true;
 const calls=[],finish={};for(const source of ['Calendar','Mail','YouTrack','Slack'])p['refresh'+source]=()=>{calls.push(source);return new Promise(r=>finish[source]=r);};
 p.homeCollapsed=true;const first=p.refreshAllWidgets();await flush();await p.refreshAllWidgets();
 assert.deepEqual(calls,['Calendar','Mail','YouTrack','Slack']);assert.equal(p.widgetsRefreshing,true);
 finish.Calendar();finish.Mail();finish.Slack();await flush();assert.equal(p.widgetsRefreshing,true);finish.YouTrack();await first;
 assert.equal(p.widgetsRefreshing,false);assert.equal(f.saves.length,0);p.unload();await p.refreshAllWidgets();assert.equal(calls.length,4);
});

test('Refresh all widgets skips disconnected/editing sources and isolates failures without leaking details',async()=>{
 const f=fixture();await f.start();const p=f.plugin;assert.equal(typeof p.refreshAllWidgets,'function');p.refreshHomes=()=>{};
 const profile=p.youtrackProfile;p.youtrackProfile=null;
 const calls=[];for(const source of ['Calendar','Mail','YouTrack','Slack'])p['refresh'+source]=async()=>{calls.push(source);if(source==='YouTrack')throw Error('PRIVATE_FAILURE');};
 await p.refreshAllWidgets();assert.deepEqual(calls,[]);assert.equal(f.modals.length,0);
 p.youtrackProfile=profile;p.calendarEnabled=true;p.mailEnabled=true;p.mailSupported=()=>true;p.slackConnected=true;
 await p.refreshAllWidgets();assert.deepEqual(calls,['Calendar','Mail','YouTrack','Slack']);assert.equal(p.widgetsRefreshing,false);
 assert.ok(f.notices.some(x=>/could not refresh/i.test(x)));assert.ok(!f.notices.some(x=>x.includes('PRIVATE_FAILURE')));
 p.calendarModal={};p.mailModal={};p.slackModal={};p.youtrackModal={};
 calls.length=0;await p.refreshAllWidgets();assert.deepEqual(calls,[]);
 p.youtrackModal=null;p.youtrackSetupBusy=true;await p.refreshAllWidgets();assert.deepEqual(calls,[]);
 p.calendarModal=null;p.mailModal=null;p.slackModal=null;p.unload();
});

test('Type icons are explicit preferences, with a neutral fallback and no startup writes',async()=>{
 const f=fixture([], {typeIcons:{Data:'flask-conical',MSc:'not-a-real-icon',Personal:'<svg onload=alert(1)>'}});await f.start();
 assert.equal(typeof f.plugin.typeIcon,'function');
 assert.equal(f.plugin.typeIcon('Data'),'flask-conical');
 assert.equal(f.plugin.typeIcon('MSc'),'folder');
 assert.equal(f.plugin.typeIcon('Personal'),'folder');
 assert.equal(f.plugin.typeIcon('Quick Notes'),'folder');
 assert.equal(f.plugin.typeIcon('Unfamiliar name'),'folder');
 assert.equal(f.saves.length,0);f.plugin.unload();
});

test('Choosing and resetting a Type icon preserves notes and unrelated settings and survives reload',async()=>{
 const f=fixture([['Hub/Data/Report.md',{tags:['kanban'],category:'Data',priority:'high'}]],{homeCollapsed:true,unrelated:{keep:7}});await f.start();
 assert.equal(typeof f.plugin.setTypeIcon,'function');
 const file=f.files.get('Hub/Data/Report.md');file.content='Keep this body';const fm=JSON.stringify(f.caches.get(file.path));
 await f.plugin.setTypeIcon('Data','flask-conical');
 assert.equal(f.plugin.typeIcon('Data'),'flask-conical');
 assert.equal(f.plugin.boardCardModel(file).typeIcon,'flask-conical');
 assert.equal(f.saves.at(-1).homeCollapsed,true);assert.deepEqual(f.saves.at(-1).unrelated,{keep:7});
 assert.equal(file.path,'Hub/Data/Report.md');assert.equal(file.content,'Keep this body');assert.equal(JSON.stringify(f.caches.get(file.path)),fm);assert.equal(f.moves.length,0);
 const reloaded=fixture([],f.saves.at(-1));await reloaded.start();assert.equal(reloaded.plugin.typeIcon('Data'),'flask-conical');reloaded.plugin.unload();
 await f.plugin.setTypeIcon('Data','folder');assert.equal(f.plugin.typeIcon('Data'),'folder');assert.equal(Object.hasOwn(f.saves.at(-1).typeIcons,'Data'),false);
 f.plugin.unload();
});

test('Type icon writes serialize with widget settings and keep previous appearance when saving fails',async()=>{
 const f=fixture([],{unrelated:'keep'});await f.start();
 assert.equal(typeof f.plugin.setTypeIcon,'function');
 await Promise.all([f.plugin.setTypeIcon('Data','code'),f.plugin.setTypeIcon('MSc','book-open'),f.plugin.setHomeCollapsed(true)]);
 assert.equal(f.saves.at(-1).typeIcons.Data,'code');assert.equal(f.saves.at(-1).typeIcons.MSc,'book-open');assert.equal(f.saves.at(-1).homeCollapsed,true);
 f.plugin.saveData=async()=>{throw Error('Disk full');};
 await assert.rejects(f.plugin.setTypeIcon('Data','heart'),/Disk full/);assert.equal(f.plugin.typeIcon('Data'),'code');
 f.plugin.unload();
});

test('Type icon changes reject invalid icons, missing or replaced folders, external conflicts and unload',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.setTypeIcon,'function');
 await assert.rejects(f.plugin.setTypeIcon('Missing','book-open'),/folder/i);
 await assert.rejects(f.plugin.setTypeIcon('Data','url(https://example.test)'),/icon/i);
 let release;f.plugin.tagSuggestionSave=new Promise(r=>release=r);
 const pending=f.plugin.setTypeIcon('Data','book-open');const folder=f.files.get('Hub/Data');
 f.files.set('Hub/Data',{...folder});release();await assert.rejects(pending,/folder/i);assert.equal(f.saves.length,0);
 f.files.set('Hub/Data',folder);
 f.plugin.loadData=async()=>({typeIcons:{Data:'heart'}});
 await assert.rejects(f.plugin.setTypeIcon('Data','book-open'),/changed/i);assert.equal(f.saves.length,0);
 f.plugin.unload();await assert.rejects(f.plugin.setTypeIcon('Data','book-open'),/closed/i);assert.equal(f.saves.length,0);
});

test('Board excerpts use the next-step section without YAML, fenced examples or empty placeholders',async()=>{
 const f=fixture();await f.start();
 assert.equal(typeof f.plugin.boardNextStep,'function');
 const text='---\nsecret: not a preview\n---\n```md\n## Sonraki adım\nWrong example\n```\n## Sonraki adım\n\n- [ ] **Read** [[Report|the report]] and [compare](https://example.test).\n## Tamamlanma kriteri\nDo not include';
 assert.equal(f.plugin.boardNextStep(text),'Read the report and compare.');
 assert.equal(f.plugin.boardNextStep('## Sonraki adım\n- [ ]\n## Tamamlanma kriteri\nDone'),'');
 assert.equal(f.plugin.boardNextStep('# Ordinary note\nBody without a next step'),'');
 assert.equal(f.plugin.boardNextStep('## Next step\n<!--\nHidden\n-->\nCompare model_name and \x60api_key\x60.'),'Compare model_name and api_key.');
 assert.equal(f.plugin.boardNextStep('## Next step\n'+'x'.repeat(400)).length,180);
 f.plugin.unload();
});

test('Board filters combine title or ID search with the effective live Type without writing metadata',async()=>{
 const f=fixture([['Hub/MSc/Nested/İSTATİSTİK.md',{tags:['kanban'],category:'msc',priority:'high',youtrack_id:'TEAM-123'}]]);await f.start();
 assert.equal(typeof f.plugin.boardCardModel,'function');
 const file=f.files.get('Hub/MSc/Nested/İSTATİSTİK.md');const before=JSON.stringify(f.caches.get(file.path));
 const model=f.plugin.boardCardModel(file,'İSTATİSTİK araştırması');
 assert.equal(model.type,'MSc');assert.equal(model.priority,'High');
 assert.equal(f.plugin.boardCardMatches(model,'istatistik','MSc'),true);
 assert.equal(f.plugin.boardCardMatches(model,'team-123','MSc'),true);
 assert.equal(f.plugin.boardCardMatches(model,'istatistik','Data'),false);
 assert.equal(f.plugin.boardCardMatches(model,'missing',''),false);
 assert.equal(JSON.stringify(f.caches.get(file.path)),before);assert.equal(f.saves.length,0);
 f.caches.get(file.path).frontmatter.category='gone';assert.equal(f.plugin.boardCardModel(file).type,'MSc');
 f.plugin.unload();
});

test('Board excerpt reads are shared and reject late results after invalidation or unload',async()=>{
 const f=fixture([['Hub/Other/Task.md',{tags:['kanban']}]]);await f.start();
 assert.equal(typeof f.plugin.loadBoardExcerpt,'function');
 const file=f.files.get('Hub/Other/Task.md');let release,reads=0;
 f.app.vault.cachedRead=()=>{reads++;return new Promise(r=>release=r);};
 const first=f.plugin.loadBoardExcerpt(file),same=f.plugin.loadBoardExcerpt(file);
 assert.equal(reads,1);f.plugin.invalidateBoardNote(file);release('## Sonraki adım\nOld');
 assert.equal(await first,null);assert.equal(await same,null);
 const second=f.plugin.loadBoardExcerpt(file);release('## Sonraki adım\nCurrent');assert.equal(await second,'Current');
 assert.equal(await f.plugin.loadBoardExcerpt(file),'Current');assert.equal(reads,2);
 f.plugin.invalidateBoardNote(file);const last=f.plugin.loadBoardExcerpt(file);f.plugin.unload();release('## Sonraki adım\nLate');assert.equal(await last,null);
});

test('Board preview removes frontmatter, bounds text and rejects deleted or moved targets after a read',async()=>{
 const f=fixture([['Hub/Other/Task.md',{tags:['kanban']}]]);await f.start();
 assert.equal(typeof f.plugin.readBoardPreview,'function');
 const file=f.files.get('Hub/Other/Task.md');file.content='---\nprivate_metadata: value\n---\n# Heading\nBody';
 const preview=await f.plugin.readBoardPreview(file);assert.equal(preview.body,'# Heading\nBody');assert.equal(preview.truncated,false);
 file.content='x'.repeat(60000);const long=await f.plugin.readBoardPreview(file);assert.equal(long.body.length,50000);assert.equal(long.truncated,true);
 let release;f.app.vault.cachedRead=()=>new Promise(r=>release=r);const pending=f.plugin.readBoardPreview(file);
 f.files.delete(file.path);release('Old body');await assert.rejects(pending,/changed|found/i);
 f.plugin.unload();
});

test('Calendar and Mail merge legacy slots without writing startup settings or losing hidden choices',async()=>{
 for (const [saved,expected] of [
  [['calendar','youtrack','mail'],['calendar','youtrack','slack']],
  [['mail','slack','youtrack'],['calendar','youtrack','slack']],
  [['calendar','mail','slack'],['calendar','youtrack','slack']],
  [['mail','youtrack'],['calendar','youtrack']],
  [['slack'],['slack']],
  [[],[]],
 ]) {
  const f=fixture([],{homeModules:saved,homeLayoutVersion:1,slackModuleKnown:true,other:'keep'});await f.start();
  assert.deepEqual(Array.from(f.plugin.homeModules),expected);assert.equal(f.saves.length,0);f.plugin.unload();
 }
});

test('Grouped widget visibility saves preserve unrelated settings and failures keep the previous layout',async()=>{
 const f=fixture([],{homeModules:['calendar','youtrack','mail'],homeLayoutVersion:1,other:'keep'});await f.start();
 await f.plugin.setHomeModule('calendar',false);
 assert.deepEqual(f.saves.at(-1).homeModules,['youtrack','slack']);assert.equal(f.saves.at(-1).other,'keep');
 assert.equal(f.saves.at(-1).homeLayoutVersion,2);
 await f.plugin.setHomeModule('calendar',true);assert.deepEqual(Array.from(f.plugin.homeModules),['calendar','youtrack','slack']);
 await assert.rejects(()=>f.plugin.setHomeModule('mail',true),/module/i);
 f.plugin.saveData=async()=>{throw Error('disk full');};
 await assert.rejects(()=>f.plugin.setHomeModule('calendar',false),/disk full/);
 assert.deepEqual(Array.from(f.plugin.homeModules),['calendar','youtrack','slack']);assert.equal(f.plugin.homeSaving,false);f.plugin.unload();
});

test('Mail stays closed and disconnected on startup, with no settings writes or automatic read',async()=>{
 const f=fixture();let calls=0;f.plugin.fetchMailSnapshot=async()=>{calls++;};await f.start();
 assert.equal(f.plugin.mailEnabled,false);assert.equal(f.plugin.mailSnapshot,null);
 assert.deepEqual(Array.from(f.plugin.homeModules),['calendar','youtrack','slack']);
 assert.equal(calls,0);assert.equal(f.saves.length,0);f.plugin.unload();
});

function mailFixtureSnapshot(){return {schema:1,accounts:[{id:'a',name:'Example',limited:false}],rows:[
 {id:12,accountId:'a',mailbox:'INBOX',messageId:'example@local.test',subject:'<script>literal</script>',sender:'Example sender',receivedAt:Date.now()-1000,read:false}
]};}

test('Mail validates snapshots, shares busy state, keeps the last result on error and disconnects locally',async()=>{
 const f=fixture();await f.start();let release,calls=0;
 f.plugin.mailSupported=()=>true;f.plugin.fetchMailSnapshot=()=>{calls++;return new Promise(r=>release=r);};
 assert.equal(typeof f.plugin.refreshMail,'function');
 const job=f.plugin.refreshMail(true);await f.flush();await f.plugin.refreshMail(true);assert.equal(calls,1);
 release(mailFixtureSnapshot());await job;
 assert.equal(f.plugin.mailEnabled,true);assert.equal(f.plugin.mailSnapshot.rows.length,1);assert.equal(f.saves.length,0);
 const snapshot=f.plugin.mailSnapshot;
 f.plugin.fetchMailSnapshot=async()=>({...mailFixtureSnapshot(),rows:[{...mailFixtureSnapshot().rows[0],accountId:'not-in-snapshot'}]});
 await f.plugin.refreshMail();assert.equal(f.plugin.mailSnapshot,snapshot);assert.match(f.plugin.mailError,/valid|read|refresh/i);
 await f.plugin.disconnectMail();assert.equal(f.plugin.mailEnabled,false);assert.equal(f.plugin.mailSnapshot,null);f.plugin.unload();
});

test('Mail ignores pending results after disconnect and only auto reads while visible',async()=>{
 const f=fixture();await f.start();f.plugin.mailSupported=()=>true;let release,calls=0;
 f.plugin.fetchMailSnapshot=()=>{calls++;return new Promise(r=>release=r);};
 assert.equal(typeof f.plugin.autoRefreshMail,'function');
 f.plugin.mailEnabled=true;f.plugin.mailNextRefresh=0;
 assert.equal(f.plugin.autoRefreshMail(),false);assert.equal(calls,0);
 const job=f.plugin.refreshMail();await f.flush();await f.plugin.disconnectMail();release(mailFixtureSnapshot());await job;
 assert.equal(f.plugin.mailSnapshot,null);assert.equal(f.plugin.mailEnabled,false);f.plugin.unload();
});

function groupedHomeEntry(f) {
 const node=()=>{const n=new Dom();n.isConnected=true;n.getClientRects=()=>[{}];n.hidden=false;n.append=(...items)=>n.children.push(...items);n.replaceChildren=()=>{n.children=[];};n.focus=()=>{f.doc.activeElement=n;};return n;};
 f.doc.createElement=()=>node();
 const entry={scope:{ownerDocument:f.doc},home:node(),homePanel:'calendar',calendarPanel:node(),mailPanel:node(),calendarMainTab:node(),mailMainTab:node(),
  calendarMode:'month',selectedDay:'2026-11-19',calendarMonth:'2026-11',mailAccount:'a',mailFilter:'unread',agenda:node(),mailList:node(),panelScroll:{}};
 for (const name of ['calendarDays','monthTab','agendaTab','calendarPrevious','calendarNext','calendarConnect','calendarStatus']) entry[name]=node();
 entry.home.ownerDocument=f.doc;entry.agenda.scrollTop=48;entry.mailList.scrollTop=120;
 f.plugin.toolbars.set({},entry);return entry;
}

test('Calendar and Mail tabs preserve each view and scroll without settings writes or reconnecting',async()=>{
 const f=fixture();await f.start();const entry=groupedHomeEntry(f);let reads=0;
 f.plugin.mailEnabled=false;f.plugin.fetchMailSnapshot=async()=>{reads++;return mailFixtureSnapshot();};
 assert.equal(typeof f.plugin.setHomePanel,'function');
 f.plugin.setHomePanel(entry,'mail');
 assert.equal(entry.calendarPanel.hidden,true);assert.equal(entry.mailPanel.hidden,false);
 assert.equal(entry.mailMainTab.getAttribute('aria-selected'),'true');assert.equal(entry.mailMainTab.tabIndex,0);assert.equal(entry.calendarMainTab.tabIndex,-1);
 assert.equal(entry.calendarMonth,'2026-11');assert.equal(entry.selectedDay,'2026-11-19');assert.equal(entry.calendarMode,'month');
 assert.equal(entry.mailAccount,'a');assert.equal(entry.mailFilter,'unread');assert.equal(entry.mailList.scrollTop,120);
 f.plugin.setHomePanel(entry,'calendar');assert.equal(entry.calendarPanel.hidden,false);assert.equal(entry.mailPanel.hidden,true);
 assert.equal(entry.agenda.scrollTop,48);assert.equal(reads,0);assert.equal(f.saves.length,0);
 f.plugin.setHomePanel(entry,'unknown');assert.equal(entry.homePanel,'calendar');f.plugin.toolbars.clear();f.plugin.unload();
});

test('Mail automatic reads require its active tab in a visible grouped widget and respect the cooldown',async()=>{
 const f=fixture();await f.start();const entry=groupedHomeEntry(f);let reads=0,release;
 f.plugin.mailEnabled=true;f.plugin.mailNextRefresh=0;f.plugin.refreshHomes=()=>{};
 f.plugin.fetchMailSnapshot=()=>{reads++;return new Promise(r=>release=r);};
 assert.equal(f.plugin.autoRefreshMail(),false);
 f.plugin.setHomePanel(entry,'mail');assert.equal(reads,1);assert.equal(f.plugin.mailBusy,true);
 f.plugin.setHomePanel(entry,'calendar');f.plugin.setHomePanel(entry,'mail');assert.equal(reads,1);
 release(mailFixtureSnapshot());await f.flush();
 f.plugin.setHomePanel(entry,'calendar');f.plugin.setHomePanel(entry,'mail');assert.equal(reads,1);
 f.plugin.mailNextRefresh=0;f.plugin.homeCollapsed=true;assert.equal(f.plugin.autoRefreshMail(),false);
 f.plugin.homeCollapsed=false;f.plugin.homeModules=['youtrack','slack'];assert.equal(f.plugin.autoRefreshMail(),false);
 f.plugin.toolbars.clear();f.plugin.unload();
});

test('Returning to Calendar starts a missing month that was deferred while Mail was visible',async()=>{
 const f=fixture();await f.start();const entry=groupedHomeEntry(f);const reads=[];
 f.plugin.calendarEnabled=true;f.plugin.calendarCache={kind:'google',fetchedAt:123,months:new Map([['2026-10',[]]])};
 f.plugin.refreshCalendar=async(manual,month)=>{reads.push(month);};
 f.plugin.setHomePanel(entry,'mail');
 f.plugin.updateCalendarAgenda(entry);assert.equal(reads.length,0);assert.match(entry.agenda.children.at(-1).textContent,/Loading this month/);
 f.plugin.setHomePanel(entry,'calendar');assert.deepEqual(reads,['2026-11']);assert.equal(entry.agenda.scrollTop,48);
 f.plugin.toolbars.clear();f.plugin.unload();
});

test('Mail rejects duplicate identities, excessive per-account rows, bad dates and raw failures atomically',async()=>{
 const f=fixture();await f.start();f.plugin.mailSupported=()=>true;
 f.plugin.fetchMailSnapshot=async()=>mailFixtureSnapshot();await f.plugin.refreshMail(true);
 const good=f.plugin.mailSnapshot, sample=mailFixtureSnapshot();
 for(const bad of [
  {...sample,rows:[sample.rows[0],sample.rows[0]]},
  {...sample,rows:Array.from({length:51},(_,i)=>({...sample.rows[0],id:i+1}))},
  {...sample,rows:[{...sample.rows[0],receivedAt:NaN}]},
  {...sample,accounts:[...sample.accounts,...sample.accounts]},
 ]){f.plugin.fetchMailSnapshot=async()=>bad;await f.plugin.refreshMail();assert.equal(f.plugin.mailSnapshot,good);}
 f.plugin.fetchMailSnapshot=async()=>{throw Error('private content must not escape');};await f.plugin.refreshMail();
 assert.ok(!f.plugin.mailError.includes('private content'));assert.equal(f.plugin.mailSnapshot,good);f.plugin.unload();
});

test('Mail connection storage failure does not enable reads or commit a snapshot',async()=>{
 const f=fixture();await f.start();f.plugin.mailSupported=()=>true;f.plugin.fetchMailSnapshot=async()=>mailFixtureSnapshot();
 f.plugin.quickDraftStorage.setItem=()=>{throw Error('blocked');};await f.plugin.refreshMail(true);
 assert.equal(f.plugin.mailEnabled,false);assert.equal(f.plugin.mailSnapshot,null);assert.match(f.plugin.mailError,/save.*preference/i);f.plugin.unload();
});

function resizeEntry(f, panelHeight=900) {
 const props={}; const home=new Dom();home.isConnected=true;home.style={setProperty:(k,v)=>{props[k]=v;},getPropertyValue:k=>props[k]};
 home.classList={toggle(){}};home.getBoundingClientRect=()=>({top:0});
 const grid=new Dom();grid.getBoundingClientRect=()=>({top:50});grid.style={};
 const handle=new Dom();handle.focus=()=>{};handle.setPointerCapture=()=>{};handle.releasePointerCapture=()=>{};
 const host={clientHeight:panelHeight};const entry={home,homeGrid:grid,homeResize:handle,host,scope:{ownerDocument:f.doc}};
 f.plugin.toolbars.set({},entry);return {entry,props,handle,host};
}

class Events {
  constructor() { this.events = new Map(); }
  on(name, fn) { const list=this.events.get(name)||[]; list.push(fn); this.events.set(name,list); return {off:()=>this.events.set(name,list.filter(x=>x!==fn))}; }
  emit(name,...args) { for(const fn of this.events.get(name)||[]) fn(...args); }
}
class Dom {
  constructor(selector='') { this.selector=selector; this.attrs={}; this.listeners=[]; this.children=[]; this.textContent=''; }
  addEventListener(event,handler) { this.listeners.push({event,handler}); }
  removeEventListener(event,handler) { this.listeners=this.listeners.filter(x=>x.event!==event||x.handler!==handler); }
  matches(selector) { return this.selector===selector; }
  querySelectorAll(selector) { return this.children.filter(c=>selector.startsWith('[')?Object.hasOwn(c.attrs,selector.slice(1,-1)):c.matches(selector)); }
  setAttribute(k,v) { this.attrs[k]=v; }
  getAttribute(k) { return this.attrs[k]??null; }
  removeAttribute(k) { delete this.attrs[k]; }
  setText(t) { this.textContent=t; return this; }
  addClass() {}
  toggleClass() {}
  dispatch(event) { for(const item of this.listeners.filter(x=>x.event===event.type)) item.handler(event); }
}
function documentFixture() {
  const doc=new Dom(); doc.body=new Dom();
  doc.defaultView={MutationObserver:class {observe(){} disconnect(){}}};
  doc.ownerDocument=doc;
  return doc;
}
function fixture(initial=[], saved={}, runtime={}) {
  const notices=[]; const files=new Map(); const caches=new Map(); const doc=documentFixture(); const cleanup=[];
  const opened=[]; const focused=[]; const saves=[]; const leaves=[]; const modals=[];
  class TFile {constructor(p,fm={},inline=[]){if(fm.youtrack_import==="local-v1"){fm.youtrack_url??=`https://tracker.example.com/issue/${fm.youtrack_id}`;fm.youtrack_assignee??="Alex";}this.path=p;this.name=path.posix.basename(p);this.basename=this.name.replace(/\.md$/,'');this.extension='md';this.parent={path:path.posix.dirname(p),name:path.posix.basename(path.posix.dirname(p))};this.stat={mtime:Date.parse('2026-01-01T00:00:00Z'),ctime:Date.parse('2026-01-01T00:00:00Z')};files.set(p,this);caches.set(p,{frontmatter:fm,tags:inline.map(tag=>({tag}))});}}
  const cache=new Events(); cache.getFileCache=f=>caches.get(f.path);
  const workspace=new Events(); workspace.containerEl={ownerDocument:doc}; workspace.onLayoutReady=fn=>fn(); workspace.iterateAllLeaves=fn=>leaves.forEach(fn);
  workspace.getLeavesOfType=()=>leaves;
  workspace.getLastOpenFiles=()=>workspace.recent||[];
  workspace.revealLeaf=async leaf=>{workspace.revealed=leaf;};
  workspace.getLeaf=type=>({view:{editor:{focus:()=>focused.push(true)}},openFile:async(file,state)=>opened.push({file,state,type})});
  const vault=new Events(); vault.adapter={read:async p=>p.endsWith('taxonomy.md')?'```json\n'+JSON.stringify(taxonomy)+'\n```':fs.readFileSync(path.resolve(root,'../../..',p),'utf8')};
  vault.getAbstractFileByPath=p=>files.get(p); vault.getMarkdownFiles=()=>[...files.values()].filter(x=>x instanceof TFile);
  vault.cachedRead=async f=>f.content||'';
  vault.read=vault.cachedRead;
  vault.process=async(f,fn)=>{f.content=fn(f.content||'');vault.emit('modify',f);return f.content;};
  const storage=new Map();
  doc.defaultView.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  vault.getName=()=> 'TestVault';
  cache.getFirstLinkpathDest=p=>files.get(p)||files.get(p+'.md');
  vault.createFolder=async p=>{if(files.has(p))throw Error('exists');const folder={path:p,name:path.posix.basename(p),parent:files.get(path.posix.dirname(p)),children:[]};files.set(p,folder);vault.emit('create',folder);return folder;};
  vault.create=async(p,text)=>{if(files.has(p))throw Error('exists');const f=new TFile(p);f.content=text;return f;};
  const secrets=new Map(); const requests=[];
  const app={workspace,vault,metadataCache:cache,secretStorage:{getSecret:key=>secrets.get(key)||null,setSecret:(key,value)=>secrets.set(key,value)},fileManager:{async processFrontMatter(f,fn){fn(caches.get(f.path).frontmatter);cache.emit('changed',f,'',caches.get(f.path));}}};
  app.requestCalendar=async()=>({status:200,text:'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR'});
  const moves=[];
  app.fileManager.renameFile=async(subject,destination)=>{
    assert.equal(files.get(subject.path),subject,'Move must use a live vault object');
    if(files.has(destination))throw Error('Target exists');
    if(!files.get(path.posix.dirname(destination))?.children)throw Error('Parent folder missing');
    const old=subject.path;
    const entries=[...files].filter(([p])=>p===old||p.startsWith(old+'/'));
    for(const [p,item] of entries){
      const next=destination+p.slice(old.length);files.delete(p);files.set(next,item);item.path=next;
      item.name=path.posix.basename(next);
      if(item instanceof TFile)item.basename=item.name.replace(/\.md$/,'');
      if(caches.has(p)){caches.set(next,caches.get(p));caches.delete(p);}
    }
    for(const [,item] of entries)item.parent=files.get(path.posix.dirname(item.path));
    moves.push({subject,from:old,to:destination});vault.emit('rename',subject,old);
  };
  class Plugin {constructor(){this.app=app;this.manifest={dir:'.obsidian/plugins/aimultiple-kanban-extras'};this._cleanup=[];}register(fn){this._cleanup.push(fn);}registerEvent(ref){this.register(()=>ref.off());}registerDomEvent(el,event,handler,opts){el.addEventListener(event,handler,opts);this.register(()=>el.removeEventListener(event,handler,opts));}addStatusBarItem(){this.status=new Dom();return this.status;}addCommand(){}unload(){this.onunload();for(const fn of this._cleanup)fn();}}
  Plugin.prototype.loadData=async()=>saved;
  Plugin.prototype.saveData=async data=>{saved=JSON.parse(JSON.stringify(data));saves.push(saved);};
  class Modal {constructor(){this.contentEl={empty(){}};this.closed=false;}open(){modals.push(this);}close(){this.closed=true;}}
  const obsidian={Plugin,Modal,TFile,Menu:class {},Setting:class {},Notice:class {constructor(s){notices.push(s);}},getAllTags:c=>[...['tags','tag'].flatMap(k=>Array.isArray(c.frontmatter?.[k])?c.frontmatter[k]:String(c.frontmatter?.[k]||'').split(/[,\s]+/)).filter(Boolean).map(t=>'#'+t.replace(/^#/,'')),...(c.tags||[]).map(x=>x.tag)]};
  const context={module:{exports:{}},require:n=>{if(['node:fs/promises','node:fs','node:path','node:os','node:buffer'].includes(n))return require(n);assert.equal(n,'obsidian');return obsidian;},document:doc,Element:Dom,HTMLElement:Dom,MutationObserver:doc.defaultView.MutationObserver,console,setTimeout,clearTimeout,...runtime};
  obsidian.requestUrl=args=>{requests.push(args);return app.requestCalendar(args);}; context.URL=URL; context.URLSearchParams=URLSearchParams;
  vm.runInNewContext(source+'\nmodule.exports.TestModal = AddCardModal;',context);
  const folders=['Quick Notes','Data','Other','Personal','MSc','Benchmark','Unity','Attachments','_kanban'].map(name=>({name,path:`Hub/${name}`,children:[]}));
  for(const folder of folders)files.set(folder.path,folder);
  files.set('Hub',{name:'Hub',path:'Hub',children:folders});
  for(const [p,fm,inline] of initial)new TFile(p,fm,inline);
  const plugin=new context.module.exports();
  plugin.restoreYouTrack=function(){this.youtrackProfile={host:'tracker.example.com',login:'Alex',project:'DEMO',states:{backlog:'To do','in-progress':'In Progress',done:'Done'},syncEnabled:true};};
  return {plugin,app,doc,files,caches,notices,TFile,opened,focused,saves,leaves,modals,moves,secrets,requests,storage,Modal:context.module.exports.TestModal,start:async()=>{await plugin.onload();plugin.youtrackProfile={host:"tracker.example.com",login:"Alex",project:"DEMO",states:{backlog:"To do","in-progress":"In Progress",done:"Done"},syncEnabled:true};plugin.slackSources={channel:"team-notes",group:"builders"};await flush();},flush};
}

test('Type selection moves a renamed Quick note and preserves its content and membership',async()=>{
  const f=fixture([['Hub/Quick Notes/My research.md',{}]]);await f.start();
  const file=f.files.get('Hub/Quick Notes/My research.md');file.content='My edited text [[Reference]]';
  await f.plugin.setNoteProperty(file,'category','Benchmark');
  assert.equal(file.path,'Hub/Benchmark/My research.md');
  assert.equal(f.files.get(file.path),file);
  assert.ok(!f.files.has('Hub/Quick Notes/My research.md'));
  assert.equal(file.content,'My edited text [[Reference]]');
  assert.deepEqual(f.caches.get(file.path).frontmatter,{category:'Benchmark'});
});

test('Type selection moves a folder note with all its attachments and keeps completion metadata',async()=>{
  const fm={category:'Quick Notes',tags:['kanban','topic/llm'],board_column:'done',priority:'high',completed_at:'2026-09-01T12:00:00Z',completed_at_source:'status_change'};
  const f=fixture([['Hub/Quick Notes/Study/Study.md',fm]]);await f.start();
  const file=f.files.get('Hub/Quick Notes/Study/Study.md');
  const folder={name:'Study',path:'Hub/Quick Notes/Study',parent:f.files.get('Hub/Quick Notes'),children:[file]};
  f.files.set(folder.path,folder);file.parent=folder;
  const attachment={path:folder.path+'/figure.png',name:'figure.png',parent:folder,content:'image bytes'};
  f.files.set(attachment.path,attachment);folder.children.push(attachment);
  await f.plugin.setNoteProperty(file,'category','Benchmark');
  assert.equal(file.path,'Hub/Benchmark/Study/Study.md');
  assert.equal(attachment.path,'Hub/Benchmark/Study/figure.png');
  assert.equal(f.moves[0].subject,folder);
  assert.deepEqual(fm,{category:'Benchmark',tags:['kanban','topic/llm'],board_column:'done',priority:'high',completed_at:'2026-09-01T12:00:00Z',completed_at_source:'status_change'});
});

test('Type selection rejects both flat and folder collisions before changing the property',async()=>{
  for(const target of ['Hub/Benchmark/Study.md','Hub/Benchmark/Study','Hub/Benchmark/Study/Study.md']){
    const fm={category:'Quick Notes'};const f=fixture([['Hub/Quick Notes/Study.md',fm]]);await f.start();
    const file=f.files.get('Hub/Quick Notes/Study.md');f.files.set(target,{path:target});
    await assert.rejects(()=>f.plugin.setNoteProperty(file,'category','Benchmark'),/already contains/i);
    assert.equal(file.path,'Hub/Quick Notes/Study.md');assert.equal(fm.category,'Quick Notes');assert.equal(f.moves.length,0);
  }
});

test('Type selection preserves nesting for the current folder and clearing does not move',async()=>{
  const fm={category:'msc'};const f=fixture([['Hub/MSc/Campus A/Study.md',fm]]);await f.start();
  const file=f.files.get('Hub/MSc/Campus A/Study.md');
  await f.plugin.setNoteProperty(file,'category','MSc');assert.equal(fm.category,'MSc');
  await f.plugin.setNoteProperty(file,'category',undefined);
  assert.equal(file.path,'Hub/MSc/Campus A/Study.md');assert.equal(f.moves.length,0);assert.equal(fm.category,undefined);
});

test('Type selection rejects a disappeared target and never recreates it',async()=>{
  const fm={category:'Quick Notes'};const f=fixture([['Hub/Quick Notes/Study.md',fm]]);await f.start();
  const file=f.files.get('Hub/Quick Notes/Study.md');f.files.delete('Hub/Benchmark');
  await assert.rejects(()=>f.plugin.setNoteProperty(file,'category','Benchmark'),/folder.*exist/i);
  assert.equal(file.path,'Hub/Quick Notes/Study.md');assert.equal(fm.category,'Quick Notes');assert.ok(!f.files.has('Hub/Benchmark'));
});

test('Type selection keeps the old value on move failure and restores the path on save failure',async()=>{
  const fm={category:'Quick Notes'};const f=fixture([['Hub/Quick Notes/Study.md',fm]]);await f.start();
  const file=f.files.get('Hub/Quick Notes/Study.md');const rename=f.app.fileManager.renameFile;
  f.app.fileManager.renameFile=async()=>{throw Error('Move failed');};
  await assert.rejects(()=>f.plugin.setNoteProperty(file,'category','Benchmark'),/Move failed/);
  assert.equal(fm.category,'Quick Notes');assert.equal(file.path,'Hub/Quick Notes/Study.md');
  f.app.fileManager.renameFile=rename;
  f.app.fileManager.processFrontMatter=async()=>{throw Error('Save failed');};
  await assert.rejects(()=>f.plugin.setNoteProperty(file,'category','Benchmark'),/Save failed/);
  assert.equal(fm.category,'Quick Notes');assert.equal(file.path,'Hub/Quick Notes/Study.md');
  assert.equal(f.moves.length,2);
});

test('Type selection cannot move a shared top-level Hub folder through its folder note',async()=>{
  const fm={category:'MSc'};const f=fixture([['Hub/MSc/MSc.md',fm]]);await f.start();
  const file=f.files.get('Hub/MSc/MSc.md');file.parent=f.files.get('Hub/MSc');
  await assert.rejects(()=>f.plugin.setNoteProperty(file,'category','Benchmark'),/top-level Hub folder/i);
  assert.equal(file.path,'Hub/MSc/MSc.md');assert.equal(fm.category,'MSc');assert.equal(f.moves.length,0);
});

test('Type selection blocks competing selections across note views until the move finishes',async()=>{
  const fm={category:'Quick Notes'};const f=fixture([['Hub/Quick Notes/Study.md',fm]]);await f.start();
  const file=f.files.get('Hub/Quick Notes/Study.md');const rename=f.app.fileManager.renameFile;let resume;
  f.app.fileManager.renameFile=async(...args)=>{await new Promise(resolve=>{resume=resolve;});return rename(...args);};
  const pending=f.plugin.setNoteProperty(file,'category','Benchmark');
  await assert.rejects(()=>f.plugin.setNoteProperty(file,'category','Data'),/already in progress/i);
  await assert.rejects(()=>f.plugin.setNoteProperty(file,'category',undefined),/already in progress/i);
  resume();await pending;
  assert.equal(file.path,'Hub/Benchmark/Study.md');assert.equal(fm.category,'Benchmark');
  f.app.fileManager.renameFile=rename;
  await f.plugin.setNoteProperty(file,'category','Data');assert.equal(file.path,'Hub/Data/Study.md');
});

test('Type selection detects a concurrent metadata edit and restores the location without overwriting it',async()=>{
  const fm={category:'Quick Notes'};const f=fixture([['Hub/Quick Notes/Study.md',fm]]);await f.start();
  const file=f.files.get('Hub/Quick Notes/Study.md');const rename=f.app.fileManager.renameFile;
  f.app.fileManager.renameFile=async(...args)=>{await rename(...args);fm.category='Personal';};
  await assert.rejects(()=>f.plugin.setNoteProperty(file,'category','Benchmark'),/changed elsewhere/i);
  assert.equal(file.path,'Hub/Quick Notes/Study.md');assert.equal(fm.category,'Personal');
});

test('Type selection reports the actual path if a save fails and its old path was claimed concurrently',async()=>{
  const fm={category:'Quick Notes'};const f=fixture([['Hub/Quick Notes/Study.md',fm]]);await f.start();
  const file=f.files.get('Hub/Quick Notes/Study.md');let other;
  f.app.fileManager.processFrontMatter=async()=>{other=new f.TFile('Hub/Quick Notes/Study.md');throw Error('Save failed');};
  await assert.rejects(()=>f.plugin.setNoteProperty(file,'category','Benchmark'),/Current note: Hub\/Benchmark\/Study.md/);
  assert.equal(f.files.get('Hub/Quick Notes/Study.md'),other);assert.equal(f.files.get('Hub/Benchmark/Study.md'),file);
  assert.match(f.notices.at(-1),/Could not restore its location/);
});

test('Type selection files a note with an existing mismatched Type but does not move notes outside Hub',async()=>{
  const f=fixture([['Hub/Quick Notes/Study.md',{category:'Benchmark'}],['Daily Notes/Today.md',{category:'Other'}]]);await f.start();
  const file=f.files.get('Hub/Quick Notes/Study.md');
  await f.plugin.setNoteProperty(file,'category','Benchmark');assert.equal(file.path,'Hub/Benchmark/Study.md');
  const daily=f.files.get('Daily Notes/Today.md');
  await f.plugin.setNoteProperty(daily,'category','Benchmark');assert.equal(daily.path,'Daily Notes/Today.md');
});

test('Move to folder rejects stale destinations instead of recreating a removed Type',async()=>{
  const f=fixture([['Hub/Quick Notes/Study.md',{}]]);await f.start();f.files.delete('Hub/Benchmark');
  await assert.rejects(()=>f.plugin.moveCardToFolder(f.files.get('Hub/Quick Notes/Study.md'),'Hub/Benchmark'),/folder.*exist/i);
  assert.ok(!f.files.has('Hub/Benchmark'));assert.equal(f.moves.length,0);
});

test('Make a folder wraps the note in its current directory and preserves its contents and properties',async()=>{
  for(const original of ['Hub/Benchmark/new_note_123.md','Hub/MSc/Campus A/Study.md','Daily Notes/Today.md','Root note.md']){
    const fm={category:'Benchmark',priority:'high',tags:['topic/llm']};const f=fixture([[original,fm]]);await f.start();
    const file=f.files.get(original);file.content='Edited text [[Reference]]';
    await f.plugin.convertFileToFolder(file);
    const expected=original.replace(/\.md$/,'')+'/'+file.name;
    assert.equal(file.path,expected);assert.equal(file.parent.name,file.basename);
    assert.equal(file.content,'Edited text [[Reference]]');assert.equal(f.caches.get(expected).frontmatter,fm);
    assert.equal(f.moves[0].subject,file);assert.ok(!f.files.has(original));
    assert.equal(f.opened.length,0,'Keep the current tab and editor');
  }
});

test('Make a folder is a no-op for existing folder notes and never nests them again',async()=>{
  const f=fixture([['Hub/Benchmark/Study/Study.md',{}]]);await f.start();const file=f.files.get('Hub/Benchmark/Study/Study.md');
  await f.plugin.convertFileToFolder(file);
  assert.equal(file.path,'Hub/Benchmark/Study/Study.md');assert.equal(f.moves.length,0);
  assert.ok(!f.files.has('Hub/Benchmark/Study/Study'));
});

test('Make a folder ignores stale or non-Markdown targets before creating anything',async()=>{
  const f=fixture([['Hub/Benchmark/Old.md',{}]]);await f.start();const stale=f.files.get('Hub/Benchmark/Old.md');new f.TFile(stale.path);
  const image=new f.TFile('Hub/Benchmark/photo.png');image.extension='png';
  const count=f.files.size;
  for(const file of [null,stale,image,{path:'Hub/Benchmark',children:[]}])await f.plugin.convertFileToFolder(file);
  assert.equal(f.files.size,count);assert.equal(f.moves.length,0);
});

test('Make a folder preserves an existing destination, even if empty',async()=>{
  const f=fixture([['Hub/Benchmark/Study.md',{}]]);await f.start();
  const folder=await f.app.vault.createFolder('Hub/Benchmark/Study');const file=f.files.get('Hub/Benchmark/Study.md');
  await assert.rejects(()=>f.plugin.convertFileToFolder(file),/already exists/i);
  assert.equal(file.path,'Hub/Benchmark/Study.md');assert.equal(f.files.get(folder.path),folder);assert.equal(f.moves.length,0);
});

test('Make a folder blocks competing conversions and Type changes until creation finishes',{timeout:1000},async()=>{
  const f=fixture([['Hub/Benchmark/Study.md',{}]]);await f.start();const file=f.files.get('Hub/Benchmark/Study.md');
  const create=f.app.vault.createFolder;let resume;
  f.app.vault.createFolder=async p=>{await new Promise(resolve=>{resume=resolve;});return create(p);};
  const pending=f.plugin.convertFileToFolder(file);
  await f.plugin.convertFileToFolder(file);
  await assert.rejects(()=>f.plugin.setNoteProperty(file,'category','Data'),/in progress/i);
  resume();await pending;
  assert.equal(file.path,'Hub/Benchmark/Study/Study.md');assert.equal(f.moves.length,1);
});

test('Make a folder retries its own prepared folder after a move failure without overwriting other files',async()=>{
  const f=fixture([['Hub/Benchmark/Study.md',{}]]);await f.start();const file=f.files.get('Hub/Benchmark/Study.md');
  const rename=f.app.fileManager.renameFile;f.app.fileManager.renameFile=async()=>{throw Error('Move failed');};
  await assert.rejects(()=>f.plugin.convertFileToFolder(file),/Move failed/);
  assert.equal(file.path,'Hub/Benchmark/Study.md');assert.ok(f.files.has('Hub/Benchmark/Study'));
  f.app.fileManager.renameFile=rename;
  await f.plugin.convertFileToFolder(file);
  assert.equal(file.path,'Hub/Benchmark/Study/Study.md');
});

test('Make a folder releases the action guard after a folder creation error',async()=>{
  const f=fixture([['Hub/Benchmark/Study.md',{}]]);await f.start();const file=f.files.get('Hub/Benchmark/Study.md');
  const create=f.app.vault.createFolder;f.app.vault.createFolder=async()=>{throw Error('Create failed');};
  await assert.rejects(()=>f.plugin.convertFileToFolder(file),/Create failed/);
  assert.equal(f.plugin.canMakeFolder(file),true);assert.ok(!f.files.has('Hub/Benchmark/Study'));
  f.app.vault.createFolder=create;
  await f.plugin.convertFileToFolder(file);assert.equal(file.path,'Hub/Benchmark/Study/Study.md');
});

test('Make a folder leaves a concurrently moved source at its new location',async()=>{
  const f=fixture([['Hub/Benchmark/Study.md',{}]]);await f.start();const file=f.files.get('Hub/Benchmark/Study.md');
  const create=f.app.vault.createFolder;
  f.app.vault.createFolder=async p=>{const folder=await create(p);await f.app.fileManager.renameFile(file,'Hub/Data/Study.md');return folder;};
  await assert.rejects(()=>f.plugin.convertFileToFolder(file),/note moved/i);
  assert.equal(file.path,'Hub/Data/Study.md');assert.equal(f.moves.length,1);
});

test('Make a folder does not reuse a prepared folder that acquired other content',async()=>{
  const f=fixture([['Hub/Benchmark/Study.md',{}]]);await f.start();const file=f.files.get('Hub/Benchmark/Study.md');
  const rename=f.app.fileManager.renameFile;f.app.fileManager.renameFile=async()=>{throw Error('Move failed');};
  await assert.rejects(()=>f.plugin.convertFileToFolder(file),/Move failed/);
  const folder=f.files.get('Hub/Benchmark/Study');const other=new f.TFile(folder.path+'/Other.md');folder.children.push(other);
  f.app.fileManager.renameFile=rename;
  await assert.rejects(()=>f.plugin.convertFileToFolder(file),/already exists/i);
  assert.equal(file.path,'Hub/Benchmark/Study.md');assert.equal(f.files.get(other.path),other);assert.equal(f.moves.length,0);
});

test('right-click remains available after unload/reload without rebuilding the board',async()=>{
  const f=fixture(); const card=new Dom('.obk-card[data-entry-path]');f.doc.children=[card];
  await f.start();f.plugin.unload();await f.plugin.onload();
  let calls=0;f.plugin.onCardRightClick=()=>calls++;
  const target={closest:s=>s==='.obk-card[data-entry-path]'?card:null};
  f.doc.dispatch({type:'contextmenu',target});
  for(const l of card.listeners)l.handler({preventDefault(){},stopPropagation(){}});
  assert.equal(calls,1);
});

test('hidden tag suggestions persist and restore without changing note tags or bodies',async()=>{
  const f=fixture([
    ['Hub/Other/Current.md',{tags:['topic/rag']}],
    ['Hub/Other/Report.md',{tags:['type/index']},['#54/wp','#394/']],
  ],{legacySetting:'keep'});
  await f.start();
  const current=f.files.get('Hub/Other/Current.md');
  const report=f.files.get('Hub/Other/Report.md');report.content='Metabase #54/wp and #394/#395';
  const before=JSON.stringify([...f.caches]);
  assert.ok(f.plugin.tagOptions(current).some(item=>item.tag==='54/wp'));
  await f.plugin.setTagSuggestionHidden('#54/wp',true);
  assert.ok(!f.plugin.tagOptions(current).some(item=>item.tag==='54/wp'));
  assert.ok(f.plugin.tagOptions(current).some(item=>item.tag==='type/index'));
  assert.ok(f.plugin.tagOptions(report).some(item=>item.tag==='54/wp' && item.selected && item.hidden));
  assert.equal(JSON.stringify([...f.caches]),before);
  assert.equal(report.content,'Metabase #54/wp and #394/#395');
  assert.equal(f.saves.at(-1).legacySetting,'keep');
  f.plugin.unload();await f.start();
  assert.ok(!f.plugin.tagOptions(current).some(item=>item.tag==='54/wp'));
  assert.ok(f.plugin.tagOptions(current,true).some(item=>item.tag==='54/wp'));
  await f.plugin.setTagSuggestionHidden('54/wp',false);
  assert.ok(f.plugin.tagOptions(current).some(item=>item.tag==='54/wp'));
  assert.equal(f.plugin.tagOptions(current,true).length,0);
});

test('hiding tags preserves queued choices and recovers from failed settings saves',async()=>{
  const f=fixture();await f.start();
  await Promise.all([
    f.plugin.setTagSuggestionHidden('54/wp',true),
    f.plugin.setTagSuggestionHidden('394/',true),
  ]);
  assert.deepEqual([...f.plugin.hiddenTagSuggestions].sort(),['394/','54/wp']);
  const save=f.plugin.saveData;
  f.plugin.saveData=async()=>{throw Error('Settings unavailable');};
  await assert.rejects(()=>f.plugin.setTagSuggestionHidden('54/wp',false),/Settings unavailable/);
  assert.ok(f.plugin.hiddenTagSuggestions.has('54/wp'));
  f.plugin.saveData=save;
  await f.plugin.setTagSuggestionHidden('54/wp',false);
  assert.deepEqual([...f.plugin.hiddenTagSuggestions],['394/']);
  await assert.rejects(()=>f.plugin.setTagSuggestionHidden('kanban',true),/board/i);
  await assert.rejects(()=>f.plugin.setTagSuggestionHidden('kanban/nested',true),/board/i);
});
test('new pop-out windows get menus and closing them removes handlers',async()=>{
  const f=fixture();await f.start();const doc=documentFixture();const win={document:doc};
  f.app.workspace.emit('window-open',{},win);
  let calls=0;f.plugin.onCardRightClick=()=>calls++;
  doc.dispatch({type:'contextmenu',target:{closest:s=>s.includes('card')?{}:null}});
  assert.equal(calls,1);f.app.workspace.emit('window-close',{},win);
  assert.equal(doc.listeners.length,0);
});
test('an inactive view label cannot choose the new-card folder',async()=>{
  const f=fixture();await f.start();
  const label={children:[],textContent:'MSc',closest:()=>null};
  const leaf={querySelector:()=>null,querySelectorAll:()=>[label]};
  assert.equal(f.plugin.inferFolderFromDom({closest:()=>leaf}),null);
});
test('explicitly active view chooses its folder',async()=>{
  const f=fixture();await f.start();
  for (const [view,folder] of [['Data','Hub/Data'],['MSc','Hub/MSc']]) {
    const leaf={querySelector:s=>s==='.bases-view-tab.is-active'?{textContent:view}:null,querySelectorAll:()=>[]};
    assert.equal(f.plugin.inferFolderFromDom({closest:()=>leaf}),folder);
  }
});

test('adding university notes defaults to MSc without overwriting an explicit type',async()=>{
  const cases=[
    ['Hub/MSc/Campus B/Courses/Example/Study.md',{},'MSc'],
    ['Hub/MSc/Campus A/Study.md',{},'MSc'],
    ['Hub/MSc/MSc.md',{},'MSc'],
    ['Hub/MSc/Campus A/Personal.md',{category:'personal'},'Personal'],
    ['Hub/MSc-other/Study.md',{},''],
  ];
  const f=fixture(cases.map(([p,fm])=>[p,fm]));await f.start();
  for(const [p,fm,expected] of cases){
    const original=JSON.stringify(fm);
    f.plugin.openAddToBoardModal(f.files.get(p));
    assert.equal(f.modals.at(-1).category,expected,p);
    assert.equal(JSON.stringify(fm),original,'Opening the picker must not change metadata');
  }
});
test('folder-note and flat-note names share one duplicate check',async()=>{
  const f=fixture([['Hub/Data/Existing/Existing.md',{}]]);await f.start();f.files.set('Hub/Data',{});
  await f.plugin.createCard('Existing','backlog','Hub/Data','data','medium');
  assert.equal(f.files.has('Hub/Data/Existing.md'),false);
});
test('Type choices follow live Hub folders and exclude notes and utility folders',async()=>{
  const f=fixture();await f.start();
  const hub=f.files.get('Hub');
  const folder={name:'AI & Data',path:'Hub/AI & Data',children:[]};
  hub.children.push(folder);f.files.set(folder.path,folder);
  hub.children.push(new f.TFile('Hub/Loose note.md'));
  assert.ok(f.plugin.propertyValues('category').includes('AI & Data'));
  for(const name of ['Attachments','_kanban','Loose note.md'])assert.ok(!f.plugin.propertyValues('category').includes(name));
  const file=new f.TFile('Hub/AI & Data/Nested/Study.md');
  f.plugin.openAddToBoardModal(file);
  assert.equal(f.modals.at(-1).category,'AI & Data');
  folder.name='Research';folder.path='Hub/Research';
  assert.ok(!f.plugin.propertyValues('category').includes('AI & Data'));
  assert.ok(f.plugin.propertyValues('category').includes('Research'));
  hub.children=hub.children.filter(child=>child!==folder);
  assert.ok(!f.plugin.propertyValues('category').includes('Research'));
});
test('new folder types serialize as YAML strings and stale folders are not recreated',async()=>{
  const f=fixture();await f.start();
  const folder={name:'true',path:'Hub/true',children:[]};
  f.files.get('Hub').children.push(folder);f.files.set(folder.path,folder);
  await f.plugin.createCard('Study','backlog',folder.path,'true','medium');
  assert.match(f.files.get('Hub/true/Study.md').content,/category: "true"/);
  f.files.delete(folder.path);
  assert.equal(await f.plugin.createCard('Later','backlog',folder.path,'true','medium'),false);
  assert.ok(!f.files.has('Hub/true'));
});
test('new card preserves taxonomy and includes an actionable body',async()=>{
  const f=fixture();await f.start();f.files.set('Hub/Data',{});
  await f.plugin.createCard('Valid','backlog','Hub/Data','data','high');
  const text=f.files.get('Hub/Data/Valid.md').content;
  assert.match(text,/priority: high/);assert.match(text,/## Next step/);assert.match(text,/## Done when/);
});
test('mixed frontmatter and inline membership never reports successful removal',async()=>{
  const f=fixture([['Hub/Data/Mixed.md',{tags:['kanban','topic/data']},['#kanban']]]);await f.start();
  await f.plugin.removeFromBoard(f.files.get('Hub/Data/Mixed.md'));
  assert.match(f.notices.at(-1),/still on.*board/i);assert.deepEqual(f.caches.get('Hub/Data/Mixed.md').frontmatter.tags,['topic/data']);
});
test('frontmatter-only membership is removed without changing note properties',async()=>{
  const fm={tags:['kanban','topic/data'],board_column:'backlog',priority:'high'};
  const f=fixture([['Hub/Data/Plain.md',fm]]);await f.start();await f.plugin.removeFromBoard(f.files.get('Hub/Data/Plain.md'));
  assert.match(f.notices.at(-1),/^Removed from board/);assert.equal(fm.priority,'high');
});
test('done transition receives a stable timestamp and reopening clears it',async()=>{
  const fm={tags:['kanban'],board_column:'backlog'};const f=fixture([['Hub/Data/Task.md',fm]]);await f.start();const file=f.files.get('Hub/Data/Task.md');
  fm.board_column='done';file.stat.mtime=Date.now();f.app.metadataCache.emit('changed',file,'',f.caches.get(file.path));await f.flush();
  assert.ok(Date.parse(fm.completed_at));const completed=fm.completed_at;
  file.stat.mtime+=86400000;f.app.metadataCache.emit('changed',file,'',f.caches.get(file.path));await f.flush();assert.equal(fm.completed_at,completed);
  fm.board_column='backlog';f.app.metadataCache.emit('changed',file,'',f.caches.get(file.path));await f.flush();assert.equal(fm.completed_at,undefined);
});
test('legacy done cards get a marked estimate instead of today',async()=>{
  const fm={tags:['kanban'],board_column:'done'};const f=fixture([['Hub/Data/Legacy.md',fm]]);await f.start();
  assert.equal(fm.completed_at,'2026-01-01T00:00:00.000Z');assert.equal(fm.completed_at_source,'legacy_mtime');
});
test('late startup metadata also marks old completion dates as estimates',async()=>{
  const f=fixture();await f.start();const fm={tags:['kanban'],board_column:'done'};
  const file=new f.TFile('Hub/Data/Late.md',fm);
  f.app.metadataCache.emit('changed',file,'',f.caches.get(file.path));await f.flush();
  assert.equal(fm.completed_at,'2026-01-01T00:00:00.000Z');assert.equal(fm.completed_at_source,'legacy_mtime');
});
test('WIP warning counts the whole board without moving cards',async()=>{
  const rows=Array.from({length:4},(_,i)=>[`Hub/Data/${i}.md`,{tags:['kanban'],board_column:'in-progress'}]);
  const f=fixture(rows);await f.start();assert.match(f.plugin.status.textContent,/4\s*\/\s*3/);
  assert.ok(rows.every(([,fm])=>fm.board_column==='in-progress'));
});
test('failed card creation keeps the modal and user input available',async()=>{
  const f=fixture();const modal=new f.Modal(f.app,{columnValue:'backlog',defaultFolder:'Hub/Data',moveTargets:[],taxonomy,onSubmit:async()=>false});
  modal.title='Keep this title';await modal.submit();assert.equal(modal.closed,false);assert.equal(modal.title,'Keep this title');
});

test('each Quick note click creates a distinct blank note and focuses a new tab',async()=>{
  const f=fixture([],{captureFolder:'Hub/Data'});await f.start();
  const first=await f.plugin.openQuickNote();
  assert.match(first.path,/^Hub\/Quick Notes\/Not .*\.md$/);assert.equal(first.content,'');
  first.content='My ongoing notes';
  const again=await f.plugin.openQuickNote();assert.notEqual(again.path,first.path);
  assert.equal(again.content,'');assert.equal(first.content,'My ongoing notes');
  assert.equal(f.app.vault.getMarkdownFiles().length,2);
  assert.equal(f.opened[0].type,'tab');assert.equal(f.opened[0].state.state.mode,'source');
  assert.equal(f.opened[1].type,'tab');assert.equal(f.focused.length,2);
});
test('Quick note ignores old scratchpad settings and leaves existing notes untouched',async()=>{
  const oldPath='Hub/Quick Notes/Quick note.md';
  const f=fixture([[oldPath,{}]],{quickNotePath:oldPath,captureFolder:'Hub/Data'});await f.start();
  const old=f.files.get(oldPath);old.content='Keep my scratchpad';
  f.leaves.push({view:{file:old,editor:{focus:()=>assert.fail('Must open the new note')}}});
  const created=await f.plugin.openQuickNote();assert.notEqual(created.path,oldPath);
  assert.match(created.path,/^Hub\/Quick Notes\/Not .*\.md$/);
  assert.equal(old.content,'Keep my scratchpad');assert.equal(f.saves.length,0);
  assert.equal(f.opened[0].file,created);
});
test('concurrent Quick note clicks are guarded while creation is pending',async()=>{
  const f=fixture();await f.start();await Promise.all([f.plugin.openQuickNote(),f.plugin.openQuickNote()]);
  assert.equal(f.app.vault.getMarkdownFiles().length,1);assert.equal(f.opened.length,1);
});
test('Quick note creates its folder when missing and does not add board membership',async()=>{
  const f=fixture();await f.start();f.files.delete('Hub/Quick Notes');
  const file=await f.plugin.openQuickNote();assert.ok(f.files.get('Hub/Quick Notes').children);
  assert.equal(file.content,'');assert.deepEqual(f.caches.get(file.path).frontmatter,{});
});
test('Quick note avoids a file created concurrently by sync and opens its own blank note',async()=>{
  const f=fixture();await f.start();let synced;const create=f.app.vault.create;
  f.app.vault.create=async(p,body)=>{
    if(!synced){synced=new f.TFile(p);synced.content='Synced content';throw Error('exists');}
    return create(p,body);
  };
  const file=await f.plugin.openQuickNote();assert.notEqual(file,synced);assert.equal(file.content,'');
  assert.match(file.path,/ \(2\)\.md$/);assert.equal(synced.content,'Synced content');
});
test('Quick note reports write errors and can be retried',async()=>{
  const f=fixture();await f.start();const create=f.app.vault.create;
  f.app.vault.create=async()=>{throw Error('Disk full');};await assert.rejects(()=>f.plugin.openQuickNote(),/Disk full/);
  f.app.vault.create=create;assert.ok(await f.plugin.openQuickNote());
});
test('backlog action creates and opens a new card immediately with the shared template',async()=>{
  const f=fixture([],{captureFolder:'Hub/Data'});await f.start();
  const file=await f.plugin.createBacklogNote();
  assert.match(file.path,/^Hub\/Quick Notes\/Not .*\.md$/);
  assert.match(file.content,/^---\ntags:\n  - kanban\n/);
  assert.match(file.content,/\nboard_column: backlog\n/);
  assert.match(file.content,/\ncategory: "Quick Notes"\n/);
  assert.match(file.content,/\npriority: medium\n/);
  assert.ok(file.content.endsWith(taxonomy.default_body));
  assert.equal(f.opened[0].type,'tab');assert.equal(f.focused.length,1);
});
test('backlog action creates its default folder when absent and never overwrites a note',async()=>{
  const f=fixture();await f.start();f.files.delete('Hub/Quick Notes');
  const first=await f.plugin.createBacklogNote();const original=first.content;
  const second=await f.plugin.createBacklogNote();
  assert.ok(f.files.get('Hub/Quick Notes').children);assert.notEqual(first.path,second.path);
  assert.equal(first.content,original);
});
test('backlog capture retries a filename collision without touching the existing note',async()=>{
  const f=fixture();await f.start();const create=f.app.vault.create;let collision;
  f.app.vault.create=async(p,body)=>{
    if(!collision){collision=new f.TFile(p);collision.content='existing content';throw Error('exists');}
    return create(p,body);
  };
  const file=await f.plugin.createBacklogNote();assert.notEqual(file.path,collision.path);
  assert.match(file.path,/ \(2\)\.md$/);assert.equal(collision.content,'existing content');
});
test('concurrent backlog clicks create only one card',async()=>{
  const f=fixture();await f.start();await Promise.all([f.plugin.createBacklogNote(),f.plugin.createBacklogNote()]);
  assert.equal(f.opened.length,1);assert.equal(f.app.vault.getMarkdownFiles().length,1);
});
test('a card saved before an editor error remains available and its path is reported',async()=>{
  const f=fixture();await f.start();f.app.workspace.getLeaf=()=>({openFile:async()=>{throw Error('Editor unavailable');}});
  await assert.rejects(()=>f.plugin.createBacklogNote(),/Note saved: Hub\/Quick Notes\/Not .*Editor unavailable/);
  assert.equal(f.app.vault.getMarkdownFiles().length,1);assert.equal(f.plugin.captureBusy,false);
});

test('note toolbar membership state includes frontmatter and inline board tags',async()=>{
  const f=fixture([
    ['Hub/Unity/Guide.md',{}],
    ['Hub/Data/Card.md',{tags:['kanban'],board_column:'backlog'}],
    ['Hub/Other/Inline.md',{},['#kanban']],
    ['Daily Notes/Today.md',{}],
  ]);await f.start();
  assert.equal(f.plugin.noteBoardState(f.files.get('Hub/Unity/Guide.md')).canAdd,true);
  assert.equal(f.plugin.noteBoardState(f.files.get('Hub/Unity/Guide.md')).canRemove,false);
  for(const path of ['Hub/Data/Card.md','Hub/Other/Inline.md']) {
    assert.equal(f.plugin.noteBoardState(f.files.get(path)).label,'On board');
    assert.equal(f.plugin.noteBoardState(f.files.get(path)).canAdd,false);
    assert.equal(f.plugin.noteBoardState(f.files.get(path)).canRemove,true);
  }
  const outside=f.plugin.noteBoardState(f.files.get('Daily Notes/Today.md'));
  assert.equal(outside.canAdd,false);assert.equal(outside.canRemove,false);assert.match(outside.hint,/Hub/);
});
test('note toolbar waits for metadata and never offers to add a deleted note',async()=>{
  const f=fixture([['Hub/Data/New.md',{}]]);await f.start();const file=f.files.get('Hub/Data/New.md');
  f.caches.delete(file.path);assert.equal(f.plugin.noteBoardState(file).canAdd,false);
  f.caches.set(file.path,{frontmatter:{}});assert.equal(f.plugin.noteBoardState(file).canAdd,true);
  f.files.delete(file.path);assert.equal(f.plugin.noteBoardState(file).canAdd,false);
});
test('note toolbar action always targets the current note in its own leaf',async()=>{
  const f=fixture([['Hub/Data/First.md',{}],['Hub/Other/Second.md',{}]]);await f.start();
  let target;f.plugin.openAddToBoardModal=file=>{target=file;};
  const leaf={view:{file:f.files.get('Hub/Data/First.md')}};
  leaf.view.file=f.files.get('Hub/Other/Second.md');f.plugin.openNoteBoardModal(leaf);
  assert.equal(target,leaf.view.file);
  f.caches.get(target.path).frontmatter.tags=['kanban'];target=null;
  f.plugin.openNoteBoardModal(leaf);assert.equal(target,null);
});

test('delete note requests native deletion of only the current file, including folder notes',async()=>{
  const paths=['Hub/Other/First.md','Hub/Other/Project/Project.md','Hub/Other/Project/Keep.md','Daily Notes/Today.md'];
  const f=fixture(paths.map(p=>[p,{}]));await f.start();
  const targets=[];f.app.fileManager.promptForDeletion=async file=>{targets.push(file);};
  const leaf={view:{file:f.files.get(paths[0])}};
  for(const p of [paths[1],paths[3]]){
    leaf.view.file=f.files.get(p);
    await f.plugin.requestNoteDeletion(leaf);
    assert.equal(targets.at(-1),leaf.view.file);
    assert.notEqual(targets.at(-1),leaf.view.file.parent);
  }
  assert.equal(targets.length,2);
  for(const p of paths)assert.ok(f.files.has(p),'A cancelled native prompt must leave every file intact');
});
test('delete note ignores missing, replaced and non-Markdown targets',async()=>{
  const f=fixture([['Hub/Other/Old.md',{}]]);await f.start();
  let calls=0;f.app.fileManager.promptForDeletion=async()=>calls++;
  const stale=f.files.get('Hub/Other/Old.md');
  new f.TFile(stale.path);
  const attachment=new f.TFile('Hub/Other/Photo.png');attachment.extension='png';
  for(const file of [null,stale,attachment,{path:'Hub/Other',children:[]}]){
    await f.plugin.requestNoteDeletion({view:{file}});
  }
  assert.equal(calls,0);
});

test('toolbar property changes preserve unrelated fields and manage completion dates',async()=>{
  const fm={tags:['kanban','topic/personal'],board_column:'backlog',priority:'medium',category:'personal',custom:42};
  const f=fixture([['Hub/Personal/Task.md',fm]]);await f.start();const file=f.files.get('Hub/Personal/Task.md');
  await f.plugin.setNoteProperty(file,'priority','urgent');assert.equal(fm.priority,'urgent');assert.equal(fm.custom,42);
  await f.plugin.setNoteProperty(file,'board_column','done');assert.ok(Date.parse(fm.completed_at));
  await f.plugin.setNoteProperty(file,'board_column','in-progress');assert.equal(fm.completed_at,undefined);
  assert.deepEqual(fm.tags,['kanban','topic/personal']);assert.equal(fm.category,'personal');
});
test('toolbar rejects invalid taxonomy and keeps managed fields protected',async()=>{
  const fm={tags:['kanban'],board_column:'backlog'};const f=fixture([['Hub/Data/Task.md',fm]]);await f.start();const file=f.files.get('Hub/Data/Task.md');
  for(const [key,value] of [['priority','super-high'],['board_column','blocked'],['board_column',undefined],['completed_at','2020-01-01'],['__proto__',{}]]) {
    await assert.rejects(()=>f.plugin.setNoteProperty(file,key,value));
  }
  assert.equal(fm.board_column,'backlog');
});
test('custom property editor preserves value types and detects concurrent edits',async()=>{
  const fm={count:2,enabled:false,links:['one'],title:'Original'};const f=fixture([['Hub/Other/Note.md',fm]]);await f.start();const file=f.files.get('Hub/Other/Note.md');
  await f.plugin.setNoteProperty(file,'count',5);await f.plugin.setNoteProperty(file,'enabled',true);
  await f.plugin.setNoteProperty(file,'links',['one','two']);assert.equal(fm.count,5);assert.equal(fm.enabled,true);assert.deepEqual(fm.links,['one','two']);
  const snapshot=JSON.stringify({present:true,value:'Original'});fm.title='Changed elsewhere';
  await assert.rejects(()=>f.plugin.setNoteProperty(file,'title','Overwrite',snapshot),/changed elsewhere/i);
  assert.equal(fm.title,'Changed elsewhere');await f.plugin.setNoteProperty(file,'count',undefined);assert.equal(fm.count,undefined);
});
test('tag controls preserve unrelated tags and leave inline and board membership edits explicit',async()=>{
  const fm={tags:['kanban','topic/personal'],tag:['type/note']};
  const f=fixture([['Hub/Other/Note.md',fm,['#inline-tag']]]);await f.start();const file=f.files.get('Hub/Other/Note.md');
  await f.plugin.toggleNoteTag(file,'topic/data');assert.ok(fm.tags.includes('topic/data'));
  await f.plugin.toggleNoteTag(file,'type/note');assert.deepEqual(fm.tag,[]);
  assert.ok(fm.tags.includes('kanban'));assert.ok(fm.tags.includes('topic/personal'));
  await assert.rejects(()=>f.plugin.toggleNoteTag(file,'kanban'),/board/i);
  await assert.rejects(()=>f.plugin.toggleNoteTag(file,'inline-tag'),/note body/i);
});

test('Home opens one daily note per selected local date, preserving an existing note', async()=>{
  const f=fixture();await f.start();
  assert.equal(typeof f.plugin.openDailyNote,'function','Home must support daily notes without another plugin');
  const results=await Promise.all([f.plugin.openDailyNote('2026-10-16'),f.plugin.openDailyNote('2026-10-16')]);
  const file=f.files.get('Daily Notes/16-10-2026.md');assert.ok(file);
  assert.match(file.content,/date: 2026-10-16/);assert.ok(!file.content.includes('kanban'));
  file.content='My journal [[Keep this]]';await f.plugin.openDailyNote('2026-10-16');
  assert.equal(file.content,'My journal [[Keep this]]');
  assert.equal([...f.files.keys()].filter(p=>p==='Daily Notes/16-10-2026.md').length,1);
  assert.equal(f.opened.at(-1).type,'tab');
  assert.ok(results.some(x=>x===file));f.plugin.unload();
});

test('Home rejects invalid dates and uses its plain template without evaluating code',async()=>{
  const f=fixture([['Templates/Home Daily Note.md',{}]]);await f.start();
  assert.equal(typeof f.plugin.openDailyNote,'function');
  for(const day of ['2026-02-30','../escape','2026-13-01','bad']) await assert.rejects(()=>f.plugin.openDailyNote(day),/date/i);
  assert.ok(!f.files.has('Daily Notes'));
  f.files.get('Templates/Home Daily Note.md').content='date: {{date}}\n# {{title}}\nMy own prompt';
  const file=await f.plugin.openDailyNote('2024-02-29');
  assert.match(file.content,/date: 2024-02-29/);assert.match(file.content,/My own prompt/);assert.ok(!file.content.includes('{{'));
  f.plugin.unload();
});

test('Home daily-note write failure allows retry and never overwrites a competing creation',async()=>{
  const f=fixture();await f.start();assert.equal(typeof f.plugin.openDailyNote,'function');
  const create=f.app.vault.create;
  f.app.vault.create=async()=>{throw Error('Disk unavailable');};
  await assert.rejects(()=>f.plugin.openDailyNote('2026-10-16'),/Disk unavailable/);
  f.app.vault.create=async p=>{const file=new f.TFile(p);file.content='Other writer';throw Error('exists');};
  const file=await f.plugin.openDailyNote('2026-10-16');assert.equal(file.content,'Other writer');
  f.app.vault.create=create;f.plugin.unload();
});

test('Home recent notes use open history, exclude infrastructure and deduplicate',async()=>{
  const f=fixture([['Hub/Other/A.md',{}],['Hub/Personal/B.md',{}],['Hub/_kanban/taxonomy.md',{}],['Hub/Larousse/Accounts/Accounts.md',{}],['Templates/Daily Note.md',{}]]);await f.start();
  assert.equal(typeof f.plugin.homeRecentNotes,'function');
  f.app.workspace.recent=['missing.md','Templates/Daily Note.md','Hub/_kanban/taxonomy.md','Hub/Larousse/Accounts/Accounts.md','Hub/Personal/B.md','Hub/Other/A.md','Hub/Personal/B.md'];
  assert.deepEqual(Array.from(f.plugin.homeRecentNotes(),x=>x.path),['Hub/Personal/B.md','Hub/Other/A.md']);
  f.plugin.unload();
});

test('Home shortcut aliases resolve live files and missing links remain non-destructive',async()=>{
  const f=fixture([['Hub/Personal/Home shortcuts.md',{}],['Hub/MSc/MSc.md',{}]]);await f.start();
  assert.equal(typeof f.plugin.homeShortcuts,'function');
  f.caches.get('Hub/Personal/Home shortcuts.md').links=[{link:'Hub/MSc/MSc',displayText:'Study'},{link:'Missing',displayText:'Missing note'}];
  const links=f.plugin.homeShortcuts();assert.equal(links[0].label,'Study');assert.equal(links[0].file.path,'Hub/MSc/MSc.md');
  assert.equal(links[1].file,null);assert.ok(!f.files.has('Missing.md'));
  f.plugin.unload();
});

test('Home collapse and hidden-tag preferences serialize and preserve unrelated settings',async()=>{
  const f=fixture([],{other:'keep'});await f.start();assert.equal(typeof f.plugin.setHomeCollapsed,'function');
  await Promise.all([f.plugin.setHomeCollapsed(true),f.plugin.setTagSuggestionHidden('noisy',true)]);
  assert.equal(f.saves.at(-1).homeCollapsed,true);assert.deepEqual(f.saves.at(-1).hiddenTagSuggestions,['noisy']);assert.equal(f.saves.at(-1).other,'keep');
  f.plugin.saveData=async()=>{throw Error('Save failed');};
  await assert.rejects(()=>f.plugin.setHomeCollapsed(false),/Save failed/);assert.equal(f.plugin.homeCollapsed,true);
  f.plugin.unload();assert.equal(f.plugin.homeTimer,null);
});

test('Home widgets can be swapped per slot and persist without duplicate modules',async()=>{
 const f=fixture([],{other:'keep',homeWidgets:['calendar','recent','youtrack']});await f.start();assert.equal(typeof f.plugin.setHomeWidget,'function');
 await f.plugin.setHomeWidget(0,'youtrack');
 assert.deepEqual(Array.from(f.plugin.homeWidgets),['youtrack','recent','calendar']);
 await f.plugin.setHomeWidget(2,'shortcuts');
 assert.deepEqual(Array.from(f.plugin.homeWidgets),['youtrack','recent','shortcuts']);
 assert.equal(f.saves.at(-1).other,'keep');
 await assert.rejects(()=>f.plugin.setHomeWidget(0,'arbitrary-script'),/widget/i);
 f.plugin.unload();
});

test('Modular Home migrates the existing layout, has no inferred sources and isolates view choices',async()=>{
 const f=fixture([],{homeWidgets:['calendar','shortcuts','youtrack'],other:'keep'});await f.start();
 assert.ok(f.plugin.homeState,'Home needs saved named views');
 assert.deepEqual(Array.from(f.plugin.homeState.views,v=>v.name),['Work','Study','Personal']);
 assert.equal(f.plugin.homeState.sources.length,0);
 assert.deepEqual(Array.from(f.plugin.homeWidgets),['calendar','shortcuts','youtrack']);
 await f.plugin.setHomeView('study');await f.plugin.setHomeWidget(0,'recent');
 await f.plugin.setHomeView('work');assert.deepEqual(Array.from(f.plugin.homeWidgets),['calendar','shortcuts','youtrack']);
 assert.equal(f.saves.at(-1).other,'keep');f.plugin.unload();
});
test('Home sources pin explicitly across views; stale edits and failed saves preserve the saved source',async()=>{
 const f=fixture();await f.start();assert.ok(f.plugin.homeState);
 const source=await f.plugin.saveHomeSource({title:'RAG',type:'note',target:'Hub/Larousse/RAG.md#Retrieval',bookmark:'Hybrid search',checkpoint:''},'work');
 assert.deepEqual(Array.from(f.plugin.homeView().pins),[source.id]);
 await f.plugin.pinHomeSource('study',source.id,true);await f.plugin.setHomeView('study');
 assert.equal(f.plugin.homeView().selected,source.id);
 const edited=await f.plugin.saveHomeSource({...source,bookmark:'Rerankers'},'study',JSON.stringify(source));
 await assert.rejects(()=>f.plugin.saveHomeSource({...source,title:'Old'},'work',JSON.stringify(source)),/changed/i);
 await f.plugin.pinHomeSource('study',source.id,false);assert.equal(f.plugin.homeView().pins.length,0);
 await f.plugin.setHomeView('work');assert.equal(f.plugin.homeView().pins[0],source.id);
 assert.equal(f.plugin.homeState.sources[0].bookmark,'Rerankers');
 f.plugin.saveData=async()=>{throw Error('Disk full');};
 await assert.rejects(()=>f.plugin.saveHomeSource({...edited,title:'Lost'},'work',JSON.stringify(edited)),/Disk full/);
 assert.equal(f.plugin.homeState.sources[0].title,'RAG');f.plugin.unload();
});
test('Home rejects executable links and still validates legacy checkpoint blocks',async()=>{
 const f=fixture();await f.start();assert.ok(f.plugin.homeState);
 for(const target of ['javascript:alert(1)','data:text/html,no','file:///tmp/script.sh','https://user:secret@example.com'])
  await assert.rejects(()=>f.plugin.saveHomeSource({title:'Bad',type:'url',target},'work'),/link/i);
 const good='```es-hub\n'+JSON.stringify({schema:1,title:'Search',next:'Inspect the saved results',updatedAt:'2026-10-16T18:00:00Z'})+'\n```';
 assert.equal(f.plugin.parseHomeCheckpoint('# Context\n'+good).next,'Inspect the saved results');
 for(const text of ['# Next steps\nGuess me',good+'\n'+good,good.replace('"schema":1','"schema":2'),good.replace('2026-10-16T18:00:00Z','yesterday')])
  assert.throws(()=>f.plugin.parseHomeCheckpoint(text),/checkpoint/i);
 f.plugin.unload();
});
test('Continue reads a normal handoff section, preserving a bounded excerpt without guessing from prose',async()=>{
 const f=fixture();await f.start();
 assert.equal(typeof f.plugin.parseHomeContinuation,'function','Continue must accept ordinary Markdown');
 const text='# Work\n\n## Ready now\nDone\n\n## Sıradaki somut iş\n\n`DEMO-TASK-01`: review the five example sources;\nfinish the sample comparison.\n\nAnother paragraph.\n\n## Rules\nDo not infer from here.';
 const parsed=f.plugin.parseHomeContinuation(text);
 assert.equal(parsed.status,'ready');assert.equal(parsed.heading,'Sıradaki somut iş');
 assert.equal(parsed.next,'DEMO-TASK-01: review the five example sources; finish the sample comparison.');
 assert.equal(f.plugin.parseHomeContinuation('# Project\nSomething important without a heading.').status,'missing');
 assert.equal(f.plugin.parseHomeContinuation('---\nexample: |\n  ## Next steps\n  Wrong\n---\n```md\n## Next steps\nWrong\n```\n<!--\n## Next steps\nWrong\n-->\n# Rules\nNothing').status,'missing');
 const huge=f.plugin.parseHomeContinuation('## Next steps\n'+'word '.repeat(200));assert.ok(huge.next.length<=321);assert.equal(huge.truncated,true);
 f.plugin.unload();
});
test('Continue asks for an ambiguous section and remembers an explicit section without switching silently',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.parseHomeContinuation,'function');
 const text='# History\n## Next steps\nOld action\n# Current\n## Next steps\nCurrent action';
 const choices=f.plugin.parseHomeContinuation(text);assert.equal(choices.status,'ambiguous');assert.equal(choices.candidates.length,2);
 const chosen=f.plugin.parseHomeContinuation(text,choices.candidates[1].id);assert.equal(chosen.next,'Current action');
 assert.equal(f.plugin.parseHomeContinuation('# History\n## Next steps\nOld action',choices.candidates[1].id).status,'missing');
 const empty=f.plugin.parseHomeContinuation('## Sonraki adım\n\n## Completed\nOld work');assert.equal(empty.status,'missing');
 f.plugin.unload();
});
test('One-field Add infers note, file, folder and link; only the chosen folder is searched in fixed order',async()=>{
 const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'home-simple-'));
 const f=fixture([['Hub/Other/Read.md',{}]]);await f.start();
 try {
  assert.equal(typeof f.plugin.inferHomeSource,'function','Add needs one-field inference');
  const note=await f.plugin.inferHomeSource('Hub/Other/Read.md#Part two');assert.equal(note.type,'note');assert.equal(note.title,'Read');
  const link=await f.plugin.inferHomeSource('https://example.com/reading');assert.equal(link.type,'url');assert.equal(link.title,'example.com');
  await assert.rejects(()=>f.plugin.inferHomeSource('javascript:alert(1)'),/link|path/i);
  fs.writeFileSync(path.join(dir,'HANDOFF.md'),'## Sıradaki somut iş\nInspect the next batch.');
  fs.writeFileSync(path.join(dir,'README.md'),'## Next steps\nREADME step');
  fs.writeFileSync(path.join(dir,'AGENTS.md'),'## Next steps\nDo not auto-select guidance.');
  const folder=await f.plugin.inferHomeSource(dir);assert.equal(folder.type,'folder');assert.equal(folder.title,path.basename(dir));
  const file=await f.plugin.inferHomeSource(path.join(dir,'HANDOFF.md'));assert.equal(file.type,'file');
  let result=await f.plugin.resolveHomeContinuation(folder);assert.equal(result.value.next,'Inspect the next batch.');assert.equal(result.path,path.join(dir,'HANDOFF.md'));
  fs.writeFileSync(path.join(dir,'HANDOFF.md'),'# Handoff\nNo matching section');
  result=await f.plugin.resolveHomeContinuation(folder);assert.equal(result.value.next,'README step');
  fs.writeFileSync(path.join(dir,'README.md'),'# Overview\nNo next step');result=await f.plugin.resolveHomeContinuation(folder);assert.equal(result.value.status,'missing');
  result=await f.plugin.resolveHomeContinuation({...folder,checkpoint:path.join(dir,'AGENTS.md')});assert.equal(result.value.next,'Do not auto-select guidance.');
  fs.unlinkSync(path.join(dir,'AGENTS.md'));await assert.rejects(()=>f.plugin.resolveHomeContinuation({...folder,checkpoint:path.join(dir,'AGENTS.md')}));
 } finally {f.plugin.unload();fs.rmSync(dir,{recursive:true,force:true});}
});
test('Checkpoint refresh reads only the selected pinned source and invalidates stale or unloaded reads',async()=>{
 const f=fixture();await f.start();assert.ok(f.plugin.homeState);
 const s=await f.plugin.saveHomeSource({title:'Project',type:'folder',target:'/tmp/project',checkpoint:'/tmp/project/HANDOFF.md'},'work');
 let finish,calls=0;f.plugin.readHomeCheckpointFile=()=>{calls++;return new Promise(r=>{finish=r;});};
 const pending=f.plugin.refreshHomeCheckpoint();const repeated=f.plugin.refreshHomeCheckpoint();await f.flush();assert.equal(calls,1);
 await f.plugin.saveHomeSource({...s,checkpoint:''},'work',JSON.stringify(s));
 finish('```es-hub\n{"schema":1,"title":"Old","next":"Obsolete","updatedAt":"2026-10-16T18:00:00Z"}\n```');await Promise.all([pending,repeated]);
 assert.equal(f.plugin.homeCheckpoints.has(s.id),false);
 f.plugin.unload();await f.plugin.refreshHomeCheckpoint();assert.equal(calls,1);
});
test('Continue preserves identifiers and ignores legacy examples hidden in comments or frontmatter',async()=>{
 const f=fixture();await f.start();
 assert.equal(f.plugin.parseHomeContinuation('## NEXT ACTION\nCheck `test_result_id` before the next run.').next,'Check test_result_id before the next run.');
 const legacy='```es-hub\n{"schema":1,"title":"Hidden","next":"Never display this","updatedAt":"2026-10-16T18:00:00Z"}\n```';
 assert.equal(f.plugin.parseHomeContinuation('<!--\n'+legacy+'\n-->').status,'missing');
 assert.equal(f.plugin.parseHomeContinuation('---\n'+legacy+'\n---').status,'missing');f.plugin.unload();
});
test('Home picker allows one file or folder without saving or reading the selection',async()=>{
 const f=fixture();await f.start();
 assert.equal(typeof f.plugin.chooseHomePath,'function');
 let received;
 const win={electron:{remote:{dialog:{showOpenDialogSync:options=>{received=options;return ['/Users/example/Documents/My studies'];}}}}};
 assert.equal(f.plugin.chooseHomePath(win),'/Users/example/Documents/My studies');
 assert.deepEqual(Array.from(received.properties),['openFile','openDirectory','dontAddToRecent']);
 win.electron.remote.dialog.showOpenDialogSync=()=>['/Users/example/Developer/project/HANDOFF.md'];
 assert.equal(f.plugin.chooseHomePath(win),'/Users/example/Developer/project/HANDOFF.md');
 assert.equal(f.saves.length,0);
 win.electron.remote.dialog.showOpenDialogSync=()=>undefined;
 assert.equal(f.plugin.chooseHomePath(win),'');
 win.electron.remote.dialog.showOpenDialogSync=()=>[];
 assert.equal(f.plugin.chooseHomePath(win),'');
 assert.throws(()=>f.plugin.chooseHomePath({}),/desktop|paste/i);
 win.electron.remote.dialog.showOpenDialogSync=()=>{throw Error('PRIVATE_SYSTEM_ERROR');};
 assert.throws(()=>f.plugin.chooseHomePath(win),e=>/paste/i.test(e.message)&&!e.message.includes('PRIVATE_SYSTEM_ERROR'));
 f.plugin.unload();
});
test('Continue allows a new document read while the old read is pending and respects a manual bookmark',async()=>{
 const f=fixture();await f.start();
 const source=await f.plugin.saveHomeSource({title:'Project',type:'file',target:'/tmp/first.md',readMode:'auto'},'work');
 let finish;f.plugin.readHomeCheckpointFile=async p=>p==='/tmp/first.md'?new Promise(r=>{finish=r;}):'## Next step\nNew document';
 const old=f.plugin.refreshHomeCheckpoint();await f.flush();
 const changed=await f.plugin.saveHomeSource({...source,target:'/tmp/second.md'},'work',JSON.stringify(source));
 await f.plugin.refreshHomeCheckpoint();assert.equal(f.plugin.homeCheckpoints.get(source.id).value.next,'New document');
 finish('## Next step\nOld document');await old;assert.equal(f.plugin.homeCheckpoints.get(source.id).value.next,'New document');
 await f.plugin.saveHomeSource({...changed,readMode:'manual',bookmark:'Page 12'},'work',JSON.stringify(changed));
 f.plugin.readHomeCheckpointFile=()=>{throw Error('Manual bookmark must not read');};await f.plugin.refreshHomeCheckpoint();
 assert.equal(f.plugin.homeCheckpoints.has(source.id),false);f.plugin.unload();
});
test('Home view rename/remove preserve sources, and forgetting a pinned source is rejected',async()=>{
 const f=fixture();await f.start();
 const viewId=await f.plugin.saveHomeView('Reading');assert.equal(f.plugin.homeView().name,'Reading');
 const source=await f.plugin.saveHomeSource({title:'Paper',type:'file',target:'~/Documents/paper.pdf'},viewId);
 await f.plugin.saveHomeView('Library',viewId,'Reading');
 await assert.rejects(async()=>f.plugin.saveHomeView('Stale',viewId,'Reading'),/changed/);
 assert.equal(typeof f.plugin.forgetHomeSource,'function','Unpinned sources must be removable without deleting files');
 await assert.rejects(()=>f.plugin.forgetHomeSource(source.id),/unpin/i);
 await f.plugin.deleteHomeView(viewId);assert.equal(f.plugin.homeView().id,'work');assert.equal(f.plugin.homeState.sources.length,1);
 await f.plugin.forgetHomeSource(source.id);assert.equal(f.plugin.homeState.sources.length,0);f.plugin.unload();
});
test('Home rejects invalid persisted dates and unknown versions without overwriting settings',async()=>{
 const f=fixture([],{homeWorkspace:{version:9},other:'keep'});await f.start();
 assert.ok(f.plugin.homeStateError);await assert.rejects(()=>f.plugin.setHomeView('study'),/repair/);assert.equal(f.saves.length,0);f.plugin.unload();
 const g=fixture();await g.start();
 await assert.rejects(()=>g.plugin.saveHomeSource({title:'Bad date',type:'url',target:'https://example.com',updatedAt:'invalid'},'work'),/date/i);g.plugin.unload();
});
const handoffContractPath=path.join(require('node:os').homedir(),'.agents/skills/handoff/references/home-checkpoint.md');
test('The handoff skill Markdown example parses with the same section reader used by Home',{skip:!fs.existsSync(handoffContractPath)},async()=>{
 const f=fixture();await f.start();
 const contract=fs.readFileSync(handoffContractPath,'utf8');
 const example=contract.match(/```markdown\n([\s\S]*?)\n```/)[1];
 const checkpoint=f.plugin.parseHomeContinuation(example);assert.equal(checkpoint.status,'ready');assert.match(checkpoint.next,/saved retrieval results/);f.plugin.unload();
});
test('Home checkpoint filesystem reader is bounded, rejects symlinks, and reports missing files without retaining a fresh claim',async()=>{
 const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'home-reader-'));const record=path.join(dir,'HANDOFF.md');
 const f=fixture();await f.start();
 try {
  fs.writeFileSync(record,'```es-hub\n{"schema":1,"title":"Check","next":"Read actual file","updatedAt":"2026-10-16T18:00:00Z"}\n```');
  const source=await f.plugin.saveHomeSource({title:'Check',type:'folder',target:dir,checkpoint:record},'work');
  await f.plugin.refreshHomeCheckpoint();assert.equal(f.plugin.homeCheckpoints.get(source.id).value.next,'Read actual file');
  fs.renameSync(record,record+'.moved');await f.plugin.refreshHomeCheckpoint();
  assert.match(f.plugin.homeCheckpoints.get(source.id).error,/unavailable/);assert.equal(f.plugin.homeCheckpoints.get(source.id).value,undefined);
  fs.symlinkSync(record+'.moved',record);await assert.rejects(()=>f.plugin.readHomeCheckpointFile(record));
  fs.unlinkSync(record);fs.writeFileSync(record,'x'.repeat(2*1024*1024+1));await assert.rejects(()=>f.plugin.readHomeCheckpointFile(record));
 } finally {f.plugin.unload();fs.rmSync(dir,{recursive:true,force:true});}
});

test('YouTrack widget rejects other assignees and unsafe URLs, keeping a dated MCP snapshot',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.homeYouTrackIssues,'function');
 f.plugin.youtrackSnapshot={schema:1,fetchedAt:'2026-10-16T11:30:00Z',issues:[
  {id:'DEMO-161',title:'Incoming card',assignee:'Alex',url:'https://tracker.example.com/issue/DEMO-161',state:'To do'},
  {id:'DEMO-162',title:'Not mine',assignee:'Someone else',url:'https://tracker.example.com/issue/DEMO-162'},
  {id:'DEMO-163',title:'Unsafe URL',assignee:'Alex',url:'javascript:alert(1)'},
 ]};
 assert.deepEqual(Array.from(f.plugin.homeYouTrackIssues(),x=>x.id),['DEMO-161']);f.plugin.unload();
});

function widgetSnapshot(title='Fresh card') {return {schema:1,source:'YouTrack MCP',assignee:'Alex',fetchedAt:new Date().toISOString(),issues:[{id:'DEMO-161',title,assignee:'Alex',state:'To do',priority:'Normal',url:'https://tracker.example.com/issue/DEMO-161'}]};}
test('YouTrack Refresh fetches on demand, saves a complete snapshot and preserves unrelated settings',async()=>{
 const f=fixture([], {homeCollapsed:false,hiddenTagSuggestions:['keep']});await f.start();
 assert.equal(typeof f.plugin.refreshYouTrack,'function');let calls=0,saved;
 f.plugin.fetchYouTrackSnapshot=async()=>{calls++;return widgetSnapshot();};
 f.plugin.persistYouTrackSnapshot=async value=>{saved=value;};
 assert.equal(calls,0);await f.plugin.refreshYouTrack();
 assert.equal(calls,1);assert.equal(saved.issues[0].title,'Fresh card');assert.equal(f.plugin.homeYouTrackIssues()[0].title,'Fresh card');
 assert.equal(f.saves.length,0);assert.equal(f.plugin.youtrackBusy,false);assert.equal(f.plugin.youtrackRefreshError,'');f.plugin.unload();
});
test('YouTrack Refresh coalesces clicks and invalidates older local reads',async()=>{
 const f=fixture();await f.start();let finish,calls=0;const saved=[];
 f.plugin.fetchYouTrackSnapshot=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
 f.plugin.persistYouTrackSnapshot=async value=>saved.push(value);
 let finishRead;f.app.vault.adapter.read=()=>new Promise(resolve=>{finishRead=resolve;});
 const oldRead=f.plugin.loadYouTrackSnapshot();const first=f.plugin.refreshYouTrack();await f.plugin.refreshYouTrack();
 assert.equal(calls,1);assert.equal(f.plugin.youtrackBusy,true);finish(widgetSnapshot());await first;
 finishRead(JSON.stringify(widgetSnapshot('Old read')));await oldRead;
 assert.equal(f.plugin.homeYouTrackIssues()[0].title,'Fresh card');assert.equal(saved.length,1);f.plugin.unload();
});
test('YouTrack Refresh preserves last good data on request, validation and persistence errors without leaking errors',async()=>{
 const f=fixture();await f.start();const old=widgetSnapshot('Keep me');f.plugin.youtrackSnapshot=old;
 f.plugin.fetchYouTrackSnapshot=async()=>{throw Error('TOKEN_SECRET');};
 await f.plugin.refreshYouTrack();assert.equal(f.plugin.youtrackSnapshot,old);assert.match(f.plugin.youtrackRefreshError,/last saved list/i);assert.ok(!f.plugin.youtrackRefreshError.includes('TOKEN_SECRET'));
 f.plugin.fetchYouTrackSnapshot=async()=>({...widgetSnapshot(),issues:[{...widgetSnapshot().issues[0],assignee:'Other'}]});
 let writes=0;f.plugin.persistYouTrackSnapshot=async()=>{writes++;};await f.plugin.refreshYouTrack();assert.equal(writes,0);assert.equal(f.plugin.youtrackSnapshot,old);
 f.plugin.fetchYouTrackSnapshot=async()=>widgetSnapshot();f.plugin.persistYouTrackSnapshot=async()=>{throw Error('DISK_SECRET');};
 await f.plugin.refreshYouTrack();assert.equal(f.plugin.youtrackSnapshot,old);assert.ok(!f.plugin.youtrackRefreshError.includes('SECRET'));assert.equal(f.plugin.youtrackBusy,false);f.plugin.unload();
});
test('YouTrack Refresh ignores late results and cancels the local reader on unload',async()=>{
 const f=fixture();await f.start();let finish,killed=false,writes=0;
 f.plugin.fetchYouTrackSnapshot=()=>new Promise(resolve=>{finish=resolve;});f.plugin.persistYouTrackSnapshot=async()=>{writes++;};
 const pending=f.plugin.refreshYouTrack();f.plugin.youtrackProcess={kill:()=>{killed=true;}};f.plugin.unload();finish(widgetSnapshot());await pending;
 assert.equal(writes,0);assert.equal(killed,true);
});

const testCalendarUrl='https://calendar.google.com/calendar/ical/test%40example.com/private-fixture/basic.ics';
test('calendar connects read-only, keeps secret out of settings, and clears local data on disconnect',async()=>{
  const f=fixture([], {hiddenTagSuggestions:['keep'],otherSetting:42});await f.start();
  assert.equal(f.requests.length,0);
  await f.plugin.connectCalendar(testCalendarUrl);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].method,'GET');
  assert.equal(f.secrets.get('es-hub-google-ical'),testCalendarUrl);
  assert.equal(f.plugin.calendarEnabled,true);assert.ok(f.plugin.calendarCache);
  assert.equal(f.saves.at(-1).otherSetting,42);
  assert.ok(!JSON.stringify(f.saves).includes('private-fixture'));
  await f.plugin.disconnectCalendar();
  assert.equal(f.plugin.calendarEnabled,false);assert.equal(f.plugin.calendarCache,null);
  assert.equal(f.secrets.get('es-hub-google-ical'),'');
  await f.plugin.refreshCalendar();assert.equal(f.requests.length,1);
  f.plugin.unload();
});
test('calendar rejects foreign URLs before requests and sanitizes feed failures without changing secrets',async()=>{
  const f=fixture();await f.start();
  await assert.rejects(f.plugin.connectCalendar('https://example.com/private.ics'),/Google Calendar/);
  assert.equal(f.requests.length,0);
  f.app.requestCalendar=async()=>{throw Error(testCalendarUrl);};
  await assert.rejects(f.plugin.connectCalendar(testCalendarUrl),e=>!e.message.includes('private-fixture')&&/Could not read/.test(e.message));
  assert.equal(f.secrets.size,0);assert.equal(f.plugin.calendarEnabled,false);assert.equal(f.plugin.calendarBusy,false);
  f.plugin.unload();
});
test('calendar persistence failure restores old secret and failed refresh preserves last successful events',async()=>{
  const f=fixture();await f.start();await f.plugin.connectCalendar(testCalendarUrl);
  const cache=f.plugin.calendarCache;
  const save=f.plugin.saveData;f.plugin.saveData=async()=>{throw Error('disk');};
  await assert.rejects(f.plugin.connectCalendar(testCalendarUrl.replace('fixture','replacement')),/previous connection was kept/);
  assert.equal(f.secrets.get('es-hub-google-ical'),testCalendarUrl);assert.equal(f.plugin.calendarCache,cache);
  f.plugin.saveData=save;f.app.requestCalendar=async()=>({status:503,text:'unavailable'});
  await f.plugin.refreshCalendar(true);assert.equal(f.plugin.calendarCache,cache);
  assert.match(f.plugin.calendarError,/last successful/);assert.ok(!f.notices.join('').includes('private-fixture'));
  f.plugin.unload();
});
test('disconnect or unload invalidates pending calendar data and duplicate connection is rejected',async()=>{
  const f=fixture();await f.start();await f.plugin.connectCalendar(testCalendarUrl);
  let finish;f.app.requestCalendar=()=>new Promise(resolve=>{finish=resolve;});
  const pending=f.plugin.refreshCalendar();await flush();
  await assert.rejects(f.plugin.connectCalendar(testCalendarUrl),/already running/);
  await f.plugin.disconnectCalendar();
  finish({status:200,text:'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR'});await pending;
  assert.equal(f.plugin.calendarCache,null);assert.equal(f.plugin.calendarEnabled,false);
  const reconnect=f.plugin.connectCalendar(testCalendarUrl);await flush();f.plugin.unload();
  finish({status:200,text:'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR'});await reconnect;
  assert.equal(f.plugin.calendarCache,null);assert.equal(f.secrets.get('es-hub-google-ical'),'');
});

test('Google sign-in stores only refresh credentials locally, loads primary events, refreshes and disconnects',async()=>{
 const f=fixture([], {other:42});await f.start();
 f.plugin.authorizeGoogle=async()=>({code:'fixture-code',verifier:'fixture-verifier',redirect:'http://127.0.0.1:12345/callback'});
 f.app.requestCalendar=async args=>args.url.endsWith('/token')?{status:200,json:{access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600,scope:'https://www.googleapis.com/auth/calendar.events.owned.readonly'}}:{status:200,json:{items:[{id:'event',summary:'Meeting',start:{dateTime:'2026-10-16T10:00:00+03:00'},end:{dateTime:'2026-10-16T11:00:00+03:00'}}]}};
 await f.plugin.connectGoogleCalendar(JSON.stringify({installed:{client_id:'123-test.apps.googleusercontent.com',client_secret:'fixture-client'}}));
 assert.equal(f.plugin.calendarSource,'google');assert.equal(f.plugin.calendarEnabled,true);assert.equal(f.plugin.calendarCache.kind,'google');
 const stored=JSON.parse(f.secrets.get('es-hub-google-oauth'));assert.equal(stored.refreshToken,'fixture-refresh');assert.equal(stored.accessToken,undefined);
 assert.ok(!JSON.stringify(f.saves).includes('fixture-'));assert.equal(f.saves.at(-1).other,42);
 f.plugin.googleToken=null;await f.plugin.refreshCalendar(true,'2026-11');
 assert.ok(f.plugin.calendarCache.months.has('2026-11'));assert.ok(f.requests.some(r=>r.body?.includes('grant_type=refresh_token')));
 f.app.requestCalendar=async()=>({status:403,json:{}});await f.plugin.refreshCalendar(false,'2026-12');
 assert.equal(f.plugin.googleMonthFailures.has('2026-12'),true);assert.ok(f.plugin.calendarCache.months.has('2026-11'));
 await f.plugin.disconnectCalendar();assert.equal(f.secrets.get('es-hub-google-oauth'),'');assert.equal(f.plugin.googleToken,null);assert.equal(f.plugin.calendarCache,null);
 f.plugin.unload();
});
test('Google sign-in cancellation prevents token exchange and does not change an existing connection',async()=>{
 const f=fixture();await f.start();await f.plugin.connectCalendar(testCalendarUrl);
 const before=f.requests.length;let finish;
 f.plugin.authorizeGoogle=()=>new Promise(resolve=>{finish=resolve;});
 const pending=f.plugin.connectGoogleCalendar(JSON.stringify({installed:{client_id:'123-test.apps.googleusercontent.com'}}));
 f.plugin.cancelGoogleSignIn();finish({code:'fixture',verifier:'v',redirect:'http://127.0.0.1:12345/callback'});
 await assert.rejects(pending,/cancelled/);assert.equal(f.requests.length,before);assert.equal(f.plugin.calendarSource,'ical');
 assert.equal(f.secrets.get('es-hub-google-ical'),testCalendarUrl);assert.equal(f.secrets.has('es-hub-google-oauth'),false);f.plugin.unload();
});


test('Home keeps three widget modules beside the independent Scratchpad bar',async()=>{
 const f=fixture([],{other:'keep',homeWidgets:['calendar','continue','links']});await f.start();
 assert.deepEqual(Array.from(f.plugin.homeModules||[]),['calendar','youtrack','slack']);
 await f.plugin.setHomeModule('youtrack',false);
 assert.deepEqual(f.saves.at(-1).homeModules,['calendar','slack']);
 assert.deepEqual(f.saves.at(-1).homeWidgets,['calendar','continue','links']);
 assert.equal(f.saves.at(-1).other,'keep');
 await assert.rejects(()=>f.plugin.setHomeModule('continue',true),/module/i);f.plugin.unload();
});

test('Manual Scratchpad typing and reload create no note; Save writes one Quick Note and stays on board',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.editQuickDraft,'function');
 f.plugin.editQuickDraft('Oyun fikri\nİkinci satır');assert.equal(f.app.vault.getMarkdownFiles().length,0);
 const g=fixture();for(const [k,v]of f.storage)g.storage.set(k,v);await g.start();
 assert.equal(g.plugin.quickDraft.text,'Oyun fikri\nİkinci satır');assert.equal(g.app.vault.getMarkdownFiles().length,0);
 const file=await g.plugin.saveQuickDraft();assert.match(file.path,/^Hub\/Quick Notes\/Oyun fikri.*\.md$/);assert.equal(file.content,'Oyun fikri\nİkinci satır');
 assert.equal(g.opened.length,0);assert.equal(g.plugin.quickDraft.text,'');assert.equal(g.plugin.quickDraft.lastSaved,file.path);
 assert.ok(!g.files.has('Daily Notes'));f.plugin.unload();g.plugin.unload();
});

test('Manual Scratchpad rejects empty Save and creates only one note for overlapping Save clicks',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.editQuickDraft,'function');
 f.plugin.editQuickDraft('  \n');assert.equal(await f.plugin.saveQuickDraft(),null);
 f.plugin.editQuickDraft('Tek not');await Promise.all([f.plugin.saveQuickDraft(),f.plugin.saveQuickDraft()]);
 assert.equal(f.app.vault.getMarkdownFiles().length,1);assert.equal(f.opened.length,0);f.plugin.unload();
});

test('Manual Scratchpad keeps failed drafts and retries without overwriting names or opening a note',async()=>{
 const f=fixture([['Hub/Quick Notes/Aynı başlık.md',{}]]);await f.start();assert.equal(typeof f.plugin.editQuickDraft,'function');
 const original=f.files.get('Hub/Quick Notes/Aynı başlık.md');original.content='Keep';const create=f.app.vault.create;
 f.plugin.editQuickDraft('Aynı başlık');f.app.vault.create=async()=>{throw Error('Disk full');};
 assert.equal(await f.plugin.saveQuickDraft(),null);assert.equal(f.plugin.quickDraft.text,'Aynı başlık');assert.match(f.plugin.quickDraft.error,/Disk full/);
 f.app.vault.create=create;const file=await f.plugin.saveQuickDraft();assert.notEqual(file.path,original.path);assert.equal(original.content,'Keep');assert.equal(file.content,'Aynı başlık');f.plugin.unload();
});

test('Manual Scratchpad preserves input changed during Save and prevents backlog capture overlap',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.editQuickDraft,'function');
 f.plugin.editQuickDraft('First');f.plugin.captureBusy=true;assert.equal(await f.plugin.saveQuickDraft(),null);assert.equal(f.plugin.quickDraft.text,'First');f.plugin.captureBusy=false;
 const create=f.app.vault.create;let release;f.app.vault.create=async(p,t)=>{await new Promise(r=>release=r);return create(p,t);};
 const saving=f.plugin.saveQuickDraft();await flush();f.plugin.editQuickDraft('Second');release();const file=await saving;
 assert.equal(file.content,'First');assert.equal(f.plugin.quickDraft.text,'Second');assert.equal(f.plugin.quickDraft.busy,false);f.plugin.unload();
});

test('Manual Scratchpad recovers an interrupted successful Save without creating a duplicate',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.editQuickDraft,'function');f.plugin.editQuickDraft('Persisted note');
 const create=f.app.vault.create;let journal;
 f.app.vault.create=async(p,t)=>{journal=new Map(f.storage);return create(p,t);};
 const file=await f.plugin.saveQuickDraft();const g=fixture([[file.path,{}]]);g.files.get(file.path).content=file.content;
 for(const [k,v]of journal)g.storage.set(k,v);await g.start();
 assert.equal(g.plugin.quickDraft.text,'');assert.equal(g.plugin.quickDraft.lastSaved,file.path);
 assert.equal(await g.plugin.saveQuickDraft(),null);assert.equal(g.app.vault.getMarkdownFiles().length,1);f.plugin.unload();g.plugin.unload();
});

test('Manual Scratchpad sanitizes only the title and preserves Markdown body exactly',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.editQuickDraft,'function');
 const text='# ../A/B: idea?\n\n- [ ] todo\n[[Link]]';f.plugin.editQuickDraft(text);const file=await f.plugin.saveQuickDraft();
 assert.ok(file.path.startsWith('Hub/Quick Notes/'));assert.equal(file.path.split('/').length,3);assert.equal(file.content,text);assert.deepEqual(f.caches.get(file.path).frontmatter,{});f.plugin.unload();
});

test('Backlog capture lives in its column header and survives redraws without a standalone row',async()=>{
 const f=fixture();await f.start();
 const node=()=>({parentElement:null,children:[],classList:{add(){},remove(){}},
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(x=>x!==this);this.parentElement=null;},
  append(child){child.remove();this.children.push(child);child.parentElement=this;},
  prepend(child){child.remove();this.children.unshift(child);child.parentElement=this;},
  before(child){child.remove();const p=this.parentElement;p.children.splice(p.children.indexOf(this),0,child);child.parentElement=p;}});
 const host=node();let header=node();
 host.querySelector=selector=>selector==='.obk-column[data-column-value="backlog"] .obk-column-header'?header:null;
 let shownHost=host;
 const entry={scope:{ownerDocument:f.doc,querySelector:()=>shownHost},toolbar:node(),home:node(),buttons:[{}]};
 f.plugin.updateHome=()=>{};
 f.plugin.mountToolbar(entry);
 assert.equal(entry.toolbar.parentElement,header);assert.equal(host.children[0],entry.home);
 assert.ok(!host.children.includes(entry.toolbar));
 f.plugin.captureBusy=true;f.plugin.mountToolbar(entry);assert.equal(entry.buttons[0].disabled,true);
 header=node();f.plugin.mountToolbar(entry);assert.equal(entry.toolbar.parentElement,header);
 assert.equal(header.children.length,1);f.plugin.mountToolbar(entry);assert.equal(header.children.length,1);
 header=null;f.plugin.mountToolbar(entry);assert.equal(entry.toolbar.parentElement,null);
 assert.equal(entry.home.parentElement,host);
 shownHost=null;f.plugin.mountToolbar(entry);assert.equal(entry.home.parentElement,null);
 f.plugin.unload();
});

test('Dashboard board controls are opt-in per view and do not change saved settings',async()=>{
 const f=fixture([], {other:'keep'});await f.start();
 assert.equal(typeof f.plugin.setBoardControlsVisible,'function');
 const classes=new Set();const label={textContent:''};
 const toggle={attrs:{},setAttribute(k,v){this.attrs[k]=v;}};
 const entry={home:{classList:{toggle(name,on){if(on)classes.add(name);else classes.delete(name);}}},boardControlsToggle:toggle,boardControlsLabel:label};
 f.plugin.setBoardControlsVisible(entry,false);
 assert.equal(classes.size,0);assert.equal(label.textContent,'Show board controls');assert.equal(toggle.attrs['aria-pressed'],'false');
 f.plugin.setBoardControlsVisible(entry,true);
 assert.equal(classes.has('aim-home-board-controls-open'),true);assert.equal(label.textContent,'Hide board controls');
 f.plugin.setBoardControlsVisible(entry,false);assert.equal(classes.size,0);
 assert.equal(f.saves.length,0);f.plugin.unload();
});

function importedDetail(id='DEMO-900') {return {schema:1,id,source:'YouTrack MCP',assignee:'Alex',title:'Full task',description:'## Steps\n- [ ] Complete **this**',url:`https://tracker.example.com/issue/${id}`,state:'To do',priority:'Major',fetchedAt:'2026-10-17T00:00:00Z',updatedAt:'2026-10-17 00:00:00',fields:{State:'To do',Assignee:'Alex'},tags:[],comments:[{author:'Alex',text:'A full comment',createdAt:1,url:`https://tracker.example.com/issue/${id}#comment`,attachments:[]}],attachments:[]};}
test('YouTrack selected import creates one complete local note in the dropped column without opening it',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.importYouTrackIssue,'function');
 f.plugin.fetchYouTrackDetail=async()=>importedDetail();
 const file=await f.plugin.importYouTrackIssue('DEMO-900','in-progress');
 assert.equal(file.path,'Hub/YouTrack/DEMO-900.md');assert.match(file.content,/board_column: "in-progress"/);
 assert.match(file.content,/youtrack_import: "local-v1"/);assert.doesNotMatch(file.content,/youtrack_mirror:/);
 assert.ok(file.content.includes('## Steps\n- [ ] Complete **this**'));assert.ok(file.content.includes('A full comment'));
 assert.match(file.content,/## My notes/);assert.equal(f.opened.length,0);f.plugin.unload();
});
test('YouTrack reimport matches a renamed local note by RES identity and preserves its body and priority',async()=>{
 const fm={youtrack_id:'DEMO-900',youtrack_import:'local-v1',tags:['kanban'],board_column:'backlog',priority:'low'};
 const f=fixture([['Hub/Data/Renamed.md',fm]]);await f.start();assert.equal(typeof f.plugin.importYouTrackIssue,'function');
 const file=f.files.get('Hub/Data/Renamed.md');file.content='My changed content';f.plugin.fetchYouTrackDetail=()=>{throw Error('Must not refetch');};
 const result=await f.plugin.importYouTrackIssue('DEMO-900','done');
 assert.equal(result,file);assert.equal(fm.board_column,'done');assert.equal(fm.priority,'low');assert.equal(file.content,'My changed content');
 assert.equal(f.files.has('Hub/YouTrack/DEMO-900.md'),false);f.plugin.unload();
});
test('YouTrack import rejects duplicate identities, foreign ownership and path collisions without overwriting',async()=>{
 for(const kind of ['duplicate','mirror','collision','foreign']){
  const initial=kind==='duplicate'?[['Hub/Data/A.md',{youtrack_id:'DEMO-900',youtrack_import:'local-v1'}],['Hub/Data/B.md',{youtrack_id:'DEMO-900',youtrack_import:'local-v1'}]]:kind==='mirror'?[['Hub/YouTrack/DEMO-900.md',{youtrack_id:'DEMO-900',youtrack_mirror:'old'}]]:kind==='collision'?[['Hub/YouTrack/DEMO-900.md',{}]]:[];
  const f=fixture(initial);await f.start();assert.equal(typeof f.plugin.importYouTrackIssue,'function');
  f.plugin.fetchYouTrackDetail=async()=>({...importedDetail(),assignee:kind==='foreign'?'Other':'Alex'});
  const size=f.files.size;await assert.rejects(()=>f.plugin.importYouTrackIssue('DEMO-900','in-progress'));
  assert.equal(f.files.size,size);f.plugin.unload();
 }
});
test('YouTrack failed and cancelled imports create no card; concurrent imports cannot duplicate one issue',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.importYouTrackIssue,'function');
 let resume;f.plugin.fetchYouTrackDetail=()=>new Promise(r=>resume=r);
 const pending=f.plugin.importYouTrackIssue('DEMO-900','in-progress');await flush();
 await assert.rejects(()=>f.plugin.importYouTrackIssue('DEMO-900','backlog'),/already/i);
 f.plugin.unload();resume(importedDetail());await assert.rejects(()=>pending);
 assert.equal(f.files.has('Hub/YouTrack/DEMO-900.md'),false);
 const g=fixture();await g.start();g.plugin.fetchYouTrackDetail=async()=>{throw Error('offline');};
 await assert.rejects(()=>g.plugin.importYouTrackIssue('DEMO-900','backlog'));
 assert.equal(g.files.has('Hub/YouTrack/DEMO-900.md'),false);g.plugin.unload();
});
test('YouTrack drop routing accepts only this widget drag and a managed three-column target',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.handleYouTrackDrop,'function');
 let imported=[];f.plugin.importYouTrackIssue=async(...args)=>imported.push(args);
 const host={},column={getAttribute:()=> 'in-progress',closest:s=>s==='.aim-home-host'?host:null};
 const target={closest:s=>s==='.obk-column[data-column-value]'?column:null};
 const event={target,dataTransfer:{getData:()=> 'DEMO-900'},preventDefault(){},stopImmediatePropagation(){}};
 await f.plugin.handleYouTrackDrop(event);assert.equal(imported.length,0);
 f.plugin.youtrackDrag={id:'DEMO-900',doc:f.doc};await f.plugin.handleYouTrackDrop(event);
 assert.deepEqual(imported,[['DEMO-900','in-progress']]);assert.equal(f.plugin.youtrackDrag,null);f.plugin.unload();
});

test('YouTrack attachments are local before the note is published, with embedded media and rollback on note failure',async()=>{
 for(const fail of [false,true]){
  const f=fixture();await f.start();const binary=new Map();
  f.app.vault.createBinary=async(p,data)=>{const file=new f.TFile(p);binary.set(p,Buffer.from(data));return file;};
  f.app.vault.readBinary=async file=>binary.get(file.path);
  f.app.vault.trash=async file=>{binary.delete(file.path);f.files.delete(file.path);};
  f.plugin.fetchYouTrackDetail=async()=>({...importedDetail(),description:'Image: ![](youtrack-attachment://1){width=70%}',attachments:[{name:'a.png',fileName:'001-a.png',size:3,data:'YWJj'}]});
  if(fail)f.app.vault.create=async()=>{throw Error('Disk write failed');};
  if(fail){await assert.rejects(()=>f.plugin.importYouTrackIssue('DEMO-900','backlog'));assert.equal(binary.size,0);assert.equal(f.files.has('Hub/YouTrack/DEMO-900.md'),false);}
  else{const file=await f.plugin.importYouTrackIssue('DEMO-900','done');assert.equal(binary.size,1);assert.match(file.content,/!\[\[Hub\/Attachments\/YouTrack\/DEMO-900-/);assert.match(file.content,/completed_at_source: "status_change"/);assert.doesNotMatch(file.content,/youtrack-attachment:/);}
  f.plugin.unload();
 }
});
test('YouTrack import rejects incomplete attachments and a competing new note before creating content',async()=>{
 for(const kind of ['bytes','late']){
 const f=fixture();await f.start();f.plugin.fetchYouTrackDetail=async()=>{
  if(kind==='late')new f.TFile('Hub/YouTrack/DEMO-900.md');
  return {...importedDetail(),attachments:kind==='bytes'?[{name:'a',fileName:'001-a',size:4,data:'YWJj'}]:[]};
 };
 await assert.rejects(()=>f.plugin.importYouTrackIssue('DEMO-900','backlog'));
 assert.equal(f.files.get('Hub/YouTrack/DEMO-900.md')?.content,undefined);f.plugin.unload();
 }
});

test('Home splitter keeps a device-local preference and clamps each panel without overwriting it',async()=>{
 const f=fixture([],{other:'keep'});await f.start();
 assert.equal(typeof f.plugin.setHomeWidgetHeight,'function','Resizable widget row is required');
 const a=resizeEntry(f,1000),b=resizeEntry(f,800);
 f.plugin.applyHomeWidgetHeight(a.entry);assert.equal(a.props['--aim-home-widget-height'],'360px');
 f.plugin.setHomeWidgetHeight(480);
 assert.equal(a.props['--aim-home-widget-height'],'480px');assert.equal(b.props['--aim-home-widget-height'],'354px');
 // Native horizontal scrollbars take visible height on narrow panels.
 b.entry.homeGrid.offsetHeight=414;b.entry.homeGrid.clientHeight=400;
 f.plugin.applyHomeWidgetHeight(b.entry);assert.equal(b.props['--aim-home-widget-height'],'340px');
 b.host.clientHeight=500;f.plugin.applyHomeWidgetHeight(b.entry);assert.equal(b.props['--aim-home-widget-height'],'300px');
 assert.equal(f.plugin.homeWidgetHeight,480);assert.equal(f.saves.length,0);assert.equal(f.files.has('Hub/Quick Notes/resize.md'),false);
 b.host.clientHeight=1000;f.plugin.applyHomeWidgetHeight(b.entry);assert.equal(b.props['--aim-home-widget-height'],'480px');
 const g=fixture();for(const[k,v]of f.storage)g.storage.set(k,v);await g.start();assert.equal(g.plugin.homeWidgetHeight,480);
 assert.throws(()=>g.plugin.setHomeWidgetHeight(NaN),/height/i);assert.equal(g.plugin.homeWidgetHeight,480);
 f.plugin.setHomeWidgetHeight(null);assert.equal(a.props['--aim-home-widget-height'],'360px');
 f.plugin.toolbars.clear();f.plugin.unload();g.plugin.unload();
});

test('Home splitter previews while dragging, commits once, and cancels without saving',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.startHomeResize,'function');
 const a=resizeEntry(f);const ev={button:0,pointerId:4,clientY:100,preventDefault(){},stopPropagation(){}};
 f.plugin.startHomeResize(a.entry,ev);
 f.doc.dispatch({type:'pointermove',pointerId:4,clientY:170,preventDefault(){}});
 assert.equal(a.props['--aim-home-widget-height'],'430px');assert.equal(f.plugin.homeWidgetHeight,null);
 f.doc.dispatch({type:'pointerup',pointerId:4,clientY:170});assert.equal(f.plugin.homeWidgetHeight,430);
 assert.equal(f.doc.listeners.filter(l=>l.event.startsWith('pointer')).length,0);
 f.plugin.startHomeResize(a.entry,ev);f.doc.dispatch({type:'pointermove',pointerId:4,clientY:1000,preventDefault(){}});
 assert.equal(a.props['--aim-home-widget-height'],'454px');
 f.doc.dispatch({type:'pointercancel',pointerId:4});assert.equal(a.props['--aim-home-widget-height'],'430px');assert.equal(f.plugin.homeWidgetHeight,430);
 f.plugin.startHomeResize(a.entry,ev);a.entry.resizeCancel();assert.equal(f.doc.listeners.filter(l=>l.event.startsWith('pointer')).length,0);
 f.plugin.toolbars.clear();f.plugin.unload();
});

test('Home splitter keyboard and storage failures preserve a usable layout without settings or note writes',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.homeResizeKey,'function');
 const a=resizeEntry(f,900);const key=k=>f.plugin.homeResizeKey(a.entry,{key:k,preventDefault(){},stopPropagation(){}});
 key('ArrowDown');assert.equal(a.props['--aim-home-widget-height'],'380px');assert.equal(a.handle.getAttribute('aria-valuenow'),'380');
 key('End');assert.equal(a.props['--aim-home-widget-height'],'454px');
 key('Enter');assert.equal(a.props['--aim-home-widget-height'],'360px');
 const saved=f.doc.defaultView.localStorage.setItem;f.doc.defaultView.localStorage.setItem=()=>{throw Error('quota');};
 assert.throws(()=>f.plugin.setHomeWidgetHeight(400),/save.*height/i);assert.equal(f.plugin.homeWidgetHeight,null);assert.equal(a.props['--aim-home-widget-height'],'360px');
 f.doc.defaultView.localStorage.setItem=saved;
 f.plugin.homeCollapsed=true;f.plugin.applyHomeWidgetHeight(a.entry);assert.equal(a.handle.hidden,true);
 assert.equal(f.saves.length,0);assert.equal(f.app.vault.getMarkdownFiles().length,0);
 f.plugin.toolbars.clear();f.plugin.unload();
});

function calendarMarkerEntry(f, days) {
 const buttons=days.map(day=>{const node=new Dom('button');node.dataset={day,dateLabel:day};return node;});
 return {calendarMonth:'2026-10',calendarDays:{querySelectorAll:()=>buttons},buttons,scope:{ownerDocument:f.doc}};
}
test('YouTrack status sync ignores startup and unrelated edits, and includes reopening',async()=>{
 const fm={youtrack_id:'DEMO-900',youtrack_import:'local-v1',tags:['kanban'],board_column:'in-progress'};
 const old={...fm,youtrack_id:'DEMO-901',board_column:'done'};
 const f=fixture([['Hub/YouTrack/DEMO-900.md',fm],['Hub/YouTrack/DEMO-901.md',old]]);
 const calls=[];f.plugin.fetchYouTrackState=async(id,column)=>{calls.push(id);return {id,state:column==='done'?'Done':'In Progress'};};await f.start();
 assert.equal(calls.length,0);const file=f.files.get('Hub/YouTrack/DEMO-900.md');
 await f.plugin.setNoteProperty(file,'board_column','done');await flush();
 assert.deepEqual(calls,['DEMO-900']);assert.match(f.notices.join(' '),/DEMO-900.*Done.*YouTrack/);
 await f.plugin.setNoteProperty(file,'priority','high');await flush();assert.equal(calls.length,1);
 await f.plugin.setNoteProperty(file,'board_column','in-progress');await flush();assert.equal(calls.length,2);
 f.plugin.unload();
});
test('YouTrack completion failures remain visible, preserve the local card, and retry only on request',async()=>{
 const fm={youtrack_id:'DEMO-900',youtrack_import:'local-v1',tags:['kanban'],board_column:'in-progress'};
 const f=fixture([['Hub/YouTrack/DEMO-900.md',fm]]);await f.start();const file=f.files.get('Hub/YouTrack/DEMO-900.md');file.content='Keep my writing';
 let calls=0;f.plugin.fetchYouTrackState=async()=>{calls++;throw Object.assign(Error('SECRET'),{youtrackCode:'uncertain'});};
 await f.plugin.setNoteProperty(file,'board_column','done');await flush();
 assert.equal(calls,1);assert.equal(fm.board_column,'done');assert.equal(file.content,'Keep my writing');
 assert.equal(f.plugin.youtrackSyncResults.get('DEMO-900').status,'uncertain');assert.doesNotMatch(f.notices.join(' '),/SECRET/);
 f.plugin.seedCompletion();await flush();assert.equal(calls,1);
 f.plugin.fetchYouTrackState=async id=>{calls++;return {id,state:'Done'};};
 await f.plugin.syncYouTrackIssue(file);assert.equal(calls,2);assert.equal(f.plugin.youtrackSyncResults.get('DEMO-900').status,'synced');f.plugin.unload();
});
test('YouTrack completion ignores unowned notes and blocks duplicate IDs and stale local states',async()=>{
 const fm={youtrack_id:'DEMO-900',youtrack_import:'local-v1',tags:['kanban'],board_column:'in-progress'};
 for(const kind of ['mirror','duplicate','unload']){
  const f=fixture([['Hub/YouTrack/DEMO-900.md',{...fm,...(kind==='mirror'?{youtrack_import:'old'}:{})}],...(kind==='duplicate'?[['Hub/Data/Duplicate.md',{...fm}]]:[])]);
  await f.start();let calls=0;f.plugin.fetchYouTrackState=async id=>{calls++;return {id,state:'Done'};};
  if(kind==='unload')f.plugin.unload();
  await f.plugin.setNoteProperty(f.files.get('Hub/YouTrack/DEMO-900.md'),'board_column','done');await flush();assert.equal(calls,0);f.plugin.unload();
 }
});
test('YouTrack pending writes survive reload as unconfirmed without replay; overlapping requests coalesce',async()=>{
 const fm={youtrack_id:'DEMO-900',youtrack_import:'local-v1',tags:['kanban'],board_column:'done'};
 const f=fixture([['Hub/YouTrack/DEMO-900.md',fm]]);
 f.storage.set('es-hub:youtrack-done:TestVault:tracker.example.com|DEMO|Alex',JSON.stringify([['DEMO-900',{status:'pending',at:Date.now()}]]));
 let calls=0,finish;f.plugin.fetchYouTrackState=async id=>{calls++;return new Promise(r=>finish=()=>r({id,state:'Done'}));};await f.start();
 assert.equal(calls,0);assert.equal(f.plugin.youtrackSyncResults.get('DEMO-900').status,'uncertain');
 const file=f.files.get('Hub/YouTrack/DEMO-900.md');const first=f.plugin.syncYouTrackIssue(file),second=f.plugin.syncYouTrackIssue(file);
 await flush();assert.equal(calls,1);finish();await Promise.all([first,second]);
 assert.equal(f.plugin.youtrackSyncResults.get('DEMO-900').status,'synced');f.plugin.unload();
});
test('YouTrack direct Done import waits for metadata and recovery storage failures prevent remote writes',async()=>{
 const f=fixture();await f.start();f.plugin.fetchYouTrackDetail=async()=>importedDetail();let calls=0;
 f.plugin.fetchYouTrackState=async(id,column)=>{calls++;return {id,state:column==='done'?'Done':'In Progress'};};
 const file=await f.plugin.importYouTrackIssue('DEMO-900','done');assert.equal(calls,0);
 f.caches.get(file.path).frontmatter={youtrack_id:'DEMO-900',youtrack_import:'local-v1',youtrack_url:'https://tracker.example.com/issue/DEMO-900',youtrack_assignee:'Alex',tags:['kanban'],board_column:'done'};
 f.app.metadataCache.emit('changed',file,'',f.caches.get(file.path));await flush();assert.equal(calls,1);
 await f.plugin.setNoteProperty(file,'board_column','in-progress');await flush();assert.equal(calls,2);
 f.doc.defaultView.localStorage.setItem=()=>{throw Error('quota');};
 await f.plugin.setNoteProperty(file,'board_column','done');await flush();assert.equal(calls,2);
 assert.equal(f.plugin.youtrackSyncResults.get('DEMO-900').status,'error');f.plugin.unload();
});
test('Explicit Add to Done retries an already-Done local copy without refetching or rewriting its body',async()=>{
 const fm={youtrack_id:'DEMO-900',youtrack_import:'local-v1',tags:['kanban'],board_column:'done'};
 const f=fixture([['Hub/YouTrack/DEMO-900.md',fm]]);await f.start();const file=f.files.get('Hub/YouTrack/DEMO-900.md');file.content='My notes';
 let calls=0;f.plugin.fetchYouTrackState=async id=>{calls++;return {id,state:'Done'};};
 await f.plugin.importYouTrackIssue('DEMO-900','done');await flush();
 assert.equal(calls,1);assert.equal(file.content,'My notes');f.plugin.unload();
});
test('Every linked-card column transition controls the corresponding YouTrack state, including reopening Done',async()=>{
 const states={backlog:'To do','in-progress':'In Progress',done:'Done'};
 for(const before of Object.keys(states)) for(const after of Object.keys(states)){
  if(before===after)continue;
  const fm={youtrack_id:'DEMO-900',youtrack_import:'local-v1',tags:['kanban'],board_column:before};
  const f=fixture([['Hub/YouTrack/DEMO-900.md',fm]]);const calls=[];
  f.plugin.fetchYouTrackState=async(id,column='done')=>{calls.push(column);return {id,state:states[column]};};
  await f.start();assert.equal(calls.length,0);const file=f.files.get('Hub/YouTrack/DEMO-900.md');file.content='My writing';
  await f.plugin.setNoteProperty(file,'board_column',after);await flush();
  assert.deepEqual(calls,[after],`${before} → ${after}`);assert.equal(file.content,'My writing');
  await f.plugin.setNoteProperty(file,'priority','high');await flush();assert.equal(calls.length,1);f.plugin.unload();
 }
});
test('Rapid column moves serialize remote writes and apply the latest destination after the active request',async()=>{
 const fm={youtrack_id:'DEMO-900',youtrack_import:'local-v1',tags:['kanban'],board_column:'backlog'};
 const f=fixture([['Hub/YouTrack/DEMO-900.md',fm]]);await f.start();const file=f.files.get('Hub/YouTrack/DEMO-900.md');
 const states={backlog:'To do','in-progress':'In Progress',done:'Done'},calls=[];let finish,active=0,peak=0;
 f.plugin.fetchYouTrackState=async(id,column='done')=>{calls.push(column);peak=Math.max(peak,++active);
  if(calls.length===1)await new Promise(r=>finish=r);active--;return {id,state:states[column]};};
 await f.plugin.setNoteProperty(file,'board_column','done');await flush();
 await f.plugin.setNoteProperty(file,'board_column','in-progress');await f.plugin.setNoteProperty(file,'board_column','backlog');await flush();
 assert.deepEqual(calls,['done']);finish();await flush();
 assert.deepEqual(calls,['done','backlog']);assert.equal(peak,1);f.plugin.unload();
});
test('Uncertain earlier write stops queued changes and explicit retry uses the current column',async()=>{
 const fm={youtrack_id:'DEMO-900',youtrack_import:'local-v1',tags:['kanban'],board_column:'backlog'};
 const f=fixture([['Hub/YouTrack/DEMO-900.md',fm]]);await f.start();const file=f.files.get('Hub/YouTrack/DEMO-900.md');
 const calls=[];let fail;f.plugin.fetchYouTrackState=async(id,column='done')=>{calls.push(column);return new Promise((r,j)=>fail=()=>j(Object.assign(Error(),{youtrackCode:'uncertain'})));};
 await f.plugin.setNoteProperty(file,'board_column','done');await flush();
 await f.plugin.setNoteProperty(file,'board_column','backlog');await flush();fail();await flush();
 assert.deepEqual(calls,['done']);
 f.plugin.fetchYouTrackState=async(id,column='done')=>{calls.push(column);return {id,state:'To do'};};
 await f.plugin.syncYouTrackIssue(file);assert.deepEqual(calls,['done','backlog']);f.plugin.unload();
});
test('Reimport waits for the requested column in metadata instead of sending a stale cached state',async()=>{
 const fm={youtrack_id:'DEMO-900',youtrack_import:'local-v1',tags:['kanban'],board_column:'done'};
 const f=fixture([['Hub/YouTrack/DEMO-900.md',fm]]);await f.start();const file=f.files.get('Hub/YouTrack/DEMO-900.md');
 let written;f.app.fileManager.processFrontMatter=async(file,fn)=>{written={...fm};fn(written);};
 const calls=[];f.plugin.fetchYouTrackState=async(id,column)=>{calls.push(column);return {id,state:'In Progress'};};
 await f.plugin.importYouTrackIssue('DEMO-900','in-progress');await flush();assert.deepEqual(calls,[]);
 f.caches.get(file.path).frontmatter=written;f.app.metadataCache.emit('changed',file,'',f.caches.get(file.path));await flush();
 assert.deepEqual(calls,['in-progress']);f.plugin.unload();
});
test('A confirmed reopening restores the issue to an older open-items snapshot; a newer refresh wins',async()=>{
 const fm={youtrack_id:'DEMO-900',youtrack_import:'local-v1',tags:['kanban'],board_column:'done'};
 const f=fixture([['Hub/YouTrack/DEMO-900.md',fm]]);await f.start();const file=f.files.get('Hub/YouTrack/DEMO-900.md');
 f.plugin.youtrackSnapshot={schema:1,fetchedAt:'2026-01-01T00:00:00Z',issues:[]};
 const issue={id:'DEMO-900',state:'In Progress',assignee:'Alex',title:'Reopened task',url:'https://tracker.example.com/issue/DEMO-900'};
 f.plugin.fetchYouTrackState=async id=>({id,state:'In Progress',issue});
 await f.plugin.setNoteProperty(file,'board_column','in-progress');await flush();
 assert.deepEqual(Array.from(f.plugin.homeYouTrackIssues(),i=>[i.id,i.state]),[['DEMO-900','In Progress']]);
 f.plugin.youtrackSnapshot.fetchedAt=new Date(Date.now()+10000).toISOString();assert.equal(f.plugin.homeYouTrackIssues().length,0);f.plugin.unload();
});
test('Agenda renders keyboard-accessible meeting anchors and leaves unsafe or absent links as text',async()=>{
 const f=fixture();await f.start();
 f.doc.createElement=tag=>{const node=new Dom(tag);node.append=(...items)=>node.children.push(...items);node.replaceChildren=()=>{node.children=[];};return node;};
 const entry={scope:{ownerDocument:f.doc},calendarMode:'agenda',selectedDay:'2026-10-17'};
 for(const name of ['calendarDays','agenda','monthTab','agendaTab','calendarPrevious','calendarNext','calendarConnect','calendarStatus'])entry[name]=f.doc.createElement('div');
 f.plugin.calendarEnabled=true;
 const start=new Date('2026-10-17T09:00:00').toISOString(),end=new Date('2026-10-17T10:00:00').toISOString();
 f.plugin.calendarCache={kind:'google',fetchedAt:Date.now(),months:new Map([['2026-10',[
  {title:'Join call',start,end,joinUrl:'https://meet.google.com/aaa-bbbb-ccc'},
  {title:'Unsafe',start,end,joinUrl:'javascript:alert(1)'},{title:'Offline',start,end}
 ]]])};
 f.plugin.updateCalendarAgenda(entry);const rows=entry.agenda.children.filter(n=>n.className==='aim-home-meeting');
 assert.deepEqual(rows.map(n=>n.selector),['a','div','div']);assert.equal(rows[0].href,'https://meet.google.com/aaa-bbbb-ccc');
 assert.equal(rows[0].target,'_blank');assert.equal(rows[0].rel,'noopener noreferrer');assert.match(rows[0].getAttribute('aria-label'),/Join call.*Google Meet/);
 assert.equal(f.requests.length,0);f.plugin.unload();
});
test('Calendar markers count cached events on every occupied local day, with exclusive midnight ends',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.updateCalendarMarkers,'function');
 f.plugin.calendarEnabled=true;
 const time=s=>new Date(s).getTime();
 const event=(start,end)=>({start:time(start),end:time(end)});
 f.plugin.calendarCache={months:new Map([['2026-10',[
  event('2026-10-16T23:00:00','2026-10-17T01:00:00'),
  event('2026-10-17T00:00:00','2026-10-18T00:00:00'),
  event('2026-10-17T10:00:00','2026-10-17T10:00:00'),
  event('2026-10-17T12:00:00','2026-10-17T13:00:00'),
  event('2026-09-30T00:00:00','2026-10-01T00:00:00')
 ]]])};
 const entry=calendarMarkerEntry(f,['2026-10-01','2026-10-16','2026-10-17','2026-10-18']);
 f.plugin.updateCalendarMarkers(entry);
 assert.deepEqual(entry.buttons.map(b=>b.dataset.meetings),['0','1','3','0']);
 assert.match(entry.buttons[2].getAttribute('aria-label'),/4 meetings/);
 assert.match(entry.buttons[1].title,/1 meeting$/);
 assert.equal(f.requests.length,0);assert.equal(f.saves.length,0);f.plugin.unload();
});
test('Calendar markers distinguish an unloaded month from an empty month and clear after disconnect',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.updateCalendarMarkers,'function');
 f.plugin.calendarEnabled=true;f.plugin.calendarCache={months:new Map()};
 const entry=calendarMarkerEntry(f,['2026-10-17']);const button=entry.buttons[0];
 f.plugin.updateCalendarMarkers(entry);assert.equal(button.dataset.meetings,'0');assert.equal(button.title,'2026-10-17');
 f.plugin.calendarCache.months.set('2026-10',[]);f.plugin.updateCalendarMarkers(entry);assert.match(button.title,/No meetings/);
 f.plugin.calendarEnabled=false;f.plugin.updateCalendarMarkers(entry);assert.equal(button.title,'2026-10-17');
 assert.equal(f.requests.length,0);f.plugin.unload();
});
test('Calendar navigation animates once, interrupts cleanly, and respects reduced motion',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.animateHomeCalendar,'function');
 let reduced=false;f.doc.defaultView.matchMedia=()=>({matches:reduced});const animations=[];
 const entry={scope:{ownerDocument:f.doc},calendarMode:'month',calendarMonth:'2026-10',today:'2026-10-17',calendarDays:{animate:(frames,options)=>{
  const animation={frames,options,cancelled:false,cancel(){this.cancelled=true;}};animations.push(animation);return animation;
 }}};
 let renders=0;f.plugin.updateHome=()=>renders++;
 f.plugin.shiftHomeMonth(entry,1);assert.equal(entry.calendarMonth,'2026-11');assert.equal(animations.length,1);
 f.plugin.shiftHomeMonth(entry,-1);assert.equal(animations[0].cancelled,true);assert.equal(animations.length,2);
 assert.notEqual(animations[0].frames[0].transform,animations[1].frames[0].transform);
 reduced=true;f.plugin.shiftHomeMonth(entry,1);assert.equal(animations[1].cancelled,true);assert.equal(animations.length,2);
 assert.equal(renders,3);assert.equal(entry.calendarMonth,'2026-11');assert.equal(f.saves.length,0);f.plugin.unload();
});

// All Slack tokens and messages below are synthetic; these tests never use the network.
const slackToken = 'xoxp-fixture-only-not-a-real-token';
const slackKey = 'es-hub-slack-user';
function slackResponse(data, status=200, headers={}) { return {status,headers,text:JSON.stringify(data)}; }
function slackMatch(text='<@USELF> Please check this', ts=String(Math.floor(Date.now()/1000))+'.000001') {
 return {text,ts,user:'UAUTHOR',channel:{id:'CROOM',name:'research'},permalink:'https://fixture.slack.com/archives/CROOM/p'+ts.replace('.','')};
}
function mockSlack(f, options={}) {
 f.app.requestCalendar=async args=>{
  const url=new URL(args.url);const method=url.pathname.split('/').at(-1);
  assert.equal(url.origin,'https://slack.com');assert.equal(args.headers.Authorization,'Bearer '+slackToken);
  assert.ok(!args.url.includes(slackToken));assert.ok(['auth.test','users.info','search.messages','conversations.list','conversations.history','conversations.replies','usergroups.list'].includes(method));
  if(options.dispatch){const result=await options.dispatch(method,args);if(result)return result;}
  if(method==='auth.test')return slackResponse({ok:true,team_id:options.team||'TTEAM',user_id:'USELF',user:'alex',team:'Fixture workspace',url:'https://fixture.slack.com/'});
  if(method==='users.info')return slackResponse({ok:true,user:{id:url.searchParams.get('user'),profile:{display_name:url.searchParams.get('user')==='USELF'?'Alex':'Colleague'}}});
  if(method==='usergroups.list')return slackResponse({ok:true,usergroups:[{id:'SRESEARCH',handle:'builders',users:['USELF'],date_delete:0}]});
  if(method==='conversations.list')return slackResponse({ok:true,channels:url.searchParams.get('types')==='im'?[]:[{id:'CNOTES',name:'team-notes',is_channel:true,is_member:true}],response_metadata:{next_cursor:''}});
  if(method==='conversations.history'||method==='conversations.replies')return slackResponse({ok:true,messages:[],has_more:false,response_metadata:{next_cursor:''}});
  return slackResponse({ok:true,messages:{matches:url.searchParams.get('query').startsWith('<@USELF>')?(options.matches||[slackMatch()]):[],paging:{page:1,pages:1,total:1}}});
 };
}

test('Slack connects only after verified identity and search, storing the token only in Keychain',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.connectSlack,'function');mockSlack(f);
 const writes=f.files.size;await f.plugin.connectSlack(slackToken);
 assert.equal(f.plugin.slackConnected,true);assert.equal(f.plugin.slackSnapshot.rows.length,1);
 assert.equal(f.plugin.slackSnapshot.rows[0].author,'Colleague');assert.equal(f.plugin.slackAccount.userId,'USELF');
 assert.equal(JSON.parse(f.secrets.get(slackKey)).token,slackToken);assert.equal(f.saves.length,0);assert.equal(f.files.size,writes);
 assert.ok(!JSON.stringify(f.plugin.slackSnapshot).includes(slackToken));
 assert.match(new URL(f.requests.find(x=>x.url.includes('search.messages')).url).searchParams.get('query'),/<@USELF>.*after:/);
 f.plugin.unload();
});

test('Slack rejects bot tokens, missing Keychain and failed reads without storing credentials',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.connectSlack,'function');mockSlack(f);
 await assert.rejects(()=>f.plugin.connectSlack('xoxb-bot-token'),/User OAuth Token/);assert.equal(f.requests.length,0);
 f.app.secretStorage=null;await assert.rejects(()=>f.plugin.connectSlack(slackToken),/Keychain/);assert.equal(f.requests.length,0);
 f.app.secretStorage={getSecret:()=>null,setSecret:()=>assert.fail('failed connection must not save')};
 mockSlack(f,{dispatch:m=>m==='search.messages'?slackResponse({ok:false,error:'missing_scope'}):null});
 await assert.rejects(()=>f.plugin.connectSlack(slackToken),/search:read/);assert.equal(f.plugin.slackConnected,false);f.plugin.unload();
});

test('Slack keeps exact personal mentions, deduplicates and rejects unsafe links without interpreting HTML',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.connectSlack,'function');
 const mention=slackMatch('<@USELF> &lt;script&gt;alert(1)&lt;/script&gt;');
 const old=slackMatch('<@USELF> old',String(Math.floor(Date.now()/1000)-8*86400)+'.000001');
 mockSlack(f,{matches:[mention,mention,slackMatch('Hi Alex'),slackMatch('<@USELFOTHER> Hi'),old,{...mention,ts:mention.ts.replace('000001','000002'),permalink:'https://fixture.slack.com.evil.example/archives/CROOM/p123'}]});
 await f.plugin.connectSlack(slackToken);assert.equal(f.plugin.slackSnapshot.rows.length,1);
 assert.match(f.plugin.slackSnapshot.rows[0].text,/<script>alert/); // UI must use textContent, never HTML.
 f.plugin.unload();
});

test('Slack Refresh preserves last success on API failures and does not leak raw errors',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.connectSlack,'function');mockSlack(f);await f.plugin.connectSlack(slackToken);
 const old=f.plugin.slackSnapshot;
 f.app.requestCalendar=async()=>{throw Error('Authorization Bearer '+slackToken);};
 await f.plugin.refreshSlack();assert.equal(f.plugin.slackSnapshot,old);assert.match(f.plugin.slackError,/connection/i);
 assert.ok(!f.plugin.slackError.includes(slackToken));assert.equal(f.plugin.slackBusy,false);
 mockSlack(f,{team:'TOTHER'});await f.plugin.refreshSlack();assert.equal(f.plugin.slackSnapshot,old);assert.match(f.plugin.slackError,/account|workspace/i);f.plugin.unload();
});

test('Slack coalesces repeated Refresh and ignores responses after disconnect',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.connectSlack,'function');mockSlack(f);await f.plugin.connectSlack(slackToken);
 let release, authCalls=0;mockSlack(f,{dispatch:async method=>{if(method==='auth.test'){authCalls++;await new Promise(r=>release=r);}}});
 const pending=f.plugin.refreshSlack();await flush();await f.plugin.refreshSlack();assert.equal(authCalls,1);
 await f.plugin.disconnectSlack();release();await pending;
 assert.equal(f.secrets.get(slackKey),'');assert.equal(f.plugin.slackSnapshot,null);assert.equal(f.plugin.slackConnected,false);f.plugin.unload();
});

test('Slack closing setup or unloading cancels an in-flight connect before Keychain writes',async()=>{
 for(const cancel of ['close','unload']){
  const f=fixture();await f.start();assert.equal(typeof f.plugin.connectSlack,'function');let release;
  mockSlack(f,{dispatch:async (method,args)=>{if(method==='search.messages'&&new URL(args.url).searchParams.get('query').startsWith('<@USELF>'))await new Promise(r=>release=r);}});
  const pending=f.plugin.connectSlack(slackToken);await flush();
  if(cancel==='unload')f.plugin.unload();else f.plugin.cancelSlackConnect();
  release();await assert.rejects(()=>pending,/cancelled/i);assert.equal(f.secrets.has(slackKey),false);assert.equal(f.plugin.slackSnapshot,null);f.plugin.unload();
 }
});

test('Slack Keychain save failure preserves the previous connection and snapshot',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.connectSlack,'function');mockSlack(f);await f.plugin.connectSlack(slackToken);
 const old=f.plugin.slackSnapshot, secret=f.secrets.get(slackKey);
 f.app.secretStorage.setSecret=()=>{throw Error('sensitive '+slackToken);};
 await assert.rejects(()=>f.plugin.connectSlack(slackToken),/save.*Keychain/i);
 assert.equal(f.plugin.slackSnapshot,old);assert.equal(f.secrets.get(slackKey),secret);assert.equal(f.plugin.slackConnected,true);f.plugin.unload();
});

test('Slack reload restores identity before scheduled refresh without writing settings',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.connectSlack,'function');mockSlack(f);await f.plugin.connectSlack(slackToken);f.plugin.unload();
 const calls=f.requests.length;await f.start();assert.equal(f.requests.length,calls);assert.equal(f.plugin.slackConnected,true);
 assert.equal(f.plugin.slackSnapshot,null);assert.equal(f.saves.length,0);f.plugin.unload();
});

test('Slack rate limits retain the snapshot and enforce Retry-After across views',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.connectSlack,'function');mockSlack(f);await f.plugin.connectSlack(slackToken);const old=f.plugin.slackSnapshot;
 mockSlack(f,{dispatch:m=>m==='search.messages'?slackResponse({ok:false,error:'ratelimited'},429,{'retry-after':'30'}):null});
 await f.plugin.refreshSlack();assert.equal(f.plugin.slackSnapshot,old);assert.match(f.plugin.slackError,/30 seconds/);
 const calls=f.requests.length;await f.plugin.refreshSlack();assert.equal(f.requests.length,calls);f.plugin.unload();
});

test('Slack introduction preserves hidden modules and an explicit Slack hide survives reload',async()=>{
 const f=fixture([],{homeModules:['scratchpad','youtrack'],other:'keep'});await f.start();
 assert.deepEqual(Array.from(f.plugin.homeModules),['youtrack','slack']);assert.equal(f.saves.length,0);
 await f.plugin.setHomeModule('slack',false);f.plugin.unload();await f.start();
 assert.deepEqual(Array.from(f.plugin.homeModules),['youtrack']);assert.equal(f.saves.at(-1).other,'keep');f.plugin.unload();
});

test('Slack search pagination is bounded and a malformed later page cannot publish partial results',async()=>{
 const f=fixture();await f.start();mockSlack(f);await f.plugin.connectSlack(slackToken);const old=f.plugin.slackSnapshot;
 let pages=0;mockSlack(f,{dispatch:(method,args)=>{
  if(method!=='search.messages'||!new URL(args.url).searchParams.get('query').startsWith('<@USELF>'))return null;pages++;const page=Number(new URL(args.url).searchParams.get('page'));
  return slackResponse({ok:true,messages:page===1?{matches:[slackMatch()],paging:{pages:2,page}}:{matches:null,paging:{pages:2,page}}});
 }});
 await f.plugin.refreshSlack();assert.equal(pages,2);assert.equal(f.plugin.slackSnapshot,old);assert.match(f.plugin.slackError,/incomplete/);
 pages=0;mockSlack(f,{dispatch:(method,args)=>{
  if(method!=='search.messages'||!new URL(args.url).searchParams.get('query').startsWith('<@USELF>'))return null;pages++;const page=Number(new URL(args.url).searchParams.get('page'));
  return slackResponse({ok:true,messages:{matches:[slackMatch('<@USELF> page '+page,String(Math.floor(Date.now()/1000))+'.00000'+page)],paging:{pages:99,page}}});
 }});
 await f.plugin.refreshSlack();assert.equal(pages,3);assert.equal(f.plugin.slackSnapshot.rows.length,3);assert.equal(f.plugin.slackSnapshot.limited,true);f.plugin.unload();
});

test('Slack caps displayed mentions and resolves only a bounded number of author names',async()=>{
 const f=fixture();await f.start();
 const matches=Array.from({length:100},(_,i)=>({...slackMatch('<@USELF> result '+i,String(Math.floor(Date.now()/1000))+'.'+String(i).padStart(6,'0')),user:'UAUTHOR'+i}));
 mockSlack(f,{matches});await f.plugin.connectSlack(slackToken);
 assert.equal(f.plugin.slackSnapshot.rows.length,50);assert.equal(f.plugin.slackSnapshot.limited,true);
 assert.equal(f.requests.filter(x=>x.url.includes('users.info')).length,13);f.plugin.unload();
});

test('Slack rejects malformed or bot identity and unsupported search before saving',async()=>{
 for(const response of [slackResponse({ok:true,bot_id:'BBOT',team_id:'TTEAM',user_id:'USELF'}),slackResponse({ok:true,user_id:'USELF'})]){
  const f=fixture();await f.start();mockSlack(f,{dispatch:m=>m==='auth.test'?response:null});
  await assert.rejects(()=>f.plugin.connectSlack(slackToken),/account|workspace/);assert.equal(f.secrets.has(slackKey),false);f.plugin.unload();
 }
 const f=fixture();await f.start();mockSlack(f,{dispatch:m=>m==='search.messages'?slackResponse({ok:false,error:'method_deprecated'}):null});
 await assert.rejects(()=>f.plugin.connectSlack(slackToken),/legacy Slack search/);assert.equal(f.secrets.has(slackKey),false);f.plugin.unload();
});

test('Slack failed Disconnect preserves the connection and does not claim the secret was removed',async()=>{
 const f=fixture();await f.start();mockSlack(f);await f.plugin.connectSlack(slackToken);const old=f.plugin.slackSnapshot;
 f.app.secretStorage=null;await assert.rejects(()=>f.plugin.disconnectSlack(),/Keychain/);
 assert.equal(f.plugin.slackSnapshot,old);assert.equal(f.plugin.slackConnected,true);f.plugin.unload();
});

test('Slack verifies Keychain writes and restores a previous secret after a partially failed save',async()=>{
 const f=fixture();await f.start();mockSlack(f);await f.plugin.connectSlack(slackToken);const old=f.plugin.slackSnapshot, previous=f.secrets.get(slackKey);
 let first=true;const set=f.app.secretStorage.setSecret;
 f.app.secretStorage.setSecret=(key,value)=>{set(key,value);if(first){first=false;throw Error('private storage error');}};
 mockSlack(f,{team:'TNEW'});await assert.rejects(()=>f.plugin.connectSlack(slackToken),/save.*Keychain/);
 assert.equal(f.secrets.get(slackKey),previous);assert.equal(f.plugin.slackSnapshot,old);f.plugin.unload();
});

test('Slack inbox includes incoming untagged DMs, note-channel messages and exact builders mentions once',async()=>{
 const f=fixture();await f.start();const ts=String(Math.floor(Date.now()/1000))+'.000011';
 mockSlack(f,{matches:[{...slackMatch('<@USELF> <!subteam^SRESEARCH> review',ts),channel:{id:'CNOTES',name:'team-notes'},permalink:'https://fixture.slack.com/archives/CNOTES/p'+ts.replace('.','')}],dispatch:(method,args)=>{
  const u=new URL(args.url);
  if(method==='conversations.list'&&u.searchParams.get('types')==='im')return slackResponse({ok:true,channels:[{id:'DDIRECT',is_im:true,user:'UAUTHOR'}],response_metadata:{next_cursor:''}});
  if(method==='conversations.history')return slackResponse({ok:true,messages:u.searchParams.get('channel')==='DDIRECT'?[{type:'message',user:'UAUTHOR',text:'Private hello without a tag',ts:ts.replace('11','12')},{type:'message',user:'USELF',text:'My outgoing DM',ts:ts.replace('11','13')}]:[{type:'message',user:'UAUTHOR',text:'<@USELF> <!subteam^SRESEARCH> review',ts},{type:'message',user:'USELF',text:'My untagged channel note',ts:ts.replace('11','14')}],has_more:false,response_metadata:{next_cursor:''}});
  if(method==='search.messages'&&u.searchParams.get('query').startsWith('@builders '))return slackResponse({ok:true,messages:{matches:[slackMatch('<!subteam^SRESEARCH|@builders> Group mention',ts.replace('11','15')),slackMatch('<!subteam^SRESEARCHOTHER> Wrong group',ts.replace('11','16')),slackMatch('builders as plain text',ts.replace('11','17'))],paging:{page:1,pages:1}}});
 }});
 await f.plugin.connectSlack(slackToken);const rows=f.plugin.slackSnapshot.rows;
 assert.ok(rows.some(r=>r.text==='Private hello without a tag'&&r.sources.includes('dm')));
 assert.ok(rows.some(r=>r.text==='My untagged channel note'&&r.sources.includes('channel')));
 assert.ok(rows.some(r=>r.text.includes('Group mention')&&r.sources.includes('group')));
 assert.ok(!rows.some(r=>/outgoing DM|Wrong group|plain text/.test(r.text)));
 const duplicate=rows.filter(r=>r.id==='CNOTES:'+ts);assert.equal(duplicate.length,1);
 assert.deepEqual([...duplicate[0].sources].sort(),['channel','group','mention']);
 assert.ok(rows.every((r,i)=>i===0||rows[i-1].time>=r.time));f.plugin.unload();
});

test('Slack inbox fails visibly on missing extra scopes and preserves the previous successful list',async()=>{
 const f=fixture();await f.start();mockSlack(f);await f.plugin.connectSlack(slackToken);const old=f.plugin.slackSnapshot;
 mockSlack(f,{dispatch:m=>m==='usergroups.list'?slackResponse({ok:false,error:'missing_scope'}):null});
 await f.plugin.refreshSlack();assert.equal(f.plugin.slackSnapshot,old);assert.match(f.plugin.slackError,/usergroups:read/);f.plugin.unload();
});

test('Slack inbox reads only the named member channel and the builders group the user belongs to',async()=>{
 const f=fixture();await f.start();mockSlack(f,{dispatch:m=>m==='usergroups.list'?slackResponse({ok:true,usergroups:[{id:'SRESEARCH',handle:'builders',users:['USOMEONE'],date_delete:0}]}):null});
 await assert.rejects(()=>f.plugin.connectSlack(slackToken),/membership.*user group/);assert.equal(f.secrets.has(slackKey),false);f.plugin.unload();
 const g=fixture();await g.start();mockSlack(g,{dispatch:m=>m==='conversations.list'?slackResponse({ok:true,channels:[{id:'COTHER',name:'unrelated',is_channel:true,is_member:true}],response_metadata:{next_cursor:''}}):null});
 await assert.rejects(()=>g.plugin.connectSlack(slackToken),/notes channel/);
 assert.equal(g.requests.filter(x=>x.url.includes('conversations.history')).length,0);g.plugin.unload();
});

test('Slack inbox follows bounded history pages and retrieves recent thread replies without duplicating parents',async()=>{
 const f=fixture();await f.start();const ts=String(Math.floor(Date.now()/1000)-300)+'.000001',reply=String(Math.floor(Date.now()/1000)-10)+'.000002';
 const parent={type:'message',user:'UAUTHOR',text:'Parent',ts,reply_count:1,latest_reply:reply};
 mockSlack(f,{matches:[],dispatch:(method,args)=>{
  const u=new URL(args.url);
  if(method==='conversations.history')return slackResponse({ok:true,messages:[parent],has_more:!u.searchParams.get('cursor'),response_metadata:{next_cursor:u.searchParams.get('cursor')?'':'page2'}});
  if(method==='conversations.replies')return slackResponse({ok:true,messages:[parent,{type:'message',user:'UAUTHOR',text:'Thread reply',ts:reply,thread_ts:ts}],has_more:false,response_metadata:{next_cursor:''}});
 }});
 await f.plugin.connectSlack(slackToken);const rows=f.plugin.slackSnapshot.rows;
 assert.equal(rows.filter(r=>r.text==='Parent').length,1);assert.equal(rows.filter(r=>r.text==='Thread reply').length,1);
 assert.ok(rows.find(r=>r.text==='Thread reply').url.includes('thread_ts='));f.plugin.unload();
});

test('Slack inbox rejects malformed history pages atomically and exposes truncation instead of claiming completeness',async()=>{
 const f=fixture();await f.start();mockSlack(f);await f.plugin.connectSlack(slackToken);const old=f.plugin.slackSnapshot;
 mockSlack(f,{dispatch:m=>m==='conversations.history'?slackResponse({ok:true,messages:null,has_more:false}):null});
 await f.plugin.refreshSlack();assert.equal(f.plugin.slackSnapshot,old);assert.match(f.plugin.slackError,/incomplete/);
 mockSlack(f,{dispatch:(method,args)=>{
  if(method!=='conversations.history')return null;const cursor=new URL(args.url).searchParams.get('cursor')||'0';
  return slackResponse({ok:true,messages:[],has_more:true,response_metadata:{next_cursor:String(Number(cursor)+1)}});
 }});await f.plugin.refreshSlack();assert.equal(f.plugin.slackSnapshot.limited,true);
 assert.ok(f.plugin.slackSnapshot.limitNotes.some(x=>/channel|history/i.test(x)));f.plugin.unload();
});

test('Slack inbox detects looping conversation cursors before reading unrelated message histories',async()=>{
 const f=fixture();await f.start();mockSlack(f,{dispatch:m=>m==='conversations.list'?slackResponse({ok:true,channels:[],response_metadata:{next_cursor:'repeated'}}):null});
 await assert.rejects(()=>f.plugin.connectSlack(slackToken),/incomplete/);
 assert.equal(f.requests.filter(x=>x.url.includes('conversations.list')).length,2);
 assert.equal(f.requests.filter(x=>x.url.includes('conversations.history')).length,0);
 assert.equal(f.secrets.has(slackKey),false);f.plugin.unload();
});

test('Slack inbox bounds DM conversations and records the omitted coverage',async()=>{
 const f=fixture();await f.start();mockSlack(f,{dispatch:(method,args)=>{
  if(method==='conversations.list'&&new URL(args.url).searchParams.get('types')==='im')return slackResponse({ok:true,channels:Array.from({length:45},(_,i)=>({id:'DDIRECT'+i,is_im:true,user:'UAUTHOR'})),response_metadata:{next_cursor:''}});
 }});
 await f.plugin.connectSlack(slackToken);
 assert.equal(f.requests.filter(x=>x.url.includes('conversations.history')&&new URL(x.url).searchParams.get('channel').startsWith('D')).length,40);
 assert.ok(f.plugin.slackSnapshot.limited);assert.ok(f.plugin.slackSnapshot.limitNotes.some(x=>/DM conversations/.test(x)));f.plugin.unload();
});

test('Slack inbox private notes-channel fallback uses only the explicitly matched member channel',async()=>{
 const f=fixture();await f.start();mockSlack(f,{dispatch:(method,args)=>{
  const u=new URL(args.url);
  if(method==='conversations.list'&&u.searchParams.get('types')==='public_channel')return slackResponse({ok:true,channels:[],response_metadata:{next_cursor:''}});
  if(method==='conversations.list'&&u.searchParams.get('types')==='private_channel')return slackResponse({ok:true,channels:[{id:'GNOTES',name:'team-notes',is_private:true,is_member:true},{id:'GOTHER',name:'private-unrelated',is_private:true,is_member:true}],response_metadata:{next_cursor:''}});
 }});
 await f.plugin.connectSlack(slackToken);
 assert.deepEqual(f.requests.filter(x=>x.url.includes('conversations.history')).map(x=>new URL(x.url).searchParams.get('channel')),['GNOTES']);f.plugin.unload();
});

test('Slack reads independent DM histories concurrently with at most three requests in flight',async()=>{
 const f=fixture();await f.start();let active=0,max=0;const waiting=[];
 mockSlack(f,{dispatch:async(method,args)=>{
  const u=new URL(args.url);
  if(method==='conversations.list'&&u.searchParams.get('types')==='im')return slackResponse({ok:true,channels:Array.from({length:6},(_,i)=>({id:'DDIRECT'+i,is_im:true,user:'UAUTHOR'})),response_metadata:{next_cursor:''}});
  if(method==='conversations.history'&&u.searchParams.get('channel').startsWith('D')){
   active++;max=Math.max(max,active);await new Promise(resolve=>waiting.push(resolve));active--;
   return slackResponse({ok:true,messages:[],has_more:false,response_metadata:{next_cursor:''}});
  }
 }});
 const pending=f.plugin.connectSlack(slackToken);await flush();
 const firstBatch=active;
 for(let n=0;n<6;n++){waiting.splice(0).forEach(resolve=>resolve());await flush();}
 await pending;assert.equal(firstBatch,3);assert.equal(max,3);f.plugin.unload();
});

test('Slack keeps author names in memory to avoid fetching the same profiles on every Refresh',async()=>{
 const f=fixture();await f.start();mockSlack(f);await f.plugin.connectSlack(slackToken);
 const before=f.requests.filter(x=>x.url.includes('users.info')&&new URL(x.url).searchParams.get('user')==='UAUTHOR').length;
 await f.plugin.refreshSlack();
 assert.equal(f.requests.filter(x=>x.url.includes('users.info')&&new URL(x.url).searchParams.get('user')==='UAUTHOR').length,before);
 assert.equal(f.plugin.slackSnapshot.rows[0].author,'Colleague');assert.equal(f.saves.length,0);f.plugin.unload();
});

test('Slack automatic refresh runs when due and visible, without overlap or hidden-board requests',async()=>{
 const f=fixture();await f.start();mockSlack(f);await f.plugin.connectSlack(slackToken);
 assert.equal(typeof f.plugin.autoRefreshSlack,'function');
 const toolbar={home:{isConnected:true,getClientRects:()=>[{}],ownerDocument:f.doc},widgets:{slack:{isConnected:true}}};
 f.plugin.toolbars.set('automatic-fixture',toolbar);f.plugin.refreshHomes=()=>{};
 f.plugin.slackNextRefresh=Date.now()+300000;assert.equal(f.plugin.autoRefreshSlack(),false);
 f.plugin.slackNextRefresh=0;f.plugin.homeCollapsed=true;assert.equal(f.plugin.autoRefreshSlack(),false);f.plugin.homeCollapsed=false;
 toolbar.home.isConnected=false;assert.equal(f.plugin.autoRefreshSlack(),false);toolbar.home.isConnected=true;
 f.plugin.slackRetryAt=Date.now()+60000;assert.equal(f.plugin.autoRefreshSlack(),false);f.plugin.slackRetryAt=0;
 let release,calls=0;mockSlack(f,{dispatch:async m=>{if(m==='auth.test'){calls++;await new Promise(r=>release=r);}}});
 assert.equal(f.plugin.autoRefreshSlack(),true);await flush();assert.equal(f.plugin.autoRefreshSlack(),false);assert.equal(calls,1);
 release();await flush();assert.ok(f.plugin.slackNextRefresh>=Date.now()+299000);assert.ok(f.plugin.slackTimer);
 f.plugin.toolbars.delete('automatic-fixture');f.plugin.unload();assert.equal(f.plugin.slackTimer,null);
});


test('Slack searches builders by handle and verifies returned group IDs',async()=>{
 const f=fixture();await f.start();
 mockSlack(f,{matches:[],dispatch:(method,args)=>{
  const q=new URL(args.url).searchParams.get('query');
  if(method==='search.messages'&&q?.startsWith('@builders '))return slackResponse({ok:true,messages:{matches:[
   slackMatch('<!subteam^SRESEARCH|@builders> Exact group'),
   slackMatch('<!subteam^SOTHER> Wrong group'),slackMatch('builders plain text')
  ],paging:{page:1,pages:1}}});
 }});
 await f.plugin.connectSlack(slackToken);
 assert.equal(f.plugin.slackSnapshot.rows.length,1);
 assert.equal(f.plugin.slackSnapshot.rows[0].text,'@builders Exact group');
 assert.ok(f.plugin.slackSnapshot.rows[0].sources.includes('group'));f.plugin.unload();
});

test('Slack preserves older group mentions when newer channel traffic fills All',async()=>{
 const f=fixture();await f.start();const now=Math.floor(Date.now()/1000);
 mockSlack(f,{matches:[slackMatch('<@USELF> <!subteam^SRESEARCH> Older group',String(now-86400)+'.000001')],dispatch:(method,args)=>{
  if(method==='conversations.history')return slackResponse({ok:true,messages:Array.from({length:75},(_,i)=>({ts:String(now-i-1)+'.000001',user:'UAUTHOR',text:'Newer note '+i})),has_more:false,response_metadata:{next_cursor:''}});
 }});
 await f.plugin.connectSlack(slackToken);const rows=f.plugin.slackSnapshot.rows;
 assert.equal(rows.filter(r=>r.sources.includes('group')).length,1);
 assert.equal(rows.filter(r=>r.sources.includes('channel')).length,50);
 assert.equal(rows.length,51);assert.ok(rows.every((r,i)=>i===0||rows[i-1].time>=r.time));
 assert.equal(f.plugin.slackSnapshot.limited,true);f.plugin.unload();
});


test('Slack accepts search-normalized user-group mentions using only the verified group ID',async()=>{
 const f=fixture();await f.start();const now=Math.floor(Date.now()/1000);
 mockSlack(f,{matches:[],dispatch:(method,args)=>{
  if(method==='search.messages'&&new URL(args.url).searchParams.get('query')?.startsWith('@builders '))return slackResponse({ok:true,messages:{matches:[
   slackMatch('<@SRESEARCH> Normalized group',String(now)+'.000001'),
   slackMatch('<@SRESEARCH|builders> Named normalized group',String(now-1)+'.000001'),
   slackMatch('<@SRESEARCHOTHER> Wrong group',String(now-2)+'.000001'),
   slackMatch('<@UOTHER> builders plain text',String(now-3)+'.000001')
  ],paging:{page:1,pages:1}}});
 }});
 await f.plugin.connectSlack(slackToken);const rows=f.plugin.slackSnapshot.rows;
 assert.equal(rows.length,2);assert.ok(rows.every(r=>r.sources.includes('group')));
 assert.deepEqual(Array.from(rows,r=>r.text),['@builders Normalized group','@builders Named normalized group']);f.plugin.unload();
});


test('Home ignores the legacy Scratchpad tile without restoring other hidden modules or saving settings',async()=>{
 const f=fixture([],{homeModules:['scratchpad','slack'],slackModuleKnown:true,other:'keep'});await f.start();
 assert.deepEqual(Array.from(f.plugin.homeModules),['slack']);assert.equal(f.saves.length,0);
 await f.plugin.setHomeModule('calendar',true);
 assert.deepEqual(f.saves.at(-1).homeModules,['calendar','slack']);assert.equal(f.saves.at(-1).other,'keep');
 await assert.rejects(()=>f.plugin.setHomeModule('scratchpad',true),/module/i);f.plugin.unload();
});

test('Scratchpad bar grows to four lines, scrolls longer drafts and shrinks after clearing',async()=>{
 const f=fixture();await f.start();assert.equal(typeof f.plugin.resizeQuickDraft,'function');
 f.doc.defaultView.getComputedStyle=()=>({lineHeight:'22px',paddingTop:'8px',paddingBottom:'8px'});
 const input={value:'One line',clientWidth:500,scrollHeight:38,style:{}};
 const entry={scratchInput:input,scope:{ownerDocument:f.doc}};
 f.plugin.resizeQuickDraft(entry);assert.equal(input.style.height,'38px');
 input.value='Long pasted note';input.scrollHeight=900;f.plugin.resizeQuickDraft(entry);
 assert.equal(input.style.height,'104px');assert.equal(input.style.overflowY,'auto');
 input.value='';input.scrollHeight=38;f.plugin.resizeQuickDraft(entry);assert.equal(input.style.height,'38px');assert.equal(input.style.overflowY,'hidden');
 input.clientWidth=0;input.value='Hidden';input.scrollHeight=900;f.plugin.resizeQuickDraft(entry);assert.equal(input.style.height,'38px');f.plugin.unload();
});

test('portable: Slack can connect without a notes channel or user group',async()=>{
 const f=fixture(); await f.start(); f.plugin.slackSources={channel:'',group:''};
 const methods=[];
 mockSlack(f,{dispatch:(method,args)=>{
  methods.push([method,args.url]);
  if(method==='usergroups.list')throw Error('Group access must be optional');
 }});
 await f.plugin.connectSlack(slackToken,{channel:'',group:''});
 assert.equal(f.plugin.slackConnected,true);
 assert.ok(!methods.some(([method,url])=>method==='conversations.list'&&new URL(url).searchParams.get('types')!=='im'));
 const saved=JSON.parse(f.secrets.get('es-hub-slack-user'));
 assert.deepEqual(saved.sources,{channel:'',group:''}); f.plugin.unload();
});

test('portable: YouTrack setup validates a different account and stores credentials only in Keychain',async()=>{
 const f=fixture();await f.start();
 const profile={host:'friends.youtrack.cloud',login:'jane',project:'TEAM',states:{backlog:'Open','in-progress':'Doing',done:'Closed'},syncEnabled:false};
 f.plugin.runYouTrackReader=async(id,mode,column,connection)=>{
  assert.deepEqual(JSON.parse(JSON.stringify(connection.profile)),profile);
  return {schema:1,source:'YouTrack MCP',host:profile.host,project:profile.project,assignee:profile.login,fetchedAt:new Date().toISOString(),issues:[]};
 };
 await f.plugin.connectYouTrack(profile,'perm:synthetic-test-token');
 assert.equal(f.plugin.youtrackProfile.project,'TEAM');
 assert.equal(f.saves.length,0);
 assert.ok(f.secrets.get('es-hub-youtrack').includes('synthetic-test-token'));
 assert.equal(f.plugin.validYouTrackId('TEAM-12'),true);assert.equal(f.plugin.validYouTrackId('DEMO-12'),false);
 f.plugin.unload();
});

test('portable: default YouTrack mode never dispatches a remote state write',async()=>{
 const f=fixture([['Hub/YouTrack/DEMO-900.md',{tags:['kanban'],youtrack_import:'local-v1',youtrack_id:'DEMO-900',board_column:'backlog'}]]);await f.start();
 f.plugin.youtrackProfile.syncEnabled=false;
 let calls=0;f.plugin.fetchYouTrackState=async()=>{calls++;};
 await f.plugin.syncYouTrackIssue(f.files.get('Hub/YouTrack/DEMO-900.md'));
 assert.equal(calls,0);f.plugin.unload();
});

test('portable: disconnected YouTrack refuses a reader call before launching a process',async()=>{
 const f=fixture();await f.start();f.secrets.delete('es-hub-youtrack');f.plugin.youtrackProfile=null;
 await assert.rejects(()=>f.plugin.runYouTrackReader(),e=>e.youtrackCode==='connection');f.plugin.unload();
});

test('portable: first trust repairs only the dashboard stuck in an unknown kanban view',async()=>{
 const f=fixture();await f.start();
 const board=new f.TFile('Hub/Kanban Board.base'),other=new f.TFile('Hub/Personal/My base.base');
 const calls=[];
 const leaf={view:{file:board,containerEl:{textContent:'Unknown view type: kanban-view',querySelector:()=>null},getViewType:()=> 'bases'},
  async setViewState(state){calls.push(state.type);this.view={getViewType:()=>state.type};},async openFile(file){calls.push(file.path);}};
 const untouched={view:{file:other,containerEl:{textContent:'Unknown view type: kanban-view'}},setViewState(){throw Error('Other bases must not change');}};
 f.leaves.push(leaf,untouched);
 await f.plugin.repairInitialBoard();
 assert.deepEqual(calls,['empty','Hub/Kanban Board.base']);
 await f.plugin.repairInitialBoard();assert.equal(calls.length,2);f.plugin.unload();
});

test('portable: changing a YouTrack host cannot reuse the old server token',async()=>{
 const f=fixture();await f.start();
 f.secrets.set('es-hub-youtrack',JSON.stringify({version:1,profile:f.plugin.youtrackProfile,token:'perm:synthetic-token'}));
 let calls=0;f.plugin.runYouTrackReader=async()=>{calls++;};
 await assert.rejects(()=>f.plugin.connectYouTrack({...f.plugin.youtrackProfile,host:'different.youtrack.cloud'},''),/token/i);
 assert.equal(calls,0);assert.equal(f.plugin.youtrackProfile.host,'tracker.example.com');f.plugin.unload();
});

test('portable: a note from another account or host never dispatches a state change',async()=>{
 for(const extra of [{youtrack_url:'https://another.youtrack.cloud/issue/DEMO-900'},{youtrack_assignee:'someone-else'}]){
  const f=fixture([['Hub/YouTrack/DEMO-900.md',{youtrack_id:'DEMO-900',youtrack_import:'local-v1',tags:['kanban'],board_column:'done',...extra}]]);await f.start();
  let calls=0;f.plugin.fetchYouTrackState=async()=>{calls++;};
  await f.plugin.syncYouTrackIssue(f.files.get('Hub/YouTrack/DEMO-900.md'));assert.equal(calls,0);f.plugin.unload();
 }
});

test('portable: an actual saved profile restores without credential values in settings',async()=>{
 const f=fixture();await f.start();
 const profile={host:'personal.youtrack.cloud',login:'jane',project:'TASK',states:{backlog:'Open','in-progress':'Doing',done:'Closed'},syncEnabled:false};
 f.secrets.set('es-hub-youtrack',JSON.stringify({version:1,profile,token:'perm:synthetic-token'}));
 Object.getPrototypeOf(f.plugin).restoreYouTrack.call(f.plugin);
 assert.deepEqual(JSON.parse(JSON.stringify(f.plugin.youtrackProfile)),profile);assert.equal(f.saves.length,0);
 f.secrets.set('es-hub-youtrack','malformed');Object.getPrototypeOf(f.plugin).restoreYouTrack.call(f.plugin);assert.equal(f.plugin.youtrackProfile,null);f.plugin.unload();
});

test('portable: connection changes block new imports and state writes while validation is pending',async()=>{
 const f=fixture([['Hub/YouTrack/DEMO-900.md',{youtrack_id:'DEMO-900',youtrack_import:'local-v1',tags:['kanban'],board_column:'done'}]]);await f.start();
 f.plugin.youtrackSetupBusy=true;
 let calls=0;f.plugin.fetchYouTrackState=async()=>{calls++;};
 await f.plugin.syncYouTrackIssue(f.files.get('Hub/YouTrack/DEMO-900.md'));
 assert.equal(calls,0);
 await assert.rejects(()=>f.plugin.importYouTrackIssue('DEMO-900','backlog'),/connection/i);
 assert.equal(f.caches.get('Hub/YouTrack/DEMO-900.md').frontmatter.board_column,'done');f.plugin.unload();
});

test('portable: changed Keychain profile cannot dispatch under the previous account context',async()=>{
 const f=fixture();await f.start();
 f.secrets.set('es-hub-youtrack',JSON.stringify({version:1,profile:{...f.plugin.youtrackProfile,host:'different.youtrack.cloud'},token:'perm:synthetic-token'}));
 await assert.rejects(()=>f.plugin.runYouTrackReader(),e=>e.youtrackCode==='connection');f.plugin.unload();
});
