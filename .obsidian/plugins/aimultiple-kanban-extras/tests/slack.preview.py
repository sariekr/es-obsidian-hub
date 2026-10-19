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
  verify(f.files.size===notes && Object.keys(f.saved).length===0,'no note or settings writes');
  const snapshot=p.slackSnapshot;f.failSlack=true;
  document.querySelector('[aria-label="Refresh Slack inbox"]').click();await settle();
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
  verify(document.querySelector('.aim-home-slack-footer').textContent.includes('Auto 5m'),'automatic refresh status');
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
  const w=f.plugin;w.mailSupported=()=>true;
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
  verify(!home.mailList.querySelector('script')&&home.mailList.textContent.includes('<script>Literal subject</script>'),'Mail subjects rendered as text');
  home.mailFilters.get('unread').click();verify(home.mailList.querySelectorAll('button').length===28,'Unread filters loaded rows');
  home.mailAccountSelect.value='account-2';home.mailAccountSelect.dispatchEvent(new Event('change'));
  verify(home.mailList.querySelectorAll('button').length===4,'account and unread filters combine');
  home.mailList.querySelector('button').click();await settle();verify(mailOpens===1,'explicit row opens exact message');
  home.mailFilters.get('all').click();home.mailAccountSelect.value='';home.mailAccountSelect.dispatchEvent(new Event('change'));
  const good=w.mailSnapshot;w.fetchMailSnapshot=async()=>{throw Error('private raw failure');};
  home.mailRefresh.click();await settle();verify(w.mailSnapshot===good&&!home.mailMessage.hidden&&!home.mailMessage.textContent.includes('private raw'),'failed refresh keeps list and safe error');
  w.fetchMailSnapshot=async()=>structuredClone(mailData);await w.refreshMail();await settle();
  home.mailList.scrollTop=80;const savedScroll=home.mailList.scrollTop;
  home.mailFilters.get('unread').click();const selectedFilter=home.mailFilter;
  home.calendarMainTab.click();await settle();
  verify(!home.calendarPanel.hidden&&home.mailPanel.hidden&&home.mailRefresh.hidden,'Calendar restores its own content and controls');
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
  const grid=document.querySelector('.aim-home-grid'),tiles=[...document.querySelectorAll('.aim-home-tile')];
  verify(new Set(tiles.map(x=>Math.round(x.getBoundingClientRect().height))).size===1,'equal widget heights');
  if(query.has('narrow')||query.has('compact'))verify(grid.scrollWidth>grid.clientWidth,'narrow row scrolls horizontally');
  verify(document.documentElement.scrollWidth<=innerWidth,'no viewport overflow');
  status.textContent='PASS · Calendar/Mail tabs, Scratchpad and Slack · Synthetic data';document.title='PASS · Slack Home fixture';
 } catch(error){status.textContent='FAIL · '+error.message;document.title='FAIL · Slack Home fixture';}
})();
'''.replace('ARGS',json.dumps(args).replace('</','<\\/'))
html='<!doctype html><html lang="en"><meta charset="utf-8"><title>Slack Home fixture</title><style>'+''.join(styles)+'</style><body><div class="fixture-bar"><strong id="qa-status">Running synthetic checks…</strong><a href="?">Desktop</a><a href="?narrow=1">Narrow panel</a><a href="?light=1">Light</a></div><script>'+(ROOT/'tests/toolbar.fixture.js').read_text()+'</script><script>'+checks.replace('</', '<\\/')+'</script></body></html>'
(OUT/'index.html').write_text(html)
print((OUT/'index.html').as_uri())
