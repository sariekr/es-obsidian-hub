"""Generate a self-contained, synthetic Slack/Home browser test; no external requests.
Open the printed file URL. ?narrow=1 and ?light=1 exercise panel/theme variants.
The page runs bounded DOM checks and displays PASS/FAIL before its fixture.
"""
from pathlib import Path
import json
import tempfile
import os

ROOT = Path(__file__).resolve().parent.parent
VAULT = ROOT.parents[2]
OUT = Path(os.environ.get('ES_HUB_PREVIEW_DIR') or tempfile.mkdtemp(prefix='kanban-slack-preview-'))
OUT.mkdir(parents=True, exist_ok=True)
base_css = '''
:root {--background-primary:#eff1f6;--background-primary-alt:#e8ebf1;--background-secondary:#e6e9f0;
--background-modifier-border:#bdc3cf;--text-normal:#4c526b;--text-muted:#747b8e;
--text-on-accent:#fff;--interactive-accent:#287e9c;--interactive-accent-hover:#236d87;
--font-interface:system-ui;--font-ui-small:13px;--radius-m:8px;--radius-l:12px;--font-semibold:600}
* {box-sizing:border-box} body {margin:0;background:var(--background-primary);color:var(--text-normal);font:13px system-ui}
.fixture-leaf {height:calc(100vh - 44px);width:100%;margin:auto} body.narrow .fixture-leaf {width:min(800px,100%)} body.compact .fixture-leaf {width:min(480px,100%)}
.fixture-bar {height:44px;padding:10px 16px;display:flex;align-items:center;gap:20px;border-bottom:1px solid var(--background-modifier-border)}
.fixture-bar a {color:var(--text-accent)} .fixture-modal {position:fixed;z-index:10000;inset:14% auto auto 50%;transform:translateX(-50%);width:min(540px,94vw);padding:24px;background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:12px;box-shadow:0 8px 30px #0005}
button,select,input {font:inherit;border:1px solid var(--background-modifier-border);border-radius:5px;color:inherit;background:var(--background-primary)}
button {height:30px;padding:3px 10px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap}
input {height:36px;padding:6px 10px} .obk-card {margin:10px;padding:12px} .obk-card-title {margin-bottom:6px;font-weight:600}
'''
styles=[base_css]
for p in [VAULT/'.obsidian/themes/AnuPpuccin/theme.css',ROOT.parent/'kanban-bases-view/styles.css',VAULT/'.obsidian/snippets/kanban-column-fill-width.css',ROOT/'styles.css']:
    styles.append(p.read_text())
