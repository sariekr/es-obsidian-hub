// Browser fixture: real DOM and MutationObserver, in-memory Obsidian/vault APIs.
// It never connects to the running app or reads/writes real note bodies.
window.bootFixture = async ({ source, schema }) => {
  class Events {
    constructor() { this.events = new Map(); }
    on(name, fn) {
      const list = this.events.get(name) || [];
      list.push(fn); this.events.set(name, list);
      return { off: () => this.events.set(name, list.filter(item => item !== fn)) };
    }
    emit(name, ...args) { for (const fn of this.events.get(name) || []) fn(...args); }
  }
  const state = window.fixture = { leaves: [], files: new Map(), opened: [], saved: {}, notices: [], deletionRequests: [] };
  class TFile {
    constructor(path) {
      this.path = path; this.extension = 'md'; this.stat = { ctime: Date.now(), mtime: Date.now() };
      this.name = path.split('/').at(-1);
      this.basename = path.split('/').at(-1).replace(/\.md$/, '');
      this.parent = { path: path.split('/').slice(0, -1).join('/'), name: path.split('/').at(-2) };
    }
  }
  const workspace = new Events();
  workspace.containerEl = document.body;
  workspace.iterateAllLeaves = fn => [...state.leaves].forEach(fn);
  workspace.getLeavesOfType = () => state.leaves.filter(leaf => leaf.view.editor);
  workspace.onLayoutReady = fn => fn();
  workspace.revealLeaf = async leaf => { state.revealed = leaf; };
  workspace.getLastOpenFiles = () => state.recent || [];
  workspace.getLeaf = type => ({
    view: { editor: { focus: () => { state.focused = true; } } },
    openFile: async (file, options) => state.opened.push({ path: file.path, type, options })
  });
  const vault = new Events();
  state.snapshot = { schema:1, fetchedAt:new Date().toISOString(), issues:Array.from({length:19},(_,i)=>({id:`DEMO-${161-i}`,assignee:'Alex',title:['Plan the next project','Review team notes','Prepare a weekly summary'][i%3],state:i%2?'Open':'In Progress',priority:i%2?'Normal':'High',url:`https://tracker.example.com/issue/DEMO-${161-i}`})) };
  vault.adapter = { read: async path => path.endsWith('youtrack-widget.json') ? JSON.stringify(state.snapshot) : schema };
  vault.getAbstractFileByPath = path => state.files.get(path);
  vault.getMarkdownFiles = () => [...state.files.values()].filter(file => file instanceof TFile);
  vault.cachedRead = async file => file.content || '';
  vault.createFolder = async path => {
    if (state.failFolderCreate) throw Error('Fixture folder failure');
    if (state.pauseFolderCreate) await new Promise(resolve => { state.finishFolderCreation = resolve; });
    if (state.files.has(path)) throw Error('Folder exists');
    const folder = { path, name: path.split('/').at(-1), parent: state.files.get(path.split('/').slice(0, -1).join('/')), children: [] };
    state.files.set(path, folder);folder.parent?.children.push(folder);vault.emit('create', folder);return folder;
  };
  vault.create = async (path, content) => {
    if (state.failCreate) throw Error('Fixture write failure');
    if (state.files.has(path)) throw Error('exists');
    const file = new TFile(path); file.content = content; state.files.set(path, file); return file;
  };
  const folders = ['Quick Notes', 'Other', 'Data', 'Personal', 'MSc', 'Benchmark', 'Unity', 'Attachments', '_kanban'].map(name => ({ name, path: `Hub/${name}`, children: [] }));
  folders.forEach(folder => state.files.set(folder.path, folder));
  state.files.set('Hub', { path: 'Hub', children: folders });
  state.files.set('Hub/Other/random notes.md', new TFile('Hub/Other/random notes.md'));
  state.caches = new Map();
  const cache = new Events(); cache.getFileCache = file => state.caches.get(file.path) || {};
  cache.getFirstLinkpathDest = path => state.files.get(path) || state.files.get(path + '.md');
  state.recent = ['Hub/Other/Plan a project.md', 'Hub/MSc/Learning notes.md', 'Hub/Personal/Weekend ideas.md'];
  for (const path of [...state.recent, 'Hub/Personal/Home shortcuts.md', 'Hub/Larousse/Knowledge.md', 'Hub/MSc/MSc.md', 'Hub/Unity/Unity Game Dev.md']) state.files.set(path, new TFile(path));
  state.caches.set('Hub/Personal/Home shortcuts.md', { links: [
    {link:'Hub/Larousse/Knowledge',displayText:'Knowledge'}, {link:'Hub/MSc/MSc',displayText:'MSc'},
    {link:'Hub/Unity/Unity Game Dev',displayText:'Unity'},
  ] });
  const app = { workspace, vault, metadataCache: cache, fileManager: {
    renameFile: async (subject, destination) => {
      if (state.failMove) throw Error('Fixture move failure');
      if (state.files.get(subject.path) !== subject) throw Error('Missing source');
      if (state.files.has(destination)) throw Error('Target exists');
      if (!state.files.get(destination.split('/').slice(0, -1).join('/'))?.children) throw Error('Missing destination folder');
      const old = subject.path;
      const entries = [...state.files].filter(([path]) => path === old || path.startsWith(old + '/'));
      for (const [path, file] of entries) {
        const next = destination + path.slice(old.length);
        state.files.delete(path);state.files.set(next, file);file.path = next;
        file.name = next.split('/').at(-1);
        if (file instanceof TFile) file.basename = file.name.replace(/\.md$/, '');
        if (state.caches.has(path)) { state.caches.set(next, state.caches.get(path));state.caches.delete(path); }
      }
      for (const [, file] of entries) file.parent = state.files.get(file.path.split('/').slice(0, -1).join('/'));
      vault.emit('rename', subject, old);
    },
    promptForDeletion: async file => {
      state.deletionRequests.push(file.path);
      if (state.failDelete) throw Error('Fixture delete failure');
      if (state.pauseDelete) await new Promise(resolve => { state.finishDeletion = resolve; });
      if (state.confirmDelete) {
        state.files.delete(file.path);state.caches.delete(file.path);vault.emit('delete',file);
      }
    },
    processFrontMatter: async (file, update) => {
      const value = cache.getFileCache(file); value.frontmatter ||= {};
      update(value.frontmatter); state.caches.set(file.path, value);
      cache.emit('changed', file, '', value);
    }
  } };
  state.app = app;
  state.secrets = new Map(); state.requests = [];
  app.secretStorage = {getSecret:key=>state.secrets.get(key)||null,setSecret:(key,value)=>state.secrets.set(key,value)};
  state.calendarText = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:fixture\r\nDTSTART:20261016T070000Z\r\nDTEND:20261016T080000Z\r\nRRULE:FREQ=DAILY;COUNT=365\r\nSUMMARY:Team meeting\r\nEND:VEVENT\r\nEND:VCALENDAR';
  class Plugin {
    constructor() { this.app = app; this.cleanup = []; }
    loadData() { return Promise.resolve(state.saved); }
    saveData(data) {
      if (state.failSettings) return Promise.reject(Error('Fixture settings failure'));
      state.saved = structuredClone(data); return Promise.resolve();
    }
    register(fn) { this.cleanup.push(fn); }
    registerEvent(ref) { this.cleanup.push(() => ref.off()); }
    registerDomEvent(el, event, fn, options) { el.addEventListener(event, fn, options); this.cleanup.push(() => el.removeEventListener(event, fn, options)); }
    addStatusBarItem() {
      const el = document.createElement('div');
      el.addClass = cls => el.classList.add(cls);
      el.setText = text => { el.textContent = text; };
      el.toggleClass = (cls, enabled) => el.classList.toggle(cls, enabled);
      return el;
    }
    unload() { this.onunload(); this.cleanup.forEach(fn => fn()); }
  }
  class Menu {
    constructor() { this.items = []; }
    addItem(configure) {
      const item = {
        setTitle(title) { this.title = title; return this; },
        setIcon() { return this; },
        setDisabled(disabled) { this.disabled = disabled; return this; },
        onClick(action) { this.action = action; return this; },
      };
      configure(item); this.items.push(item); return this;
    }
    showAtMouseEvent(event) {
      const doc = event.target.ownerDocument;
      const menu = doc.createElement('div');menu.className = 'menu';menu.setAttribute('role', 'menu');
      menu.style.cssText = `position:fixed;left:${event.clientX}px;top:${event.clientY}px;z-index:1000;background:var(--background-primary);padding:6px;border:1px solid var(--background-modifier-border)`;
      for (const item of this.items) {
        const button = doc.createElement('button');button.textContent = item.title;
        button.disabled = item.disabled;button.setAttribute('role', 'menuitem');
        button.addEventListener('click', () => { menu.remove();item.action(); });menu.append(button);
      }
      doc.body.append(menu);
    }
  }
  const obsidian = {
    Plugin, TFile, Modal: class {
      constructor() {this.contentEl=document.createElement('div');}
      open() { state.modal=this; if(['HomeCalendarModal','HomeSlackModal','HomeYouTrackModal'].includes(this.constructor.name)) {this.contentEl.className='fixture-modal';this.contentEl.setAttribute('role','dialog');document.body.append(this.contentEl);this.onOpen();} }
      close() {this.onClose?.();this.contentEl.remove();}
    }, Setting: class {}, Menu,
    requestUrl: async args=>{
      if(args.url.startsWith('https://slack.com/api/')) {
        state.requests.push(args);
        if(!state.requestSlack) throw Error('No Slack fixture configured');
        return state.requestSlack(args);
      }
      state.requests.push(args);if(state.failCalendar)throw Error('Network failed');
      if(args.url.endsWith('/token'))return {status:200,json:{access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600,scope:'https://www.googleapis.com/auth/calendar.events.owned.readonly'}};
      if(args.url.startsWith('https://www.googleapis.com/calendar/'))return {status:200,json:{items:[{id:'fixture',summary:'Private account meeting',start:{dateTime:new Date().toISOString()},end:{dateTime:new Date(Date.now()+3600000).toISOString()}}]}};
      return {status:200,text:state.calendarText};
    },
    Notice: class { constructor(text) { state.notices.push(text); } },
    getAllTags: value => [...(value.frontmatter?.tags || []).map(tag => `#${tag}`), ...(value.tags || []).map(item => item.tag)],
    setIcon: (el, name) => {
      const svg=el.ownerDocument.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');
      svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','2');svg.setAttribute('aria-hidden','true');
      const path=el.ownerDocument.createElementNS(svg.namespaceURI,'path');
      path.setAttribute('d',name==='chevron-left'?'m15 18-6-6 6-6':name==='chevron-right'?'m9 18 6-6-6-6':'M15 3h6v6M10 14 21 3M21 14v7H3V3h7');
      svg.append(path);el.replaceChildren(svg);
    },
  };
  const module = { exports: {} };
  new Function('require', 'module', source)(() => obsidian, module);
  state.addBoard = (doc = document, path = 'Hub/Kanban Board.base') => {
    const scope = doc.createElement('section'); scope.className = 'fixture-leaf'; doc.body.append(scope);
    const leaf = { view: { file: { path }, containerEl: scope } };
    state.leaves.push(leaf);
    state.renderBoard(leaf);
    workspace.emit('layout-change');
    return leaf;
  };
  state.renderBoard = leaf => {
    leaf.view.containerEl.innerHTML = `<div class="obk-view-container"><div class="obk-board">${['backlog', 'in-progress', 'done'].map((column, index) => `
      <div class="obk-column" data-column-value="${column}" style="--obk-column-accent-color:${['#d78c71', '#439b59', '#c52e61'][index]}">
        <div class="obk-column-header"><span>${['Backlog', 'In-Progress', 'Done'][index]}</span><span>3</span></div>
        <div class="obk-column-body">${['Project notes', 'Next step', 'Review'].map((title, i) => `<div class="obk-card" data-entry-path="Hub/Other/example-${index}-${i}.md"><div class="obk-card-title">${title}</div><div>Priority Label 🟡 Medium</div><div>Type Other</div></div>`).join('')}</div>
      </div>`).join('')}</div></div>`;
  };
  state.addNote = (path, doc = document) => {
    const scope = doc.createElement('section'); scope.className = 'fixture-note-leaf'; doc.body.append(scope);
    const leaf = { view: { containerEl: scope, getViewType: () => 'markdown' } };
    state.leaves.push(leaf);state.openNote(leaf,path);
    return leaf;
  };
  state.openNote = (leaf, path, mode = 'source') => {
    const file = state.files.get(path) || new TFile(path);state.files.set(path,file);
    leaf.view.file = file;
    leaf.view.containerEl.innerHTML = '<div class="view-header">Hub / Note</div><div class="view-content"></div>';
    leaf.view.contentEl = leaf.view.containerEl.querySelector('.view-content');
    state.renderNote(leaf,mode);workspace.emit('file-open',file);workspace.emit('layout-change');
  };
  state.renderNote = (leaf,mode) => {
    const content=leaf.view.contentEl;
    content.innerHTML = `<div class="${mode === 'preview' ? 'markdown-reading-view' : 'markdown-source-view'}"><h1 class="inline-title"></h1><div class="metadata-container">Properties</div><textarea aria-label="Note content">Keep my note content</textarea></div>`;
    content.querySelector('.inline-title').textContent=leaf.view.file.basename;
  };
  state.board = state.addBoard();
  module.exports.prototype.fetchYouTrackSnapshot = async () => {
    state.youtrackCalls = (state.youtrackCalls || 0) + 1;
    if (state.pauseYouTrack) await new Promise(resolve => {state.finishYouTrack = resolve;});
    if (state.failYouTrack) throw Error('TOKEN_SECRET');
    return {...structuredClone(state.snapshot), source:'YouTrack MCP', assignee:'Alex', fetchedAt:new Date().toISOString()};
  };
  module.exports.prototype.persistYouTrackSnapshot = async snapshot => {
    if (state.failYouTrackSave) throw Error('SAVE_SECRET');
    state.snapshot = structuredClone(snapshot);
  };
  state.plugin = new module.exports();
  state.reload = async () => { state.plugin.unload(); state.plugin = new module.exports(); await state.plugin.onload(); };
  await state.plugin.onload();
};
