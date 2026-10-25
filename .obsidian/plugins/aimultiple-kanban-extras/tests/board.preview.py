"""Build a synthetic board UI check using the shipped runtime and theme.
Serve the printed directory over localhost; no real vault data or credentials.
"""
from pathlib import Path
import json
import tempfile

ROOT = Path(__file__).resolve().parent.parent
VAULT = ROOT.parents[2]
OUT = Path(tempfile.mkdtemp(prefix='kanban-board-preview-'))
styles = ['''
*{box-sizing:border-box}body{margin:0;background:var(--background-primary);color:var(--text-normal);font:13px var(--font-interface,system-ui)}
.fixture-leaf{height:calc(100vh - 44px);width:100%;margin:auto}
body.narrow .fixture-leaf{width:min(800px,100%)}body.compact .fixture-leaf{width:min(480px,100%)}
.fixture-bar{height:44px;padding:10px 16px;display:flex;align-items:center;gap:20px}
button,select,input{font:inherit} .obk-card{margin:10px}.obk-card-title{font-weight:600}
body.neutral .aim-card-priority-icon{color:var(--text-normal)!important}
''']
for path in [VAULT/'.obsidian/themes/AnuPpuccin/theme.css', ROOT.parent/'kanban-bases-view/styles.css',
             VAULT/'.obsidian/snippets/kanban-column-fill-width.css', ROOT/'styles.css']:
    styles.append(path.read_text())