args={'source':(ROOT/'main.js').read_text(),'schema':(VAULT/'Hub/_kanban/taxonomy.md').read_text()}
checks=r'''
(async()=>{
 const status=document.getElementById('qa-status');
 const query=new URLSearchParams(location.search);
 document.body.className=(query.has('light')?'theme-light ctp-latte':'theme-dark ctp-mocha')+' ctp-accent-teal anuppuccin-accent-toggle'+(query.has('narrow')?' narrow':'')+(query.has('compact')?' compact':'');
 const verify=(test,label)=>{if(!test)throw Error(label);};
 const settle=async()=>{for(let n=0;n<8;n++)await new Promise(r=>setTimeout(r,0));};
 try {
  // Reset only this synthetic page's Mail preference between theme variants.
  localStorage.removeItem('es-hub:mail-enabled:vault');
  await bootFixture(ARGS);const f=window.fixture,p=f.plugin;
  const token='xoxp-fixture-only-not-a-real-token';
  const response=data=>({status:200,headers:{},text:JSON.stringify(data)});
  f.requestSlack=async args=>{
   if(f.pauseSlack)await new Promise(r=>f.finishSlack=r);
   if(f.failSlack)throw Error('synthetic network failure');
   const url=new URL(args.url),method=url.pathname.split('/').at(-1);
   if(method==='auth.test')return response({ok:true,team_id:'TDEMO',user_id:'UME',team:'Demo workspace',user:'demo',url:'https://demo.slack.com/'});
   if(method==='users.info')return response({ok:true,user:{id:url.searchParams.get('user'),profile:{display_name:url.searchParams.get('user')==='UME'?'Demo user':'Demo colleague'}}});
   const fresh=String(Math.floor(Date.now()/1000))+'.000099';
   if(method==='usergroups.list')return response({ok:true,usergroups:[{id:'SRESEARCH',handle:'builders',users:['UME'],date_delete:0}]});
   if(method==='conversations.list')return response({ok:true,channels:url.searchParams.get('types')==='im'?[{id:'DDM',is_im:true,user:'UCOLLEAGUE'}]:[{id:'CNOTES',name:'team-notes',is_channel:true,is_member:true}],response_metadata:{next_cursor:''}});
   if(method==='conversations.history'&&f.crowdedSlack&&url.searchParams.get('channel')==='CNOTES')return response({ok:true,messages:Array.from({length:75},(_,i)=>({ts:String(Math.floor(Date.now()/1000)-i-1)+'.000001',user:'UCOLLEAGUE',text:'Recent channel note '+i})),has_more:false,response_metadata:{next_cursor:''}});
   if(method==='conversations.history')return response({ok:true,messages:[{type:'message',ts:fresh,user:'UCOLLEAGUE',text:url.searchParams.get('channel')==='DDM'?'Could you send me the final report when it is ready?':'Notes for tomorrow: review the benchmark and update the task list.'}],has_more:false,response_metadata:{next_cursor:''}});
   if(method==='search.messages'&&url.searchParams.get('query').startsWith('@builders '))return response({ok:true,messages:{paging:{page:1,pages:1},matches:[{ts:f.crowdedSlack?String(Math.floor(Date.now()/1000)-86400)+'.000001':fresh,user:'UCOLLEAGUE',channel:{id:'CTEAM',name:'research'},permalink:'https://demo.slack.com/archives/CTEAM/p'+fresh.replace('.',''),text:'<@SRESEARCH> Please add your weekly findings before Friday.'}]}});
   verify(method==='search.messages','Read-only method allowlist');
   return response({ok:true,messages:{paging:{page:1,pages:1,total:6},matches:Array.from({length:6},(_,i)=>{
    const ts=String(Math.floor(Date.now()/1000)-i*3900)+'.000001';
    return {ts,user:'UCOLLEAGUE',channel:{id:'CDEMO',name:i%2?'research':'team-updates'},permalink:'https://demo.slack.com/archives/CDEMO/p'+ts.replace('.',''),
     text:['<@UME> Could you review the comparison table before tomorrow’s meeting?','New benchmark results are ready. <@UME> The notes include the updated methodology and all the source links.','<@UME> &lt;script&gt;This is escaped test text, not executable markup.&lt;/script&gt;'][i%3]};})}});
  };
  const notes=f.files.size;
  verify(document.querySelectorAll('.aim-home-tile').length===3,'three widget modules');
  const initial=[...p.toolbars.values()].find(e=>e.home?.isConnected);
  verify(initial.widgetsRefresh.closest('.aim-home-heading-actions'),'one refresh in header');
  verify(initial.homeToggle.closest('.aim-home-config'),'Hide widgets moved into Customize');
  verify(!document.querySelector('.aim-home-grid button[aria-label^="Refresh"]'),'no per-widget refresh buttons');
  verify(![...document.querySelectorAll('.aim-home-grid button')].some(x=>x.textContent==='Refresh'),'no unlabeled per-widget refresh');
  verify(!document.querySelector('.aim-home-recent-strip')&&!document.querySelector('.aim-home-scratchpad-tile'),'Recent and Scratchpad tile removed');
  verify(document.querySelector('.aim-home-heading .aim-home-scratch-bar textarea'),'Scratchpad in header');
  verify(document.querySelectorAll('.obk-column').length===3,'three kanban columns');
  p.slackSources={channel:'team-notes',group:'builders'};p.openSlackSetup();verify(f.modal.input.type==='password','masked token input');
  f.modal.input.value=token;
  [...f.modal.contentEl.querySelectorAll('button')].find(x=>x.textContent==='Connect Slack').click();await settle();
  verify(p.slackConnected && p.slackSnapshot.rows.length===9,'connect through actual form');
  verify(!document.querySelector('[role=dialog]'),'close verified setup');
  verify(document.querySelectorAll('.aim-home-slack-mention').length===9,'render real adapter results');
  const filter=label=>[...document.querySelectorAll('.aim-home-slack-filters button')].find(x=>x.textContent===label);
  for(const [label,count] of [['DMs',1],['@Me',6],['#Notes',1],['@Group',1],['All',9]]){
   filter(label).click();verify(document.querySelectorAll('.aim-home-slack-mention').length===count,'source filter '+label);
   verify(filter(label).getAttribute('aria-pressed')==='true','pressed source filter');
  }
  f.crowdedSlack=true;await p.refreshSlack();await settle();
  verify(document.querySelectorAll('.aim-home-slack-mention').length===50,'All display is capped at 50');
  verify(!document.querySelector('.aim-home-slack-summary'),'no coverage caption in inbox');
  p.openSlackSetup();
  const inboxDetails=f.modal.contentEl.querySelector('.aim-home-slack-details');
  verify(inboxDetails?.textContent.includes('Last 7 days')&&inboxDetails.textContent.includes('50 messages per view'),'coverage in Slack settings');
  verify(inboxDetails.textContent.includes('Some results were limited')&&inboxDetails.textContent.includes('Each view shows'),'actual limits in Slack settings');
  f.modal.close();
  const callsBeforeFilter=f.requests.length;
  filter('@Group').click();verify(document.querySelectorAll('.aim-home-slack-mention').length===1,'older group survives busy notes channel');
  verify(f.requests.length===callsBeforeFilter,'source filters use retained results without requests');
  filter('All').click();f.crowdedSlack=false;await p.refreshSlack();await settle();
  verify(!document.querySelector('.aim-home-slack-list script'),'render escaped text safely');
  const slackEntry=[...p.toolbars.values()].find(e=>e.home?.isConnected);
  verify(slackEntry.slackList.querySelector('.aim-widget-group')?.textContent==='Today','Slack date group');
  const slackRow=slackEntry.slackList.querySelector('.aim-home-slack-mention');
  verify(slackRow.children[1].classList.contains('aim-home-slack-text')&&slackRow.lastElementChild.classList.contains('aim-home-slack-channel'),'Slack sender/message/context order');
  slackEntry.slackList.scrollTop=50;const slackScroll=slackEntry.slackList.scrollTop;
  await p.refreshSlack();verify(slackEntry.slackList.scrollTop===slackScroll,'Slack refresh preserves scroll');
  filter('DMs').click();verify(slackEntry.slackList.scrollTop===0,'Slack changed filter starts at top');filter('All').click();
  verify(f.files.size===notes && Object.keys(f.saved).length===0,'no note or settings writes');
  const snapshot=p.slackSnapshot;f.failSlack=true;
  [...p.toolbars.values()].find(e=>e.home?.isConnected).widgetsRefresh.click();await settle();
  verify(p.slackSnapshot===snapshot && !document.querySelector('.aim-home-slack-message').hidden,'retain data and show error');f.failSlack=false;
  p.openSlackSetup();f.pauseSlack=true;f.modal.input.value=token;
  [...f.modal.contentEl.querySelectorAll('button')].find(x=>x.textContent==='Replace connection').click();await settle();
  f.modal.close();f.pauseSlack=false;f.finishSlack();await settle();
  verify(!p.slackBusy && p.slackSnapshot===snapshot,'cancel pending replacement');
  await p.disconnectSlack();verify(!p.slackConnected && !f.secrets.get('es-hub-slack-user'),'disconnect clears mock secret');
  await p.connectSlack(token);
  const calls=f.requests.length;await f.reload();await settle();
  verify(f.requests.length===calls && f.plugin.slackConnected && !f.plugin.slackSnapshot,'reload restores only identity');
  await f.plugin.refreshSlack();await settle();
  const previousAutoSnapshot=f.plugin.slackSnapshot;
  f.plugin.slackNextRefresh=0;
  verify(f.plugin.autoRefreshSlack(),'due visible inbox auto refresh starts');
  verify(!f.plugin.autoRefreshSlack(),'automatic refresh does not overlap');await settle();
  verify(f.plugin.slackSnapshot!==previousAutoSnapshot,'automatic refresh publishes a new snapshot');
  verify(document.querySelector('.aim-home-slack-tile .aim-widget-footer').textContent.includes('Auto 5m'),'automatic refresh status');
  // Exercise the moved controls through their DOM listeners with synthetic notes only.
  const q=f.plugin, input=document.querySelector('.aim-home-scratch-input'),save=document.querySelector('[aria-label="Save to Quick Notes"]');
  const latest=[...document.querySelectorAll('.aim-home-scratch-actions button')].find(x=>x.textContent==='Open latest note');
  const beforeFiles=f.files.size,beforeOpened=f.opened.length;
  const draft='Scratchpad fixture note\n\n'+Array.from({length:12},(_,i)=>'Line '+i+' — exact content').join('\n');
  input.value=draft;input.dispatchEvent(new Event('input',{bubbles:true}));await settle();
  verify(f.files.size===beforeFiles,'typing creates no notes');
  verify(input.getBoundingClientRect().height<=105&&input.scrollHeight>input.clientHeight,'four-line maximum and internal scrolling');
  f.failCreate=true;save.click();await settle();
  verify(input.value===draft&&f.files.size===beforeFiles,'failed Save retains draft');
  verify(document.querySelector('.aim-home-scratch-status.is-error.is-visible'),'visible Save error');
  f.failCreate=false;save.click();save.click();await settle();
  verify(f.files.size===beforeFiles+1&&f.opened.length===beforeOpened,'Save creates exactly one note without navigation');
  verify(f.files.get(q.quickDraft.lastSaved)?.content===draft,'Save preserves exact body');
  verify(input.value===''&&input.getBoundingClientRect().height<=40,'cleared input shrinks');
  verify(!latest.disabled,'latest note enabled');latest.click();await settle();
  verify(f.opened.length===beforeOpened+1&&f.opened.at(-1).path===q.quickDraft.lastSaved,'Open latest note opens saved file');
  await q.setHomeCollapsed(true);await settle();
  verify(document.querySelector('.aim-home-grid').hidden&&input.getClientRects().length>0,'Scratchpad remains while widgets hidden');
  input.value='Recovered draft';input.dispatchEvent(new Event('input',{bubbles:true}));
  const savedPath=q.quickDraft.lastSaved;await f.reload();await settle();
  verify(document.querySelector('.aim-home-scratch-input').value==='Recovered draft','draft recovery after reload');
  verify(f.plugin.quickDraft.lastSaved===savedPath,'latest saved note survives reload');
  f.plugin.editQuickDraft('');await f.plugin.setHomeCollapsed(false);await f.plugin.refreshSlack();await settle();
  // Actual Calendar/Mail tabs, using only synthetic message metadata.
  const w=f.plugin;w.mailSupported=()=>true;w.refreshHomes();
  const mailData={schema:1,accounts:Array.from({length:7},(_,i)=>({id:'account-'+i,name:['Work','Personal','University','Research','Projects','Alumni','Family'][i],limited:true})),
    rows:Array.from({length:84},(_,i)=>({id:i+1,accountId:'account-'+(i%7),mailbox:'INBOX',messageId:'demo-'+i+'@example.test',
      subject:i===0?'<script>Literal subject</script>':['Review notes for tomorrow’s meeting','Your weekly reading list is ready','Updated schedule for the autumn semester'][i%3],
      sender:['Demo colleague','Reading list','University office'][i%3],receivedAt:Date.now()-i*1800000,read:i%3!==0}))};
  let mailReads=0,mailOpens=0;w.fetchMailSnapshot=async()=>{mailReads++;return structuredClone(mailData);};
  w.runMailBridge=async args=>{verify(args[0]==='open','only explicit opens');mailOpens++;return {ok:true};};
  w.refreshHomes();
  const home=[...w.toolbars.values()].find(e=>e.home?.isConnected);
  verify(!document.querySelector('.aim-home-module-shelf,.aim-home-module-handle'),'shelf and swap handles removed');
  home.calendarMainTab.click();
  const selectedDay=home.selectedDay,month=home.calendarMonth,mode=home.calendarMode;
  const originalHeight=home.widgets.calendar.getBoundingClientRect().height;
  home.mailMainTab.click();await settle();
  verify(home.calendarPanel.hidden&&!home.mailPanel.hidden,'Mail replaces Calendar content in the shared tile');
  verify(home.mailMainTab.getAttribute('aria-selected')==='true'&&home.calendarMainTab.tabIndex===-1,'tab selection and keyboard stop');
  verify(document.querySelectorAll('.aim-home-grid > .aim-home-tile').length===3,'tabs keep three tiles');
  verify(mailReads===0,'no reads before Connect');
  home.mailConnect.click();await settle();
  verify(w.mailEnabled&&mailReads===1&&home.mailList.querySelectorAll('button').length===50,'connect reads and renders bounded list');
  verify(home.mailList.querySelectorAll('.aim-widget-group').length>=2&&home.mailList.querySelector('.aim-widget-group').textContent==='Today','Mail groups across midnight');
  verify(!home.mailList.querySelector('script')&&home.mailList.textContent.includes('<script>Literal subject</script>'),'Mail subjects rendered as text');
  home.mailFilters.get('unread').click();verify(home.mailList.querySelectorAll('button').length===28,'Unread filters loaded rows');
  home.mailAccountSelect.value='account-2';home.mailAccountSelect.dispatchEvent(new Event('change'));
  verify(home.mailList.querySelectorAll('button').length===4,'account and unread filters combine');
  home.mailList.querySelector('button').click();await settle();verify(mailOpens===1,'explicit row opens exact message');
  home.mailFilters.get('all').click();home.mailAccountSelect.value='';home.mailAccountSelect.dispatchEvent(new Event('change'));
  const good=w.mailSnapshot;w.fetchMailSnapshot=async()=>{throw Error('private raw failure');};
  home.widgetsRefresh.click();await settle();verify(w.mailSnapshot===good&&!home.mailMessage.hidden&&!home.mailMessage.textContent.includes('private raw'),'failed refresh keeps list and safe error');
  w.fetchMailSnapshot=async()=>structuredClone(mailData);await w.refreshMail();await settle();
  home.mailList.scrollTop=80;const savedScroll=home.mailList.scrollTop;
  home.mailFilters.get('unread').click();const selectedFilter=home.mailFilter;
  home.calendarMainTab.click();await settle();
  verify(!home.calendarPanel.hidden&&home.mailPanel.hidden,'Calendar restores its own content and controls');
  verify(home.selectedDay===selectedDay&&home.calendarMonth===month&&home.calendarMode===mode,'Calendar view survives Mail');
  home.calendarMainTab.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));
  verify(home.homePanel==='mail'&&document.activeElement===home.mailMainTab,'arrow key switches and focuses Mail');
  verify(home.mailFilter===selectedFilter,'Mail filter survives Calendar');
  home.mailFilters.get('all').click();home.mailList.scrollTop=savedScroll;
  home.calendarMainTab.click();home.mailMainTab.click();await settle();
  verify(home.mailList.scrollTop===savedScroll,'Mail scroll survives tab switch');
  verify(home.widgets.calendar.getBoundingClientRect().height===originalHeight,'shared tile height stays fixed');
  home.mailMainTab.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));
  verify(home.homePanel==='calendar'&&document.activeElement===home.calendarMainTab,'Home selects Calendar');
  const unchanged=[...w.homeModules];f.failSettings=true;
  await w.setHomeModule('calendar',false).catch(()=>{});await settle();
  verify(w.homeModules.join(',')===unchanged.join(','),'failed visibility save preserves layout');f.failSettings=false;
  verify(!JSON.stringify(f.saved).includes('example.test')&&!JSON.stringify(f.saved).includes('Literal subject'),'Mail data is never persisted in plugin settings');
  const savedLayout=w.homeModules.join(',');await f.reload();await settle();
  verify(f.plugin.homeModules.join(',')===savedLayout,'layout survives reload');
  const r=f.plugin;r.mailSupported=()=>true;r.fetchMailSnapshot=async()=>structuredClone(mailData);
  await r.refreshMail();await settle();
  await r.setHomeCollapsed(true);await settle();verify(document.querySelector('.aim-home-grid').hidden,'Hide widgets hides grouped tile');
  await r.setHomeCollapsed(false);await settle();
  const finalHome=[...r.toolbars.values()].find(e=>e.home?.isConnected);
  const methods=['refreshCalendar','refreshMail','refreshYouTrack','refreshSlack'],originalMethods=methods.map(name=>r[name]);
  const previousCalendar=r.calendarEnabled,previousSlack=r.slackConnected,previousYouTrack=r.youtrackProfile;
  r.calendarEnabled=true;r.slackConnected=true;r.youtrackProfile={host:'tracker.example.com',project:'DEMO',login:'Alex'};finalHome.youtrackKey=null;const completed={},refreshCalls=[];
  for(const method of methods)r[method]=()=>{refreshCalls.push(method);return new Promise(resolve=>completed[method]=resolve);};
  const fileCount=f.files.size,settingsBefore=JSON.stringify(f.saved);
  finalHome.widgetsRefresh.click();await settle();
  verify(finalHome.widgetsRefresh.disabled&&finalHome.widgetsRefresh.textContent.includes('Refreshing'),'busy label and disabled state');
  finalHome.widgetsRefresh.click();await settle();verify(refreshCalls.length===4,'one read per connected widget, including hidden Mail');
  for(const method of methods.slice(0,3))completed[method]();await settle();verify(finalHome.widgetsRefresh.disabled,'wait for last widget');
  completed.refreshSlack();await settle();verify(!finalHome.widgetsRefresh.disabled,'refresh re-enabled');
  verify(f.files.size===fileCount&&JSON.stringify(f.saved)===settingsBefore,'Refresh all never writes notes or settings');
  methods.forEach((name,i)=>r[name]=originalMethods[i]);r.calendarEnabled=previousCalendar;r.slackConnected=previousSlack;r.refreshHomes();
  finalHome.customize.click();await settle();verify(!finalHome.config.hidden,'Customize opens');
  finalHome.homeToggle.click();await settle();verify(finalHome.homeGrid.hidden,'Hide widgets remains available');
  finalHome.homeToggle.click();await settle();verify(!finalHome.homeGrid.hidden,'Show widgets restores row');finalHome.customize.click();await settle();
  verify(finalHome.mailStatus.textContent.includes('Auto 10m')&&finalHome.youtrackStatus.textContent.includes('Auto 6h'),'new interval labels');
  r.youtrackProfile=previousYouTrack;finalHome.youtrackKey=null;r.refreshHomes();
  verify(finalHome.youtrackStatus.textContent==='Not connected','disconnected YouTrack has no automatic-read claim');
  r.slackConnected=true;r.slackAccount={teamName:'Demo workspace',userName:'demo'};
  r.slackSnapshot={fetchedAt:Date.now(),rows:Array.from({length:12},(_,i)=>({author:'Demo colleague',time:Date.now()-i*10800000,text:['Could you review the launch checklist before our meeting?','The updated project notes are ready.'][i%2],channel:'#team-notes',sources:['mention'],url:'https://demo.slack.com/archives/CDEMO/p'+i}))};
  r.youtrackProfile={host:'tracker.example.com',project:'DEMO',login:'Alex'};
  const ytRow=([id,title,state,priority='Normal'])=>({id,title,state,priority,assignee:'Alex',url:'https://tracker.example.com/issue/'+id});
  r.youtrackSnapshot={schema:1,source:'YouTrack MCP',assignee:'Alex',fetchedAt:new Date().toISOString(),issues:[
   ['DEMO-42','Prepare the launch checklist','In Progress','High'],
   ['DEMO-38','Review the onboarding copy','To do'],
   ['DEMO-36','Document the export flow','In Progress'],
   ['DEMO-46','Check the draft','Review']
  ].map(ytRow),completed:{hasMore:false,issues:[
   ['DEMO-44','Publish the quick start','Done'],['DEMO-45','Consolidate the old checklist','Duplicate']
  ].map(ytRow)}};
  r.refreshHomes();
  const shownIds=()=>[...finalHome.youtrackList.querySelectorAll('.aim-home-issue')].map(x=>x.dataset.youtrackId).join('|');
  const ytReads=[];const oldRefresh=r.refreshYouTrack;r.refreshYouTrack=()=>ytReads.push('read');
  verify(shownIds()==='DEMO-38','YouTrack starts on To do');
  verify(finalHome.youtrackFilters.get('backlog').getAttribute('aria-pressed')==='true','selected filter is accessible');
  finalHome.youtrackFilters.get('in-progress').click();
  verify(shownIds()==='DEMO-42|DEMO-36','In progress preserves source order and identities');
  finalHome.youtrackFilters.get('done').click();
  verify(shownIds()==='DEMO-44|DEMO-45','Done includes resolved states');
  verify([...finalHome.youtrackList.querySelectorAll('.aim-widget-group')].map(x=>x.textContent).join('|')==='Done|Duplicate','Done keeps actual State labels');
  finalHome.youtrackFilters.get('other').click();verify(shownIds()==='DEMO-46','Other keeps unmatched State accessible');
  const completedRows=r.youtrackSnapshot.completed;delete r.youtrackSnapshot.completed;
  finalHome.youtrackFilters.get('done').click();
  verify(finalHome.youtrackList.textContent.includes('not loaded yet'),'legacy snapshots explain missing completed results');
  r.youtrackSnapshot.completed=completedRows;finalHome.youtrackFilters.get('backlog').click();
  verify(ytReads.length===0&&f.files.size===fileCount&&JSON.stringify(f.saved)===settingsBefore,'filters do not refresh, write settings or mutate notes');r.refreshYouTrack=oldRefresh;
  verify([...finalHome.youtrackList.querySelectorAll('.aim-home-issue')].every(x=>x.draggable&&x.href.endsWith(x.dataset.youtrackId)),'filtered issues keep drag/open actions');
  const grid=document.querySelector('.aim-home-grid'),tiles=[...document.querySelectorAll('.aim-home-tile')];
  verify(new Set(tiles.map(x=>Math.round(x.getBoundingClientRect().height))).size===1,'equal widget heights');
  if(query.has('narrow')||query.has('compact'))verify(grid.scrollWidth>grid.clientWidth,'narrow row scrolls horizontally');
  verify(document.documentElement.scrollWidth<=innerWidth,'no viewport overflow');
  const checkFrame=label=>{
   const visible=selector=>tiles.map(tile=>[...tile.querySelectorAll(selector)].find(node=>node.getClientRects().length));
   for(const selector of ['.aim-widget-header','.aim-widget-controls','.aim-widget-body','.aim-widget-footer']){
    const nodes=visible(selector);verify(nodes.every(Boolean),label+' shared '+selector);
    for(const edge of ['top','bottom']){
     const values=nodes.map(node=>node.getBoundingClientRect()[edge]);
     verify(Math.max(...values)-Math.min(...values)<=1,label+' aligned '+selector+' '+edge);
    }
   }
   for(const selector of ['.aim-widget-footer','.aim-widget-header']){
    verify(new Set(visible(selector).map(node=>getComputedStyle(node).fontFamily)).size===1,label+' common font '+selector);
   }
  };
  checkFrame('Mail');
  const titles=tiles.map(tile=>tile.querySelector('.aim-widget-header h3,.aim-widget-header button'));
  for(const role of ['fontFamily','fontSize','fontWeight','lineHeight'])verify(new Set(titles.map(n=>getComputedStyle(n)[role])).size===1,'title typography '+role);
  const senderStyles=['.aim-home-mail-sender','.aim-home-slack-author','.aim-home-note-name'].map(sel=>getComputedStyle(finalHome.home.querySelector(sel)));
  for(const role of ['fontFamily','fontSize','fontWeight','lineHeight'])verify(new Set(senderStyles.map(s=>s[role])).size===1,'row title typography '+role);
  verify(getComputedStyle(finalHome.home.querySelector('.aim-home-mail-subject')).lineHeight===getComputedStyle(finalHome.home.querySelector('.aim-home-slack-text')).lineHeight,'Mail/Slack excerpt line height');
  r.setHomePanel(finalHome,'calendar');checkFrame('Calendar');
  finalHome.calendarMode='agenda';r.updateHome(finalHome);checkFrame('Agenda');
  finalHome.calendarMode='month';r.updateHome(finalHome);
  const beforeHeight=r.homeWidgetHeight;
  r.homeWidgetHeight=300;
  finalHome.calendarMonth='2026-08';r.updateHome(finalHome);checkFrame('six-week minimum');
  r.mailError=r.slackError=r.youtrackRefreshError='Synthetic long error. '.repeat(16);
  r.refreshHomes();checkFrame('long errors');r.setHomePanel(finalHome,'mail');checkFrame('Mail error');
  r.mailError=r.slackError=r.youtrackRefreshError='';r.refreshHomes();
  r.slackAccount={...r.slackAccount,teamName:'A very long fictional workspace name to test clipping',userName:'demo'};
  r.slackSources={channel:'team-notes',group:'builders'};r.refreshHomes();checkFrame('long context');
  r.mailBusy=r.slackBusy=r.youtrackBusy=true;r.refreshHomes();checkFrame('busy');
  r.mailBusy=r.slackBusy=r.youtrackBusy=false;r.refreshHomes();
  for(const [token,value] of [['--font-ui-small','16px'],['--font-ui-medium','18px'],['--font-ui-smaller','14px']])finalHome.home.style.setProperty(token,value);
  checkFrame('larger fonts');
  for(const token of ['--font-ui-small','--font-ui-medium','--font-ui-smaller'])finalHome.home.style.removeProperty(token);
  r.homeWidgetHeight=beforeHeight;r.applyHomeWidgetHeight(finalHome);
  verify(f.files.size===fileCount&&JSON.stringify(f.saved)===settingsBefore,'grouping and geometry checks never write notes/settings');
  // Meeting markers must occupy their own line, including a selected day at minimum height.
  const markerMonths=['2026-10','2027-02','2026-08'];
  const markerEvents=month=>[2,3,4,26].flatMap(day=>Array.from({length:day===2?1:day===3?2:day===4?4:3},(_,i)=>({
   uid:`fixture-${month}-${day}-${i}`,summary:'Fictional meeting',
   start:+new Date(`${month}-${String(day).padStart(2,'0')}T10:00:00`),end:+new Date(`${month}-${String(day).padStart(2,'0')}T11:00:00`)
  })));
  r.calendarEnabled=true;r.calendarError='';r.calendarBusy=false;
  r.calendarCache={months:new Map(markerMonths.map(month=>[month,markerEvents(month)])),stamps:new Map(markerMonths.map(month=>[month,Date.now()])),fetchedAt:Date.now()};
  r.setHomePanel(finalHome,'calendar');
  const measuredCalendarHeights=new Set();
  for(const height of [401,300])for(const month of markerMonths){
   r.homeWidgetHeight=height;
   finalHome.calendarMode='month';finalHome.calendarMonth=month;finalHome.selectedDay=month+'-04';r.updateHome(finalHome);
   const measuredHeight=finalHome.widgets.calendar.getBoundingClientRect().height;
   verify(Math.abs(measuredHeight-Math.max(300,Math.min(height,r.homeWidgetBounds(finalHome).max)))<=1,'bounded calendar height is rendered');measuredCalendarHeights.add(Math.round(measuredHeight));
   checkFrame('Calendar markers '+height+' '+month);
   for(const day of finalHome.calendarDays.querySelectorAll('button')){
    const box=day.getBoundingClientRect(),number=day.querySelector('.aim-home-day-number').getBoundingClientRect();
    verify(box.bottom-number.bottom>=8,'meeting markers need clear space below date badge at '+height+' '+month);
    const markers=day.querySelector('.aim-home-day-markers');verify(markers,'dedicated marker line');
    const marks=markers.getBoundingClientRect();
    verify(marks.top-number.bottom>=4-0.1,'date and markers separated');
    verify(marks.bottom<=box.bottom&&marks.left>=box.left&&marks.right<=box.right,'markers stay inside their day');
    verify(Math.abs((marks.left+marks.right)-(box.left+box.right))<=1,'marker line centered');
    verify(markers.getAttribute('aria-hidden')==='true','marker shape does not repeat accessible date');
   }
   const buttons=[...finalHome.calendarDays.querySelectorAll('button')];
   verify(buttons.slice(0,4).map(n=>n.dataset.meetings).join(',')==='0,1,2,3','zero/one/two/capped meeting indicators');
   verify(buttons[3].getAttribute('aria-label').includes('4 meetings'),'full count remains accessible');
   if(height===300)verify(finalHome.calendarDays.scrollHeight>finalHome.calendarDays.clientHeight,'short calendar scrolls without shrinking dates');
  }
  r.homeWidgetHeight=401;finalHome.calendarMonth='2026-10';finalHome.selectedDay='2026-10-26';r.updateHome(finalHome);
  finalHome.calendarDays.querySelector('[data-day="2026-10-04"]').click();verify(finalHome.calendarMode==='agenda'&&finalHome.selectedDay==='2026-10-04','date still opens its agenda');
  finalHome.calendarMode='month';finalHome.selectedDay='2026-10-26';r.updateHome(finalHome);
  status.textContent='PASS · Calendar marker spacing ('+[...measuredCalendarHeights].join('/')+'px), aligned frames and interactions · Synthetic data';document.title='PASS · Slack Home fixture';
 } catch(error){status.textContent='FAIL · '+error.message;document.title='FAIL · Slack Home fixture';}
})();
'''.replace('ARGS',json.dumps(args).replace('</','<\\/'))
html='<!doctype html><html lang="en"><meta charset="utf-8"><title>Slack Home fixture</title><style>'+''.join(styles)+'</style><body><div class="fixture-bar"><strong id="qa-status">Running synthetic checks…</strong><a href="?">Desktop</a><a href="?narrow=1">Narrow panel</a><a href="?light=1">Light</a></div><script>'+(ROOT/'tests/toolbar.fixture.js').read_text()+'</script><script>'+checks.replace('</', '<\\/')+'</script></body></html>'
(OUT/'index.html').write_text(html)
print((OUT/'index.html').as_uri())