args = {'source': (ROOT/'main.js').read_text(), 'schema': (VAULT/'Hub/_kanban/taxonomy.md').read_text()}
checks = r'''
(async()=>{
 const query=new URLSearchParams(location.search),status=document.getElementById('qa-status');
 document.body.className=(query.has('light')?'theme-light ctp-latte':'theme-dark ctp-mocha')+' ctp-accent-teal anuppuccin-accent-toggle'+(query.has('narrow')?' narrow':'')+(query.has('compact')?' compact':'')+(query.has('neutral')?' neutral':'');
 const verify=(ok,label)=>{if(!ok)throw Error(label);};
 const settle=async()=>{for(let n=0;n<6;n++)await new Promise(r=>setTimeout(r,0));};
 try {
  await bootFixture(ARGS);const f=window.fixture,p=f.plugin;
  const File=[...f.files.values()].find(x=>x.extension==='md').constructor;
  const titles=['Compare embedding models','Review the experiment','Prepare the final report'];
  const seed=()=>{
   for(const [index,card] of [...document.querySelectorAll('.obk-card')].entries()){
    const path=card.dataset.entryPath;
    if(!f.files.has(path)){
     const file=new File(path);file.content='---\nprivate_field: OMIT_FROM_PREVIEW\n---\n## Sonraki adım\n- [ ] Review **the results** and [[Methodology|the method]].\n\n## Tamamlanma kriteri\nThe comparison is ready.\n\n## Notes\n<script>Literal text, never executed</script>\n\n'+('More supporting context.\n\n'.repeat(12));
     f.files.set(path,file);
     f.caches.set(path,{frontmatter:{tags:['kanban'],board_column:['backlog','in-progress','done'][Math.floor(index/3)],priority:index===0?'high':['urgent','high','medium','low'][index%4],category:index%2?'MSc':'Benchmark'}});
    }
    card.querySelector('.obk-card-title').textContent=titles[index%3]+(index===0?' — İstatistik':'');
    for(const child of [...card.children])if(child.tagName==='DIV'&&!child.className)child.remove();
    if(!card.querySelector('.obk-card-property')){
     const el=document.createElement('div');el.className='obk-card-property';el.dataset.label='formula.priority_label';el.textContent='Priority Label Medium';card.append(el);
    }
   }
   p.refreshBoardTools();
  };
  seed();await settle();const entry=[...p.toolbars.values()][0];
  const cards=()=>[...entry.host.querySelectorAll('.obk-card')];
  const visible=()=>cards().filter(c=>!c.classList.contains('aim-card-filtered'));
  const search=text=>{entry.boardSearch.value=text;entry.boardSearch.dispatchEvent(new Event('input',{bubbles:true}));};
  const type=value=>{entry.boardTypeSelect.value=value;entry.boardTypeSelect.dispatchEvent(new Event('change',{bubbles:true}));};
  verify(cards().length===9&&document.querySelectorAll('.aim-card-details').length===9,'one enhancement per card');
  verify(document.querySelectorAll('.aim-board-tools').length===1,'one filter row');
  verify(cards()[0].querySelector('.aim-card-summary').textContent==='Review the results and the method.','next step excerpt');
  verify(getComputedStyle(cards()[0].querySelector('.obk-card-property')).display==='none','redundant label hidden');
  const original=[...f.files.values()].filter(x=>x.extension==='md').map(x=>[x.path,x.content,JSON.stringify(f.caches.get(x.path))]);
  search('istatistik');verify(visible().length===1,'Turkish case-insensitive title search');
  type('MSc');verify(visible().length===0&&entry.boardCount.textContent.includes('No matches'),'combined filters and empty feedback');
  entry.boardClear.click();verify(visible().length===9&&entry.boardSearch.value==='','clear filters');
  type('Benchmark');verify(visible().length===5,'Type filter');
  f.renderBoard(f.board);seed();await settle();verify(visible().length===5&&entry.boardTypeSelect.value==='Benchmark','filter survives vendor rebuild');
  verify(document.querySelectorAll('.aim-board-tools').length===1,'no duplicate filters after redraw');
  entry.boardClear.click();const first=cards()[0].querySelector('.aim-card-preview');
  const opened=f.opened.length;first.click();await settle();
  let preview=document.querySelector('.aim-board-preview');
  verify(preview&&preview.textContent.includes('the method'),'preview opens on click');
  verify(!preview.textContent.includes('OMIT_FROM_PREVIEW')&&!preview.querySelector('script,img,iframe'),'no YAML, executable markup or image requests');
  verify(f.opened.length===opened,'Preview leaves board open without opening a file');
  preview.querySelector('.aim-board-preview-close').click();verify(!document.querySelector('.aim-board-preview')&&document.activeElement===first,'close restores focus');
  first.click();await settle();preview=document.querySelector('.aim-board-preview');
  preview.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  verify(!document.querySelector('.aim-board-preview'),'Escape closes preview');
  first.click();await settle();document.querySelector('.aim-board-preview-footer button').click();await settle();
  verify(f.opened.length===opened+1&&f.opened.at(-1).type==='tab','Open note uses a new tab');
  const cardFile=f.files.get(cards()[0].dataset.entryPath);cardFile.content='## Sonraki adım\nUpdated after edit';
  f.app.vault.emit('modify',cardFile);await settle();
  verify(cards()[0].querySelector('.aim-card-summary').textContent==='Updated after edit','excerpt refreshes after edit without mtime advance');
  cardFile.content=original.find(x=>x[0]===cardFile.path)[1];f.app.vault.emit('modify',cardFile);await settle();
  verify(original.every(([path,body,cache])=>f.files.get(path)?.content===body&&JSON.stringify(f.caches.get(path))===cache),'filter and preview preserve note contents and properties');
  verify(Object.keys(f.saved).length===0,'no settings writes');
  entry.customize.click();entry.home.querySelector('.aim-type-icon-settings').open=true;
  const choose=async(type,icon)=>{const select=entry.typeIconInputs.get(type).select;select.value=icon;select.dispatchEvent(new Event('change',{bubbles:true}));await p.tagSuggestionSave;await settle();};
  verify(cards().every(c=>c.querySelector('[data-property="category"] .aim-ui-icon')?.getAttribute('data-icon')==='folder'),'neutral defaults, no folder-name assumptions');
  await choose('Benchmark','flask-conical');await choose('MSc','graduation-cap');
  verify(cards()[0].querySelector('[data-property="category"] .aim-ui-icon').getAttribute('data-icon')==='flask-conical','saved icon refreshes existing cards');
  verify(cards()[0].querySelector('[data-property="category"]').textContent==='Benchmark','Type label retained');
  verify(cards()[0].querySelector('[data-priority="high"] .aim-ui-icon').getAttribute('data-icon')==='chevrons-up','priority uses its own shape');
  f.failSettings=true;await choose('Benchmark','heart');f.failSettings=false;
  verify(p.typeIcon('Benchmark')==='flask-conical'&&entry.typeIconInputs.get('Benchmark').select.value==='flask-conical','failed save restores the selected icon');
  verify(entry.typeIconMessage.textContent.includes('failure'),'failed save is visible');
  const named='Customer operations with a very long folder name';
  const added=await f.app.vault.createFolder('Hub/'+named);await settle();
  verify(entry.typeIconInputs.has(named)&&p.typeIcon(named)==='folder','new arbitrary Type appears with a neutral icon');
  verify([...entry.typeIconRows.children].every(row=>row.scrollWidth<=row.clientWidth+1),'long Type settings fit the panel');
  f.files.delete(added.path);const hub=f.files.get('Hub');hub.children=hub.children.filter(x=>x!==added);f.app.vault.emit('delete',added);await settle();
  verify(!entry.typeIconInputs.has(named),'deleted Type disappears from settings');
  cards()[0].querySelector('[data-property="category"]').click();await settle();
  verify(document.querySelector('.aim-property-option .aim-ui-icon[data-icon="flask-conical"]'),'Type picker uses the same assigned icon');
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  verify(original.every(([path,body,cache])=>f.files.get(path)?.content===body&&JSON.stringify(f.caches.get(path))===cache),'icon choices never move or modify notes');
  entry.customize.click();
  const count=document.querySelectorAll('.aim-board-tools').length;
  const other=f.addBoard(document,'Hub/Other/Other.base');await settle();
  verify(!other.view.containerEl.querySelector('.aim-board-tools'),'other Bases untouched');
  f.leaves.splice(f.leaves.indexOf(other),1);other.view.containerEl.remove();f.app.workspace.emit('layout-change');
  first.click();await settle();p.unload();
  verify(!document.querySelector('.aim-board-preview,.aim-board-tools,.aim-card-details'),'unload cleans owned UI');
  verify(cards().every(c=>!c.classList.contains('aim-card-filtered')&&!c.classList.contains('aim-card-managed')),'unload restores vendor cards');
  await f.reload();await settle();
  verify(f.plugin.typeIcon('Benchmark')==='flask-conical','Type icons survive reload');
  verify(document.querySelectorAll('.aim-board-tools').length===1,'reload mounts once');
  verify(document.querySelectorAll('.obk-column').length===3,'three columns preserved');
  verify(document.documentElement.scrollWidth<=innerWidth,'no page overflow');
  const pixel=color=>{const ctx=document.createElement('canvas').getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].map((v,i)=>i===3?v/255:v);};
  const blend=(fg,bg)=>fg.slice(0,3).map((v,i)=>v*fg[3]+bg[i]*(1-fg[3])).concat(1);
  const background=el=>{if(!el)return [255,255,255,1];const color=pixel(getComputedStyle(el).backgroundColor);return color[3]===1?color:blend(color,background(el.parentElement));};
  const luminance=rgb=>rgb.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
  const contrast=(fg,bg)=>{const a=luminance(blend(fg,bg)),b=luminance(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
  const samples=[...document.querySelectorAll('.aim-card-chip,.aim-card-preview,.aim-card-summary,.aim-board-count,.aim-card-footer .aim-ui-icon,.aim-board-search-field .aim-ui-icon')].filter(el=>el.getClientRects().length);
  verify(samples.every(el=>{for(let node=el;node;node=node.parentElement)if(Number(getComputedStyle(node).opacity)<1)return false;return true;}),'controls and excerpts are not dimmed by ancestor opacity, including Done');
  const ratios=samples.map(el=>({kind:el.classList.contains('aim-ui-icon')?'icon':'text',ratio:contrast(pixel(getComputedStyle(el).color),background(el))}));
  const searchInput=document.querySelector('.aim-board-tools input');
  ratios.push({kind:'text',ratio:contrast(pixel(getComputedStyle(searchInput,'::placeholder').color),background(searchInput))});
  verify(ratios.every(x=>x.ratio >= (x.kind==='icon'?3:4.5)),'changed text and icon contrast');
  window.iconContrast=ratios;
  status.textContent='PASS · Icons, settings, filters, preview, cleanup · Text ≥ '+Math.min(...ratios.filter(x=>x.kind==='text').map(x=>x.ratio)).toFixed(2)+':1 · Icons ≥ '+Math.min(...ratios.filter(x=>x.kind==='icon').map(x=>x.ratio)).toFixed(2)+':1';
  document.title='PASS · Board UI fixture';
  if(query.has('preview')){document.querySelector('.aim-card-preview').click();await settle();}
  if(query.has('settings')){const live=[...f.plugin.toolbars.values()][0];live.customize.click();live.home.querySelector('.aim-type-icon-settings').open=true;}
 }catch(error){status.textContent='FAIL · '+error.message;document.title=status.textContent;}
})();
'''.replace('ARGS',json.dumps(args).replace('</','<\\/')).replace('</','<\\/')
html='<!doctype html><html lang="en"><meta charset="utf-8"><title>Board UI fixture</title><style>'+''.join(styles)+'</style><body><div class="fixture-bar"><strong id="qa-status">Running synthetic checks…</strong><a href="?">Desktop</a><a href="?narrow=1&light=1">Narrow light</a><a href="?compact=1&preview=1">Compact preview</a></div><script>'+(ROOT/'tests/toolbar.fixture.js').read_text()+'</script><script>'+checks+'</script></body></html>'
(OUT/'index.html').write_text(html)
print(OUT)
