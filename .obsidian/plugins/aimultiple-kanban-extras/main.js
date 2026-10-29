"use strict";

const { Plugin, Menu, Modal, Notice, Setting, TFile, getAllTags, setIcon, requestUrl } = require("obsidian");

// Shared board schema; loaded through the vault adapter for desktop/mobile.
const CARD_SELECTOR = ".obk-card[data-entry-path]";
const COLUMN_SELECTOR = ".obk-column[data-column-value]";
const BOARD_PATH = "Hub/Kanban Board.base";
const DEFAULT_CAPTURE_FOLDER = "Hub/Quick Notes";
const HOME_SHORTCUTS = "Hub/Personal/Home shortcuts.md";
const DAILY_FOLDER = "Daily Notes";
const DAILY_TEMPLATE = "Templates/Home Daily Note.md";
const HOME_WIDGETS = { calendar: 'Calendar', continue: 'Continue', links: 'Pinned links', recent: 'Recent notes', shortcuts: 'Your places', youtrack: 'YouTrack' };
const HOME_MODULES = {calendar:'Calendar / Mail',youtrack:'YouTrack',slack:'Slack · Inbox'};
const DEFAULT_HOME_MODULES = ['calendar','youtrack','slack'];
const SLACK_SECRET = 'es-hub-slack-user';
const YOU_TRACK_SECRET = 'es-hub-youtrack';
const SLACK_FILTERS = {all:'All',dm:'DMs',mention:'@Me',channel:'#Notes',group:'@Group'};
const CALENDAR_SECRET = 'es-hub-google-ical';
const GOOGLE_SECRET = 'es-hub-google-oauth';
const YOU_TRACK_STATES = Object.freeze({backlog:'To do', 'in-progress':'In Progress', done:'Done'});
const NOTE_FIELDS = { board_column: "Status", priority: "Priority", category: "Type" };
const MANAGED_PROPERTIES = new Set(["completed_at", "completed_at_source"]);
const RESERVED_PROPERTIES = new Set(["__proto__", "constructor", "prototype", "position"]);
// A small built-in Lucide set, available in the supported Obsidian version.
// Folder names have no implied meaning: people choose their own Type icons.
const TYPE_ICONS = Object.freeze({folder:'Folder (default)',briefcase:'Briefcase','graduation-cap':'Graduation cap',user:'Person',
  'sticky-note':'Sticky note','flask-conical':'Flask',code:'Code','book-open':'Book',heart:'Heart',lightbulb:'Lightbulb',ticket:'Ticket',palette:'Palette'});
const PRIORITY_ICONS = Object.freeze({urgent:'alert-circle',high:'chevrons-up',medium:'equal',low:'chevron-down'});

class AIMultipleKanbanExtras extends Plugin {
  async repairInitialBoard() {
    const leaves=[]; this.app.workspace.iterateAllLeaves(leaf=>leaves.push(leaf));
    for (const leaf of leaves) {
      const view=leaf.view;
      if (!this.active || view?.file?.path!==BOARD_PATH || view.getViewType?.()!=='bases' ||
          view.containerEl?.querySelector?.('.obk-board') || !view.containerEl?.textContent?.includes('Unknown view type: kanban-view')) continue;
      const file=this.app.vault.getAbstractFileByPath(BOARD_PATH);
      if (!file || !leaf.setViewState || !leaf.openFile) continue;
      await leaf.setViewState({type:'empty'});
      if (this.active && leaf.view?.getViewType?.()==='empty') await leaf.openFile(file);
    }
  }

  get youtrackStates() { return this.youtrackProfile?.states || YOU_TRACK_STATES; }

  youtrackScope() { return this.youtrackProfile ? [this.youtrackProfile.host,this.youtrackProfile.project,this.youtrackProfile.login].join('|') : 'disconnected'; }

  validYouTrackId(id) { return validYouTrackId(id, this.youtrackProfile); }

  youtrackNoteMatches(file) {
    const fm = file && this.app.metadataCache.getFileCache(file)?.frontmatter;
    return !!fm && this.validYouTrackId(fm.youtrack_id) && fm.youtrack_url === `https://${this.youtrackProfile.host}/issue/${fm.youtrack_id}` && fm.youtrack_assignee === this.youtrackProfile.login;
  }

  restoreYouTrack() {
    try { this.youtrackProfile = parseYouTrackSecret(this.app.secretStorage?.getSecret?.(YOU_TRACK_SECRET))?.profile || null; }
    catch (_) { this.youtrackProfile = null; }
  }

  openYouTrackSetup() {
    if (this.youtrackModal) return;
    if (this.youtrackBusy || this.youtrackSetupBusy || this.youtrackImports.size || this.youtrackSyncJobs.size) { new Notice('Wait for the current YouTrack action to finish.'); return; }
    this.youtrackModal = new HomeYouTrackModal(this); this.youtrackModal.open();
  }

  async connectYouTrack(input, tokenInput) {
    if (!this.active || this.youtrackBusy || this.youtrackSetupBusy || this.youtrackImports.size || this.youtrackSyncJobs.size) throw Error('Wait for the current YouTrack action to finish.');
    const profile = normalizeYouTrackProfile(input);
    const storage = this.app.secretStorage;
    if (!storage?.getSecret || !storage?.setSecret) throw Error('Obsidian 1.11.4 or newer is required for Keychain.');
    const previous = parseYouTrackSecret(storage.getSecret(YOU_TRACK_SECRET));
    // A saved token must never be sent to a different server when editing the host.
    const token = validateYouTrackToken(tokenInput || (previous?.profile.host === profile.host ? previous.token : ''));
    const connection = {version:1,profile,token};
    this.youtrackSetupBusy = true;
    const revision = this.youtrackSetupRevision = (this.youtrackSetupRevision || 0) + 1;
    try {
      const snapshot = await this.runYouTrackReader(undefined, 'read', undefined, connection);
      if (!this.active || revision !== this.youtrackSetupRevision) throw Error('Connection cancelled.');
      if (!validYouTrackSnapshot(snapshot,profile)) throw Error('The returned account or issue list does not match this setup.');
      commitYouTrackSecret(storage,JSON.stringify(connection));
      const changed = !this.youtrackProfile || this.youtrackScope() !== [profile.host,profile.project,profile.login].join('|');
      this.youtrackProfile = profile; this.youtrackNextRefresh = Date.now() + 21600000;
      if (changed) {
        this.youtrackSyncResults.clear(); this.youtrackVerifiedIssues.clear(); this.observedYouTrack = new WeakMap();
        const scope=this.app.vault.adapter.getBasePath?.() || this.app.vault.getName?.() || 'vault';
        this.youtrackSyncKey='es-hub:youtrack-done:'+scope+':'+this.youtrackScope();
      }
      this.youtrackReadRevision++; this.youtrackSnapshot = snapshot; this.youtrackSnapshotError = ''; this.youtrackRefreshError = '';
      try { await this.persistYouTrackSnapshot(snapshot); }
      catch (_) { this.youtrackSnapshotError = 'Connected. The local snapshot could not be saved; try Refresh all widgets.'; }
      this.refreshHomes();
    } finally { this.youtrackSetupBusy = false; }
  }

  async disconnectYouTrack() {
    if (this.youtrackBusy || this.youtrackSetupBusy || this.youtrackImports.size || this.youtrackSyncJobs.size) throw Error('Wait for the current YouTrack action to finish.');
    commitYouTrackSecret(this.app.secretStorage,'');
    this.youtrackSetupRevision = (this.youtrackSetupRevision || 0) + 1;
    this.youtrackReadRevision++; this.youtrackNextRefresh=0; this.youtrackProfile=null; this.youtrackSnapshot=null;
    this.youtrackVerifiedIssues.clear(); this.youtrackSyncResults.clear();
    this.youtrackSnapshotError=''; this.youtrackRefreshError=''; this.youtrackImportMessage=''; this.refreshHomes();
    const file=`${this.manifest.dir}/youtrack-widget.json`;
    try { if (await this.app.vault.adapter.exists(file)) await this.app.vault.adapter.remove(file); }
    catch (_) { new Notice('Disconnected. The old local snapshot could not be removed.'); }
  }

  async onload() {
    const schemaText = await this.app.vault.adapter.read("Hub/_kanban/taxonomy.md");
    const schemaBlock = schemaText.match(/^```json\r?\n([\s\S]*?)\r?\n```/m);
    if (!schemaBlock) throw new Error("Missing JSON block in kanban taxonomy.md");
    this.taxonomy = JSON.parse(schemaBlock[1]);
    if (this.taxonomy.version !== 1 || !Array.isArray(this.taxonomy.columns) ||
        !Array.isArray(this.taxonomy.categories) || !Array.isArray(this.taxonomy.priorities) ||
        !this.taxonomy.folder_to_category || !this.taxonomy.view_to_folder ||
        !Array.isArray(this.taxonomy.excluded_folders) ||
        !Number.isInteger(this.taxonomy.wip_limit) || this.taxonomy.wip_limit < 1 ||
        typeof this.taxonomy.default_body !== "string") {
      throw new Error("Invalid kanban taxonomy.md");
    }
    const savedSettings = await this.loadData();
    this.typeIcons = typeIconsFromSettings(savedSettings);
    this.typeIconSaving = new Set();
    this.slackSources = {channel:'',group:''};
    this.youtrackProfile = null;
    this.restoreYouTrack();
    this.hiddenTagSuggestions = hiddenTagsFromSettings(savedSettings);
    this.homeCollapsed = savedSettings?.homeCollapsed === true;
    try { this.homeState = homeWorkspaceState(savedSettings); }
    catch (_) { this.homeState = homeWorkspaceState({}); this.homeStateError = 'Home settings need repair. Your saved settings have not been replaced.'; }
    this.homeWidgets = this.homeView().widgets; // Retained legacy settings; no longer rendered.
    this.homeModules = homeModuleSelection(savedSettings);
    const draftScope = this.app.vault.adapter.getBasePath?.() || this.app.vault.getName?.() || 'vault';
    this.quickDraftKey = 'es-hub:quick-draft:' + draftScope;
    try { this.quickDraftStorage = this.app.workspace.containerEl.ownerDocument.defaultView?.localStorage; } catch (_) {}
    this.homeHeightKey = 'es-hub:widget-height:' + draftScope;
    this.mailKey = 'es-hub:mail-enabled:' + draftScope;
    this.mailEnabled = false;
    try { this.mailEnabled = this.quickDraftStorage?.getItem(this.mailKey) === 'true'; } catch (_) {}
    this.mailSnapshot = null; this.mailBusy = false; this.mailError = ''; this.mailRevision = 0;
    this.mailNextRefresh = Date.now(); this.mailProcesses = new Set(); this.mailOpenBusy = false;
    this.homeWidgetHeight = null;
    try {
      const height = JSON.parse(this.quickDraftStorage?.getItem(this.homeHeightKey) || 'null');
      if (Number.isInteger(height) && height >= 300 && height <= 560) this.homeWidgetHeight = height;
    } catch (_) {} // A corrupt/blocked preference falls back to the usable default.
    this.quickDraft = {text:'',revision:0,busy:false,ready:false,error:'',lastSaved:'',pending:null};
    try {
      const saved = JSON.parse(this.quickDraftStorage?.getItem(this.quickDraftKey) || 'null');
      if (saved?.version === 1 && typeof saved.text === 'string' && saved.text.length <= 100000) {
        this.quickDraft.text = saved.text;
        if (quickNotePath(saved.lastSaved)) this.quickDraft.lastSaved = saved.lastSaved;
        if (quickNotePath(saved.pending?.path) && typeof saved.pending.text === 'string' && saved.pending.text.length <= 100000) this.quickDraft.pending = saved.pending;
      }
    } catch (_) { this.quickDraft.error = 'Could not restore the local draft. Keep this window open while writing.'; }
    this.homeCheckpoints = new Map();
    this.homeCheckpointJobs = new Map();
    this.homeModals = new Set();
    this.slackRevision = 0;
    this.slackConnected = false;
    this.slackBusy = false;
    this.slackError = '';
    this.slackSnapshot = null;
    this.slackAccount = null;
    this.slackRetryAt = 0;
    this.slackNameCache = new Map();
    this.slackNextRefresh = Date.now();
    this.slackTimer = null;
    this.calendarEnabled = savedSettings?.calendarEnabled === true;
    this.calendarSource = savedSettings?.calendarSource === 'google' ? 'google' : 'ical';
    this.googleToken = null;
    this.googleMonthFailures = new Set();
    this.calendarRevision = 0;
    this.calendarCache = null;
    this.calendarError = '';
    this.calendarBusy = false;
    this.calendarNextRefresh = 0;
    this.widgetsRefreshing = false;
    this.youtrackSnapshot = null;
    this.youtrackSnapshotError = '';
    this.youtrackRefreshError = '';
    this.youtrackBusy = false;
    this.youtrackNextRefresh = 0;
    this.youtrackImports = new Map();
    this.youtrackImportedFiles = new Map();
    this.youtrackDetailProcesses = new Set();
    this.youtrackDocHandlers = new Map();
    this.youtrackDrag = null;
    this.youtrackImportMessage = '';
    this.youtrackReadRevision = 0;
    this.youtrackSyncKey = 'es-hub:youtrack-done:' + draftScope + ':' + this.youtrackScope();
    this.youtrackSyncResults = new Map();
    this.youtrackSyncJobs = new Map();
    this.youtrackSyncRequests = new Map();
    this.youtrackVerifiedIssues = new Map();
    this.observedYouTrack = new WeakMap();
    this.youtrackSyncImports = new WeakMap();
    try {
      const saved = JSON.parse(this.quickDraftStorage?.getItem(this.youtrackSyncKey) || '[]');
      if (Array.isArray(saved)) for (const [id, value] of saved.slice(-100)) {
        if (this.validYouTrackId(id) && ['pending','done','synced','error','uncertain'].includes(value?.status) && Number.isFinite(value.at)) {
          const column = value.column ?? 'done'; // Read 0.20.0 receipts without replaying them.
          if (Object.hasOwn(this.youtrackStates, column)) this.youtrackSyncResults.set(id, {...value, column,
            status:value.status === 'pending' ? 'uncertain' : value.status === 'done' ? 'synced' : value.status});
        }
      }
    } catch (_) {} // Invalid recovery data never authorizes a remote write.
    this.dailyJobs = new Map();
    this.tagSuggestionSave = Promise.resolve();
    this.captureBusy = false;
    this.toolbars = new Map();
    this.boardExcerptCache = new WeakMap();
    this.noteToolbars = new Map();
    this.documents = new Map();
    this.completionJobs = new Map();
    this.typeChanges = new WeakSet();
    this.folderConversions = new WeakSet();
    this.preparedFolders = new WeakMap();
    this.noteDeletions = new WeakSet();
    this.observedColumns = new WeakMap();
    this.startedAt = Date.now();
    this.active = true;
    this.status = this.addStatusBarItem();
    this.status.addClass("aim-kanban-wip");
    this.registerDomEvent(this.status, "click", () => {
      const board = this.app.vault.getAbstractFileByPath("Hub/Kanban Board.base");
      if (board) void this.runAction(() => this.app.workspace.getLeaf(false).openFile(board));
    });
    this.attachDocument(this.app.workspace.containerEl.ownerDocument);
    this.registerEvent(this.app.workspace.on("window-open", (_workspaceWindow, win) => this.attachDocument(win.document)));
    this.registerEvent(this.app.workspace.on("window-close", (_workspaceWindow, win) => this.detachDocument(win.document)));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.syncToolbars()));
    this.registerEvent(this.app.workspace.on("file-open", () => { this.syncToolbars(); this.refreshHomes(); }));
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => this.onFileMenu(menu, file)));
    this.registerEvent(this.app.metadataCache.on("changed", (file, _data, cache) => {
      this.queueCompletion(file, cache, false);
      this.updateWip();
      this.refreshNoteToolbars(file);
      this.invalidateBoardNote(file);
      this.refreshHomes();
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      this.invalidateBoardNote(file);
      this.updateWip();
      this.refreshNoteToolbars(file.children !== undefined ? undefined : file);
      this.refreshHomes();
    }));
    this.registerEvent(this.app.vault.on("create", (file) => {
      this.refreshBoardTools();
      if (file.children !== undefined) this.refreshNoteToolbars();
      this.refreshHomes();
    }));
    this.registerEvent(this.app.vault.on("modify", file => this.invalidateBoardNote(file)));
    this.registerEvent(this.app.vault.on("rename", (file) => { this.invalidateBoardNote(file); this.syncNoteToolbars(); this.refreshNoteToolbars(); this.refreshHomes(); }));
    this.app.workspace.onLayoutReady(() => {
      if (!this.active) return;
      this.app.workspace.iterateAllLeaves((leaf) => this.attachDocument(leaf.view.containerEl.ownerDocument));
      this.syncToolbars();
      this.seedCompletion();
      const repairTimer=setTimeout(()=>{ void this.repairInitialBoard().catch(()=>new Notice('Open Hub/Kanban Board.base to reload the board.')); },0);
      this.register(()=>clearTimeout(repairTimer));
    });
    // Metadata may not yet be ready when layout is restored during startup.
    this.registerEvent(this.app.metadataCache.on("resolved", () => {
      this.seedCompletion();
      this.refreshNoteToolbars();
      this.refreshHomes();
    }));
    this.scheduleHomeRefresh();
    void this.loadQuickDraft();
    this.restoreSlack();
    this.scheduleSlackRefresh();
    this.scheduleMailRefresh();
    void this.loadYouTrackSnapshot().then(() => this.autoRefreshYouTrack());
    this.autoRefreshCalendar();
  }

  onunload() {
    this.active = false;
    this.mailRevision++; this.mailSnapshot = null; clearTimeout(this.mailTimer);
    for (const child of this.mailProcesses || []) child.kill('SIGKILL');
    this.mailProcesses?.clear(); this.mailModal?.close();
    this.youtrackSetupRevision = (this.youtrackSetupRevision || 0) + 1;
    this.youtrackModal?.close();
    this.slackRevision++;
    this.slackModal?.close();
    this.slackSnapshot = null;
    this.slackAccount = null;
    this.slackNameCache?.clear();
    clearTimeout(this.slackTimer); this.slackTimer = null;
    this.calendarRevision++;
    this.googleSession?.cancel();
    this.calendarModal?.close();
    for (const modal of this.homeModals || []) modal.close();
    this.homeCheckpoints?.clear();
    this.youtrackReadRevision++;
    this.youtrackProcess?.kill('SIGKILL');
    this.youtrackProcess = null;
    for (const child of this.youtrackDetailProcesses || []) child.kill('SIGKILL');
    this.clearYouTrackDrag();
    clearTimeout(this.homeTimer);
    this.homeTimer = null;
    for (const leaf of this.toolbars?.keys() ?? []) this.removeToolbar(leaf);
    for (const leaf of this.noteToolbars?.keys() ?? []) this.removeNoteToolbar(leaf);
    for (const doc of this.documents?.keys() ?? []) this.detachDocument(doc);
  }

  attachDocument(doc) {
    if (!doc || this.documents.has(doc)) return;
    const handler = (event) => {
      const target = event.target?.closest ? event.target : event.target?.parentElement;
      const issue = target?.closest('.aim-home-issue[data-youtrack-id]');
      if (issue) return this.onYouTrackMenu(issue, event);
      const card = target?.closest(CARD_SELECTOR);
      if (card) return this.onCardRightClick(card, event);
      const column = target?.closest(COLUMN_SELECTOR);
      if (column) this.onColumnRightClick(column, event);
    };
    doc.addEventListener("contextmenu", handler, true);
    this.documents.set(doc, handler);
    const dragHandlers = {
      dragover: event => this.handleYouTrackDragOver(event),
      drop: event => { void this.handleYouTrackDrop(event); },
      dragend: () => this.clearYouTrackDrag(),
    };
    for (const [name, callback] of Object.entries(dragHandlers)) doc.addEventListener(name, callback, true);
    this.youtrackDocHandlers.set(doc, dragHandlers);
  }

  detachDocument(doc) {
    for (const [leaf, entry] of this.noteToolbars ?? []) {
      if (entry.scope.ownerDocument === doc) this.removeNoteToolbar(leaf);
    }
    for (const [leaf, entry] of this.toolbars ?? []) {
      if (entry.scope.ownerDocument === doc) this.removeToolbar(leaf);
    }
    const handler = this.documents.get(doc);
    if (!handler) return;
    doc.removeEventListener("contextmenu", handler, true);
    for (const [name, callback] of Object.entries(this.youtrackDocHandlers.get(doc) || {})) doc.removeEventListener(name, callback, true);
    this.youtrackDocHandlers.delete(doc);
    if (this.youtrackDrag?.doc === doc) this.clearYouTrackDrag();
    this.documents.delete(doc);
  }

  async runAction(action) {
    try { return await action(); }
    catch (error) {
      console.error("[aimultiple-kanban-extras]", error);
      new Notice(`Kanban action failed: ${error.message || error}`);
      return false;
    }
  }

  // ---------- board toolbar: capture now, promote to a card later ----------

  syncToolbars() {
    if (!this.active) return;
    const live = new Set();
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.file?.path !== BOARD_PATH) return;
      live.add(leaf);
      const scope = leaf.view.containerEl;
      let entry = this.toolbars.get(leaf);
      if (entry?.scope !== scope) {
        this.removeToolbar(leaf);
        entry = { scope, toolbar: null };
        this.toolbars.set(leaf, entry);
        // Watch only this Bases leaf. Vendor fullRebuild() empties its container.
        entry.observer = new scope.ownerDocument.defaultView.MutationObserver(() => {
          if (leaf.view.file?.path !== BOARD_PATH) this.removeToolbar(leaf);
          else this.mountToolbar(entry);
        });
        entry.observer.observe(scope, { childList: true, subtree: true });
      }
      this.mountToolbar(entry);
    });
    for (const leaf of this.toolbars.keys()) if (!live.has(leaf)) this.removeToolbar(leaf);
    this.syncNoteToolbars();
  }

  removeToolbar(leaf) {
    const entry = this.toolbars.get(leaf);
    if (!entry) return;
    entry.observer.disconnect();
    this.clearBoardTools(entry);
    entry.calendarAnimation?.cancel();
    entry.resizeCancel?.();
    entry.homeResizeObserver?.disconnect();
    entry.toolbar?.remove();
    entry.home?.remove();
    entry.host?.classList.remove("aim-home-host");
    this.toolbars.delete(leaf);
  }

  mountToolbar(entry) {
    if (!this.active) return;
    const host = entry.scope.querySelector(".obk-view-container");
    if (!host) {
      this.clearBoardTools(entry);
      entry.calendarAnimation?.cancel();
      entry.resizeCancel?.();
      entry.homeResizeObserver?.disconnect();
      entry.resizeHost = null;
      entry.toolbar?.remove();
      entry.home?.remove();
      entry.host?.classList.remove("aim-home-host");
      entry.host = null;
      return;
    }
    if (entry.host !== host) { this.clearBoardTools(entry); entry.host?.classList.remove("aim-home-host"); }
    entry.host = host;
    host.classList.add("aim-home-host");
    if (!entry.toolbar) this.buildToolbar(entry);
    const backlogHeader = host.querySelector('.obk-column[data-column-value="backlog"] .obk-column-header');
    if (backlogHeader) {
      if (entry.toolbar.parentElement !== backlogHeader) backlogHeader.append(entry.toolbar);
    } else entry.toolbar.remove();
    if (!entry.home) this.buildHome(entry);
    if (host.firstElementChild !== entry.home) host.prepend(entry.home);
    this.mountBoardTools(entry);
    if (entry.resizeHost !== host) {
      entry.resizeCancel?.();
      entry.homeResizeObserver?.disconnect();
      entry.resizeHost = host;
      const Observer = entry.scope.ownerDocument.defaultView.ResizeObserver;
      if (Observer) {
        entry.homeResizeObserver = new Observer(() => { this.resizeQuickDraft(entry); this.applyHomeWidgetHeight(entry); });
        entry.homeResizeObserver.observe(host);
        entry.homeResizeObserver.observe(entry.homeHeading);
        entry.homeResizeObserver.observe(entry.config);
        if (entry.boardTools) entry.homeResizeObserver.observe(entry.boardTools);
      }
    }
    this.updateHome(entry);
    this.updateToolbar(entry);
  }

  buildToolbar(entry) {
    const doc = entry.scope.ownerDocument;
    const toolbar = doc.createElement("div");
    toolbar.className = "aim-kanban-toolbar";
    toolbar.setAttribute("role", "group");
    toolbar.setAttribute("aria-label", "Backlog quick capture");
    toolbar.addEventListener("pointerdown", event => event.stopPropagation());
    entry.toolbar = toolbar;

    // Every action is one visible button; future actions can join this list.
    const actions = [
      { label: "Add note", title: "Add note to backlog", run: () => this.createBacklogNote() },
    ];
    entry.buttons = actions.map((action, index) => {
      const button = doc.createElement("button");
      button.type = "button";

      button.textContent = action.label;
      button.title = action.title;
      button.setAttribute("aria-label", action.title);
      button.addEventListener("click", event => { event.stopPropagation(); void this.runAction(action.run); });
      toolbar.append(button);
      return button;
    });
  }

  updateToolbar(entry) {
    if (!entry.toolbar) return;
    for (const button of entry.buttons) button.disabled = this.captureBusy;
  }

  // Display-only enhancements on the managed Base; preserve its query and card order.
  typeIcon(type) {
    return Object.hasOwn(this.typeIcons, type) ? this.typeIcons[type] : 'folder';
  }

  async setTypeIcon(type, icon) {
    if (!this.active) throw Error('The dashboard was closed.');
    if (!Object.hasOwn(TYPE_ICONS, icon)) throw Error('Choose an icon from the list.');
    const folder = this.app.vault.getAbstractFileByPath('Hub/' + type);
    if (!folder?.children || !this.categoryValues().includes(type)) throw Error('This Type folder no longer exists. Reopen Customize.');
    if (this.typeIconSaving.has(type)) throw Error('Wait for this icon to finish saving.');
    const expected = this.typeIcon(type);
    this.typeIconSaving.add(type); this.refreshHomes();
    const job = this.tagSuggestionSave.then(async () => {
      const settings = await this.loadData() || {};
      if (!this.active) throw Error('The dashboard was closed.');
      if (this.app.vault.getAbstractFileByPath('Hub/' + type) !== folder || !this.categoryValues().includes(type))
        throw Error('The Type folder changed. Reopen Customize.');
      const current = typeIconsFromSettings(settings);
      if ((Object.hasOwn(current,type) ? current[type] : 'folder') !== expected)
        throw Error('Type icons changed elsewhere. Reload the hub before trying again.');
      const next = {...current};
      if (icon === 'folder') delete next[type]; else next[type] = icon;
      await this.saveData({...settings,typeIcons:next});
      if (this.active) this.typeIcons = next;
    });
    this.tagSuggestionSave = job.catch(() => {});
    try { await job; }
    finally {
      this.typeIconSaving.delete(type);
      this.refreshHomes(); this.refreshBoardTools(); this.refreshNoteToolbars();
    }
  }

  updateTypeIconControls(entry) {
    if (!entry.typeIconRows) return;
    const types = this.categoryValues(), signature = JSON.stringify(types);
    const doc = entry.scope.ownerDocument;
    if (entry.typeIconSignature !== signature) {
      entry.typeIconRows.replaceChildren(); entry.typeIconInputs = new Map();
      for (const type of types) {
        const row = homeElement(doc,'label','aim-type-icon-row');
        const icon = hubIcon(doc,this.typeIcon(type));
        const name = homeElement(doc,'span','aim-type-icon-name',type);
        const select = doc.createElement('select'); select.setAttribute('aria-label','Icon for ' + type);
        for (const [value,label] of Object.entries(TYPE_ICONS)) {
          const option = doc.createElement('option'); option.value = value; option.textContent = label; select.append(option);
        }
        select.addEventListener('change', () => {
          const value = select.value;
          homeText(entry.typeIconMessage,'Saving…');
          void this.setTypeIcon(type,value).then(() => homeText(entry.typeIconMessage,'Icon saved.'))
            .catch(error => homeText(entry.typeIconMessage,error.message || 'Could not save the icon. Try again.'));
        });
        row.append(icon,name,select); entry.typeIconRows.append(row);
        entry.typeIconInputs.set(type,{icon,select});
      }
      entry.typeIconSignature = signature;
    }
    for (const [type,{icon,select}] of entry.typeIconInputs) {
      const value = this.typeIcon(type);
      if (icon.getAttribute('data-icon') !== value) { setIcon(icon,value); icon.setAttribute('data-icon',value); }
      select.value = value; select.disabled = this.typeIconSaving.has(type);
    }
  }

  boardNextStep(text) {
    let section = false, depth = 0, fence = '';
    for (const line of boardBody(text).slice(0, 128000).replace(/<!--[\s\S]*?-->/g,'').split(/\r?\n/)) {
      const marker = line.trim().match(/^(\x60{3,}|~{3,})/);
      if (marker) { if (!fence) fence = marker[1][0]; else if (fence === marker[1][0]) fence = ''; continue; }
      if (fence) continue;
      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        if (section && heading[1].length <= depth) break;
        if (/^(sonraki ad[ıi]m|next step)$/i.test(boardPlainText(heading[2]))) { section = true; depth = heading[1].length; }
        continue;
      }
      if (!section || /^\s*(?:<!--|!?\[\^)/.test(line)) continue;
      const value = boardPlainText(line.replace(/^\s*(?:[-*+]|\d+[.)])\s*(?:\[[ xX]\]\s*)?/, ''));
      if (value && !/^[-–—.…\s]+$/.test(value)) return value.length > 180 ? value.slice(0,179) + '…' : value;
    }
    return '';
  }

  boardCardModel(file, title) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const stored = this.categoryValue(fm.category);
    const type = this.categoryValues().includes(stored) ? stored : this.inferCategoryFromFolder(file.parent?.path || '') || '';
    const priority = typeof fm.priority === 'string' ? fm.priority : '';
    return {
      title: title || (typeof fm.youtrack_title === 'string' && fm.youtrack_title) || file.basename,
      path: file.path, type, typeIcon:this.typeIcon(type), priority: priority.replace(/^./, c => c.toUpperCase()),
      priorityValue: this.taxonomy.priorities.includes(priority) ? priority : '',
      id: typeof fm.youtrack_id === 'string' ? fm.youtrack_id : '',
      stale: fm.board_column !== 'done' && Date.now() - file.stat.mtime > 30 * 86400000,
    };
  }

  boardCardMatches(model, query = '', type = '') {
    if (type && model.type !== type) return false;
    const haystack = boardSearchText([model.title,model.path,model.id,model.type].join(' '));
    return boardSearchText(query).split(/\s+/).filter(Boolean).every(word => haystack.includes(word));
  }

  invalidateBoardNote(file) {
    if (file) this.boardExcerptCache?.delete(file);
    this.refreshBoardTools();
    for (const entry of this.toolbars.values()) {
      if (entry.boardPreview?.file === file) entry.boardPreview.refresh();
    }
  }

  async loadBoardExcerpt(file) {
    if (!this.active || this.app.vault.getAbstractFileByPath(file.path) !== file) return null;
    const key = boardFileStamp(file);
    const previous = this.boardExcerptCache.get(file);
    if (previous?.key === key) return previous.promise;
    const record = {key};
    this.boardExcerptCache.set(file,record);
    record.promise = (async () => {
      const text = file.stat.size > 1024 * 1024 ? '' : await this.app.vault.cachedRead(file);
      if (!this.active || this.boardExcerptCache.get(file) !== record || boardFileStamp(file) !== key ||
          this.app.vault.getAbstractFileByPath(file.path) !== file) return null;
      return this.boardNextStep(text);
    })().catch(() => null);
    return record.promise;
  }

  async readBoardPreview(file) {
    const path = file.path;
    if (!this.active || this.app.vault.getAbstractFileByPath(path) !== file) throw Error('Note not found.');
    if (file.stat.size > 2 * 1024 * 1024) throw Error('This note is too large to preview. Use Open note.');
    const body = boardBody(await this.app.vault.cachedRead(file));
    if (!this.active || file.path !== path || this.app.vault.getAbstractFileByPath(path) !== file) throw Error('The note changed or could not be found.');
    return {body:body.slice(0,50000),truncated:body.length > 50000};
  }

  refreshBoardTools() {
    if (!this.active) return;
    for (const entry of this.toolbars.values()) this.mountBoardTools(entry);
  }

  clearBoardTools(entry) {
    entry.boardPreview?.close();
    entry.boardPopover?.close();
    for (const card of entry.boardCards?.keys() || []) {
      card.classList.remove('aim-card-managed','aim-card-filtered');
      card.querySelector('.aim-card-details')?.remove();
    }
    entry.boardCards = new Map();
    entry.boardTools?.remove();
    entry.boardTools = null;
  }

  mountBoardTools(entry) {
    const board = entry.host?.querySelector('.obk-board');
    if (!board || !this.active) return;
    const doc = entry.scope.ownerDocument;
    if (!entry.boardTools) {
      entry.boardCards = new Map();
      const row = entry.boardTools = doc.createElement('div');
      row.className = 'aim-board-tools';
      row.setAttribute('role','search'); row.setAttribute('aria-label','Filter board cards');
      const search = entry.boardSearch = doc.createElement('input');
      search.type = 'search'; search.placeholder = 'Search cards…';
      search.setAttribute('aria-label','Search cards'); search.title = 'Search card titles, paths and issue IDs';
      search.value = entry.boardQuery || '';
      const type = entry.boardTypeSelect = doc.createElement('select');
      type.setAttribute('aria-label','Filter by Type');
      const clear = entry.boardClear = doc.createElement('button');
      clear.type = 'button'; clear.textContent = 'Clear'; clear.setAttribute('aria-label','Clear card filters');
      const count = entry.boardCount = doc.createElement('span');
      count.className = 'aim-board-count'; count.setAttribute('role','status'); count.setAttribute('aria-live','polite');
      search.addEventListener('input', () => { entry.boardQuery = search.value; this.filterBoardCards(entry); });
      search.addEventListener('keydown', event => {
        if (event.key === 'Escape' && search.value) { event.preventDefault(); event.stopPropagation(); search.value = ''; entry.boardQuery = ''; this.filterBoardCards(entry); }
      });
      type.addEventListener('change', () => { entry.boardType = type.value; this.filterBoardCards(entry); });
      clear.addEventListener('click', () => {
        entry.boardQuery = ''; entry.boardType = ''; search.value = ''; type.value = '';
        this.filterBoardCards(entry); search.focus();
      });
      const searchLabel = doc.createElement('label'); searchLabel.className = 'aim-board-search-field';
      searchLabel.append(hubIcon(doc,'search'),search);
      row.append(searchLabel,type,clear,count);
      entry.boardTypeSignature = null;
    }
    if (entry.home.nextElementSibling !== entry.boardTools) entry.home.after(entry.boardTools);
    const types = this.categoryValues(), signature = JSON.stringify(types);
    if (entry.boardTypeSignature !== signature) {
      const select = entry.boardTypeSelect;
      select.replaceChildren();
      for (const value of ['', ...types]) {
        const option = doc.createElement('option'); option.value = value; option.textContent = value || 'All types'; select.append(option);
      }
      if (!types.includes(entry.boardType)) entry.boardType = '';
      select.value = entry.boardType || '';
      entry.boardTypeSignature = signature;
    }
    const live = new Set();
    for (const card of board.querySelectorAll(CARD_SELECTOR)) {
      if (card.matches('.sortable-ghost,.sortable-fallback,.sortable-drag,.obk-card-ghost,.obk-card-dragging')) { live.add(card); continue; }
      const file = this.app.vault.getAbstractFileByPath(card.getAttribute('data-entry-path'));
      if (!(file instanceof TFile) || file.extension !== 'md') continue;
      live.add(card);
      let state = entry.boardCards.get(card);
      if (state && (state.file !== file || !card.contains(state.details))) {
        state.details.remove(); entry.boardCards.delete(card); state = null;
      }
      if (!state) {
        const details = doc.createElement('div'); details.className = 'aim-card-details';
        const summary = doc.createElement('p'); summary.className = 'aim-card-summary'; summary.hidden = true;
        const footer = doc.createElement('div'); footer.className = 'aim-card-footer';
        const chips = doc.createElement('div'); chips.className = 'aim-card-chips';
        const preview = doc.createElement('button'); preview.type = 'button'; preview.className = 'aim-card-preview';
        preview.append(hubIcon(doc,'eye'),doc.createTextNode('Preview'));
        preview.setAttribute('aria-haspopup','dialog'); preview.setAttribute('aria-expanded','false');
        footer.append(chips,preview); details.append(summary,footer); card.append(details);
        state = {file,details,summary,chips,preview}; entry.boardCards.set(card,state);
        for (const name of ['pointerdown','mousedown','click','dblclick','auxclick']) footer.addEventListener(name, e => e.stopPropagation());
        footer.addEventListener('mouseover', e => e.stopPropagation());
        preview.addEventListener('click', () => {
          if (entry.boardPreview?.file === file) { entry.boardPreview.close(true); return; }
          entry.boardPreview?.close();
          entry.boardPreview = new BoardNotePreview(this,entry,file,preview);
          entry.boardPreview.open();
        });
        card.classList.add('aim-card-managed');
      }
      const model = this.boardCardModel(file,card.querySelector('.obk-card-title')?.textContent);
      const modelKey = JSON.stringify(model);
      if (state.modelKey !== modelKey) {
        state.model = model; state.modelKey = modelKey;
        state.preview.setAttribute('aria-label','Preview ' + model.title);
        state.chips.replaceChildren();
        for (const [key,label] of [['priority',model.priority],['category',model.type]]) {
          if (!label) continue;
          const chip = doc.createElement('button'); chip.type = 'button'; chip.className = 'aim-card-chip';
          const icon = key === 'category' ? model.typeIcon : PRIORITY_ICONS[model.priorityValue];
          if (icon) chip.append(hubIcon(doc,icon, key === 'priority' ? 'aim-card-priority-icon' : ''));
          chip.append(homeElement(doc,'span','aim-card-chip-label',label)); chip.dataset.property = key;
          if (key === 'priority' && model.priorityValue) chip.dataset.priority = model.priorityValue;
          chip.title = key === 'category' ? 'Type: ' + label + '. Choosing a Type moves this note to its Hub folder.' : 'Priority: ' + label;
          chip.setAttribute('aria-label',NOTE_FIELDS[key] + ': ' + label);
          chip.setAttribute('aria-haspopup','dialog'); chip.setAttribute('aria-expanded','false');
          chip.addEventListener('click', () => {
            if (entry.boardPopover?.anchor === chip) { entry.boardPopover.close(true); return; }
            entry.boardPopover?.close();
            const picker = entry.boardPopover = new NotePropertyPopover(this,chip,file,key);
            picker.onClose = () => { if (entry.boardPopover === picker) entry.boardPopover = null; };
            picker.open();
          });
          state.chips.append(chip);
        }
        if (model.stale) { const stale = doc.createElement('span'); stale.className = 'aim-card-stale'; stale.textContent = 'Stale'; stale.title = 'No note edits in the last 30 days'; state.chips.append(stale); }
      }
      const excerptKey = boardFileStamp(file);
      const cached = this.boardExcerptCache.get(file);
      if (state.excerptKey !== excerptKey || state.excerptRecord !== cached) {
        state.excerptKey = excerptKey;
        const job = this.loadBoardExcerpt(file);
        state.excerptRecord = this.boardExcerptCache.get(file);
        const record = state.excerptRecord;
        void job.then(value => {
          if (!this.active || !card.isConnected || entry.boardCards.get(card) !== state || state.excerptRecord !== record) return;
          homeText(state.summary,value || ''); state.summary.hidden = !value;
        });
      }
    }
    for (const [card,state] of entry.boardCards) if (!live.has(card)) {
      card.classList.remove('aim-card-managed','aim-card-filtered'); state.details.remove(); entry.boardCards.delete(card);
    }
    if (entry.boardPopover && !entry.boardPopover.anchor.isConnected) entry.boardPopover.close();
    if (entry.boardPreview) {
      const replacement = [...entry.boardCards.values()].find(s => s.file === entry.boardPreview.file);
      if (!replacement) entry.boardPreview.close();
      else entry.boardPreview.setAnchor(replacement.preview);
    }
    this.filterBoardCards(entry);
  }

  filterBoardCards(entry) {
    if (!entry.boardTools) return;
    let shown = 0;
    for (const [card,state] of entry.boardCards) {
      const visible = this.boardCardMatches(state.model,entry.boardQuery,entry.boardType);
      card.classList.toggle('aim-card-filtered',!visible);
      if (visible) shown++;
    }
    const total = entry.boardCards.size;
    const filtered = !!(entry.boardQuery?.trim() || entry.boardType);
    homeText(entry.boardCount, filtered ? shown + ' of ' + total + ' cards' + (shown ? '' : ' · No matches') : total + ' cards');
    entry.boardClear.hidden = !filtered;
  }

  refreshToolbars() {
    if (!this.active) return;
    for (const entry of this.toolbars.values()) this.updateToolbar(entry);
  }

  setBoardControlsVisible(entry, visible) {
    entry.boardControlsVisible = !!visible;
    entry.home.classList.toggle('aim-home-board-controls-open', entry.boardControlsVisible);
    homeText(entry.boardControlsLabel, entry.boardControlsVisible ? 'Hide board controls' : 'Show board controls');
    entry.boardControlsToggle.setAttribute('aria-pressed', String(entry.boardControlsVisible));
  }

  // ---------- local daily home; optional read-only Google feed, no remote embeds ----------

  homeWidgetBounds(entry) {
    const win = entry.scope.ownerDocument.defaultView;
    const padding = node => {
      const style = win?.getComputedStyle?.(node);
      return (parseFloat(style?.paddingTop) || 0) + (parseFloat(style?.paddingBottom) || 0);
    };
    const heading = Math.max(0, entry.homeGrid.getBoundingClientRect().top - entry.home.getBoundingClientRect().top);
    // Keep the established board minimum; very short panels scroll instead of crushing either region.
    const available = entry.host?.clientHeight || 0;
    const scrollbar = Math.max(0, (entry.homeGrid.offsetHeight || 0) - (entry.homeGrid.clientHeight || 0));
    const filters = entry.boardTools?.getBoundingClientRect().height || 0;
    const max = available ? Math.max(300, Math.min(560, Math.floor(available - padding(entry.host) - heading - padding(entry.homeGrid) - scrollbar - filters - 16 - 380))) : 560;
    return {min:300, max};
  }

  applyHomeWidgetHeight(entry, preview) {
    if (!this.active || !entry.home?.isConnected || !entry.homeResize) return;
    const hidden = this.homeCollapsed || !this.homeModules.length;
    entry.homeResize.hidden = hidden;
    if (hidden) { entry.resizeCancel?.(); return; }
    const {min,max} = this.homeWidgetBounds(entry);
    const height = Math.max(min, Math.min(max, preview ?? entry.resizePreview ?? this.homeWidgetHeight ?? 360));
    entry.effectiveWidgetHeight = height;
    const value = `${height}px`;
    if (entry.home.style.getPropertyValue('--aim-home-widget-height') !== value) entry.home.style.setProperty('--aim-home-widget-height', value);
    entry.homeResize.setAttribute('aria-valuemin', String(min));
    entry.homeResize.setAttribute('aria-valuemax', String(max));
    entry.homeResize.setAttribute('aria-valuenow', String(height));
    entry.homeResize.setAttribute('aria-valuetext', `${height} pixels`);
  }

  setHomeWidgetHeight(height) {
    if (height !== null && (!Number.isInteger(height) || height < 300 || height > 560)) throw Error('Invalid widget height.');
    try {
      if (!this.quickDraftStorage) throw Error('Storage unavailable');
      if (height === null) this.quickDraftStorage.removeItem(this.homeHeightKey);
      else this.quickDraftStorage.setItem(this.homeHeightKey, JSON.stringify(height));
    } catch (_) {
      for (const entry of this.toolbars.values()) this.applyHomeWidgetHeight(entry);
      throw Error('Could not save widget height on this Mac. The previous height was restored.');
    }
    this.homeWidgetHeight = height;
    for (const entry of this.toolbars.values()) this.applyHomeWidgetHeight(entry);
  }

  homeResizeKey(entry, event) {
    const {min,max} = this.homeWidgetBounds(entry);
    this.applyHomeWidgetHeight(entry);
    let height;
    if (event.key === 'ArrowUp') height = entry.effectiveWidgetHeight - 20;
    else if (event.key === 'ArrowDown') height = entry.effectiveWidgetHeight + 20;
    else if (event.key === 'Home') height = min;
    else if (event.key === 'End') height = max;
    else if (event.key === 'Enter') height = null;
    else return;
    event.preventDefault(); event.stopPropagation();
    this.setHomeWidgetHeight(height === null ? null : Math.max(min, Math.min(max,height)));
  }

  startHomeResize(entry, event) {
    if (!this.active || event.button !== 0 || this.homeCollapsed || !this.homeModules.length) return;
    this.homeResizeEntry?.resizeCancel?.();
    this.applyHomeWidgetHeight(entry);
    event.preventDefault(); event.stopPropagation(); entry.homeResize.focus();
    const doc = entry.scope.ownerDocument, win = doc.defaultView;
    const start = entry.effectiveWidgetHeight, startY = event.clientY, pointer = event.pointerId;
    this.homeResizeEntry = entry;
    entry.home.classList.toggle('aim-home-resizing', true);
    const move = next => {
      if (next.pointerId !== pointer) return;
      next.preventDefault();
      const {min,max} = this.homeWidgetBounds(entry);
      entry.resizePreview = Math.max(min,Math.min(max,Math.round(start + next.clientY - startY)));
      this.applyHomeWidgetHeight(entry);
    };
    const finish = commit => {
      const height = entry.resizePreview;
      entry.resizeCancel = null; entry.resizePreview = undefined;
      if (this.homeResizeEntry === entry) this.homeResizeEntry = null;
      doc.removeEventListener('pointermove',move,true); doc.removeEventListener('pointerup',up,true);
      doc.removeEventListener('pointercancel',cancel,true); doc.removeEventListener('keydown',escape,true);
      win?.removeEventListener?.('blur',cancel);
      entry.homeResize.removeEventListener('lostpointercapture',cancel);
      try { entry.homeResize.releasePointerCapture(pointer); } catch (_) {}
      entry.home.classList.toggle('aim-home-resizing',false);
      if (commit && height !== undefined && height !== start && this.active) {
        void this.runAction(() => this.setHomeWidgetHeight(height));
      } else this.applyHomeWidgetHeight(entry);
    };
    const up = next => { if (next.pointerId === pointer) finish(true); };
    const cancel = () => finish(false);
    const escape = next => { if (next.key === 'Escape') { next.preventDefault(); next.stopPropagation(); finish(false); } };
    entry.resizeCancel = cancel;
    doc.addEventListener('pointermove',move,true); doc.addEventListener('pointerup',up,true);
    doc.addEventListener('pointercancel',cancel,true); doc.addEventListener('keydown',escape,true);
    win?.addEventListener?.('blur',cancel);
    entry.homeResize.addEventListener('lostpointercapture',cancel);
    try { entry.homeResize.setPointerCapture(pointer); } catch (_) {}
  }

  buildHome(entry) {
    const doc = entry.scope.ownerDocument;
    const el = (tag, cls, text) => homeElement(doc, tag, cls, text);
    const button = (label, action, cls = '') => {
      const node = el('button', cls, label); node.type = 'button';
      node.addEventListener('click', () => { void this.runAction(action); });
      return node;
    };
    entry.home = el('section', 'aim-home');
    entry.home.setAttribute('aria-label', 'Daily home');
    const header = el('div', 'aim-home-heading');
    entry.homeHeading = header;
    const heading = el('div', 'aim-home-title');
    heading.append(el('h2', '', 'Home'));
    entry.homeDate = el('span', 'aim-home-date'); heading.append(entry.homeDate);
    entry.homeToggle = button('Hide widgets', () => this.setHomeCollapsed(!this.homeCollapsed), 'aim-home-text-button');
    const headerActions = el('div', 'aim-home-heading-actions');
    entry.customize = button('Customize', () => {
      entry.config.hidden = !entry.config.hidden;
      entry.customize.setAttribute('aria-expanded', String(!entry.config.hidden));
    }, 'aim-home-text-button');
    entry.customize.setAttribute('aria-expanded', 'false');
    entry.customize.prepend(hubIcon(doc,'sliders-horizontal'));
    entry.widgetsRefresh = button('', () => this.refreshAllWidgets(), 'aim-home-text-button');
    entry.widgetsRefresh.append(hubIcon(doc,'refresh-cw'));
    entry.widgetsRefreshLabel = el('span','','Refresh all widgets'); entry.widgetsRefresh.append(entry.widgetsRefreshLabel);
    entry.widgetsRefresh.title = 'Refresh all connected widgets, including the inactive Calendar or Mail tab. Auto: YouTrack 6h; Calendar and Mail 10m; Slack 5m.';
    headerActions.append(entry.customize, entry.widgetsRefresh);
    header.append(heading, headerActions);
    entry.config = el('div', 'aim-home-config'); entry.config.hidden = true;
    entry.config.append(entry.homeToggle);
    entry.moduleToggles = {};
    for (const [id, label] of Object.entries(HOME_MODULES)) {
      const toggle = button(label, () => this.setHomeModule(id, !this.homeModules.includes(id)));
      entry.moduleToggles[id] = toggle; entry.config.append(toggle);
    }
    entry.boardControlsToggle = button('', () => this.setBoardControlsVisible(entry, !entry.boardControlsVisible), 'aim-home-board-controls-toggle');
    entry.boardControlsLabel = entry.boardControlsToggle;
    entry.config.append(entry.boardControlsToggle);
    const typeSettings = el('details','aim-type-icon-settings');
    typeSettings.append(el('summary','','Type icons'));
    typeSettings.append(el('p','aim-type-icon-help','Choose an icon for each Type. Labels stay visible. Unconfigured folders use the default folder icon.'));
    entry.typeIconRows = el('div','aim-type-icon-rows');
    entry.typeIconMessage = el('p','aim-type-icon-message'); entry.typeIconMessage.setAttribute('role','status');
    typeSettings.append(entry.typeIconRows,entry.typeIconMessage); entry.config.append(typeSettings);
    this.updateTypeIconControls(entry);
    this.setBoardControlsVisible(entry, false);
    entry.homeGrid = el('div', 'aim-home-grid');
    entry.homeResize = el('div', 'aim-home-resize');
    entry.homeResize.tabIndex = 0;
    entry.homeResize.setAttribute('role','separator');
    entry.homeResize.setAttribute('aria-orientation','horizontal');
    entry.homeResize.setAttribute('aria-label','Resize widgets');
    entry.homeResize.title = 'Drag to resize widgets. Double-click to reset.';
    entry.homeResize.addEventListener('pointerdown', event => this.startHomeResize(entry,event));
    entry.homeResize.addEventListener('keydown', event => { void this.runAction(() => this.homeResizeKey(entry,event)); });
    entry.homeResize.addEventListener('dblclick', () => { void this.runAction(() => this.setHomeWidgetHeight(null)); });
    entry.home.append(header, entry.config, entry.homeGrid, entry.homeResize);
    entry.widgets = {};
    const tile = (cls, label) => {
      const node = el('section', `aim-home-tile ${cls}`);
      node.setAttribute('aria-label', label); entry.homeGrid.append(node); return node;
    };
    const calendar = tile('aim-home-calendar-tile', 'Calendar and Mail');
    entry.widgets.calendar = calendar;
    entry.homePanel = 'calendar';
    entry.panelScroll = {};
    const panelId = `aim-home-panel-${this.homePanelSequence = (this.homePanelSequence || 0) + 1}`;
    const mainHead = el('div','aim-home-inbox-heading aim-widget-header');
    const mainTabs = el('div','aim-home-inbox-tabs');
    mainTabs.setAttribute('role','tablist'); mainTabs.setAttribute('aria-label','Calendar and Mail');
    for (const [id,label] of [['calendar','Calendar'],['mail','Mail']]) {
      const control = button(label,() => this.setHomePanel(entry,id));
      control.prepend(hubIcon(doc,id === 'calendar' ? 'calendar-days' : 'mail'));
      control.id = `${panelId}-${id}-tab`; control.setAttribute('role','tab');
      control.setAttribute('aria-controls',`${panelId}-${id}`);
      control.addEventListener('keydown',event => {
        if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const next = event.key === 'Home' ? 'calendar' : event.key === 'End' ? 'mail' : id === 'calendar' ? 'mail' : 'calendar';
        this.setHomePanel(entry,next); entry[`${next}MainTab`].focus();
      });
      entry[`${id}MainTab`] = control; mainTabs.append(control);
      const panel = el('div',`aim-home-shared-panel aim-home-${id}-panel`);
      panel.id = `${panelId}-${id}`; panel.setAttribute('role','tabpanel');
      panel.setAttribute('aria-labelledby',control.id); panel.tabIndex = 0;
      entry[`${id}Panel`] = panel;
    }
    mainHead.append(mainTabs);
    calendar.append(mainHead,entry.calendarPanel,entry.mailPanel);
    const calendarHead = el('div', 'aim-home-calendar-toolbar');
    entry.monthLabel = el('h3');
    const monthActions = el('div', 'aim-home-month-actions');
    for (const [label, icon, action] of [
      ['Previous month', 'chevron-left', () => this.shiftHomeCalendar(entry, -1)],
      ['Today', null, () => { entry.selectedDay = homeDay(new Date()); entry.calendarMonth = entry.selectedDay.slice(0, 7); this.updateHome(entry); }],
      ['Next month', 'chevron-right', () => this.shiftHomeCalendar(entry, 1)],
    ]) {
      const control = button(icon ? '' : label, action, icon ? 'aim-home-icon-button' : 'aim-home-text-button');
      control.setAttribute('aria-label', label); control.title = label;
      if (icon) setIcon(control, icon);
      if (icon === 'chevron-left') entry.calendarPrevious = control;
      if (icon === 'chevron-right') entry.calendarNext = control;
      monthActions.append(control);
    }
    calendarHead.append(entry.monthLabel, monthActions);
    entry.calendarDays = el('div', 'aim-home-calendar');
    entry.calendarDays.setAttribute('role', 'group');
    entry.calendarDays.setAttribute('aria-label', 'Choose a date to see meetings');
    entry.calendarMode = 'month';
    const tabs = el('div', 'aim-home-calendar-tabs aim-widget-controls');
    entry.monthTab = button('Month', () => { entry.calendarMode = 'month'; this.updateHome(entry); });
    entry.agendaTab = button('Agenda', () => { entry.calendarMode = 'agenda'; this.updateHome(entry); });
    tabs.append(entry.monthTab, entry.agendaTab);
    entry.agenda = el('div', 'aim-home-agenda');
    entry.calendarConnect = button('Connect Google Calendar', () => this.openCalendarSetup(), 'aim-home-text-button');
    entry.calendarStatus = el('span','aim-home-caption'); entry.calendarStatus.setAttribute('role','status');
    entry.calendarFooter = homeWidgetFooter(doc, [entry.calendarConnect], entry.calendarStatus, 'aim-home-calendar-footer');
    const calendarBody = el('div','aim-widget-body aim-widget-calendar-body');
    calendarBody.append(calendarHead, entry.calendarDays, entry.agenda);
    entry.calendarPanel.append(tabs, calendarBody, entry.calendarFooter);

    entry.scratchBar = el('section','aim-home-scratch-bar');
    entry.scratchBar.setAttribute('aria-label','Scratchpad');
    entry.scratchInput = el('textarea','aim-home-scratch-input');
    entry.scratchInput.setAttribute('aria-label','Scratchpad'); entry.scratchInput.rows = 1;
    entry.scratchInput.placeholder = 'Write a quick note…'; entry.scratchInput.maxLength = 100000;
    entry.scratchInput.addEventListener('input', () => this.editQuickDraft(entry.scratchInput.value));
    entry.scratchStatus = el('span','aim-home-caption aim-home-scratch-status'); entry.scratchStatus.setAttribute('role','status');
    entry.scratchSave = button('Save', () => this.saveQuickDraft(),'aim-home-primary');
    entry.scratchSave.setAttribute('aria-label','Save to Quick Notes');
    entry.scratchOpen = button('Open latest note', () => this.openHomeFile(this.app.vault.getAbstractFileByPath(this.quickDraft.lastSaved)),'aim-home-text-button');
    const scratchActions = el('div','aim-home-scratch-actions');
    scratchActions.append(entry.scratchOpen,entry.scratchSave);
    entry.scratchBar.append(entry.scratchInput,scratchActions,entry.scratchStatus);
    header.insertBefore(entry.scratchBar,headerActions);

    const youtrack = tile('aim-home-youtrack-tile', 'Your YouTrack issues');
    entry.widgets.youtrack = youtrack;
    const youtrackHead = el('div', 'aim-home-tile-heading aim-widget-header');
    const youtrackTitle = el('h3', '', 'YouTrack'); youtrackTitle.prepend(hubIcon(doc,'list-todo'));
    youtrackHead.append(youtrackTitle);
    entry.youtrackCount = el('span', 'aim-home-caption'); youtrackHead.append(entry.youtrackCount);
    entry.youtrackList = el('div', 'aim-home-youtrack-list');
    entry.youtrackStatus = el('span', 'aim-home-caption');
    entry.youtrackMessage = el('p', 'aim-home-empty');
    entry.youtrackMessage.setAttribute('role', 'status');
    entry.youtrackMessage.hidden = true;
    const youtrackFilters = el('div','aim-widget-controls aim-home-youtrack-filters');
    youtrackFilters.setAttribute('aria-label','Filter YouTrack issues');
    entry.youtrackFilter = 'backlog'; entry.youtrackFilters = new Map();
    for (const [id,label] of [['backlog','To do'],['in-progress','In progress'],['done','Done'],['other','Other']]) {
      const control = button(label,() => { entry.youtrackFilter = id; this.updateYouTrackWidget(entry); },'aim-home-text-button');
      entry.youtrackFilters.set(id,control); youtrackFilters.append(control);
    }
    const source = el('a', 'aim-home-calendar-link', 'Open YouTrack');
    source.href = this.youtrackProfile ? `https://${this.youtrackProfile.host}/issues` : '#';
    source.hidden = !this.youtrackProfile; entry.youtrackSource = source;
    const setup = button('YouTrack settings', () => this.openYouTrackSetup(), 'aim-home-text-button');
    source.target = '_blank'; source.rel = 'noopener noreferrer';
    const youtrackFooter = homeWidgetFooter(doc, [setup,source], entry.youtrackStatus);
    const youtrackBody = el('div','aim-widget-body');
    youtrackBody.append(entry.youtrackMessage,entry.youtrackList);
    youtrack.append(youtrackHead,youtrackFilters,youtrackBody,youtrackFooter);

    const slack = tile('aim-home-slack-tile', 'Slack inbox'); entry.widgets.slack = slack;
    const slackHead = el('div', 'aim-home-tile-heading aim-widget-header');
    const slackTitle = el('h3', '', 'Slack'); slackTitle.prepend(hubIcon(doc,'messages-square'));
    slackHead.append(slackTitle);
    entry.slackCount = el('span', 'aim-home-caption');
    const slackFilters = el('div', 'aim-home-slack-filters aim-widget-controls'); slackFilters.setAttribute('aria-label', 'Filter Slack inbox');
    entry.slackFilter = 'all'; entry.slackFilters = new Map();
    for (const [key,label] of Object.entries(SLACK_FILTERS)) {
      const control = button(label, () => { entry.slackFilter = key; this.updateSlackWidget(entry); }, 'aim-home-text-button');
      control.setAttribute('aria-pressed', String(key === 'all'));
      control.title = {all:'All sources',dm:'Incoming direct messages',mention:'Mentions of you',channel:'#' + this.slackSources.channel,group:'@' + this.slackSources.group}[key];
      entry.slackFilters.set(key,control); slackFilters.append(control);
    }
    entry.slackList = el('div', 'aim-home-slack-list');
    entry.slackMessage = el('p', 'aim-home-slack-message'); entry.slackMessage.setAttribute('role', 'status');
    entry.slackConnect = button('Connect Slack', () => this.openSlackSetup(), 'aim-home-text-button');
    entry.slackStatus = el('span', 'aim-home-caption');
    const slackFooter = homeWidgetFooter(doc,[entry.slackConnect],entry.slackStatus);
    slackHead.append(entry.slackCount);
    const slackBody = el('div','aim-widget-body');
    slackBody.append(entry.slackMessage,entry.slackList);
    slack.append(slackHead,slackFilters,slackBody,slackFooter);
    this.buildMailWidget(entry,el,button);
    this.updateHomePanel(entry);
  }

  setHomePanel(entry,panel) {
    if (!this.active || !['calendar','mail'].includes(panel) || entry.homePanel === panel) return;
    entry.panelScroll ||= {};
    entry.panelScroll[entry.homePanel] = (entry.homePanel === 'mail' ? [entry.mailList] : [entry.calendarDays,entry.agenda])
      .filter(Boolean).map(node => [node,node.scrollTop]);
    entry.calendarAnimation?.cancel(); entry.calendarAnimation = null;
    entry.homePanel = panel;
    this.updateHomePanel(entry);
    if (panel === 'calendar') {
      entry.agendaKey = null;
      this.updateCalendarAgenda(entry);
      this.updateCalendarMarkers(entry);
    }
    for (const [node,top] of entry.panelScroll[panel] || []) node.scrollTop = top;
    if (panel === 'mail') this.autoRefreshMail();
  }

  updateHomePanel(entry) {
    if (!entry.calendarPanel) return;
    for (const id of ['calendar','mail']) {
      const selected = entry.homePanel === id;
      entry[`${id}Panel`].hidden = !selected;
      entry[`${id}MainTab`].setAttribute('aria-selected',String(selected));
      entry[`${id}MainTab`].tabIndex = selected ? 0 : -1;
    }
  }

  homePanelVisible(entry,panel) {
    const node = entry[`${panel}Panel`];
    return !this.homeCollapsed && this.homeModules.includes('calendar') && (entry.homePanel || 'calendar') === panel &&
      entry.home?.isConnected && entry.home.ownerDocument?.visibilityState !== 'hidden' &&
      (!node || (node.isConnected && !node.hidden)) && (!entry.home.getClientRects || entry.home.getClientRects().length > 0);
  }

  updateHome(entry) {
    if (!entry.home || !this.active) return;
    this.updateTypeIconControls(entry);
    const layoutKey = JSON.stringify([this.homeCollapsed,this.homeModules]);
    const layoutChanged = entry.homeLayoutKey !== layoutKey;
    entry.moduleScroll ||= new Map();
    if (layoutChanged) for (const [id,widget] of Object.entries(entry.widgets || {})) {
      if (widget.isConnected && widget.getClientRects().length) entry.moduleScroll.set(id,
        [...widget.querySelectorAll('.aim-home-youtrack-list,.aim-home-slack-list,.aim-home-mail-list,.aim-home-agenda')].map(node => [node,node.scrollTop]));
    }
    entry.homeLayoutKey = layoutKey;
    const today = homeDay(new Date());
    if (!entry.selectedDay || entry.selectedDay === entry.today) {
      entry.selectedDay = today;
      if (!entry.calendarMonth || entry.calendarMonth === entry.today?.slice(0, 7)) entry.calendarMonth = today.slice(0, 7);
    }
    entry.today = today;
    homeText(entry.homeDate, new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(homeDate(today)));
    homeText(entry.homeToggle, this.homeCollapsed ? 'Show widgets' : 'Hide widgets');
    entry.homeToggle.setAttribute('aria-expanded', String(!this.homeCollapsed));
    entry.homeToggle.disabled = !!this.homeSaving;
    const refreshing = !!(this.widgetsRefreshing || this.calendarBusy || this.mailBusy || this.youtrackBusy || this.slackBusy);
    entry.widgetsRefresh.disabled = refreshing;
    entry.widgetsRefresh.setAttribute('aria-busy',String(refreshing));
    homeText(entry.widgetsRefreshLabel,refreshing ? 'Refreshing widgets…' : 'Refresh all widgets');
    entry.homeGrid.hidden = this.homeCollapsed;
    this.updateHomePanel(entry);

    entry.homeGrid.style.setProperty('--aim-home-columns', Math.max(1,this.homeModules.length));
    for (const [id,toggle] of Object.entries(entry.moduleToggles)) {
      toggle.setAttribute('aria-pressed',String(this.homeModules.includes(id))); toggle.disabled = !!this.homeSaving;
    }
    for (let i = 0; i < this.homeModules.length; i++) {
      const widget = entry.widgets[this.homeModules[i]];
      if (entry.homeGrid.children[i] !== widget) entry.homeGrid.insertBefore(widget,entry.homeGrid.children[i] || null);
    }
    for (const [id,widget] of Object.entries(entry.widgets)) if (!this.homeModules.includes(id)) widget.remove();
    this.applyHomeWidgetHeight(entry);

    const month = homeDate(entry.calendarMonth + '-01');
    const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const calendarKey = JSON.stringify([entry.calendarMonth, today]);
    if (calendarKey !== entry.calendarKey) {
      entry.calendarKey = calendarKey;
      const focusedDay = entry.calendarDays.contains(entry.scope.ownerDocument.activeElement)
        ? entry.scope.ownerDocument.activeElement?.dataset?.day : null;
      entry.calendarDays.replaceChildren();
      const offset = (month.getDay() + 6) % 7;
      entry.calendarDays.style.setProperty('--aim-calendar-weeks', Math.ceil((offset + days) / 7));
      homeText(entry.monthLabel, new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(month));
      const doc = entry.scope.ownerDocument;
      for (const day of ['M', 'T', 'W', 'T', 'F', 'S', 'S']) {
        const label = homeElement(doc, 'span', 'aim-home-weekday', day);
        label.setAttribute('aria-hidden', 'true'); entry.calendarDays.append(label);
      }
      for (let n = 0; n < offset; n++) entry.calendarDays.append(homeElement(doc, 'span'));
      for (let n = 1; n <= days; n++) {
        const day = `${entry.calendarMonth}-${String(n).padStart(2, '0')}`;
        const node = homeElement(doc, 'button', 'aim-home-day');
        const markers = homeElement(doc, 'span', 'aim-home-day-markers');
        markers.setAttribute('aria-hidden', 'true');
        node.append(homeElement(doc, 'span', 'aim-home-day-number', String(n)), markers);
        node.type = 'button'; node.dataset.day = day;
        node.dataset.dateLabel = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full' }).format(homeDate(day));
        node.setAttribute('aria-label', node.dataset.dateLabel);
        if (day === today) node.setAttribute('aria-current', 'date');
        node.addEventListener('click', () => { entry.selectedDay = day; if (this.calendarEnabled) entry.calendarMode = 'agenda'; this.updateHome(entry); });
        entry.calendarDays.append(node);
      }
      if (focusedDay) entry.calendarDays.querySelector(`[data-day="${focusedDay}"]`)?.focus();
    }
    for (const node of entry.calendarDays.querySelectorAll('button')) {
      node.setAttribute('aria-pressed', String(node.dataset.day === entry.selectedDay));
    }
    this.updateCalendarAgenda(entry);
    this.updateCalendarMarkers(entry);
    this.updateYouTrackWidget(entry);
    this.updateSlackWidget(entry);
    this.updateMailWidget(entry);
    if (layoutChanged && !this.homeCollapsed) for (const id of this.homeModules) {
      for (const [node,top] of entry.moduleScroll.get(id) || []) node.scrollTop = top;
      entry.moduleScroll.delete(id);
    }
    this.updateQuickDraft(entry);
  }

  shiftHomeMonth(entry, amount) {
    const month = homeDate(entry.calendarMonth + '-01'); month.setMonth(month.getMonth() + amount);
    entry.calendarMonth = homeDay(month).slice(0, 7);
    entry.selectedDay = entry.calendarMonth === entry.today.slice(0, 7) ? entry.today : entry.calendarMonth + '-01';
    this.updateHome(entry);
    this.animateHomeCalendar(entry, amount);
  }

  shiftHomeCalendar(entry, amount) {
    if (entry.calendarMode !== 'agenda') return this.shiftHomeMonth(entry, amount);
    const day = homeDate(entry.selectedDay); day.setDate(day.getDate() + amount);
    entry.selectedDay = homeDay(day); entry.calendarMonth = entry.selectedDay.slice(0, 7); this.updateHome(entry);
    this.animateHomeCalendar(entry, amount);
  }

  animateHomeCalendar(entry, direction) {
    entry.calendarAnimation?.cancel();
    entry.calendarAnimation = null;
    const target = entry.calendarMode === 'agenda' ? entry.agenda : entry.calendarDays;
    const win = entry.scope.ownerDocument.defaultView;
    if (win.matchMedia?.('(prefers-reduced-motion: reduce)').matches || !target?.animate) return;
    const animation = target.animate([
      { transform: `translateX(${Math.sign(direction) * 10}px)`, opacity: 0.65 },
      { transform: 'translateX(0)', opacity: 1 },
    ], { duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
    entry.calendarAnimation = animation;
    animation.onfinish = () => { if (entry.calendarAnimation === animation) entry.calendarAnimation = null; };
  }

  updateCalendarMarkers(entry) {
    // Reuse the loaded month; markers never initiate a request or expose event titles.
    const events = this.calendarEnabled ? this.calendarCache?.months.get(entry.calendarMonth) : undefined;
    for (const node of entry.calendarDays.querySelectorAll('button')) {
      const day = homeDate(node.dataset.day); day.setHours(0, 0, 0, 0);
      const end = new Date(day); end.setDate(end.getDate() + 1);
      const count = events?.filter(event => {
        const start = +new Date(event.start), finish = +new Date(event.end);
        return start < +end && (finish > start ? finish > +day : start >= +day);
      }).length;
      node.dataset.meetings = String(Math.min(count || 0, 3));
      const detail = count === undefined ? '' : count === 0 ? ' · No meetings' : ` · ${count} meeting${count === 1 ? '' : 's'}`;
      const label = node.dataset.dateLabel + detail;
      node.setAttribute('aria-label', label); node.title = label;
    }
  }

  refreshHomes() {
    if (!this.active) return;
    for (const entry of this.toolbars.values()) if (entry.home?.isConnected) this.updateHome(entry);
  }

  scheduleHomeRefresh() {
    this.homeTimer = setTimeout(() => {
      if (!this.active) return;
      this.refreshHomes(); this.scheduleHomeRefresh();
      void this.loadYouTrackSnapshot().then(() => this.autoRefreshYouTrack());
      this.autoRefreshCalendar();
    }, 60000);
    this.homeTimer?.unref?.();
  }

  autoRefreshCalendar() {
    const stamp = this.calendarCache?.fetchedAt;
    const due = Math.max(this.calendarNextRefresh || 0, Number.isFinite(stamp) && stamp <= Date.now() ? stamp + 600000 : 0);
    if (!this.active || !this.calendarEnabled || this.calendarBusy || this.calendarModal || this.googleSigningIn ||
        Date.now() < due ||
        ![...this.toolbars.values()].some(entry => this.homePanelVisible(entry,'calendar'))) return false;
    void this.refreshCalendar(); return true;
  }

  autoRefreshYouTrack() {
    if (!this.active || !this.youtrackProfile || this.youtrackModal || this.youtrackSetupBusy || this.youtrackBusy || this.youtrackImports.size || this.youtrackSyncJobs.size || this.homeCollapsed ||
        !this.homeModules.includes('youtrack')) return false;
    const stamp = Date.parse(this.youtrackSnapshot?.fetchedAt);
    const due = Math.max(this.youtrackNextRefresh || 0, Number.isFinite(stamp) && stamp <= Date.now() ? stamp + 21600000 : 0);
    if (Date.now() < due || ![...this.toolbars.values()].some(entry => entry.home?.isConnected && entry.widgets?.youtrack?.isConnected &&
        entry.home.ownerDocument?.visibilityState !== 'hidden' && (!entry.home.getClientRects || entry.home.getClientRects().length > 0))) return false;
    void this.refreshYouTrack(); return true;
  }

  async refreshAllWidgets() {
    if (!this.active || this.widgetsRefreshing) return;
    this.widgetsRefreshing = true; this.refreshHomes();
    const reads = [];
    if (this.calendarEnabled && !this.calendarModal && !this.googleSigningIn) reads.push(['calendarError',() => this.refreshCalendar()]);
    if (this.mailEnabled && this.mailSupported() && !this.mailModal && !this.mailOpenBusy) reads.push(['mailError',() => this.refreshMail()]);
    if (this.youtrackProfile && !this.youtrackModal && !this.youtrackSetupBusy && !this.youtrackImports.size && !this.youtrackSyncJobs.size)
      reads.push(['youtrackRefreshError',() => this.refreshYouTrack()]);
    if (this.slackConnected && !this.slackModal) reads.push(['slackError',() => this.refreshSlack()]);
    try {
      const results = await Promise.allSettled(reads.map(([,read]) => Promise.resolve().then(() => this.active && read())));
      if (this.active && results.some((result,index) => result.status === 'rejected' || this[reads[index][0]]))
        new Notice('Some widgets could not refresh. Check their status messages; previous results were kept.');
    } finally { this.widgetsRefreshing = false; this.refreshHomes(); }
  }

  homeRecentNotes() {
    return [...new Set(this.app.workspace.getLastOpenFiles?.() || [])]
      .filter(path => (path.startsWith('Hub/') || path.startsWith(DAILY_FOLDER + '/')) &&
        !path.split('/').some(part => part.startsWith('_') || part.startsWith('.') || part === 'Accounts') && path !== HOME_SHORTCUTS)
      .map(path => this.app.vault.getAbstractFileByPath(path))
      .filter(file => file instanceof TFile && file.extension === 'md' && this.app.metadataCache.getFileCache(file)?.frontmatter?.home_hidden !== true)
      .slice(0, 5);
  }

  homeNoteLabel(file) {
    const title = this.app.metadataCache.getFileCache(file)?.frontmatter?.youtrack_title;
    return typeof title === 'string' && title.trim() ? title.trim() : file.basename;
  }

  homeShortcuts() {
    const source = this.app.vault.getAbstractFileByPath(HOME_SHORTCUTS);
    if (!(source instanceof TFile)) return [];
    return (this.app.metadataCache.getFileCache(source)?.links || [])
      .filter(item => typeof item.link === 'string' && !/^[a-z][a-z\d+.-]*:|^\/\//i.test(item.link))
      .slice(0, 6).map(item => {
        const file = this.app.metadataCache.getFirstLinkpathDest(item.link.split('#')[0], HOME_SHORTCUTS);
        return { file: file instanceof TFile ? file : null, label: item.displayText || file?.basename || item.link };
      });
  }

  async openHomeFile(file) {
    if (!(file instanceof TFile) || this.app.vault.getAbstractFileByPath(file.path) !== file) throw new Error('This note is no longer available. Update the shortcut or choose another note.');
    const existing = this.app.workspace.getLeavesOfType('markdown').find(leaf => leaf.view.file === file);
    if (existing) { await this.app.workspace.revealLeaf(existing); return; }
    await this.app.workspace.getLeaf('tab').openFile(file);
  }

  async openDailyNote(day = homeDay(new Date())) {
    const file = await this.ensureDailyNote(day); await this.openHomeFile(file); return file;
  }

  async ensureDailyNote(day = homeDay(new Date())) {
    const date = homeDate(day); // Validate before any filesystem or UI action.
    if (this.dailyJobs.has(day)) return this.dailyJobs.get(day);
    const job = (async () => {
      const path = homeDailyPath(day);
      let file = this.app.vault.getAbstractFileByPath(path);
      if (!file) {
        let folder = this.app.vault.getAbstractFileByPath(DAILY_FOLDER);
        if (!folder) {
          try { await this.app.vault.createFolder(DAILY_FOLDER); }
          catch (error) { if (!this.app.vault.getAbstractFileByPath(DAILY_FOLDER)?.children) throw error; }
          folder = this.app.vault.getAbstractFileByPath(DAILY_FOLDER);
        }
        if (!folder?.children) throw new Error(`${DAILY_FOLDER} is not a folder.`);
        const template = this.app.vault.getAbstractFileByPath(DAILY_TEMPLATE);
        let content = template instanceof TFile ? await this.app.vault.cachedRead(template)
          : '---\ntags:\n  - type/note\n  - topic/personal\ndate: {{date}}\n---\n\n# {{title}}\n\n## Daily notes\n\n\n## Things to remember\n\n';
        content = content.replaceAll('{{date}}', day).replaceAll('{{title}}', new Intl.DateTimeFormat('tr-TR', { dateStyle: 'full' }).format(date));
        try { file = await this.app.vault.create(path, content); }
        catch (error) {
          file = this.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile)) throw error;
        }
      }
      if (!(file instanceof TFile)) throw new Error(`Cannot open daily note: ${path} is not a file.`);
      return file;
    })();
    this.dailyJobs.set(day, job); this.refreshHomes();
    try { return await job; }
    finally { this.dailyJobs.delete(day); this.refreshHomes(); }
  }

  async changeHomeModules(transform) {
    if (!this.active || this.homeSaving) throw Error('Wait for the current widget change.');
    const expected = JSON.stringify(this.homeModules);
    this.homeSaving = true; this.refreshHomes();
    const job = this.tagSuggestionSave.then(async () => {
      if (!this.active) throw Error('The dashboard was closed.');
      const settings = await this.loadData() || {};
      const current = homeModuleSelection(settings);
      if (JSON.stringify(current) !== expected) throw Error('The widget layout changed. Reopen the dashboard and try again.');
      const next = transform([...current],settings);
      if (next.length > 3 || new Set(next).size !== next.length || next.some(id => !Object.hasOwn(HOME_MODULES,id))) throw Error('Choose up to three different widgets.');
      await this.saveData({...settings,homeModules:next,homeLayoutVersion:2,slackModuleKnown:true});
      if (this.active) this.homeModules = next;
    });
    this.tagSuggestionSave = job.catch(() => {});
    try { await job; } finally {
      this.homeSaving = false; this.refreshHomes();
      this.autoRefreshMail(); this.autoRefreshSlack();
    }
  }

  async setHomeModule(id, enabled) {
    if (!Object.hasOwn(HOME_MODULES,id)) throw Error('Choose a valid module.');
    return this.changeHomeModules((modules,settings) => {
      if (!enabled) return modules.filter(key => key !== id);
      if (modules.includes(id)) return modules;
      if (modules.length >= 3) throw Error('Three widgets are already open. Choose one to replace.');
      const next = [...modules,id];
      return Object.keys(HOME_MODULES).filter(key => next.includes(key));
    });
  }

  rememberQuickDraft() {
    const state = this.quickDraft;
    try {
      if (!this.quickDraftStorage) throw new Error('Local draft storage unavailable');
      this.quickDraftStorage.setItem(this.quickDraftKey,JSON.stringify({version:1,text:state.text,lastSaved:state.lastSaved,pending:state.pending}));
      state.recoveryError = false; return true;
    } catch (_) { state.recoveryError = true; return false; }
  }

  async recoverQuickDraftSave() {
    const state = this.quickDraft, pending = state.pending;
    if (!pending) return null;
    const file = this.app.vault.getAbstractFileByPath(pending.path);
    if (!(file instanceof TFile) || await this.app.vault.read(file) !== pending.text) return null;
    // A previous explicit Save finished before the local receipt was cleared.
    state.lastSaved = file.path;
    if (state.text === pending.text) state.text = '';
    state.pending = null; this.rememberQuickDraft(); return file;
  }

  async loadQuickDraft() {
    try { await this.recoverQuickDraftSave(); }
    catch (_) { this.quickDraft.error = 'Could not check the previous Save. Your draft is kept here.'; }
    finally { this.quickDraft.ready = true; this.refreshHomes(); }
  }

  editQuickDraft(text) {
    if (typeof text !== 'string' || text.length > 100000 || !this.quickDraft.ready) return;
    this.quickDraft.text = text; this.quickDraft.revision++; this.quickDraft.error = '';
    this.rememberQuickDraft(); this.refreshHomes();
  }

  async saveQuickDraft() {
    const state = this.quickDraft;
    if (this.quickDraftSaving) return this.quickDraftSaving;
    if (!this.active || !state.ready || !state.text.trim()) return null;
    if (this.captureBusy) { state.error = 'Another note is being created. Try Save again.'; this.refreshHomes(); return null; }
    state.busy = true; state.error = ''; this.refreshHomes();
    const job = (async () => {
      await Promise.resolve();
      try {
        const recovered = await this.recoverQuickDraftSave();
        if (recovered && !state.text.trim()) return recovered;
        const text = state.text, revision = state.revision;
        const title = text.split(/\r?\n/).find(line => line.trim())?.replace(/^\s*#+\s*/, '').replace(/[\/\\:*?"<>|#\[\]\^\u0000-\u001f]/g,' ').replace(/\s+/g,' ').replace(/^[. ]+|[. ]+$/g,'').slice(0,80).trim();
        const file = await this.createCapturedNote(text,{open:false,title,beforeCreate:path => {
          state.pending = {path,text};
          // Persist the intended target before writing, so a restart cannot duplicate a completed Save.
          if (!this.rememberQuickDraft()) throw new Error('Cannot protect this Save on this device. Keep the draft here and try again.');
        }});
        if (!file) throw new Error('Another note is being created. Try Save again.');
        state.lastSaved = file.path; state.pending = null;
        if (state.revision === revision) state.text = '';
        this.rememberQuickDraft(); return file;
      } catch (error) {
        state.error = error.message || 'Could not save. Your draft is kept here.';
        this.rememberQuickDraft(); return null;
      } finally { state.busy = false; this.quickDraftSaving = null; this.refreshHomes(); }
    })();
    this.quickDraftSaving = job; return job;
  }

  updateQuickDraft(entry) {
    const state = this.quickDraft;
    entry.scratchInput.disabled = !state.ready || state.busy;
    if (entry.scratchInput.value !== state.text) entry.scratchInput.value = state.text;
    homeText(entry.scratchStatus,state.error || (!state.ready ? 'Loading draft…' : state.busy ? 'Saving…' : state.recoveryError ? 'Draft not protected · keep this window open' : state.text ? 'Draft · on this device' : state.lastSaved ? 'Saved to Quick Notes' : 'Save when ready'));
    entry.scratchStatus.classList.toggle('is-error',!!state.error || !!state.recoveryError);
    entry.scratchStatus.classList.toggle('is-visible',!!state.error || !!state.recoveryError || !state.ready || state.busy);
    entry.scratchSave.disabled = !state.ready || state.busy || !state.text.trim() || this.captureBusy;
    homeText(entry.scratchSave,state.busy ? 'Saving…' : 'Save');
    entry.scratchOpen.disabled = !(this.app.vault.getAbstractFileByPath(state.lastSaved) instanceof TFile);
    entry.scratchOpen.title = entry.scratchOpen.disabled ? (state.lastSaved ? 'The last saved note is no longer available.' : 'Save a note from Scratchpad to open it here.') : state.lastSaved;
    this.resizeQuickDraft(entry);
  }

  resizeQuickDraft(entry) {
    const input = entry.scratchInput;
    if (!input?.clientWidth) return;
    const sizeKey = input.clientWidth + ':' + input.value;
    if (entry.scratchSizeKey === sizeKey) return;
    entry.scratchSizeKey = sizeKey;
    const style = entry.scope.ownerDocument.defaultView?.getComputedStyle?.(input);
    const line = parseFloat(style?.lineHeight) || 22;
    const padding = (parseFloat(style?.paddingTop) || 0) + (parseFloat(style?.paddingBottom) || 0);
    const min = Math.ceil(line + padding), max = Math.ceil(4 * line + padding);
    input.style.height = 'auto';
    const content = input.value ? input.scrollHeight : min;
    input.style.height = Math.max(min,Math.min(max,content)) + 'px';
    input.style.overflowY = content > max ? 'auto' : 'hidden';
  }

  async setHomeCollapsed(collapsed) {
    this.homeSaving = true; this.refreshHomes();
    const job = this.tagSuggestionSave.then(async () => {
      const loaded = await this.loadData();
      const settings = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};
      await this.saveData({ ...settings, homeCollapsed: !!collapsed });
      this.homeCollapsed = !!collapsed;
    });
    this.tagSuggestionSave = job.catch(() => {});
    try { await job; }
    finally { this.homeSaving = false; this.refreshHomes(); }
  }

  updateCalendarAgenda(entry) {
    const agendaMode = entry.calendarMode === 'agenda';
    entry.calendarDays.hidden = agendaMode; entry.agenda.hidden = !agendaMode;
    entry.monthTab.setAttribute('aria-pressed', String(!agendaMode)); entry.agendaTab.setAttribute('aria-pressed', String(agendaMode));
    for (const [node, direction] of [[entry.calendarPrevious, 'Previous'], [entry.calendarNext, 'Next']]) {
      node.setAttribute('aria-label', `${direction} ${agendaMode ? 'day' : 'month'}`); node.title = `${direction} ${agendaMode ? 'day' : 'month'}`;
    }
    homeText(entry.calendarConnect, this.calendarEnabled ? 'Calendar settings' : 'Connect Google Calendar');
    const stamp = this.calendarCache?.kind === 'google' ? this.calendarCache.stamps?.get(entry.calendarMonth) : this.calendarCache?.fetchedAt;
    homeText(entry.calendarStatus, !this.calendarEnabled ? 'Not connected' : this.calendarBusy ? 'Refreshing…' : this.calendarError ? 'Refresh failed · Auto 10m' :
      (stamp ? `Updated ${new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit'}).format(new Date(stamp))} · ` : '') + 'Auto 10m');
    entry.calendarStatus.title = this.calendarError || 'Refreshes every 10 minutes while the Calendar tab is visible. Refresh all widgets also reads inactive tabs.';
    const key = JSON.stringify([entry.selectedDay, this.calendarEnabled, this.calendarCache?.fetchedAt, this.calendarError, this.calendarBusy]);
    if (key === entry.agendaKey) return;
    entry.agendaKey = key; entry.agenda.replaceChildren();
    const doc = entry.scope.ownerDocument;
    entry.agenda.append(homeElement(doc, 'p', 'aim-home-agenda-date', new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(homeDate(entry.selectedDay))));
    if (!this.calendarEnabled) {
      entry.agenda.append(homeElement(doc, 'p', 'aim-home-empty', 'See your meetings here. Connect a read-only Google Calendar feed below.'));
      return;
    }
    if (this.calendarError) entry.agenda.append(homeElement(doc, 'p', 'aim-home-feed-message', this.calendarError));
    if (!this.calendarCache) {
      if (!this.calendarError) entry.agenda.append(homeElement(doc, 'p', 'aim-home-empty', 'Loading your calendar…'));
      return;
    }
    try {
      const day = homeDate(entry.selectedDay); day.setHours(0, 0, 0, 0);
      const end = new Date(day); end.setDate(end.getDate() + 1);
      const monthKey = entry.selectedDay.slice(0, 7);
      if (!this.calendarCache.months.has(monthKey)) {
        if (this.calendarCache.kind === 'google') {
          if (!this.calendarBusy && !this.googleMonthFailures.has(monthKey) && this.homePanelVisible(entry,'calendar')) void this.refreshCalendar(false, monthKey);
          entry.agenda.append(homeElement(doc, 'p', 'aim-home-empty', this.googleMonthFailures.has(monthKey) ? 'Could not load this month. Use Refresh all widgets to retry.' : 'Loading this month…'));
          return;
        }
        const monthStart = new Date(day.getFullYear(), day.getMonth(), 1);
        const monthEnd = new Date(day.getFullYear(), day.getMonth() + 1, 1);
        const events = getHomeCalendarAdapter().calendarAgenda(this.calendarCache.text, monthStart, monthEnd);
        if (this.calendarCache.months.size >= 6) this.calendarCache.months.delete(this.calendarCache.months.keys().next().value);
        this.calendarCache.months.set(monthKey, events);
      }
      const events = this.calendarCache.months.get(monthKey).filter(event => new Date(event.start) < end &&
        (event.end > event.start ? new Date(event.end) > day : new Date(event.start) >= day));
      for (const event of events) {
        const { safeMeetingUrl, meetingProvider } = getHomeMeetingLinks();
        const joinUrl = safeMeetingUrl(event.joinUrl);
        const row = homeElement(doc, joinUrl ? 'a' : 'div', 'aim-home-meeting');
        if (joinUrl) {
          row.href = joinUrl; row.target = '_blank'; row.rel = 'noopener noreferrer';
          row.title = `Open ${meetingProvider(joinUrl) || 'meeting link'}`;
          row.setAttribute('aria-label', `${event.title} · ${row.title}`);
        }
        const time = event.allDay ? 'All day' : new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(event.start));
        row.append(homeElement(doc, 'time', 'aim-home-meeting-time', time), homeElement(doc, 'span', 'aim-home-meeting-name', event.title));
        if (joinUrl) row.append(homeElement(doc, 'span', 'aim-home-meeting-join', meetingProvider(joinUrl) || 'Join'));
        entry.agenda.append(row);
      }
      if (!events.length) entry.agenda.append(homeElement(doc, 'p', 'aim-home-empty', 'No meetings on this date.'));
    } catch (error) { entry.agenda.append(homeElement(doc, 'p', 'aim-home-feed-message', error.message)); }
  }


  mailSupported() {
    try { return require('node:os').platform() === 'darwin'; } catch (_) { return false; }
  }

  buildMailWidget(entry,el,button) {
    const widget = entry.mailPanel;
    const filters = el('div','aim-home-mail-filters aim-widget-controls'); filters.setAttribute('aria-label','Filter Mail inbox');
    entry.mailFilter = 'all'; entry.mailAccount = ''; entry.mailFilters = new Map();
    for (const [id,label] of [['all','All'],['unread','Unread']]) {
      const control = button(label,() => { entry.mailFilter = id; this.updateMailWidget(entry); },'aim-home-text-button');
      control.setAttribute('aria-pressed',String(id === 'all')); entry.mailFilters.set(id,control); filters.append(control);
    }
    entry.mailAccountSelect = el('select','aim-home-mail-account'); entry.mailAccountSelect.setAttribute('aria-label','Mail account');
    entry.mailAccountSelect.addEventListener('change',() => { entry.mailAccount = entry.mailAccountSelect.value; this.updateMailWidget(entry); });
    filters.append(entry.mailAccountSelect);
    entry.mailList = el('div','aim-home-mail-list');
    entry.mailMessage = el('p','aim-home-mail-message'); entry.mailMessage.setAttribute('role','status');
    entry.mailConnect = button('Connect Mail',() => this.mailEnabled ? this.openMailSettings() : this.refreshMail(true),'aim-home-text-button');
    entry.mailStatus = el('span','aim-home-caption');
    const footer = homeWidgetFooter(entry.scope.ownerDocument,[entry.mailConnect],entry.mailStatus);
    const body = el('div','aim-widget-body'); body.append(entry.mailMessage,entry.mailList);
    widget.append(filters,body,footer);
  }

  updateMailWidget(entry) {
    if (!entry.mailList) return;
    const doc = entry.scope.ownerDocument, snapshot = this.mailSnapshot, supported = this.mailSupported();
    entry.mailConnect.disabled = !supported || (this.mailBusy && !this.mailEnabled);
    homeText(entry.mailConnect,this.mailEnabled ? 'Mail settings' : this.mailBusy ? 'Connecting…' : 'Connect Mail');
    for (const [id,control] of entry.mailFilters) control.setAttribute('aria-pressed',String(id === entry.mailFilter));
    const accountKey = JSON.stringify(snapshot?.accounts || []);
    if (entry.mailAccountKey !== accountKey) {
      entry.mailAccountKey = accountKey; entry.mailAccountSelect.replaceChildren();
      const all = homeElement(doc,'option','','All accounts'); all.value = ''; entry.mailAccountSelect.append(all);
      for (const account of snapshot?.accounts || []) { const option = homeElement(doc,'option','',account.name); option.value = account.id; entry.mailAccountSelect.append(option); }
      if (!snapshot?.accounts.some(a => a.id === entry.mailAccount)) entry.mailAccount = '';
      entry.mailAccountSelect.value = entry.mailAccount;
    }
    entry.mailAccountSelect.disabled = !snapshot;
    entry.mailList.setAttribute('aria-busy',String(this.mailBusy));
    homeText(entry.mailStatus,this.mailBusy ? 'Refreshing…' : snapshot ? `Updated ${new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit'}).format(new Date(snapshot.fetchedAt))} · Auto 10m` : this.mailEnabled ? 'Auto 10m' : 'Not connected');
    entry.mailStatus.title = snapshot ? `${snapshot.accounts.length} accounts · Last read ${(snapshot.durationMs / 1000).toFixed(1)}s. Mail stays in memory on this Mac.` : '';
    homeText(entry.mailMessage,this.mailError + (this.mailError && snapshot ? ' Showing the last successful results.' : ''));
    entry.mailMessage.hidden = !this.mailError;
    const key = JSON.stringify([snapshot?.fetchedAt,this.mailEnabled,!snapshot && this.mailBusy,supported,entry.mailFilter,entry.mailAccount,homeDay(new Date())]);
    if (entry.mailRenderKey === key) return;
    const oldScroll = entry.mailList.scrollTop, sameFilter = entry.mailLastFilter === entry.mailFilter && entry.mailLastAccount === entry.mailAccount;
    entry.mailRenderKey = key; entry.mailLastFilter = entry.mailFilter; entry.mailLastAccount = entry.mailAccount; entry.mailList.replaceChildren();
    if (!snapshot) {
      entry.mailList.append(homeElement(doc,'p','aim-home-empty',!supported ? 'Apple Mail is available on macOS. Choose another widget on this device.' : this.mailBusy
        ? 'Reading your inboxes… The first read may take about 30 seconds. Allow Mail access if macOS asks.'
        : this.mailEnabled ? 'Your inboxes will load while this widget is visible.' : 'Bring the inboxes already configured in Apple Mail together. Connect once on this Mac; macOS may ask for Automation access.'));
      return;
    }
    const accounts = new Map(snapshot.accounts.map(a => [a.id,a.name]));
    const rows = snapshot.rows.filter(row => (!entry.mailAccount || row.accountId === entry.mailAccount) && (entry.mailFilter !== 'unread' || !row.read)).slice(0,50);
    if (!rows.length) entry.mailList.append(homeElement(doc,'p','aim-home-empty',snapshot.accounts.length ? 'No messages in this view among the loaded results.' : 'No enabled accounts were found in Apple Mail.'));
    let dateKey;
    for (const item of rows) {
      const group = homeDateGroup(item.receivedAt);
      if (dateKey !== group.key) { entry.mailList.append(homeElement(doc,'h4','aim-widget-group',group.label)); dateKey = group.key; }
      const row = homeElement(doc,'button','aim-home-mail-row' + (item.read ? '' : ' is-unread')); row.type = 'button';
      row.title = 'Open in Apple Mail';
      const meta = homeElement(doc,'span','aim-home-mail-meta');
      meta.append(homeElement(doc,'span','aim-home-mail-sender',item.sender || '(Unknown sender)'));
      const time = homeElement(doc,'time','aim-home-mail-time',new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit'}).format(new Date(item.receivedAt)));
      time.dateTime = new Date(item.receivedAt).toISOString(); time.title = new Date(item.receivedAt).toLocaleString('en-GB'); meta.append(time);
      row.append(meta,homeElement(doc,'span','aim-home-mail-subject',item.subject || '(No subject)'),homeElement(doc,'span','aim-home-mail-account-label',accounts.get(item.accountId)));
      row.setAttribute('aria-label',`${item.read ? '' : 'Unread. '}${item.sender}. ${item.subject || 'No subject'}. ${accounts.get(item.accountId)}. ${time.title}. Open in Apple Mail`);
      row.addEventListener('click',() => { void this.openMailMessage(item); }); entry.mailList.append(row);
    }
    entry.mailList.scrollTop = sameFilter ? oldScroll : 0;
  }

  async refreshMail(connect = false) {
    if (!this.active || this.mailBusy || (!connect && !this.mailEnabled)) return;
    if (!this.mailSupported()) { this.mailError = 'Apple Mail is available on macOS only.'; this.refreshHomes(); return; }
    this.mailBusy = true; this.mailError = ''; clearTimeout(this.mailTimer);
    const revision = ++this.mailRevision, started = Date.now();
    const current = () => this.active && this.mailRevision === revision;
    this.refreshHomes();
    try {
      const snapshot = parseMailSnapshot(await this.fetchMailSnapshot());
      if (!current()) return;
      if (connect) {
        try {
          if (!this.quickDraftStorage) throw Error();
          this.quickDraftStorage.setItem(this.mailKey,'true');
        } catch (_) { throw mailFailure('storage'); }
        this.mailEnabled = true;
      }
      snapshot.durationMs = Date.now() - started; this.mailSnapshot = snapshot; this.mailPermissionError = false;
    } catch (error) {
      if (current()) { this.mailError = error?.mailSafe ? error.message : mailFailure('read').message; this.mailPermissionError = error?.mailCode === -1743; }
    } finally {
      if (current()) { this.mailBusy = false; this.mailNextRefresh = Date.now() + 600000; this.refreshHomes(); this.scheduleMailRefresh(); }
    }
  }

  autoRefreshMail() {
    if (!this.active || !this.mailEnabled || this.mailBusy || this.mailOpenBusy || this.mailModal || this.mailPermissionError || this.homeCollapsed ||
        !this.homeModules.includes('calendar') || Date.now() < this.mailNextRefresh) return false;
    if (![...this.toolbars.values()].some(entry => this.homePanelVisible(entry,'mail'))) return false;
    void this.refreshMail(); return true;
  }

  scheduleMailRefresh(waitWhenHidden = false) {
    clearTimeout(this.mailTimer); this.mailTimer = null;
    if (!this.active || !this.mailEnabled || this.mailBusy || this.mailPermissionError) return;
    this.mailTimer = setTimeout(() => {
      this.mailTimer = null; if (!this.autoRefreshMail()) this.scheduleMailRefresh(true);
    },waitWhenHidden ? 60000 : Math.max(1000,this.mailNextRefresh - Date.now()));
    this.mailTimer?.unref?.();
  }

  async disconnectMail() {
    try { this.quickDraftStorage?.removeItem(this.mailKey); } catch (_) { throw mailFailure('storage'); }
    this.mailRevision++; this.mailEnabled = false; this.mailBusy = false; this.mailOpenBusy = false;
    this.mailSnapshot = null; this.mailError = ''; this.mailPermissionError = false;
    clearTimeout(this.mailTimer); for (const child of this.mailProcesses || []) child.kill('SIGKILL');
    this.mailProcesses?.clear(); this.refreshHomes();
  }

  openMailSettings() {
    if (this.mailModal) return;
    const modal = this.mailModal = new Modal(this.app), doc = this.app.workspace.containerEl.ownerDocument;
    modal.onOpen = () => {
      const content = modal.contentEl; content.empty();
      content.append(homeElement(doc,'h2','','Apple Mail'));
      content.append(homeElement(doc,'p','','Up to 50 messages from each enabled account’s inbox, sorted by received date. Each view shows at most 50 loaded messages. Unread filters this sample; it is not a total unread count. Archives and other folders are not included.'));
      content.append(homeElement(doc,'p','','Messages stay in memory on this Mac. Automatic refresh runs about every ten minutes while Mail is visible. Use Refresh all widgets for an immediate read, including inactive tabs. Opening a message in Apple Mail may mark it read.'));
      content.append(homeElement(doc,'p','','Disconnect stops reads and clears this list. To remove macOS permission, use System Settings → Privacy & Security → Automation. Connect separately on each Mac.'));
      const disconnect = homeElement(doc,'button','','Disconnect Mail'); disconnect.type = 'button';
      disconnect.addEventListener('click',() => { void this.runAction(async () => { await this.disconnectMail(); modal.close(); }); }); content.append(disconnect);
    };
    modal.onClose = () => { if (this.mailModal === modal) this.mailModal = null; };
    modal.open();
  }

  fetchMailSnapshot() { return this.runMailBridge(['list']); }

  async openMailMessage(item) {
    if (!this.active || this.mailOpenBusy || !this.mailEnabled || !this.mailSnapshot?.rows.includes(item)) return;
    this.mailOpenBusy = true; const revision = this.mailRevision;
    try { await this.runMailBridge(['open',item.accountId,item.mailbox,String(item.id),item.messageId]); }
    catch (error) { if (this.active && revision === this.mailRevision) { this.mailError = error?.mailSafe ? error.message : 'Could not open this message. Refresh Mail and try again.'; this.refreshHomes(); } }
    finally { this.mailOpenBusy = false; }
  }

  runMailBridge(args) {
    return new Promise((resolve,reject) => {
      if (!this.mailSupported() || !((args.length === 1 && args[0] === 'list') || (args.length === 5 && args[0] === 'open' && args.slice(1).every(v => typeof v === 'string' && v.length <= 2048)))) { reject(mailFailure('runtime')); return; }
      let execFile,script;
      try {
        ({execFile} = require('child_process'));
        const dir = this.manifest?.dir || `${this.app.vault.configDir || '.obsidian'}/plugins/aimultiple-kanban-extras`;
        script = this.app.vault.adapter.getFullPath(`${dir}/scripts/read-mail.applescript`);
        if (!require('path').isAbsolute(script) || !require('fs').existsSync(script)) throw Error();
      } catch (_) { reject(mailFailure('runtime')); return; }
      const child = execFile('/usr/bin/osascript',['-l','AppleScript',script,...args],{
        timeout:args[0] === 'list' ? 90000 : 20000,maxBuffer:4*1024*1024,killSignal:'SIGKILL',encoding:'utf8',
      },(error,stdout,stderr) => {
        this.mailProcesses.delete(child);
        let data; try { data = JSON.parse(stdout); } catch (_) {}
        if (error) { reject(mailFailure(error.killed ? -1712 : /\(-1743\)/.test(stderr || '') ? -1743 : 'read')); return; }
        if (!data || data.ok === false) { reject(mailFailure(data?.code)); return; }
        if (args[0] === 'open' && data.ok !== true) { reject(mailFailure('read')); return; }
        resolve(data);
      });
      this.mailProcesses.add(child);
    });
  }

  restoreSlack() {
    try {
      const saved = parseSlackSecret(this.app.secretStorage?.getSecret?.(SLACK_SECRET));
      if (saved) { this.slackConnected = true; this.slackAccount = saved.account; this.slackSources = normalizeSlackSources(saved.sources); }
    } catch (_) { this.slackError = 'Could not read the saved Slack connection. Open Slack settings to reconnect.'; }
  }

  openSlackSetup() {
    if (this.slackModal) return;
    this.slackModal = new HomeSlackModal(this); this.slackModal.open();
  }

  autoRefreshSlack() {
    if (!this.active || !this.slackConnected || this.slackBusy || this.slackModal || this.homeCollapsed ||
        !this.homeModules.includes('slack') || Date.now() < this.slackNextRefresh || Date.now() < this.slackRetryAt) return false;
    const visible = [...this.toolbars.values()].some(entry => entry.home?.isConnected && entry.widgets?.slack?.isConnected &&
      entry.home.ownerDocument?.visibilityState !== 'hidden' && (!entry.home.getClientRects || entry.home.getClientRects().length > 0));
    if (!visible) return false;
    void this.refreshSlack(); return true;
  }

  scheduleSlackRefresh(waitWhenHidden = false) {
    clearTimeout(this.slackTimer); this.slackTimer = null;
    if (!this.active || !this.slackConnected || this.slackBusy) return;
    const delay = waitWhenHidden ? 60000 : Math.max(1000, this.slackNextRefresh - Date.now(), this.slackRetryAt - Date.now());
    this.slackTimer = setTimeout(() => {
      this.slackTimer = null;
      if (!this.autoRefreshSlack()) this.scheduleSlackRefresh(true);
    }, delay);
    this.slackTimer?.unref?.();
  }

  cancelSlackConnect() {
    if (this.slackJobKind !== 'connect') return;
    this.slackRevision++; this.slackBusy = false; this.slackJobKind = null;
    this.scheduleSlackRefresh();
    if (this.active) this.refreshHomes();
  }

  async connectSlack(value, sourceInput = this.slackSources) {
    if (!this.active) throw slackFailure('cancelled');
    if (this.slackBusy) throw slackFailure('busy');
    if (!this.app.secretStorage?.getSecret || !this.app.secretStorage?.setSecret) throw slackFailure('keychain');
    const sources = normalizeSlackSources(sourceInput);
    const token = validateSlackToken(value || parseSlackSecret(this.app.secretStorage.getSecret(SLACK_SECRET))?.token);
    if (Date.now() < this.slackRetryAt) throw slackRateLimit(this.slackRetryAt - Date.now());
    this.slackBusy = true; this.slackJobKind = 'connect'; this.slackError = '';
    clearTimeout(this.slackTimer); this.slackTimer = null;
    const revision = ++this.slackRevision;
    const current = () => this.active && revision === this.slackRevision;
    this.refreshHomes();
    try {
      const nameCache = new Map();
      const snapshot = await readSlackMentions(requestUrl, token, null, current, nameCache, sources);
      if (!current()) throw slackFailure('cancelled');
      commitSlackSecret(this.app.secretStorage, JSON.stringify({version:1,token,account:snapshot.account,sources}));
      this.slackConnected = true; this.slackAccount = snapshot.account; this.slackSnapshot = snapshot;
      this.slackNameCache = nameCache; this.slackSources = sources;
      this.slackRetryAt = 0;
      return snapshot;
    } catch (error) {
      if (current()) {
        this.slackError = slackErrorMessage(error);
        if (error?.slackUncertain) { this.slackConnected = false; this.slackAccount = null; this.slackSnapshot = null; }
        if (error?.retryMs) this.slackRetryAt = Date.now() + error.retryMs;
      }
      throw error?.slackSafe ? error : slackFailure('network');
    } finally {
      if (current()) { this.slackBusy = false; this.slackJobKind = null; this.slackNextRefresh = Date.now() + 300000; this.scheduleSlackRefresh(); this.refreshHomes(); }
    }
  }

  async refreshSlack() {
    if (!this.active || this.slackBusy) return;
    if (Date.now() < this.slackRetryAt) {
      this.slackError = slackErrorMessage(slackRateLimit(this.slackRetryAt - Date.now())); this.refreshHomes(); return;
    }
    this.slackBusy = true; this.slackJobKind = 'refresh'; this.slackError = '';
    clearTimeout(this.slackTimer); this.slackTimer = null;
    const revision = ++this.slackRevision;
    const current = () => this.active && revision === this.slackRevision;
    this.refreshHomes();
    try {
      let saved;
      try { saved = parseSlackSecret(this.app.secretStorage?.getSecret?.(SLACK_SECRET)); }
      catch (_) { throw slackFailure('keychain'); }
      if (!saved) throw slackFailure('connection');
      const snapshot = await readSlackMentions(requestUrl, saved.token, saved.account, current, this.slackNameCache, normalizeSlackSources(saved.sources));
      if (!current()) return;
      this.slackConnected = true; this.slackAccount = snapshot.account; this.slackSnapshot = snapshot;
      this.slackRetryAt = 0;
    } catch (error) {
      if (current()) {
        this.slackError = slackErrorMessage(error);
        if (error?.retryMs) this.slackRetryAt = Date.now() + error.retryMs;
      }
    } finally {
      if (current()) { this.slackBusy = false; this.slackJobKind = null; this.slackNextRefresh = Date.now() + 300000; this.scheduleSlackRefresh(); this.refreshHomes(); }
    }
  }

  async disconnectSlack() {
    // Clear the durable credential first; a failed Keychain operation keeps the connection usable.
    try { commitSlackSecret(this.app.secretStorage, '', 'disconnect'); }
    catch (error) {
      if (error?.slackUncertain) {
        this.slackRevision++; this.slackConnected = false; this.slackAccount = null; this.slackSnapshot = null;
        this.slackNameCache.clear(); clearTimeout(this.slackTimer); this.slackTimer = null;
        this.slackBusy = false; this.slackJobKind = null; this.slackError = slackErrorMessage(error); this.refreshHomes();
      }
      throw error;
    }
    this.slackRevision++; this.slackBusy = false; this.slackJobKind = null;
    this.slackConnected = false; this.slackAccount = null; this.slackSnapshot = null; this.slackError = '';
    this.slackNameCache.clear(); clearTimeout(this.slackTimer); this.slackTimer = null;
    this.slackRetryAt = 0; this.refreshHomes();
  }

  updateSlackWidget(entry) {
    if (!entry.slackList) return;
    const doc = entry.scope.ownerDocument, snapshot = this.slackSnapshot;
    entry.slackList.setAttribute('aria-busy', String(this.slackBusy));
    homeText(entry.slackConnect, this.slackConnected ? 'Slack settings' : 'Connect Slack');
    homeText(entry.slackCount, this.slackConnected
      ? this.slackAccount.teamName : 'Inbox');
    entry.slackCount.title = this.slackConnected ? `${this.slackAccount.teamName} · @${this.slackAccount.userName}` : 'DMs, mentions and your notes channel';
    if ((entry.slackFilter==='channel' && !this.slackSources.channel) || (entry.slackFilter==='group' && !this.slackSources.group)) entry.slackFilter='all';
    for (const [key,control] of entry.slackFilters || []) {
      control.setAttribute('aria-pressed', String(key === entry.slackFilter));
      if (key==='channel' || key==='group') { control.hidden=!this.slackSources[key]; control.title=(key==='channel'?'#':'@')+this.slackSources[key]; }
    }
    homeText(entry.slackStatus, this.slackBusy ? 'Refreshing…' : snapshot ? `Updated ${new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit'}).format(new Date(snapshot.fetchedAt))} · Auto 5m` : this.slackConnected ? 'Auto 5m' : 'Not connected');
    entry.slackStatus.title = (Number.isFinite(snapshot?.durationMs) ? `Last refresh took ${(snapshot.durationMs/1000).toFixed(1)}s. ` : '') + 'Refreshes every 5 minutes while Home and Slack are visible. Current messages remain available during refresh.';
    homeText(entry.slackMessage, this.slackError + (this.slackError && snapshot ? ' Showing the last successful results.' : ''));
    entry.slackMessage.hidden = !this.slackError;
    const key = JSON.stringify([snapshot?.fetchedAt, this.slackConnected, !snapshot && this.slackBusy, entry.slackFilter,homeDay(new Date())]);
    if (entry.slackRenderKey === key) return;
    const oldScroll = entry.slackList.scrollTop, sameFilter = entry.slackLastFilter === entry.slackFilter;
    entry.slackRenderKey = key; entry.slackLastFilter = entry.slackFilter; entry.slackList.replaceChildren();
    if (!snapshot) {
      entry.slackList.append(homeElement(doc, 'p', 'aim-home-empty', this.slackBusy ? 'Checking your Slack connection…'
        : this.slackConnected ? 'Click Refresh all widgets to load your recent messages.' : 'Connect Slack to see incoming DMs and mentions. Add an optional notes channel or user group in settings.'));
      return;
    }
    const rows = snapshot.rows.filter(row => !entry.slackFilter || entry.slackFilter === 'all' || row.sources?.includes(entry.slackFilter)).slice(0,50);
    if (!rows.length) entry.slackList.append(homeElement(doc, 'p', 'aim-home-empty', 'No messages in this view among the loaded results.'));
    let dateKey;
    for (const item of rows) {
      const group = homeDateGroup(item.time);
      if (dateKey !== group.key) { entry.slackList.append(homeElement(doc,'h4','aim-widget-group',group.label)); dateKey = group.key; }
      const row = homeElement(doc, 'a', 'aim-home-slack-mention');
      row.href = item.url; row.target = '_blank'; row.rel = 'noopener noreferrer';
      const meta = homeElement(doc, 'span', 'aim-home-slack-meta');
      meta.append(homeElement(doc, 'span', 'aim-home-slack-author', item.author));
      const time = homeElement(doc, 'time', 'aim-home-slack-time', new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit'}).format(new Date(item.time)));
      time.dateTime = new Date(item.time).toISOString(); time.title = new Date(item.time).toLocaleString('en-GB'); meta.append(time);
      const sourceLabel = item.sources?.includes('dm') ? 'DM' : item.sources?.includes('group') ? '@' + this.slackSources.group : item.sources?.includes('mention') ? 'Mention' : 'Channel';
      row.append(meta, homeElement(doc, 'span', 'aim-home-slack-text', item.text), homeElement(doc, 'span', 'aim-home-slack-channel', `${sourceLabel} · ${item.channel}`));
      row.setAttribute('aria-label', `${item.author} · ${item.channel} · ${time.title}. ${item.text}`);
      entry.slackList.append(row);
    }
    entry.slackList.scrollTop = sameFilter ? oldScroll : 0;
  }

  openCalendarSetup() {
    this.calendarModal?.close();
    this.calendarModal = new HomeCalendarModal(this);
    this.calendarModal.open();
  }

  async saveCalendarEnabled(enabled, source = this.calendarSource) {
    const job = this.tagSuggestionSave.then(async () => {
      const loaded = await this.loadData();
      const settings = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};
      await this.saveData({ ...settings, calendarEnabled: enabled, calendarSource: source });
      this.calendarEnabled = enabled;
      this.calendarSource = source;
    });
    this.tagSuggestionSave = job.catch(() => {});
    return job;
  }

  async fetchCalendarFeed(value) {
    const { validateGoogleCalendarUrl, calendarAgenda } = getHomeCalendarAdapter();
    const url = validateGoogleCalendarUrl(value);
    let timer;
    try {
      const response = await Promise.race([
        requestUrl({ url, method: 'GET', throw: false }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 20000); }),
      ]);
      if (response.status !== 200) throw new Error('http');
      const now = new Date(), until = new Date(now); until.setDate(until.getDate() + 7);
      calendarAgenda(response.text, now, until); // Validate before storing a credential or showing success.
      return { text: response.text, fetchedAt: Date.now(), months: new Map() };
    } catch (_) {
      throw new Error('Could not read Google Calendar. Check the iCal address and your connection, then retry.');
    } finally { clearTimeout(timer); }
  }

  async connectCalendar(value) {
    if (!this.app.secretStorage?.setSecret || !this.app.secretStorage?.getSecret) throw new Error('Calendar connection requires Obsidian 1.11.4 or later with Keychain support.');
    if (this.calendarBusy) throw new Error('A calendar request is already running. Try again when it finishes.');
    const url = getHomeCalendarAdapter().validateGoogleCalendarUrl(value);
    const revision = ++this.calendarRevision;
    this.calendarBusy = true; this.calendarLastAttempt = Date.now(); this.refreshHomes();
    try {
      const cache = await this.fetchCalendarFeed(url);
      if (!this.active || revision !== this.calendarRevision) return;
      const previous = this.app.secretStorage.getSecret(CALENDAR_SECRET) || '';
      try {
        this.app.secretStorage.setSecret(CALENDAR_SECRET, url);
        await this.saveCalendarEnabled(true, 'ical');
      } catch (_) {
        this.app.secretStorage.setSecret(CALENDAR_SECRET, previous);
        throw new Error('Could not save the calendar connection. Your previous connection was kept.');
      }
      if (!this.active || revision !== this.calendarRevision) return;
      this.calendarCache = cache; this.calendarError = '';
      for (const entry of this.toolbars.values()) entry.calendarMode = 'agenda';
    } finally { this.calendarBusy = false; this.refreshHomes(); }
  }

  selectedCalendarMonth() {
    return [...this.toolbars.values()].find(entry => entry.home?.isConnected)?.selectedDay?.slice(0, 7) || homeDay(new Date()).slice(0, 7);
  }

  async authorizeGoogle(client) {
    const revision = this.calendarRevision;
    const session = await getHomeGoogleAdapter().startGoogleAuthorization(client);
    if (!this.active || revision !== this.calendarRevision) { session.cancel(); throw new Error('Google sign-in cancelled.'); }
    this.googleSession = session;
    try {
      const shell = require('electron').shell;
      await shell.openExternal(session.url);
      return await session.result;
    } catch (_) { session.cancel(); throw new Error('Google sign-in was cancelled, blocked, or timed out. Try again.'); }
    finally { session.cancel(); if (this.googleSession === session) this.googleSession = null; }
  }

  cancelGoogleSignIn() {
    if (!this.googleSigningIn) return;
    this.calendarRevision++; this.googleSession?.cancel();
  }

  async googleMonthCache(token, monthKey) {
    const from = homeDate(monthKey + '-01'); from.setHours(0, 0, 0, 0);
    const until = new Date(from.getFullYear(), from.getMonth() + 1, 1);
    const events = await getHomeGoogleAdapter().fetchGoogleEvents(requestUrl, token, from, until);
    return { kind: 'google', fetchedAt: Date.now(), months: new Map([[monthKey, events]]), stamps: new Map([[monthKey, Date.now()]]) };
  }

  async connectGoogleCalendar(value) {
    if (!this.app.secretStorage?.setSecret || !this.app.secretStorage?.getSecret) throw new Error('Google sign-in requires Obsidian 1.11.4 or later with Keychain support.');
    if (this.calendarBusy || this.calendarDisconnecting) throw new Error('A calendar request is already running. Try again when it finishes.');
    const adapter = getHomeGoogleAdapter(), client = adapter.parseGoogleClient(value);
    const revision = ++this.calendarRevision;
    this.calendarBusy = true; this.googleSigningIn = true; this.refreshHomes();
    const current = () => this.active && revision === this.calendarRevision;
    try {
      const auth = await this.authorizeGoogle(client);
      if (!current()) throw new Error('Google sign-in cancelled.');
      const token = await adapter.exchangeGoogleCode(requestUrl, client, auth.code, auth.verifier, auth.redirect);
      if (!current()) throw new Error('Google sign-in cancelled.');
      const cache = await this.googleMonthCache(token.accessToken, this.selectedCalendarMonth());
      if (!current()) throw new Error('Google sign-in cancelled.');
      this.googleSigningIn = false; // Validation is done; commit the local connection.
      const previous = this.app.secretStorage.getSecret(GOOGLE_SECRET) || '';
      try {
        this.app.secretStorage.setSecret(GOOGLE_SECRET, JSON.stringify({ ...client, refreshToken: token.refreshToken }));
        await this.saveCalendarEnabled(true, 'google');
      } catch (_) {
        this.app.secretStorage.setSecret(GOOGLE_SECRET, previous);
        throw new Error('Could not save Google sign-in. Your previous connection was kept.');
      }
      if (!current()) return;
      this.googleToken = token; this.calendarCache = cache; this.calendarError = ''; this.googleMonthFailures.clear();
      this.calendarLastAttempt = Date.now();
      for (const entry of this.toolbars.values()) entry.calendarMode = 'agenda';
    } finally { this.calendarBusy = false; this.googleSigningIn = false; this.refreshHomes(); }
  }

  async refreshCalendar(manual = false, monthKey = this.selectedCalendarMonth()) {
    if (!this.calendarEnabled || this.calendarBusy || !this.active) return;
    this.calendarBusy = true; this.calendarLastAttempt = Date.now();
    const revision = this.calendarRevision; this.refreshHomes();
    try {
      if (this.calendarSource === 'google') {
        const saved = this.app.secretStorage?.getSecret(GOOGLE_SECRET);
        if (!saved) throw new Error('Sign in with Google on this device.');
        const client = JSON.parse(saved);
        let token = this.googleToken;
        if (!token || token.expiresAt - Date.now() < 60000) token = await getHomeGoogleAdapter().refreshGoogleToken(requestUrl, client);
        if (!this.active || revision !== this.calendarRevision) return;
        const cache = await this.googleMonthCache(token.accessToken, monthKey);
        if (!this.active || revision !== this.calendarRevision) return;
        const months = new Map(this.calendarCache?.kind === 'google' ? this.calendarCache.months : []);
        const stamps = new Map(this.calendarCache?.kind === 'google' ? this.calendarCache.stamps : []);
        months.set(monthKey, cache.months.get(monthKey)); stamps.set(monthKey, cache.fetchedAt);
        if (months.size > 6) { const oldest = months.keys().next().value; months.delete(oldest); stamps.delete(oldest); }
        this.googleToken = token; this.calendarCache = { ...cache, months, stamps }; this.calendarError = ''; this.googleMonthFailures.delete(monthKey);
        return;
      }
      const url = this.app.secretStorage?.getSecret(CALENDAR_SECRET);
      if (!url) throw new Error('Add the iCal address in Calendar settings on this device.');
      const cache = await this.fetchCalendarFeed(url);
      if (!this.active || revision !== this.calendarRevision) return;
      this.calendarCache = cache; this.calendarError = '';
    } catch (error) {
      if (!this.active || revision !== this.calendarRevision) return;
      if (this.calendarSource === 'google') this.googleMonthFailures.add(monthKey);
      this.calendarError = this.calendarCache ? 'Refresh failed. Showing the last successful calendar data.' : 'Calendar unavailable. Check the connection in Calendar settings.';
      if (manual) new Notice(this.calendarError);
    } finally {
      this.calendarBusy = false;
      if (this.active && revision === this.calendarRevision) this.calendarNextRefresh = Date.now() + 600000;
      this.refreshHomes();
    }
  }

  async disconnectCalendar() {
    if (this.calendarDisconnecting) return;
    this.calendarDisconnecting = true;
    try {
    await this.saveCalendarEnabled(false);
    this.calendarRevision++;
    this.googleSession?.cancel(); this.googleToken = null; this.googleMonthFailures.clear();
    this.calendarCache = null; this.calendarError = '';
    for (const entry of this.toolbars.values()) entry.calendarMode = 'month';
    this.refreshHomes();
    this.app.secretStorage?.setSecret(CALENDAR_SECRET, '');
    this.app.secretStorage?.setSecret(GOOGLE_SECRET, '');
    } finally { this.calendarDisconnecting = false; }
  }

  async setHomeWidget(index, widget) {
    if (!Number.isInteger(index) || index < 0 || index > 2 || !Object.hasOwn(HOME_WIDGETS, widget)) throw new Error('Choose a valid widget.');
    const viewId = this.homeState.activeView;
    await this.changeHomeState(state => {
      const layout = requireHomeView(state, viewId).widgets;
      const oldIndex = layout.indexOf(widget);
      if (oldIndex >= 0) layout[oldIndex] = layout[index];
      layout[index] = widget;
    });
  }

  homeView() { return requireHomeView(this.homeState, this.homeState.activeView); }

  updateHomeSources(entry) {
    const doc = entry.scope.ownerDocument;
    const el = (tag, cls, text) => homeElement(doc, tag, cls, text);
    const button = (label, action) => {
      const b = el('button','',label); b.type = 'button'; b.addEventListener('click', () => { void this.runAction(action); }); return b;
    };
    const view = this.homeView();
    const viewsKey = JSON.stringify(this.homeState.views.map(v => [v.id,v.name]));
    if (entry.viewsKey !== viewsKey) {
      entry.viewsKey = viewsKey; entry.viewBar.replaceChildren();
      for (const v of this.homeState.views) {
        const b = button(v.name, async () => { await this.setHomeView(v.id); await this.refreshHomeCheckpoint(); });
        b.dataset.viewId = v.id; entry.viewBar.append(b);
      }
      const add = button('+', () => this.openHomeManager('new-view')); add.setAttribute('aria-label','Add Home view'); entry.viewBar.append(add);
    }
    for (const b of entry.viewBar.children) { if (b.dataset.viewId) b.setAttribute('aria-pressed',String(b.dataset.viewId === view.id)); b.disabled = !!this.homeSaving; }
    const pins = view.pins.map(id => this.homeState.sources.find(s => s.id === id));
    const pinsKey = JSON.stringify([view.id,pins]);
    if (entry.pinsKey !== pinsKey) {
      entry.pinsKey = pinsKey; entry.continueSelect.replaceChildren(); entry.pinnedLinks.replaceChildren();
      for (const source of pins) {
        const option = el('option','',source.title); option.value = source.id; entry.continueSelect.append(option);
        const link = button(source.title, () => this.openHomeSource(source)); link.className = 'aim-home-pinned-link'; link.title = source.target; entry.pinnedLinks.append(link);
      }
      if (!pins.length) { const add = button('Add a note, folder or link', () => this.openHomeManager('edit')); add.className = 'aim-home-pin-empty'; entry.pinnedLinks.append(add); }
    }
    const source = pins.find(s => s.id === view.selected);
    const changedSource = entry.selectedSourceId !== source?.id;
    if (changedSource) entry.continueDetails.open = false;
    entry.selectedSourceId = source?.id;
    entry.continueSelect.value = view.selected;
    entry.continueSelect.hidden = !source; entry.continueSelect.disabled = !!this.homeSaving;
    entry.continueEmpty.hidden = !!source;
    entry.continueText.hidden = !source && !this.homeStateError;
    entry.continueOpen.hidden = entry.continueMark.hidden = entry.continueDetails.hidden = !source;
    const readable = homeCanRead(source);
    entry.continueRefresh.hidden = !readable;
    entry.continueRefresh.disabled = this.homeCheckpointJobs.has(source?.id);
    entry.continueOrigin.hidden = entry.continueRecover.hidden = true;
    if (!source) { homeText(entry.continueText,this.homeStateError || ''); return; }
    const cached = this.homeCheckpoints.get(source.id);
    const value = cached?.value;
    const missing = value?.reason === 'selection' ? 'The selected section is no longer here.' : 'No next step found in this document.';
    homeText(entry.continueText, readable ? cached?.error || value?.next || (value?.status === 'ambiguous' ? 'More than one next step. Choose a section once.' : value?.status === 'missing' ? missing : 'Reading document…') : source.bookmark || 'Mark where you left off.');
    homeText(entry.continueMark, readable ? 'Edit' : 'Mark place');
    if (readable && (cached?.error || value?.status === 'missing' || value?.status === 'ambiguous')) {
      entry.continueRecover.hidden = false;
      homeText(entry.continueRecover, value?.sections?.length ? 'Choose section' : 'Choose document');
    }
    if (readable && value?.status === 'ready') {
      entry.continueOrigin.hidden = false;
      homeText(entry.continueOrigin, `${cached.path.split('/').pop()} · ${value.heading}`);
    }
    const date = readable ? cached?.readAt : source.updatedAt;
    const updated = date ? new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'short'}).format(new Date(date)) : '';
    homeText(entry.continueDetailsText,[source.target,readable ? `Document: ${cached?.path || source.checkpoint || 'HANDOFF.md → README.md'}` : 'Manual bookmark',updated ? `${readable ? 'Read' : 'Saved'} ${updated}` : '',value?.truncated ? 'Excerpt shortened. Open the document for the full section.' : '',readable ? 'Reads on selection, Refresh, and every minute while visible. Shows a document excerpt, not live session progress.' : ''].filter(Boolean).join('\n'));
  }

  async changeHomeState(change) {
    if (!this.active || this.homeStateError) throw new Error(this.homeStateError || 'Home is closed.');
    this.homeSaveCount = (this.homeSaveCount || 0) + 1; this.homeSaving = true; this.refreshHomes();
    const job = this.tagSuggestionSave.then(async () => {
      if (!this.active) throw new Error('Home is closed.');
      const loaded = await this.loadData();
      const settings = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};
      const state = homeWorkspaceState(settings);
      const result = change(state);
      await this.saveData({ ...settings, homeWorkspace: state });
      if (this.active) {
        this.homeState = state; this.homeWidgets = this.homeView().widgets;
        for (const [id, cached] of this.homeCheckpoints) {
          if (homeSourceReadKey(state.sources.find(s => s.id === id)) !== cached.key) this.homeCheckpoints.delete(id);
        }
      }
      return result;
    });
    this.tagSuggestionSave = job.catch(() => {});
    try { return await job; } finally { this.homeSaving = --this.homeSaveCount > 0; this.refreshHomes(); }
  }

  setHomeView(id) {
    return this.changeHomeState(state => { requireHomeView(state, id); state.activeView = id; });
  }

  saveHomeView(name, id, expectedName) {
    name = homeShortText(name, 60, 'View name');
    return this.changeHomeState(state => {
      if (id) {
        const view = requireHomeView(state, id);
        if (view.name !== expectedName) throw new Error('This view changed. Reopen its editor.');
        view.name = name; return id;
      }
      if (state.views.length >= 100) throw new Error('Home supports up to 100 views.');
      const newId = homeId();
      state.views.push({id:newId, name, widgets:['calendar','continue','links'], pins:[], selected:''});
      state.activeView = newId; return newId;
    });
  }

  deleteHomeView(id) {
    return this.changeHomeState(state => {
      requireHomeView(state, id);
      if (state.views.length === 1) throw new Error('Keep at least one view.');
      state.views = state.views.filter(v => v.id !== id);
      if (state.activeView === id) state.activeView = state.views[0].id;
    });
  }

  async saveHomeSource(input, viewId, expected) {
    const source = validateHomeSource(input);
    return this.changeHomeState(state => {
      const view = requireHomeView(state, viewId);
      if (source.id) {
        const index = state.sources.findIndex(s => s.id === source.id);
        if (index < 0 || JSON.stringify(state.sources[index]) !== expected) throw new Error('This source changed. Reopen its editor.');
        state.sources[index] = source;
      } else {
        if (state.sources.length >= 1000) throw new Error('Home supports up to 1000 sources.');
        source.id = homeId(); state.sources.push(source);
      }
      source.updatedAt = new Date().toISOString();
      if (!view.pins.includes(source.id)) view.pins.push(source.id);
      view.selected = source.id;
      return JSON.parse(JSON.stringify(source));
    });
  }

  pinHomeSource(viewId, id, pin) {
    return this.changeHomeState(state => {
      const view = requireHomeView(state, viewId);
      if (!state.sources.some(s => s.id === id)) throw new Error('Source no longer exists.');
      if (pin && !view.pins.includes(id)) view.pins.push(id);
      if (!pin) view.pins = view.pins.filter(x => x !== id);
      if (pin || !view.pins.includes(view.selected)) view.selected = pin ? id : view.pins[0] || '';
    });
  }

  forgetHomeSource(id) {
    return this.changeHomeState(state => {
      if (state.views.some(v => v.pins.includes(id))) throw new Error('Unpin this source from every view first.');
      state.sources = state.sources.filter(s => s.id !== id);
    });
  }

  selectHomeSource(viewId, id) {
    return this.changeHomeState(state => {
      const view = requireHomeView(state, viewId);
      if (!view.pins.includes(id)) throw new Error('Pin this source to the view first.');
      view.selected = id;
    });
  }

  parseHomeCheckpoint(text) {
    if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) throw new Error('Checkpoint file is too large.');
    const starts = [...text.matchAll(/^```es-hub[^\r\n]*\r?$/gm)];
    const blocks = [...text.matchAll(/^```es-hub\r?\n([\s\S]*?)\r?\n```[ \t]*\r?$/gm)];
    if (starts.length !== 1 || blocks.length !== 1 || blocks[0][1].length > 4096) throw new Error('One valid es-hub checkpoint is required.');
    let value;
    try { value = JSON.parse(blocks[0][1]); } catch (_) { throw new Error('Invalid checkpoint JSON.'); }
    if (!value || value.schema !== 1 || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 160 ||
        typeof value.next !== 'string' || !value.next.trim() || value.next.length > 280 ||
        /[\r\n\u0000-\u001f]/.test(value.title + value.next) || typeof value.updatedAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.updatedAt) || !Number.isFinite(Date.parse(value.updatedAt)))
      throw new Error('Invalid checkpoint fields or version.');
    return { title:value.title.trim(), next:value.next.trim(), updatedAt:value.updatedAt };
  }

  parseHomeContinuation(text, chosenSection = '') {
    if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) throw new Error('Document is too large.');
    const clean = text.replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[^\S\r\n]*(?:\r?\n|$)/, '')
      .replace(/<!--[\s\S]*?(?:-->|$)/g, '');
    const lines = clean.split(/\r?\n/), sections = [], stack = [];
    let fence = null, hasLegacy = false;
    for (let i = 0; i < lines.length; i++) {
      const mark = lines[i].match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && !mark[2].trim()) fence = null;
        lines[i] = ''; continue;
      }
      if (mark) { if (mark[1] === '```' && mark[2] === 'es-hub') hasLegacy = true; fence = mark[1]; lines[i] = ''; continue; }
      const heading = lines[i].match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (!heading) continue;
      const level = heading[1].length, title = homePlainExcerpt(heading[2]);
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      const trail = [...stack.map(s => s.heading), title];
      const section = {id:JSON.stringify(trail), label:trail.join(' › '), heading:title, level, start:i};
      sections.push(section); stack.push(section);
    }
    for (let index = 0; index < sections.length; index++) {
      const section = sections[index];
      const end = sections[index + 1]?.start ?? lines.length;
      const paragraph = [];
      for (let i = section.start + 1; i < end; i++) {
        const line = lines[i].trim();
        if (!line) { if (paragraph.length) break; continue; }
        if (paragraph.length && /^(?:[-*+] |\d+[.)] )/.test(line)) break;
        paragraph.push(line.replace(/^(?:[-*+] |\d+[.)] )(?:\[[ xX]\] )?/, ''));
      }
      const full = homePlainExcerpt(paragraph.join(' '));
      section.preview = full.length > 320 ? full.slice(0, 317).replace(/\s+\S*$/, '') + '…' : full;
      section.truncated = full.length > 320;
    }
    const normalize = value => value.toLocaleLowerCase('tr-TR').replace(/ı/g,'i').replace(/[:：]$/, '').trim();
    const aliases = new Set(['sonraki adım','sonraki adımlar','sıradaki somut iş','sıradaki adım','next step','next steps','next action','next actions'].map(normalize));
    const choices = sections.filter(s => aliases.has(normalize(s.heading)));
    const candidates = sections.map(({id,label,preview}) => ({id,label,preview}));
    const matches = chosenSection ? sections.filter(s => s.id === chosenSection) : choices;
    if (matches.length > 1) return {status:'ambiguous', candidates:matches.map(({id,label,preview}) => ({id,label,preview})), sections:candidates};
    if (matches.length === 1 && matches[0].preview) {
      const s = matches[0];
      return {status:'ready', next:s.preview, heading:s.heading, section:s.id, format:'markdown', truncated:s.truncated, sections:candidates};
    }
    // Compatibility only. Ordinary Markdown is the primary contract.
    if (!chosenSection && !choices.length && hasLegacy) {
      const legacy = this.parseHomeCheckpoint(clean);
      return {...legacy,status:'ready',heading:'Saved checkpoint',format:'legacy',sections:candidates};
    }
    return {status:'missing', sections:candidates, reason:chosenSection ? 'selection' : 'heading'};
  }

  async inferHomeSource(raw, existing = null) {
    let target = homeShortText(raw, 2048, 'Path or link');
    if (target.startsWith('[[') && target.endsWith(']]')) target = target.slice(2,-2).split('|')[0];
    let type, title;
    if (/^[a-z][a-z\d+.-]*:/i.test(target)) {
      let url; try { url = new URL(target); } catch (_) { throw new Error('Use a valid link.'); }
      type = ['http:','https:'].includes(url.protocol) ? 'url' : 'app'; title = url.hostname || 'Link';
    } else if (target.startsWith('/') || target.startsWith('~/')) {
      const path = require('node:path');
      const absolute = target.startsWith('~/') ? path.join(require('node:os').homedir(),target.slice(2)) : target;
      let stat; try { stat = await require('node:fs/promises').lstat(absolute); } catch (_) { throw new Error('Path not found on this device. Check the path and try again.'); }
      if (!stat.isFile() && !stat.isDirectory()) throw new Error('Choose a regular file or folder.');
      type = stat.isDirectory() ? 'folder' : 'file'; title = path.basename(absolute).replace(/\.md$/i,'') || 'Folder';
    } else {
      const [notePath,...heading] = target.split('#');
      const file = this.app.vault.getAbstractFileByPath(notePath) || this.app.metadataCache.getFirstLinkpathDest(notePath,'');
      if (!file) throw new Error('Note not found. Choose a vault note or paste a full file path.');
      title = file.basename || file.name;
      if (file instanceof TFile) { type = 'note'; target = file.path + (heading.length ? '#' + heading.join('#') : ''); }
      else {
        const base = this.app.vault.adapter.getBasePath?.();
        if (!base) throw new Error('Local folders require Obsidian desktop.');
        type = 'folder'; target = require('node:path').join(base,file.path);
      }
    }
    const same = existing?.target === target && existing?.type === type;
    return validateHomeSource({...existing, type, target, title:same ? existing.title : title,
      bookmark:same ? existing.bookmark : '', checkpoint:same ? existing.checkpoint : '',
      section:same ? existing.section : '', readMode:same ? existing.readMode : 'auto'});
  }

  chooseHomePath(ownerWindow) {
    const dialog = ownerWindow?.electron?.remote?.dialog || this.app.workspace.containerEl.ownerDocument.defaultView?.electron?.remote?.dialog;
    if (typeof dialog?.showOpenDialogSync !== 'function') throw new Error('File browsing needs Obsidian desktop. You can paste a path instead.');
    let paths;
    try {
      paths = dialog.showOpenDialogSync({title:'Choose a file or folder for Home',buttonLabel:'Choose',properties:['openFile','openDirectory','dontAddToRecent']});
    } catch (_) { throw new Error('Could not open the file picker. Try again or paste a path.'); }
    return Array.isArray(paths) && typeof paths[0] === 'string' ? paths[0] : '';
  }

  async resolveHomeContinuation(source) {
    if (!homeCanRead(source)) return {path:'',value:{status:'manual'}};
    const direct = source.checkpoint || (source.type !== 'folder' ? source.target.split('#')[0] : '');
    if (direct) return {path:direct,value:this.parseHomeContinuation(await this.readHomeCheckpointFile(direct),source.section)};
    let last = {path:'',value:{status:'missing',sections:[]}};
    for (const name of ['HANDOFF.md','README.md']) {
      const path = source.target.replace(/\/$/,'') + '/' + name;
      let text;
      try { text = await this.readHomeCheckpointFile(path); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      last = {path,value:this.parseHomeContinuation(text)};
      if (last.value.status !== 'missing') return last;
    }
    return last;
  }

  async readHomeCheckpointFile(path) {
    if (!path.startsWith('/') && !path.startsWith('~/')) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile) || file.extension !== 'md' || file.stat.size > 2 * 1024 * 1024) throw new Error('Checkpoint unavailable.');
      return this.app.vault.read(file);
    }
    // Explicit document or one of two known root files. No recursive discovery.
    const fs = require('node:fs/promises');
    const absolute = path.startsWith('~/') ? require('node:path').join(require('node:os').homedir(), path.slice(2)) : path;
    const before = await fs.lstat(absolute);
    if (!before.isFile() || before.size > 2 * 1024 * 1024) throw new Error('Checkpoint unavailable.');
    const handle = await fs.open(absolute, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NONBLOCK | require('node:fs').constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Checkpoint unavailable.');
      const buffer = require('node:buffer').Buffer.alloc(2 * 1024 * 1024 + 1);
      let total = 0;
      while (total < buffer.length) { const result = await handle.read(buffer, total, buffer.length - total, null); if (!result.bytesRead) break; total += result.bytesRead; }
      if (total > 2 * 1024 * 1024) throw new Error('Checkpoint too large.');
      return buffer.subarray(0, total).toString('utf8');
    } finally { await handle.close(); }
  }

  async refreshHomeCheckpoint() {
    if (!this.active) return;
    const source = this.homeState.sources.find(s => s.id === this.homeView().selected);
    if (!homeCanRead(source)) return;
    const key = homeSourceReadKey(source);
    const running = this.homeCheckpointJobs.get(source.id);
    if (running?.key === key) return running;
    const job = Promise.resolve().then(async () => {
      let value, path = source.checkpoint || source.target, error = '';
      try { ({path,value} = await this.resolveHomeContinuation(source)); }
      catch (_) { error = 'Document unavailable. Check its path or choose another document.'; }
      if (!this.active || homeSourceReadKey(this.homeState.sources.find(s => s.id === source.id)) !== key) return;
      this.homeCheckpoints.set(source.id, {key,path,value,error,readAt:new Date().toISOString()});
    }).finally(() => { if (this.homeCheckpointJobs.get(source.id) === job) this.homeCheckpointJobs.delete(source.id); this.refreshHomes(); });
    job.key = key;
    this.homeCheckpointJobs.set(source.id, job); this.refreshHomes();
    return job;
  }

  async openHomeSource(source) {
    const current = this.homeState.sources.find(s => s.id === source?.id);
    if (!current) throw new Error('Source no longer exists.');
    const safe = validateHomeSource(current);
    if (safe.type === 'note') {
      const path = safe.target.split('#')[0];
      const file = this.app.vault.getAbstractFileByPath(path) || this.app.metadataCache.getFirstLinkpathDest(path, '');
      if (!(file instanceof TFile)) throw new Error('Note not found. Edit this source to update its path.');
      if (safe.target.includes('#')) return this.app.workspace.openLinkText(file.path + safe.target.slice(safe.target.indexOf('#')), '', true);
      return this.openHomeFile(file);
    }
    const shell = require('electron').shell;
    if (safe.type === 'url' || safe.type === 'app') return shell.openExternal(safe.target);
    const absolute = safe.target.startsWith('~/') ? require('node:path').join(require('node:os').homedir(), safe.target.slice(2)) : safe.target;
    let stat;
    try { stat = await require('node:fs/promises').stat(absolute); } catch (_) { throw new Error('Path not found on this device. Edit the source to update it.'); }
    if (safe.type === 'folder' ? !stat.isDirectory() : !stat.isFile()) throw new Error('The path does not match the selected source type.');
    const error = await shell.openPath(absolute);
    if (error) throw new Error('This device could not open the source.');
  }

  openHomeManager(mode = 'sources', source = null) {
    const modal = new HomeManagerModal(this, mode, source); this.homeModals.add(modal); modal.open(); return modal;
  }

  async loadYouTrackSnapshot() {
    if (!this.active || this.youtrackBusy || !this.youtrackProfile) return;
    const revision = ++this.youtrackReadRevision;
    try {
      const dir = this.manifest?.dir || `${this.app.vault.configDir || '.obsidian'}/plugins/aimultiple-kanban-extras`;
      const data = JSON.parse(await this.app.vault.adapter.read(`${dir}/youtrack-widget.json`));
      if (!validYouTrackSnapshot(data,this.youtrackProfile)) throw new Error('Invalid snapshot');
      if (!this.active || revision !== this.youtrackReadRevision) return;
      this.youtrackSnapshot = data; this.youtrackSnapshotError = '';
    } catch (_) {
      if (!this.active || revision !== this.youtrackReadRevision) return;
      this.youtrackSnapshotError = 'Saved list unavailable. Press Refresh all widgets to load your YouTrack cards.';
    }
    this.refreshHomes();
  }

  fetchYouTrackSnapshot() { return this.runYouTrackReader(); }

  fetchYouTrackDetail(id) { return this.runYouTrackReader(id); }

  fetchYouTrackState(id, column) { return this.runYouTrackReader(id, 'state', column); }

  runYouTrackReader(id, mode = 'read', column, provided) {
    return new Promise((resolve, reject) => {
      let connection;
      try {
        connection = provided || parseYouTrackSecret(this.app.secretStorage?.getSecret?.(YOU_TRACK_SECRET));
        if (!connection || (!provided && JSON.stringify(connection.profile) !== JSON.stringify(normalizeYouTrackProfile(this.youtrackProfile)))) throw Error();
      }
      catch (_) { reject(Object.assign(Error('Open YouTrack settings to connect.'), {youtrackCode:'connection'})); return; }
      if (mode === 'state' && !connection.profile.syncEnabled) { reject(Object.assign(Error(), {youtrackCode:'state'})); return; }
      if (!['read','state'].includes(mode) || (mode === 'state' && (!id || !Object.hasOwn(this.youtrackStates, column)))) { reject(Error('Invalid operation.')); return; }
      if (id !== undefined && !this.validYouTrackId(id)) { reject(Error('Invalid issue.')); return; }
      let fs, path, execFile, script, python;
      try {
        fs = require('fs'); path = require('path'); ({ execFile } = require('child_process'));
        const dir = this.manifest?.dir || `${this.app.vault.configDir || '.obsidian'}/plugins/aimultiple-kanban-extras`;
        script = this.app.vault.adapter.getFullPath(`${dir}/scripts/refresh-youtrack.py`);
        python = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find(file => fs.existsSync(file));
        if (!python || !fs.existsSync(script) || !path.isAbsolute(script)) throw Error();
      } catch (_) { const error = Error(); error.youtrackCode = 'runtime'; reject(error); return; }
      // No shell or credential arguments. Credentials travel only through this child process stdin.
      const child = execFile(python, ['-I', '-S', '-B', script, ...(id ? mode === 'state' ? ['--state', id, column] : ['--issue', id] : [])], { timeout: 70000, maxBuffer: id && mode === 'read' ? 80 * 1024 * 1024 : 1024 * 1024, killSignal: 'SIGKILL', encoding: 'utf8' }, (error, stdout) => {
        if (this.youtrackProcess === child) this.youtrackProcess = null;
        this.youtrackDetailProcesses.delete(child);
        let result; try { result = JSON.parse(stdout); } catch (_) {}
        if (!error && result?.ok === true) { resolve(mode === 'state' ? result.stateChange : id ? result.detail : result.snapshot); return; }
        const failure = Error(); failure.youtrackCode = result?.ok === false ? result.code : mode === 'state' ? 'uncertain' : error?.killed ? 'timeout' : 'reader'; reject(failure);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(connection));
      if (id) this.youtrackDetailProcesses.add(child); else this.youtrackProcess = child;
    });
  }

  observeYouTrackState(file, cache, legacy) {
    if (!this.youtrackProfile?.syncEnabled || !this.youtrackNoteMatches(file)) return;
    if (!this.active || !(file instanceof TFile)) return;
    const fm = cache?.frontmatter;
    const valid = file.path.startsWith('Hub/') && fileHasKanbanTag(cache) && fm?.youtrack_import === 'local-v1' && this.validYouTrackId(fm.youtrack_id);
    const previous = this.observedYouTrack.get(file);
    this.observedYouTrack.set(file, valid ? {id:fm.youtrack_id, column:fm.board_column} : null);
    if (!valid || legacy || !Object.hasOwn(this.youtrackStates, fm.board_column)) return;
    const imported = this.youtrackSyncImports.get(file) === fm.board_column;
    if (imported) this.youtrackSyncImports.delete(file);
    if (imported || (previous?.id === fm.youtrack_id && Object.hasOwn(this.youtrackStates, previous.column) && previous.column !== fm.board_column)) {
      // Let the metadata transaction finish; recheck the live file before any network write.
      void Promise.resolve().then(() => this.syncYouTrackIssue(file));
    }
  }

  saveYouTrackSyncResults() {
    if (!this.quickDraftStorage) throw Error('Local recovery storage is unavailable.');
    this.quickDraftStorage.setItem(this.youtrackSyncKey, JSON.stringify([...this.youtrackSyncResults].slice(-100)));
  }

  youtrackSyncText(id, value) {
    const target = this.youtrackStates[value.column] || 'selected status';
    if (value.status === 'synced') return `${id}: ${target} in YouTrack.`;
    if (value.status === 'pending') return `${id}: Syncing ${target} to YouTrack…`;
    const help = {runtime:'Desktop Obsidian and Python 3.11+ are required.',connection:'Open YouTrack settings to check your connection.',authentication:'Reconnect in YouTrack settings.',identity:'Check the configured login.',issue:'Check the issue owner and local duplicates.',state:'The selected state is unavailable.',storage:'Local recovery status could not be saved.'};
    return `${id}: ${target} not confirmed in YouTrack. ${help[value.code] || (value.status === 'uncertain' ? 'The previous request may have been applied.' : 'Check the connection.')} Retry sends the current local status.`;
  }

  async syncYouTrackIssue(file) {
    if (this.youtrackSetupBusy) return;
    if (!this.youtrackProfile?.syncEnabled || !this.youtrackNoteMatches(file)) return;
    if (!this.active || !(file instanceof TFile) || this.app.vault.getAbstractFileByPath(file.path) !== file || !file.path.startsWith('Hub/')) return;
    const cache = this.app.metadataCache.getFileCache(file), fm = cache?.frontmatter;
    if (!fileHasKanbanTag(cache) || fm?.youtrack_import !== 'local-v1' || !Object.hasOwn(this.youtrackStates, fm.board_column) || !this.validYouTrackId(fm.youtrack_id)) return;
    const id = fm.youtrack_id;
    this.youtrackSyncRequests.set(id, {file, column:fm.board_column});
    if (this.youtrackSyncJobs.has(id)) return this.youtrackSyncJobs.get(id);
    const job = Promise.resolve().then(async () => {
      let sent = false, column = fm.board_column;
      try {
        while (this.active && this.youtrackSyncRequests.has(id)) {
          const request = this.youtrackSyncRequests.get(id); this.youtrackSyncRequests.delete(id);
          const targetFile = request.file; column = request.column; sent = false;
          if (this.app.vault.getAbstractFileByPath(targetFile.path) !== targetFile || !targetFile.path.startsWith('Hub/')) return;
          const current = this.app.metadataCache.getFileCache(targetFile);
          if (!fileHasKanbanTag(current) || current?.frontmatter?.board_column !== column || current.frontmatter.youtrack_id !== id || current.frontmatter.youtrack_import !== 'local-v1') return;
          if (this.findYouTrackLocalNote(id) !== targetFile) throw Object.assign(Error(), {youtrackCode:'issue'});
          this.youtrackSyncResults.set(id, {status:'pending', column, at:Date.now()});
          try { this.saveYouTrackSyncResults(); } catch (_) { throw Object.assign(Error(), {youtrackCode:'storage'}); }
          this.refreshHomes(); sent = true;
          const result = await this.fetchYouTrackState(id, column);
          if (!this.active) return; // Pending receipt becomes unconfirmed after reload; no replay.
          if (result?.id !== id || result.state !== this.youtrackStates[column]) throw Object.assign(Error(), {youtrackCode:'uncertain'});
          const at = Date.now();
          this.youtrackSyncResults.set(id, {status:'synced', column, at});
          if (validYouTrackWidgetIssue(result.issue, this.youtrackProfile) && result.issue.id === id && result.issue.state === result.state) {
            this.youtrackVerifiedIssues.set(id, {issue:result.issue, at});
          }
          const next = this.youtrackSyncRequests.get(id);
          if (next?.column === column && next.file === targetFile) this.youtrackSyncRequests.delete(id);
          if (!this.youtrackSyncRequests.has(id)) new Notice(this.youtrackSyncText(id, this.youtrackSyncResults.get(id)));
        }
      } catch (error) {
        if (!this.active) return;
        const code = error?.youtrackCode || (sent ? 'uncertain' : 'issue');
        column = this.youtrackSyncRequests.get(id)?.column || column;
        // An uncertain earlier write must be reconciled by explicit Retry before a later target is sent.
        this.youtrackSyncRequests.delete(id);
        const value = {status:code === 'uncertain' ? 'uncertain' : 'error', column, code, at:Date.now()};
        this.youtrackSyncResults.set(id, value);
        new Notice(this.youtrackSyncText(id, value), 10000);
      } finally {
        if (this.active) {
          try { this.saveYouTrackSyncResults(); } catch (_) { new Notice('Could not save YouTrack recovery status. Check YouTrack before retrying.'); }
          this.refreshHomes();
        }
      }
    });
    this.youtrackSyncJobs.set(id, job);
    try { await job; } finally { if (this.youtrackSyncJobs.get(id) === job) { this.youtrackSyncJobs.delete(id); this.youtrackSyncRequests.delete(id); } }
  }

  async persistYouTrackSnapshot(snapshot) {
    const fs = require('fs').promises, crypto = require('crypto');
    const dir = this.manifest?.dir || `${this.app.vault.configDir || '.obsidian'}/plugins/aimultiple-kanban-extras`;
    const destination = this.app.vault.adapter.getFullPath(`${dir}/youtrack-widget.json`);
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(snapshot, null, 2) + '\n'); await handle.sync();
      await handle.close();
      if (!this.active) throw Error('Plugin unloaded');
      await fs.rename(temporary, destination);
    } finally {
      if (handle) { await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
    }
  }

  async refreshYouTrack() {
    if (!this.active || this.youtrackBusy || this.youtrackSetupBusy) return;
    if (!this.youtrackProfile) { this.openYouTrackSetup(); return; }
    if (!this.youtrackImports.size) this.youtrackImportMessage = '';
    this.youtrackBusy = true; this.youtrackRefreshError = ''; this.youtrackReadRevision++; this.refreshHomes();
    try {
      const data = await this.fetchYouTrackSnapshot();
      if (!this.active) return;
      if (!validYouTrackSnapshot(data,this.youtrackProfile)) throw Error();
      await this.persistYouTrackSnapshot(data);
      if (!this.active) return;
      this.youtrackSnapshot = data; this.youtrackSnapshotError = ''; this.youtrackRefreshError = '';
    } catch (error) {
      const messages = {
        runtime: 'Refresh needs desktop Obsidian and Python 3.11+ on this Mac.',
        connection: 'The local YouTrack connection is unavailable. Open YouTrack settings to check your connection.',
        authentication: 'YouTrack access was rejected. Reconnect in YouTrack settings, then try again.',
        identity: 'The local YouTrack connection belongs to another account. Check the configured login.',
        timeout: 'YouTrack took too long. Press Refresh all widgets to try again.',
        network: 'Could not reach YouTrack. Check your connection and try again.'
      };
      if (this.active) this.youtrackRefreshError = (Object.hasOwn(messages, error?.youtrackCode) ? messages[error.youtrackCode] : 'Could not refresh YouTrack. Try again.') + ' Kept the last saved list.';
    } finally { this.youtrackBusy = false; this.youtrackNextRefresh = Date.now() + 21600000; this.refreshHomes(); }
  }

  findYouTrackLocalNote(id) {
    const matches = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith('Hub/') &&
      this.app.metadataCache.getFileCache(file)?.frontmatter?.youtrack_id === id);
    const pending = this.youtrackImportedFiles.get(id);
    if (pending && this.app.vault.getAbstractFileByPath(pending.path) === pending && !matches.includes(pending)) matches.push(pending);
    if (matches.some(file => !this.youtrackNoteMatches(file))) throw Error('This issue ID belongs to another connection. Move the old copy outside Hub before importing.');
    if (matches.length > 1) throw Error(`More than one local note has ${id}. Resolve the duplicate before importing.`);
    return matches[0] || null;
  }

  clearYouTrackDrag() {
    this.youtrackDropTarget?.classList.remove('aim-youtrack-drop-target');
    this.youtrackDropTarget = null;
    this.youtrackDrag = null;
  }

  youtrackDropColumn(event) {
    if (!this.active || !this.youtrackDrag) return null;
    const target = event.target?.closest ? event.target : event.target?.parentElement;
    const column = target?.closest(COLUMN_SELECTOR);
    return column?.closest('.aim-home-host') && ['backlog', 'in-progress', 'done'].includes(column.getAttribute('data-column-value')) ? column : null;
  }

  handleYouTrackDragOver(event) {
    const column = this.youtrackDropColumn(event);
    if (this.youtrackDropTarget !== column) {
      this.youtrackDropTarget?.classList.remove('aim-youtrack-drop-target');
      this.youtrackDropTarget = column; column?.classList.add('aim-youtrack-drop-target');
    }
    if (!column) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  async handleYouTrackDrop(event) {
    const column = this.youtrackDropColumn(event);
    if (!column) return;
    const id = this.youtrackDrag.id;
    if (event.dataTransfer?.getData('application/x-es-hub-youtrack') !== id) { this.clearYouTrackDrag(); return; }
    const status = column.getAttribute('data-column-value');
    event.preventDefault(); event.stopImmediatePropagation(); this.clearYouTrackDrag();
    await this.runAction(() => this.importYouTrackIssue(id, status));
  }

  onYouTrackMenu(element, event) {
    event.preventDefault(); event.stopPropagation();
    const id = element.getAttribute('data-youtrack-id');
    if (!this.validYouTrackId(id || '')) return;
    const menu = new Menu();
    for (const [column, label] of [['backlog','Backlog'], ['in-progress','In progress'], ['done','Done']]) {
      menu.addItem(item => item.setTitle(`Add to ${label}`).setDisabled(this.youtrackImports.has(id))
        .onClick(() => this.runAction(() => this.importYouTrackIssue(id, column))));
    }
    try {
      const file = this.findYouTrackLocalNote(id);
      if (file) menu.addItem(item => item.setTitle('Open local note').onClick(() => this.runAction(() => this.openHomeFile(file))));
    } catch (_) {}
    menu.showAtMouseEvent(event);
  }

  async importYouTrackIssue(id, column) {
    if (this.youtrackSetupBusy) throw Error('Wait for the connection check to finish.');
    if (!this.active || !this.validYouTrackId(id) || !['backlog','in-progress','done'].includes(column)) throw Error('Invalid local import.');
    if (this.youtrackImports.has(id)) throw Error(`${id} is already being imported. Wait for it to finish.`);
    this.youtrackImports.set(id, true); this.youtrackImportMessage = `Importing ${id}…`; this.refreshHomes();
    const destination = `Hub/YouTrack/${id}.md`;
    const created = [];
    let committed = false;
    try {
      const existing = this.findYouTrackLocalNote(id);
      if (existing) {
        const fm = this.app.metadataCache.getFileCache(existing)?.frontmatter;
        if (fm?.youtrack_import !== 'local-v1') throw Error('This is an old mirror or an unrecognized note. It was left unchanged.');
        if (this.folderConversions.has(existing) || this.typeChanges.has(existing) || this.noteDeletions.has(existing)) throw Error('A file action is already in progress.');
        this.typeChanges.add(existing);
        this.youtrackSyncImports.set(existing, column);
        try {
          await this.app.fileManager.processFrontMatter(existing, front => {
            if (!this.active || this.app.vault.getAbstractFileByPath(existing.path) !== existing || !existing.path.startsWith('Hub/') ||
                front.youtrack_id !== id || front.youtrack_import !== 'local-v1') throw Error('The local note changed. Try again.');
            if (!fileHasKanbanTag({frontmatter: front})) front.tags = [...frontmatterTags(front.tags), 'kanban'];
            front.board_column = column; updateCompletion(front, new Date().toISOString(), 'status_change');
          });
        } catch (error) { this.youtrackSyncImports.delete(existing); throw error; }
        finally { this.typeChanges.delete(existing); }
        this.observeYouTrackState(existing, this.app.metadataCache.getFileCache(existing), false);
        this.youtrackImportMessage = `${id} moved to ${column}.`;
        return existing;
      }
      if (this.app.vault.getAbstractFileByPath(destination)) throw Error(`${destination} already exists. It was left unchanged.`);
      const detail = await this.fetchYouTrackDetail(id);
      if (!this.active) throw Error('Import cancelled.');
      validateYouTrackDetail(detail, id, this.youtrackProfile);
      // Recheck after the network wait; another view, Sync or writer may have created the note.
      if (this.findYouTrackLocalNote(id) || this.app.vault.getAbstractFileByPath(destination)) throw Error('A local note appeared during import. Drop again to use it.');
      const ensureFolder = async path => {
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing) { if (!Array.isArray(existing.children)) throw Error(`A file occupies ${path}.`); return; }
        await this.app.vault.createFolder(path);
      };
      const Buffer = require('node:buffer').Buffer;
      const attachments = detail.attachments.map(item => ({...item, bytes: Buffer.from(item.data, 'base64')}));
      let attachmentFolder = '';
      if (attachments.length) {
        await ensureFolder('Hub/Attachments'); await ensureFolder('Hub/Attachments/YouTrack');
        attachmentFolder = `Hub/Attachments/YouTrack/${id}-${Date.now()}`;
        if (this.app.vault.getAbstractFileByPath(attachmentFolder)) throw Error('Attachment destination exists. Try again.');
        await this.app.vault.createFolder(attachmentFolder);
        for (const attachment of attachments) {
          if (!this.active) throw Error('Import cancelled.');
          attachment.path = `${attachmentFolder}/${attachment.fileName}`;
          const bytes = attachment.bytes;
          const file = await this.app.vault.createBinary(attachment.path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
          created.push({file, bytes});
        }
      }
      if (!this.active) throw Error('Import cancelled.');
      await ensureFolder('Hub/YouTrack');
      if (!this.active || this.findYouTrackLocalNote(id)) throw Error('Import interrupted. Try again.');
      const file = await this.app.vault.create(destination, renderYouTrackLocalNote(detail, column, attachments));
      committed = true; this.youtrackImportedFiles.set(id, file);
      this.youtrackSyncImports.set(file, column);
      this.observeYouTrackState(file, this.app.metadataCache.getFileCache(file), false);
      this.youtrackImportMessage = `${id} added to ${column}.`;
      new Notice(this.youtrackImportMessage);
      return file;
    } catch (error) {
      if (!committed) for (const {file, bytes} of created) {
        // Roll back only the exact attachment bytes this attempt created, never another writer's changes.
        try {
          const Buffer = require('node:buffer').Buffer;
          if (this.app.vault.getAbstractFileByPath(file.path) === file && Buffer.from(await this.app.vault.readBinary(file)).equals(bytes)) await this.app.vault.trash(file, false);
        } catch (_) {}
      }
      const codes = {
        runtime:'Import needs desktop Obsidian and Python 3.11+.', connection:'Open YouTrack settings to check your connection.',
        authentication:'Reconnect in YouTrack settings.', identity:'Check the configured YouTrack login.',
        issue:'The issue is no longer available to this account or is assigned elsewhere.',
        changed:'The issue changed during import. Drop it again.', attachment:'An attachment could not be downloaded. Drop again to retry.',
        attachment_size:'Attachments exceed the import limit (20 MB each, 50 MB total).',
        incomplete:'YouTrack returned incomplete content. Drop again to retry.', network:'Could not reach YouTrack. Try again.',
        timeout:'YouTrack took too long. Drop again to retry.', protocol:'The YouTrack response could not be read. Try again.', reader:'The local YouTrack reader failed. Try again.'
      };
      const message = error.youtrackCode ? codes[error.youtrackCode] || 'Could not read the issue. Try again.' : error.message;
      this.youtrackImportMessage = `${id} was not imported. ${message}`;
      throw Error(this.youtrackImportMessage);
    } finally { this.youtrackImports.delete(id); this.refreshHomes(); }
  }

  youTrackIssueFilter(issue) {
    if (issue.completed || issue.state === this.youtrackStates.done) return 'done';
    if (issue.state === this.youtrackStates.backlog) return 'backlog';
    return issue.state === this.youtrackStates['in-progress'] ? 'in-progress' : 'other';
  }

  homeYouTrackIssues(filter = 'all') {
    const rows = new Map((this.youtrackSnapshot?.issues || []).filter(item => validYouTrackWidgetIssue(item, this.youtrackProfile)).map(item => [item.id, {...item,completed:false}]));
    for (const item of this.youtrackSnapshot?.completed?.issues || []) {
      if (!rows.has(item.id) && validYouTrackWidgetIssue(item,this.youtrackProfile)) rows.set(item.id,{...item,completed:true});
    }
    const stamp = Date.parse(this.youtrackSnapshot?.fetchedAt) || 0;
    for (const [id, value] of this.youtrackVerifiedIssues) {
      if (value.at >= stamp && validYouTrackWidgetIssue(value.issue, this.youtrackProfile)) rows.set(id, value.issue);
    }
    return [...rows.values()].map(item => {
      const result = this.youtrackSyncResults.get(item.id);
      return result?.status === 'synced' && result.at >= stamp ? {...item, state:this.youtrackStates[result.column],completed:result.column==='done'} : item;
    }).filter(item => filter === 'all' || this.youTrackIssueFilter(item) === filter);
  }

  updateYouTrackWidget(entry) {
    const filter = entry.youtrackFilter || 'backlog', issues = this.homeYouTrackIssues(filter);
    const hasOther = this.homeYouTrackIssues('other').length > 0;
    for (const [id,control] of entry.youtrackFilters || []) {
      control.setAttribute('aria-pressed',String(id === filter));
      control.hidden = id === 'other' && !hasOther && filter !== 'other';
      control.title = id === 'done' ? 'Recently completed issues, including all resolved states'
        : id === 'other' ? 'Other states among your loaded issues' : `State: ${this.youtrackStates[id]}`;
    }
    const localStates = issues.map(issue => {
      try { const file = this.findYouTrackLocalNote(issue.id); const cache = file && this.app.metadataCache.getFileCache(file);
        return cache && fileHasKanbanTag(cache) ? cache.frontmatter?.board_column || 'on board' : file ? 'saved' : ''; }
      catch (_) { return 'check duplicates'; }
    });
    const key = JSON.stringify([filter, this.youtrackSnapshot?.completed?.hasMore, issues, localStates, [...this.youtrackImports.keys()], [...this.youtrackSyncResults], this.youtrackImportMessage, this.youtrackSnapshot?.fetchedAt, this.youtrackSnapshotError, this.youtrackRefreshError, this.youtrackBusy]);
    if (key === entry.youtrackKey) return;
    const oldScroll = entry.youtrackList.scrollTop, sameFilter = entry.youtrackLastFilter === filter;
    entry.youtrackKey = key; entry.youtrackLastFilter = filter; entry.youtrackList.replaceChildren();
    homeText(entry.youtrackCount, `${issues.length} shown`);
    entry.youtrackCount.title = this.youtrackProfile ? `${this.youtrackProfile.project} · Assigned to ${this.youtrackProfile.login}` : 'Assigned issues';
    if (filter === 'done' && this.youtrackSnapshot?.completed?.hasMore) entry.youtrackList.append(homeElement(entry.scope.ownerDocument,'p','aim-home-caption','Latest 20 completed issues. Open YouTrack for more.'));
    const groups = new Map();
    for (const [index,issue] of issues.entries()) { const state = issue.state || 'Open'; if (!groups.has(state)) groups.set(state,[]); groups.get(state).push([index,issue]); }
    for (const [state,items] of groups) {
      entry.youtrackList.append(homeElement(entry.scope.ownerDocument,'h4','aim-widget-group',state));
      for (const [index, issue] of items) {
        const link = homeElement(entry.scope.ownerDocument, 'a', 'aim-home-issue');
        link.dataset.youtrackId = issue.id;
        link.draggable = !this.youtrackImports.has(issue.id);
        link.title = 'Drag to a kanban column, or right-click to add. Click to open YouTrack.';
        link.addEventListener('dragstart', event => {
          if (!this.active || this.youtrackImports.has(issue.id) || !event.dataTransfer) { event.preventDefault(); return; }
          this.youtrackDrag = {id: issue.id, doc: link.ownerDocument};
          event.dataTransfer.setData('application/x-es-hub-youtrack', issue.id);
          event.dataTransfer.effectAllowed = 'copy';
        });
        link.href = issue.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.append(homeElement(entry.scope.ownerDocument, 'span', 'aim-home-note-name', issue.title),
          homeElement(entry.scope.ownerDocument, 'span', 'aim-home-caption', `${issue.id}${issue.priority ? ` · ${issue.priority}` : ''}`));
        const local = this.youtrackImports.has(issue.id) ? 'Importing…' : localStates[index] ? `Local: ${localStates[index]}` : '';
        if (local) link.append(homeElement(entry.scope.ownerDocument, 'span', 'aim-home-local-state', local));
        entry.youtrackList.append(link);
      }
    }
    if (!issues.length) entry.youtrackList.append(homeElement(entry.scope.ownerDocument, 'p', 'aim-home-empty',
      this.youtrackSnapshot ? filter === 'done' && !this.youtrackSnapshot.completed ? 'Completed issues are not loaded yet. Use Refresh all widgets.' : 'No issues in this view among the loaded results.' : 'Connect your account in YouTrack settings. Your board works without a connection.'));
    entry.youtrackList.scrollTop = sameFilter ? oldScroll : 0;
    const message = this.youtrackImportMessage || this.youtrackRefreshError || this.youtrackSnapshotError;
    entry.youtrackMessage.replaceChildren();
    if (message) entry.youtrackMessage.append(homeElement(entry.scope.ownerDocument, 'span', '', message));
    let reports = 0;
    for (const [id, value] of this.youtrackSyncResults) {
      if (value.status === 'synced') continue;
      reports++;
      const report = homeElement(entry.scope.ownerDocument, 'span', 'aim-home-sync-result', this.youtrackSyncText(id, value));
      if (value.status !== 'pending') {
        const retry = homeElement(entry.scope.ownerDocument, 'button', '', `Retry ${id}`); retry.type = 'button';
        retry.addEventListener('click', () => { void this.runAction(async () => {
          const file = this.findYouTrackLocalNote(id);
          if (!file || !Object.hasOwn(this.youtrackStates, this.app.metadataCache.getFileCache(file)?.frontmatter?.board_column)) throw Error('Choose a valid local status first.');
          await this.syncYouTrackIssue(file);
        }); });
        report.append(retry);
      }
      entry.youtrackMessage.append(report);
    }
    entry.youtrackMessage.hidden = !message && !reports;
    if (entry.youtrackSource) { entry.youtrackSource.hidden = !this.youtrackProfile; entry.youtrackSource.href = this.youtrackProfile ? `https://${this.youtrackProfile.host}/issues` : '#'; }
    entry.youtrackList.setAttribute('aria-busy', String(this.youtrackBusy));
    const stamp = this.youtrackSnapshot?.fetchedAt;
    homeText(entry.youtrackStatus, this.youtrackBusy ? 'Refreshing…' : !this.youtrackProfile ? 'Not connected' : (stamp ? `Updated ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(stamp))}` : 'Not loaded') + ' · Auto 6h');
    entry.youtrackStatus.title = (stamp ? `Last read ${new Date(stamp).toLocaleString('en-GB')}. ` : '') + 'Reads your open and recent completed cards every 6 hours while YouTrack is visible, or with Refresh all widgets. Updates only this snapshot; never imports notes or changes issue status.';
  }

  async ensureQuickNotesFolder() {
    let folder = this.app.vault.getAbstractFileByPath(DEFAULT_CAPTURE_FOLDER);
    if (!folder) {
      try { await this.app.vault.createFolder(DEFAULT_CAPTURE_FOLDER); }
      catch (error) {
        if (!this.app.vault.getAbstractFileByPath(DEFAULT_CAPTURE_FOLDER)?.children) throw error;
      }
      folder = this.app.vault.getAbstractFileByPath(DEFAULT_CAPTURE_FOLDER);
    }
    if (!folder?.children) throw new Error(`${DEFAULT_CAPTURE_FOLDER} is not a folder.`);
  }

  async openQuickNote() {
    return this.createCapturedNote("");
  }

  async createBacklogNote() {
    return this.createCapturedNote(this.cardContent("backlog", "Quick Notes", "medium"));
  }

  async createCapturedNote(content, options = {}) {
    if (this.captureBusy) return null;
    this.captureBusy = true;
    this.refreshToolbars();
    try {
      const folder = DEFAULT_CAPTURE_FOLDER;
      await this.ensureQuickNotesFolder();
      const now = new Date();
      const pad = (value) => String(value).padStart(2, "0");
      const name = options.title || `Not ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
      let file;
      for (let index = 1; index <= 100; index++) {
        const path = `${folder}/${name}${index === 1 ? "" : ` (${index})`}.md`;
        if (this.app.vault.getAbstractFileByPath(path)) continue;
        try { await options.beforeCreate?.(path); file = await this.app.vault.create(path, content); break; }
        catch (error) {
          // Sync or another capture may have claimed the name between check/create.
          if (!this.app.vault.getAbstractFileByPath(path)) throw error;
        }
      }
      if (!file) throw new Error("Could not find an available filename for the new note.");
      try { if (options.open !== false) await this.openNoteForWriting(file); }
      catch (error) { throw new Error(`Note saved: ${file.path}. Could not open it: ${error.message || error}`); }
      return file;
    } finally {
      this.captureBusy = false;
      this.refreshToolbars(); this.refreshHomes();
    }
  }

  async openNoteForWriting(file) {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file, { active: true, state: { mode: "source" } });
    leaf.view.editor?.focus();
  }

  // ---------- every Markdown note: membership action above the editor ----------

  syncNoteToolbars() {
    if (!this.active) return;
    const live = new Set();
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.getViewType?.() !== "markdown" || !(leaf.view.file instanceof TFile)) return;
      live.add(leaf);
      let entry = this.noteToolbars.get(leaf);
      const scope = leaf.view.containerEl;
      if (entry?.view !== leaf.view || entry?.scope !== scope) {
        this.removeNoteToolbar(leaf);
        entry = { leaf, view: leaf.view, scope, toolbar: null };
        this.noteToolbars.set(leaf, entry);
        // Only direct children: typing/CodeMirror mutations need no observation.
        entry.observer = new scope.ownerDocument.defaultView.MutationObserver(() => {
          if (leaf.view !== entry.view || !(leaf.view.file instanceof TFile)) this.syncNoteToolbars();
          else this.mountNoteToolbar(entry);
        });
        entry.observer.observe(scope, { childList: true });
      }
      this.mountNoteToolbar(entry);
    });
    for (const leaf of this.noteToolbars.keys()) if (!live.has(leaf)) this.removeNoteToolbar(leaf);
  }

  removeNoteToolbar(leaf) {
    const entry = this.noteToolbars.get(leaf);
    if (!entry) return;
    entry.observer.disconnect();
    entry.popover?.close();
    entry.scope.classList.remove("aim-note-properties-managed");
    entry.toolbar?.remove();
    this.noteToolbars.delete(leaf);
  }

  mountNoteToolbar(entry) {
    if (!this.active) return;
    const content = entry.view.contentEl;
    if (!content?.parentElement || !entry.scope.contains(content)) {
      entry.toolbar?.remove();
      return;
    }
    if (!entry.toolbar) {
      const doc = entry.scope.ownerDocument;
      entry.toolbar = doc.createElement("div");
      entry.toolbar.className = "aim-note-toolbar";
      entry.toolbar.setAttribute("role", "group");
      entry.toolbar.setAttribute("aria-label", "Note actions");
      entry.button = doc.createElement("button");
      entry.button.type = "button";
      // Resolve the leaf's current file at click time, including same-tab navigation.
      entry.button.addEventListener("click", () => { void this.runAction(() => this.openNoteBoardModal(entry.leaf)); });
      entry.removeButton = doc.createElement("button");
      entry.removeButton.type = "button";
      entry.removeButton.textContent = "Remove from board";
      entry.removeButton.title = "Remove from the board and keep the note";
      entry.removeButton.addEventListener("click", async () => {
        entry.removeButton.disabled = true;
        await this.runAction(() => this.removeNoteFromBoard(entry.leaf));
        this.updateNoteToolbar(entry);
      });
      entry.hint = doc.createElement("span");
      entry.hint.className = "aim-note-toolbar-hint";
      entry.toolbar.append(entry.button, entry.removeButton, entry.hint);
      entry.propertyButtons = new Map();
      for (const key of [...Object.keys(NOTE_FIELDS), "tags", "other"]) {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "aim-note-property-button";
        button.dataset.property = key;
        button.setAttribute("aria-haspopup", "dialog");
        button.setAttribute("aria-expanded", "false");
        button.addEventListener("click", () => this.openPropertyPicker(entry, key));
        entry.propertyButtons.set(key, button);
        entry.toolbar.append(button);
      }
      const fileActions = doc.createElement("div");
      fileActions.className = "aim-note-file-actions";
      entry.folderButton = doc.createElement("button");
      entry.folderButton.type = "button";
      entry.folderButton.className = "aim-note-folder-button";
      entry.folderButton.textContent = "Make a folder";
      entry.folderButton.addEventListener("click", () => {
        entry.popover?.close();
        void this.runAction(() => this.makeNoteFolder(entry.leaf));
      });
      const deleteAction = doc.createElement("div");
      deleteAction.className = "aim-note-delete-action";
      entry.deleteButton = doc.createElement("button");
      entry.deleteButton.type = "button";
      entry.deleteButton.className = "aim-note-delete-button";
      entry.deleteButton.textContent = "Delete note";
      entry.deleteButton.title = "Delete only this note; keep its folder and other files";
      entry.deleteButton.addEventListener("click", async () => {
        if (entry.deleting) return;
        entry.popover?.close();
        entry.deleting = true;
        this.updateNoteToolbar(entry);
        try { await this.runAction(() => this.requestNoteDeletion(entry.leaf)); }
        finally {
          entry.deleting = false;
          this.updateNoteToolbar(entry);
        }
      });
      deleteAction.append(entry.deleteButton);
      fileActions.append(entry.folderButton, deleteAction);
      entry.toolbar.append(fileActions);
    }
    // Stay outside both CodeMirror and the rendered Markdown document.
    if (entry.toolbar.nextElementSibling !== content) content.before(entry.toolbar);
    this.updateNoteToolbar(entry);
  }

  noteBoardState(file) {
    const state = { label: "Add to board", canAdd: false, canRemove: false, hint: "", title: "This note cannot be added to the board." };
    if (!(file instanceof TFile) || file.extension !== "md" || this.app.vault.getAbstractFileByPath(file.path) !== file) return state;
    if (!file.path.startsWith("Hub/")) {
      state.title = state.hint = "Move this note into Hub to add it to the board.";
      return state;
    }
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) {
      state.title = "Loading note properties.";
      return state;
    }
    if (fileHasKanbanTag(cache)) return { ...state, label: "On board", canRemove: true, title: "This note is already on Kanban Board." };
    return { ...state, canAdd: true, title: "Add this note to Kanban Board" };
  }

  updateNoteToolbar(entry) {
    if (!entry.toolbar) return;
    const file = entry.leaf.view.file;
    if (entry.propertyFile !== file) entry.popover?.close();
    entry.propertyFile = file;
    const state = this.noteBoardState(file);
    if (entry.button.textContent !== state.label) entry.button.textContent = state.label;
    entry.button.disabled = !state.canAdd;
    entry.button.title = state.title;
    entry.removeButton.hidden = !state.canRemove;
    entry.removeButton.disabled = !state.canRemove;
    const fileBusy = this.folderConversions.has(file) || this.typeChanges.has(file) || this.noteDeletions.has(file);
    entry.folderButton.disabled = !this.canMakeFolder(file);
    entry.folderButton.title = file?.parent?.name === file?.basename
      ? "This note is already a folder note." : "Wrap this note in a folder with the same name, in its current location";
    entry.deleteButton.disabled = !!entry.deleting || fileBusy || !this.canDeleteNote(file);
    if (entry.hint.textContent !== state.hint) entry.hint.textContent = state.hint;
    entry.hint.hidden = !state.hint;
    const cache = file && this.app.metadataCache.getFileCache(file);
    const ready = !!cache && this.app.vault.getAbstractFileByPath(file.path) === file;
    entry.scope.classList.toggle("aim-note-properties-managed", ready);
    const fm = cache?.frontmatter ?? {};
    for (const [key, button] of entry.propertyButtons) {
      button.disabled = !ready || (key === "category" && fileBusy);
      button.hidden = key in NOTE_FIELDS && !file?.path.startsWith("Hub/") && !Object.hasOwn(fm, key);
      const value = key === "category" ? this.categoryValue(fm[key]) : fm[key];
      const unset = key in NOTE_FIELDS && (value == null || (typeof value === "string" && !value.trim()));
      button.classList.toggle("is-unset", unset);
      const displayValue = key === "board_column" || key === "priority"
        ? propertyValueLabel(value).replace(/-/g, " ").replace(/^./, (letter) => letter.toUpperCase())
        : propertyValueLabel(value);
      const label = key === "tags" ? `Tags: ${(cache ? getAllTags(cache) : [])?.length ?? 0}`
        : key === "other" ? "Other properties"
        : unset ? `Set ${NOTE_FIELDS[key].toLowerCase()}`
        : `${NOTE_FIELDS[key]}: ${displayValue}`;
      if (button.textContent !== `${label} ▾`) button.textContent = `${label} ▾`;
      button.title = key === "category" && file?.path.startsWith("Hub/")
        ? `${label}. Choosing a Type moves this note to its Hub folder.` : label;
    }
  }

  refreshNoteToolbars(file) {
    if (!this.active) return;
    for (const entry of this.noteToolbars.values()) {
      if (!file || entry.leaf.view.file === file) {
        this.updateNoteToolbar(entry);
        entry.popover?.refresh();
      }
    }
  }

  openNoteBoardModal(leaf) {
    const file = leaf.view.file;
    if (this.noteBoardState(file).canAdd) this.openAddToBoardModal(file);
  }

  async removeNoteFromBoard(leaf) {
    const file = leaf.view.file;
    if (this.noteBoardState(file).canRemove) await this.removeFromBoard(file);
  }

  canDeleteNote(file) {
    return file instanceof TFile && file.extension === "md" && this.app.vault.getAbstractFileByPath(file.path) === file;
  }

  async requestNoteDeletion(leaf) {
    const file = leaf.view.file;
    if (!this.canDeleteNote(file) || this.folderConversions.has(file) || this.typeChanges.has(file) || this.noteDeletions.has(file)) return;
    // Even a folder note targets the TFile, never its parent folder.
    this.noteDeletions.add(file);
    this.refreshNoteToolbars(file);
    try { await this.app.fileManager.promptForDeletion(file); }
    finally { this.noteDeletions.delete(file); this.refreshNoteToolbars(file); }
  }

  canMakeFolder(file) {
    return this.canDeleteNote(file) && file.parent?.name !== file.basename &&
      !this.folderConversions.has(file) && !this.typeChanges.has(file) && !this.noteDeletions.has(file);
  }

  async makeNoteFolder(leaf) {
    return this.convertFileToFolder(leaf.view.file);
  }

  propertyValues(key) {
    return key === "board_column" ? this.taxonomy.columns
      : key === "priority" ? this.taxonomy.priorities
      : key === "category" ? this.categoryValues() : null;
  }

  async setNoteProperty(file, key, value, snapshot) {
    if (!(file instanceof TFile) || this.app.vault.getAbstractFileByPath(file.path) !== file) throw new Error("Note not found.");
    if (!key || RESERVED_PROPERTIES.has(key) || MANAGED_PROPERTIES.has(key) || key === "tags" || key === "tag") throw new Error("Use the dedicated control to edit this property.");
    if (key === "category" && value !== undefined) value = this.categoryValue(value);
    const values = this.propertyValues(key);
    if (values && value !== undefined && !values.includes(value)) throw new Error("Invalid property value.");
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Enter a valid number.");
    const write = () => this.app.fileManager.processFrontMatter(file, (fm) => {
      if (snapshot !== undefined && snapshot !== propertySnapshot(fm, key)) throw new Error("This property changed elsewhere. Reopen the menu.");
      const isCard = fileHasKanbanTag({ ...this.app.metadataCache.getFileCache(file), frontmatter: fm });
      if (key === "board_column" && value === undefined && isCard) throw new Error("A note on the board must have a status.");
      if (value === undefined) delete fm[key];
      else fm[key] = value;
      if (key === "board_column" && isCard) updateCompletion(fm, new Date().toISOString(), "status_change");
    });
    if (key === "category") {
      if (this.folderConversions.has(file) || this.noteDeletions.has(file)) throw new Error("A file action is already in progress for this note.");
      if (this.typeChanges.has(file)) throw new Error("A Type change is already in progress for this note.");
      this.typeChanges.add(file);
      this.refreshNoteToolbars(file);
      try {
        let move = null;
        if (value !== undefined && file.path.startsWith("Hub/")) {
          const target = `Hub/${value}`;
          this.requireMoveTarget(target);
          // Selecting the current top-level Type must preserve nested study/reference folders.
          if (!file.path.startsWith(`${target}/`)) move = this.planCardMove(file, target);
        }
        if (move) {
          const cache = this.app.metadataCache.getFileCache(file);
          if (!cache) throw new Error("Loading note properties. Try again shortly.");
          const current = propertySnapshot(cache.frontmatter ?? {}, key);
          if (snapshot !== undefined && snapshot !== current) throw new Error("This property changed elsewhere. Reopen the menu.");
          snapshot = current;
          await this.app.fileManager.renameFile(move.subject, move.newPath);
        }
        try { await write(); }
        catch (error) {
          if (move) {
            try {
              if (move.subject.path !== move.newPath || this.app.vault.getAbstractFileByPath(move.newPath) !== move.subject ||
                  this.app.vault.getAbstractFileByPath(move.oldPath)) throw new Error("The note location changed during the operation.");
              await this.app.fileManager.renameFile(move.subject, move.oldPath);
            } catch (rollbackError) {
              const message = `Type could not be saved: ${error.message || error}. Current note: ${file.path}. Could not restore its location: ${rollbackError.message || rollbackError}`;
              new Notice(message);
              throw new Error(message);
            }
          }
          throw error;
        }
      } finally {
        this.typeChanges.delete(file);
        this.refreshNoteToolbars(file);
      }
    } else await write();
    return true;
  }

  async toggleNoteTag(file, tag) {
    const value = String(tag).trim().replace(/^#/, "");
    if (!value || !/^[\p{L}\p{N}_/-]+$/u.test(value) || /^\d+$/.test(value)) throw new Error("Enter a valid tag.");
    if (isKanbanTag(value)) throw new Error("Use Add to board / Remove from board to change board membership.");
    if (this.app.vault.getAbstractFileByPath(file.path) !== file) throw new Error("Note not found.");
    const normalized = normalizeTag(value);
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      const keys = ["tags", "tag"];
      const present = keys.some((key) => frontmatterTags(fm[key]).some((item) => normalizeTag(item) === normalized));
      const inline = this.app.metadataCache.getFileCache(file)?.tags?.some((item) => normalizeTag(item.tag) === normalized);
      if (!present && inline) throw new Error("This tag is in the note body. Remove it from the text.");
      if (present) {
        for (const key of keys) if (Object.hasOwn(fm, key)) fm[key] = frontmatterTags(fm[key]).filter((item) => normalizeTag(item) !== normalized);
      } else {
        const key = Object.hasOwn(fm, "tags") || !Object.hasOwn(fm, "tag") ? "tags" : "tag";
        fm[key] = [...frontmatterTags(fm[key]), value];
      }
    });
    return true;
  }

  tagOptions(file, hiddenOnly = false) {
    const tags = new Map();
    for (const note of this.app.vault.getMarkdownFiles()) {
      const metadata = this.app.metadataCache.getFileCache(note);
      for (const tag of metadata ? getAllTags(metadata) ?? [] : []) {
        tags.set(normalizeTag(tag), String(tag).replace(/^#/, ""));
      }
    }
    const cache = this.app.metadataCache.getFileCache(file) ?? {};
    const front = new Set(["tags", "tag"].flatMap((key) => frontmatterTags(cache.frontmatter?.[key])).map(normalizeTag));
    const inline = new Set((cache.tags ?? []).map((item) => normalizeTag(item.tag)));
    // Hidden preferences remain restorable even after the last source note is removed.
    if (hiddenOnly) for (const tag of this.hiddenTagSuggestions) if (!tags.has(tag)) tags.set(tag, tag);
    return [...tags].map(([tag, label]) => ({
      tag, label, selected: front.has(tag) || inline.has(tag),
      bodyOnly: inline.has(tag) && !front.has(tag), hidden: this.hiddenTagSuggestions.has(tag),
    })).filter((item) => hiddenOnly ? item.hidden : !item.hidden || item.selected)
      .sort((a, b) => Number(b.selected) - Number(a.selected) || a.label.localeCompare(b.label));
  }

  async setTagSuggestionHidden(tag, hidden) {
    const normalized = normalizeTag(tag);
    if (!normalized) throw new Error("Choose a tag to hide.");
    if (isKanbanTag(normalized)) throw new Error("Board membership tags cannot be hidden.");
    // Serialize preference changes across leaves; notes and metadata are never written.
    const job = this.tagSuggestionSave.then(async () => {
      const loaded = await this.loadData();
      const settings = loaded && typeof loaded === "object" && !Array.isArray(loaded) ? loaded : {};
      const next = hiddenTagsFromSettings(settings);
      if (hidden) next.add(normalized);
      else next.delete(normalized);
      await this.saveData({ ...settings, hiddenTagSuggestions: [...next].sort() });
      this.hiddenTagSuggestions = next;
      if (this.active) for (const entry of this.noteToolbars.values()) {
        if (entry.popover?.key === "tags") entry.popover.refresh();
      }
    });
    this.tagSuggestionSave = job.catch(() => {});
    return job;
  }

  openPropertyPicker(entry, key) {
    const file = entry.leaf.view.file;
    if (!(file instanceof TFile) || !this.app.metadataCache.getFileCache(file)) return;
    if (entry.popover?.key === key) { entry.popover.close(); return; }
    entry.popover?.close();
    const popover = new NotePropertyPopover(this, entry.propertyButtons.get(key), file, key);
    entry.popover = popover;
    popover.onClose = () => { if (entry.popover === popover) entry.popover = null; };
    popover.open();
  }

  seedCompletion() {
    if (!this.active) return;
    for (const file of this.app.vault.getMarkdownFiles()) {
      this.queueCompletion(file, this.app.metadataCache.getFileCache(file), true);
    }
    this.updateWip();
  }

  queueCompletion(file, cache, legacy) {
    this.observeYouTrackState(file, cache, legacy);
    if (!this.active || !file.path.startsWith("Hub/") || !cache || !fileHasKanbanTag(cache)) return;
    const front = cache.frontmatter ?? {};
    const previouslyObserved = this.observedColumns.has(file);
    this.observedColumns.set(file, front.board_column);
    const estimated = legacy || (!previouslyObserved && file.stat.ctime < this.startedAt);
    if (!needsCompletionUpdate(front)) return;
    const instant = new Date(file.stat.mtime).toISOString();
    // Serialize writes for the same note and recheck its current frontmatter.
    const previous = this.completionJobs.get(file) ?? Promise.resolve();
    const job = previous.then(() => {
      if (!this.active || !this.app.vault.getAbstractFileByPath(file.path)) return;
      const current = this.app.metadataCache.getFileCache(file);
      if (!current || !fileHasKanbanTag(current) || !needsCompletionUpdate(current.frontmatter ?? {})) return;
      return this.runAction(() => this.app.fileManager.processFrontMatter(file, (fm) => {
        updateCompletion(fm, instant, estimated ? "legacy_mtime" : "status_change");
      }));
    });
    this.completionJobs.set(file, job);
    void job.finally(() => { if (this.completionJobs.get(file) === job) this.completionJobs.delete(file); });
  }

  updateWip() {
    if (!this.active) return;
    const count = this.app.vault.getMarkdownFiles().filter((file) => {
      const cache = this.app.metadataCache.getFileCache(file);
      return file.path.startsWith("Hub/") && cache && fileHasKanbanTag(cache) && cache.frontmatter?.board_column === "in-progress";
    }).length;
    const limit = this.taxonomy.wip_limit;
    this.status.setText(`Kanban WIP: ${count}/${limit}`);
    this.status.toggleClass("is-over-limit", count > limit);
    this.status.setAttribute("aria-label", `${count} items in progress; suggested limit ${limit}. Open board.`);
  }

  // ---------- card context menu ----------

  onCardRightClick(card, e) {
    const filePath = card.getAttribute("data-entry-path");
    if (!filePath) return;
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile) || file.extension !== "md" || !file.path.startsWith("Hub/")) return;

    e.preventDefault();
    e.stopPropagation();
    const menu = new Menu();
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};

    if (this.youtrackProfile?.syncEnabled && fm.youtrack_import === 'local-v1' && this.validYouTrackId(fm.youtrack_id) && Object.hasOwn(this.youtrackStates, fm.board_column)) {
      menu.addItem(item => item.setTitle('Sync status to YouTrack').setIcon('refresh-cw')
        .setDisabled(this.youtrackSyncJobs.has(fm.youtrack_id))
        .onClick(() => this.runAction(() => this.syncYouTrackIssue(file))));
    }

    menu.addItem((item) => {
      item.setTitle("Set priority").setIcon("flag");
      const sub = item.setSubmenu();
      for (const p of this.taxonomy.priorities) {
        sub.addItem((si) => si
          .setTitle(p)
          .setChecked(fm.priority === p)
          .onClick(async () => {
            await this.runAction(() => this.app.fileManager.processFrontMatter(file, (front) => {
              front.priority = p;
            }));
          }));
      }
    });

    menu.addItem((item) => {
      item.setTitle("Set type").setIcon("tag");
      const sub = item.setSubmenu();
      for (const c of this.categoryValues()) {
        sub.addItem((si) => si
          .setTitle(c)
          .setChecked(this.categoryValue(fm.category) === c)
          .onClick(async () => {
            await this.runAction(() => this.setNoteProperty(file, "category", c));
          }));
      }
    });

    const isAlreadyFolderNote =
      file.parent && file.parent.name === file.basename;
    if (!isAlreadyFolderNote) {
      menu.addItem((item) => {
        item.setTitle("Convert to folder").setIcon("folder-plus");
        item.onClick(() => this.runAction(() => this.convertFileToFolder(file)));
      });
    }

    menu.addItem((item) => {
      item.setTitle("Move to folder").setIcon("folder-tree");
      const sub = item.setSubmenu();
      const currentParentPath = this.getEffectiveParentPath(file);
      for (const target of this.computeMoveTargets()) {
        sub.addItem((si) => si
          .setTitle(target.label)
          .setChecked(currentParentPath === target.path)
          .onClick(() => this.runAction(() => this.moveCardToFolder(file, target.path))));
      }
    });

    menu.addItem((item) => {
      item.setTitle("Delete").setIcon("trash");
      const sub = item.setSubmenu();

      // Least destructive: drop the card off the board by stripping the
      // `kanban` tag. File + folder + attachments stay untouched on disk —
      // fully reversible (re-add the tag to bring the card back).
      sub.addItem((si) => si
        .setTitle("Remove from board")
        .setIcon("eye-off")
        .onClick(() => this.runAction(() => this.removeFromBoard(file))));

      // Full delete. For a folder note (Hub/Foo/Foo.md) this takes the whole
      // wrapping folder — note + attachments + sub-notes — in one shot. For a
      // standalone card (e.g. a fresh quick-add not yet converted to a folder)
      // there's no folder to delete, so we delete the .md itself; otherwise
      // such cards would have no delete option at all. Label reflects what
      // actually gets removed; standalone delete is scoped to the single file
      // so it can't nuke a shared category folder (Hub/Benchmark/ etc.).
      // Native prompt handles confirm + Trash-vs-permanent per vault setting.
      if (isAlreadyFolderNote) {
        sub.addItem((si) => si
          .setTitle("Delete folder & contents")
          .setIcon("trash-2")
          .onClick(() => this.app.fileManager.promptForDeletion(file.parent)));
      } else {
        sub.addItem((si) => si
          .setTitle("Delete card")
          .setIcon("trash-2")
          .onClick(() => this.app.fileManager.promptForDeletion(file)));
      }
    });

    menu.showAtMouseEvent(e);
  }

  // ---------- column header context menu ----------

  onColumnRightClick(columnEl, e) {
    // Cards live inside the column and have their own listener; if their
    // handler runs it calls stopPropagation, so we won't reach here. But just
    // in case (e.g. clicks on card border), bail out if the right-click was
    // on a card.
    if (e.target?.closest?.(CARD_SELECTOR)) return;
    // Don't fight legitimate clicks on the drag handle, color picker, or the
    // header's own +/× buttons.
    if (e.target?.closest) {
      if (e.target.closest(".obk-column-drag-handle")) return;
      if (e.target.closest(".obk-column-color-btn")) return;
      if (e.target.closest(".obk-column-add-btn")) return;
      if (e.target.closest(".obk-column-remove-btn")) return;
    }
    const columnValue = columnEl.getAttribute("data-column-value");
    if (!columnValue) return;
    e.preventDefault();
    e.stopPropagation();

    const menu = new Menu();
    menu.addItem((item) => {
      item.setTitle(`Add new card to ${columnValue}`).setIcon("plus");
      item.onClick(() => this.openAddCardModal(columnValue, columnEl));
    });
    menu.showAtMouseEvent(e);
  }

  openAddCardModal(columnValue, columnEl) {
    const defaultFolder = this.inferFolderFromDom(columnEl);
    const moveTargets = this.computeMoveTargets();
    new AddCardModal(this.app, {
      columnValue,
      defaultFolder,
      moveTargets,
      taxonomy: this.typeTaxonomy(),
      onSubmit: ({ title, folder, category, priority }) =>
        this.runAction(() => this.createCard(title, columnValue, folder, category, priority)),
    }).open();
  }

  // ---------- file-explorer "Add to board" ----------

  /**
   * Surface "Add to board" in the file-menu for a plain markdown note that
   * isn't already on the board. Inverse of the card menu's "Remove from
   * board". Skips folders, non-md files, notes outside Hub/ (the board filter
   * is `hasTag(kanban) AND inFolder(Hub)`, so a tagged note elsewhere would
   * never surface — don't pretend otherwise), and notes that already carry a
   * `kanban` tag (frontmatter OR inline — checked via getAllTags).
   */
  onFileMenu(menu, file) {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    if (!file.path.startsWith("Hub/")) return;
    const cache = this.app.metadataCache.getFileCache(file);
    if (cache && fileHasKanbanTag(cache)) return; // already a card
    menu.addItem((item) => {
      item.setTitle("Add to board").setIcon("plus-circle");
      item.onClick(() => this.openAddToBoardModal(file));
    });
  }

  /**
   * Open the add-to-board modal, pre-filled from any leftover frontmatter.
   * Because "Remove from board" only strips the `kanban` tag (it deliberately
   * keeps board_column / category / priority), re-adding a previously-removed
   * card restores its old column/type/priority automatically — just hit "Add
   * to board".
   * Falls back to folder-inferred category, `backlog`, and `medium` when those
   * fields are absent (a note that was never a card).
   */
  openAddToBoardModal(file) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    const effectiveParent = file.parent?.path ?? "";
    const column = this.taxonomy.columns.includes(fm.board_column) ? fm.board_column : "backlog";
    const category =
      typeof fm.category === "string" && this.categoryValues().includes(this.categoryValue(fm.category))
        ? this.categoryValue(fm.category)
        : (this.inferCategoryFromFolder(effectiveParent) ?? "");
    const priority = this.taxonomy.priorities.includes(fm.priority) ? fm.priority : "medium";
    new AddToBoardModal(this.app, {
      file,
      column,
      category,
      priority,
      taxonomy: this.typeTaxonomy(),
      onSubmit: (opts) => this.runAction(() => this.addToBoard(file, opts)),
    }).open();
  }

  /**
   * Stamp kanban frontmatter onto an existing note: ensure the `kanban` tag
   * (preserving any existing tags), set board_column / priority, and set or
   * clear category. Membership is by tag, so this is all it takes to put the
   * note on the board — no file move, the note stays exactly where it is.
   */
  async addToBoard(file, { column, category, priority }) {
    if (category) {
      category = this.categoryValue(category);
      if (!this.categoryValues().includes(category)) throw new Error("This Type folder no longer exists. Reopen the menu.");
    }
    const ensureKanban = (val) => {
      let arr;
      if (Array.isArray(val)) arr = val.slice();
      else if (typeof val === "string") arr = val.split(/[,\s]+/).filter(Boolean);
      else arr = [];
      if (!arr.some((t) => normalizeTag(t) === "kanban")) arr.push("kanban");
      return arr;
    };
    await this.app.fileManager.processFrontMatter(file, (front) => {
      if (Array.isArray(front.tags) || typeof front.tags === "string") {
        front.tags = ensureKanban(front.tags);
      } else if (Array.isArray(front.tag) || typeof front.tag === "string") {
        front.tag = ensureKanban(front.tag);
      } else {
        front.tags = ["kanban"];
      }
      const oldColumn = front.board_column;
      front.board_column = column;
      if (oldColumn !== column && column === "done") delete front.completed_at;
      updateCompletion(front, new Date().toISOString(), "status_change");
      front.priority = priority || "medium";
      if (category) front.category = category;
      else delete front.category;
    });
    new Notice(`Added to board: ${file.basename}`);
    return true;
  }

  /**
   * List Hub/ top-level subfolders, skipping utility folders. Used by both
   * the Move to folder submenu and the Add new card modal dropdown — any
   * Hub/<X>/ folder you create shows up immediately on next right-click,
   * no plugin code change needed.
   */
  computeMoveTargets() {
    const hub = this.app.vault.getAbstractFileByPath("Hub");
    if (!hub || !hub.children) return [];
    return hub.children
      .filter((c) => c.children !== undefined)
      .filter((c) => !c.name.startsWith("_") && !c.name.startsWith("."))
      .filter((c) => !this.taxonomy.excluded_folders.includes(c.name))
      .map((c) => ({ label: c.name, path: c.path }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  inferFolderFromDom(el) {
    const leaf = el.closest(".workspace-leaf");
    if (!leaf) return null;
    // Only an explicitly active Bases view may choose a folder. Unknown UI
    // versions and the unfiltered Board leave the choice to the user.
    for (const selector of [".bases-view-tab.is-active", ".bases-tab.is-active", ".bases-view-name.is-active", '.bases-view-tab[aria-selected="true"]']) {
      const name = leaf.querySelector(selector)?.textContent?.trim();
      if (name) {
        const folder = this.taxonomy.view_to_folder[name];
        return this.computeMoveTargets().some(target => target.path === folder) ? folder : null;
      }
    }
    return null;
  }

  async createCard(title, columnValue, folder, category, priority) {
    if (category) category = this.categoryValue(category);
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      new Notice("This folder no longer exists. Reopen the menu and choose a folder.");
      return false;
    }
    const safeName = title.replace(/[\\/:*?"<>|]/g, "").trim().replace(/\.md$/i, "").trim();
    if (!safeName || /^\.+$/.test(safeName) || /[\x00-\x1f\x7f]/.test(safeName)) {
      new Notice("Enter a valid card title.");
      return false;
    }
    if (!(folder === "Hub" || folder.startsWith("Hub/")) || folder.split("/").some(p => p === ".." || p === ".") ||
        !this.taxonomy.columns.includes(columnValue) || (category && !this.categoryValues().includes(category)) ||
        !this.taxonomy.priorities.includes(priority || "medium")) {
      new Notice("Invalid folder, column, type or priority.");
      return false;
    }
    const path = `${folder}/${safeName}.md`;
    for (const candidate of [path, `${folder}/${safeName}/${safeName}.md`]) {
      if (this.app.vault.getAbstractFileByPath(candidate)) {
        new Notice(`Already exists: ${candidate}`);
        return false;
      }
    }
    const file = await this.app.vault.create(path, this.cardContent(columnValue, category, priority));
    await this.runAction(() => this.app.workspace.getLeaf(false).openFile(file));
    return true;
  }

  cardContent(columnValue, category, priority) {
    return ["---", "tags:", "  - kanban",
      ...(category ? [`category: ${JSON.stringify(this.categoryValue(category))}`] : []),
      `board_column: ${columnValue}`, `priority: ${priority || "medium"}`,
      ...(columnValue === "done" ? [`completed_at: "${new Date().toISOString()}"`, "completed_at_source: status_change"] : []),
      "---", "", this.taxonomy.default_body].join("\n");
  }

  // ---------- shared helpers ----------

  async convertFileToFolder(file) {
    if (!this.canMakeFolder(file)) return false;
    this.folderConversions.add(file);
    this.refreshNoteToolbars(file);
    const source = file.path;
    const parentPath = source.slice(0, Math.max(0, source.lastIndexOf("/")));
    const folderPath = `${parentPath ? parentPath + "/" : ""}${file.basename}`;
    try {
      let folder = this.app.vault.getAbstractFileByPath(folderPath);
      const prepared = this.preparedFolders.get(file);
      if (folder && (prepared?.folder !== folder || prepared.source !== source || folder.children?.length !== 0)) {
        throw new Error(`Folder already exists: ${folderPath}`);
      }
      if (!folder) {
        folder = await this.app.vault.createFolder(folderPath);
        this.preparedFolders.set(file, { source, folder });
      }
      if (!this.canDeleteNote(file) || file.path !== source) throw new Error("The note moved or was deleted during folder creation. Reopen the note and try again.");
      const destination = `${folderPath}/${file.name}`;
      if (this.app.vault.getAbstractFileByPath(folderPath) !== folder || !folder?.children || folder.children.length ||
          this.app.vault.getAbstractFileByPath(destination)) throw new Error(`Folder changed during creation: ${folderPath}`);
      try { await this.app.fileManager.renameFile(file, destination); }
      catch (error) {
        // Keep our empty folder for retry; never remove a folder another plugin or Sync may use.
        throw new Error(`${error.message || error}. Note: ${file.path}. Prepared folder: ${folderPath}. Retry Make a folder if it is still empty.`);
      }
      this.preparedFolders.delete(file);
      return true;
    } finally {
      this.folderConversions.delete(file);
      this.refreshNoteToolbars(file);
    }
  }

  /**
   * Move a card to one of the auto-discovered Hub/ subfolders. If the card is already a
   * folder note (file.basename === file.parent.name) we move the parent folder
   * — that keeps the folder + its note + any attachments together. Otherwise
   * we move the file itself.
   */
  async moveCardToFolder(file, targetFolder) {
    if (this.folderConversions.has(file) || this.noteDeletions.has(file)) throw new Error("A file action is already in progress for this note.");
    if (this.typeChanges.has(file)) throw new Error("A Type change is already in progress for this note.");
    const move = this.planCardMove(file, targetFolder);
    if (!move) { new Notice(`Already in ${targetFolder}.`); return; }
    await this.app.fileManager.renameFile(move.subject, move.newPath);
  }

  requireMoveTarget(targetFolder) {
    if (!this.computeMoveTargets().some(target => target.path === targetFolder) ||
        !this.app.vault.getAbstractFileByPath(targetFolder)?.children) {
      throw new Error("This Type folder no longer exists. Reopen the menu.");
    }
  }

  planCardMove(file, targetFolder) {
    if (!(file instanceof TFile) || file.extension !== "md" || !file.path.startsWith("Hub/") ||
        this.app.vault.getAbstractFileByPath(file.path) !== file) throw new Error("Note not found.");
    this.requireMoveTarget(targetFolder);
    const isFolderNote =
      file.parent && file.parent.name === file.basename;
    const subject = isFolderNote ? file.parent : file;
    const subjectName = isFolderNote ? file.parent.name : file.name;
    if (isFolderNote && subject.path.split("/").length <= 2) throw new Error("A top-level Hub folder cannot be moved through its folder note.");
    const newPath = `${targetFolder}/${subjectName}`;
    if (subject.path === newPath) return null;
    const base = `${targetFolder}/${file.basename}`;
    if ([newPath, `${base}.md`, base, `${base}/${file.name}`].some(path => this.app.vault.getAbstractFileByPath(path))) {
      throw new Error(`Target already contains: ${file.basename}`);
    }
    return { subject, oldPath: subject.path, newPath };
  }

  categoryValues() {
    return this.computeMoveTargets().map(target => target.label);
  }

  categoryValue(value) {
    const categories = this.categoryValues();
    if (categories.includes(value)) return value;
    // Read old card values without bulk rewriting existing note metadata.
    for (const [folder, legacy] of Object.entries(this.taxonomy.folder_to_category)) {
      if (legacy === value && categories.includes(folder)) return folder;
    }
    return value;
  }

  typeTaxonomy() {
    const categories = this.categoryValues();
    return { ...this.taxonomy, categories, folder_to_category: Object.fromEntries(categories.map(name => [name, name])) };
  }

  inferCategoryFromFolder(folder) {
    if (!folder.startsWith("Hub/")) return undefined;
    const top = folder.split("/")[1];
    return this.categoryValues().includes(top) ? top : undefined;
  }

  /**
   * Return the "effective parent path" for checkmark display in the Move to
   * folder submenu. For a folder note this is the grandparent folder (since
   * `file.parent` is the wrapping folder, not the kanban category folder).
   */
  getEffectiveParentPath(file) {
    const isFolderNote =
      file.parent && file.parent.name === file.basename;
    return isFolderNote ? (file.parent.parent?.path ?? "") : (file.parent?.path ?? "");
  }

  /**
   * Drop a card off the kanban board without deleting anything on disk: strip
   * the `kanban` tag from frontmatter. Board membership is
   * `file.hasTag("kanban")`, so once the tag is gone the card disappears while
   * the note + folder + attachments stay put. Reversible — re-add the tag (or
   * the kanban template) to bring the card back. The board_column / category /
   * priority properties are intentionally left in place so a re-tag restores
   * the card's full state.
   *
   * Only touches frontmatter `tags`/`tag` (the vault convention). An inline
   * `#kanban` in the note body would NOT be caught — we surface a Notice when
   * no frontmatter kanban tag was found so the silent-no-op is visible.
   */
  async removeFromBoard(file) {
    const cache = this.app.metadataCache.getFileCache(file);
    const inlineRemains = (cache?.tags ?? []).some((entry) => isKanbanTag(entry.tag));
    let removed = false;
    const strip = (val) => {
      if (Array.isArray(val)) {
        const next = val.filter((t) => !isKanbanTag(t));
        if (next.length !== val.length) removed = true;
        return next;
      }
      if (typeof val === "string") {
        const parts = val.split(/[,\s]+/).filter(Boolean);
        const next = parts.filter((t) => !isKanbanTag(t));
        if (next.length !== parts.length) removed = true;
        return next; // string collapses to an array (YAML list — preferred form)
      }
      return val;
    };
    await this.app.fileManager.processFrontMatter(file, (front) => {
      for (const key of ["tags", "tag"]) {
        if (front[key] === undefined) continue;
        const next = strip(front[key]);
        if (Array.isArray(next) && next.length === 0) delete front[key];
        else front[key] = next;
      }
    });
    new Notice(inlineRemains
      ? `Still on the board: ${file.basename}. Remove the inline #kanban tag from the note body.`
      : removed ? `Removed from board: ${file.basename}`
      : `No "kanban" frontmatter tag on ${file.basename}.`);
  }
}


function normalizeSlackSources(value = {}) {
  const result = {};
  for (const key of ['channel','group']) {
    const raw = value?.[key] ?? '';
    if (typeof raw !== 'string') throw slackFailure('invalid');
    const name = raw.trim().replace(/^[#@]/,'');
    if (name && !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(name)) throw Object.assign(Error('Use a channel name or group handle without spaces, # or @.'), {slackSafe:true});
    result[key]=name;
  }
  return result;
}

function normalizeYouTrackProfile(value) {
  if (!value || typeof value !== 'object') throw Error('Enter your YouTrack connection details.');
  const host=String(value.host || '').trim().replace(/^https:\/\//,'').replace(/\/$/,'').toLowerCase();
  const login=String(value.login || '').trim(), project=String(value.project || '').trim().toUpperCase();
  if (host.length>253 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host) || /^\d+$/.test(host.split('.').at(-1))) throw Error('Enter the YouTrack hostname, for example company.youtrack.cloud. HTTPS is required; paths and ports are not supported.');
  if (!/^[A-Za-z0-9_.@+-]{1,100}$/.test(login)) throw Error('Enter your exact YouTrack login (not your display name).');
  if (!/^[A-Z][A-Z0-9_]{0,30}$/.test(project)) throw Error('Enter a project key, for example TEAM.');
  const states={};
  for (const column of ['backlog','in-progress','done']) {
    const state=value.states?.[column];
    if (typeof state!=='string' || !state.trim() || state.length>100 || /[\x00-\x1f\x7f]/.test(state)) throw Error('Enter all three YouTrack state names.');
    states[column]=state.trim();
  }
  if (new Set(Object.values(states)).size!==3) throw Error('Choose a different state for each board column.');
  return {host,login,project,states,syncEnabled:value.syncEnabled===true};
}

function validateYouTrackToken(value) {
  if (typeof value!=='string' || value.length<8 || value.length>8192 || /[^\x21-\x7e]/.test(value)) throw Error('Enter a permanent YouTrack token in this local field.');
  return value;
}

function parseYouTrackSecret(value) {
  if (!value) return null;
  const saved=JSON.parse(value);
  if (saved.version!==1) throw Error('Reconnect YouTrack.');
  return {version:1,profile:normalizeYouTrackProfile(saved.profile),token:validateYouTrackToken(saved.token)};
}

function commitYouTrackSecret(storage,next) {
  if (!storage?.getSecret || !storage?.setSecret) throw Error('Obsidian Keychain is unavailable. Update Obsidian.');
  const previous=storage.getSecret(YOU_TRACK_SECRET) || '';
  try {
    storage.setSecret(YOU_TRACK_SECRET,next);
    if ((storage.getSecret(YOU_TRACK_SECRET)||'')!==next) throw Error();
  } catch (_) {
    try { storage.setSecret(YOU_TRACK_SECRET,previous); if ((storage.getSecret(YOU_TRACK_SECRET)||'')!==previous) throw Error(); }
    catch (_) { throw Error('Keychain could not restore the previous connection. Reopen YouTrack settings.'); }
    throw Error('Could not save the connection to Keychain. The previous connection was retained.');
  }
}

function validYouTrackId(id,profile) {
  return !!profile && typeof id==='string' && id.startsWith(profile.project+'-') && /^[A-Z][A-Z0-9_]{0,30}-[0-9]+$/.test(id);
}

function validYouTrackSnapshot(value,profile) {
  if (!profile || !value || value.schema!==1 || value.source!=='YouTrack MCP' || value.assignee!==profile.login ||
      !Number.isFinite(Date.parse(value.fetchedAt)) || !Array.isArray(value.issues) || value.issues.length>400) return false;
  const ids=new Set(), valid=item=>validYouTrackWidgetIssue(item,profile) && !!item.title.trim() && typeof item.priority==='string' && !ids.has(item.id) && !!ids.add(item.id);
  if (!value.issues.every(item=>valid(item) && item.state!==profile.states.done)) return false;
  if (!Object.hasOwn(value,'completed')) return true; // Old snapshots remain usable until the next refresh.
  const done=value.completed;
  return !!done && Array.isArray(done.issues) && done.issues.length<=20 && typeof done.hasMore==='boolean' &&
    (!done.hasMore || done.issues.length===20) && done.issues.every(valid);
}

class HomeYouTrackModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin=plugin; this.closed=false; }
  onOpen() {
    const doc=this.contentEl.ownerDocument, el=(tag,cls,text)=>homeElement(doc,tag,cls,text);
    this.contentEl.classList.add('aim-home-setup'); this.contentEl.replaceChildren();
    const profile=this.plugin.youtrackProfile || {host:'',login:'',project:'',states:YOU_TRACK_STATES,syncEnabled:false};
    this.contentEl.append(el('h2','','YouTrack settings'),el('p','','Connect your own account and project. Python 3.11+ and YouTrack’s /mcp endpoint are required.'));
    const field=(title,value,placeholder,type='text')=>{
      const label=el('label','',title),input=el('input');input.type=type;input.value=value;input.placeholder=placeholder;input.autocomplete='off';input.spellcheck=false;input.maxLength=type==='password'?8192:253;label.append(input);this.contentEl.append(label);return input;
    };
    const host=field('Server',profile.host,'company.youtrack.cloud');
    const login=field('Your login',profile.login,'jane.doe');
    const project=field('Project key',profile.project,'TEAM');
    const token=field('Permanent token','',this.plugin.youtrackProfile?'Leave empty to keep your saved token':'Paste your permanent token','password');this.token=token;
    const details=el('details','aim-home-slack-details'); details.append(el('summary','','Board status sync (optional)'));
    const checkbox=el('input');checkbox.type='checkbox';checkbox.checked=profile.syncEnabled;
    const label=el('label','aim-home-sync-toggle','Enable remote status changes');label.prepend(checkbox);details.append(label);
    details.append(el('p','aim-home-caption','When enabled, importing or moving a linked card changes its YouTrack State. Moving out of Done reopens it. Existing cards are not bulk synced. Leave off for local-only status.'));
    const states={};
    for(const [column,title] of [['backlog','Backlog →'],['in-progress','In progress →'],['done','Done →']]) {
      const label=el('label','',title),input=el('input');input.value=profile.states[column];input.maxLength=100;label.append(input);details.append(label);states[column]=input;
    }
    this.contentEl.append(details,el('p','aim-home-caption','The token and account profile stay in Obsidian Keychain on this Mac. Never paste tokens into chat or a note.'));
    const status=el('p','aim-home-feed-message');status.setAttribute('role','status');this.contentEl.append(status);
    const actions=el('div','aim-home-setup-actions');
    const save=el('button','mod-cta','Connect'),cancel=el('button','','Cancel'),disconnect=el('button','','Disconnect');
    disconnect.hidden=!this.plugin.youtrackProfile;
    const run=async action=>{if(this.busy)return;this.busy=true;save.disabled=disconnect.disabled=true;homeText(status,'Checking your account and open issues…');try{await action();if(!this.closed)this.close();}catch(e){if(!this.closed)homeText(status,e.youtrackCode?youtrackSetupError(e.youtrackCode):e.message || 'Connection failed. Check your settings.');}finally{this.busy=false;save.disabled=disconnect.disabled=false;}};
    save.addEventListener('click',()=>void run(()=>this.plugin.connectYouTrack({host:host.value,login:login.value,project:project.value,states:Object.fromEntries(Object.entries(states).map(([k,v])=>[k,v.value])),syncEnabled:checkbox.checked},token.value)));
    disconnect.addEventListener('click',()=>void run(()=>this.plugin.disconnectYouTrack()));
    cancel.addEventListener('click',()=>this.close());actions.append(save,cancel,disconnect);this.contentEl.append(actions);host.focus();
  }
  onClose() {
    this.closed=true;if(this.token)this.token.value='';
    this.plugin.youtrackSetupRevision=(this.plugin.youtrackSetupRevision||0)+1;
    if(this.plugin.youtrackModal===this)this.plugin.youtrackModal=null;
    this.contentEl.replaceChildren();
  }
}

function youtrackSetupError(code) {
  return {runtime:'Install Python 3.11 or newer from python.org, then try again.',identity:'The token does not belong to this login. Check your exact YouTrack login.',authentication:'YouTrack rejected this token. Create a new permanent token with the YouTrack scope.',connection:'Check the server, login, project and token.',state:'Check your three state names and permissions.',incomplete:'The server returned an unsupported or incomplete issue list.',timeout:'YouTrack took too long. Try again.',network:'Could not reach YouTrack. Check your server and connection.'}[code] || 'Could not verify the connection. Check that this server supports the YouTrack MCP endpoint.';
}

class HomeSlackModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; this.closed = false; }
  onOpen() {
    const doc = this.contentEl.ownerDocument;
    this.contentEl.classList.add('aim-home-setup'); this.contentEl.replaceChildren();
    const el = (tag, cls, text) => homeElement(doc, tag, cls, text);
    this.contentEl.append(el('h2', '', this.plugin.slackConnected ? 'Slack settings' : 'Connect Slack'));
    if (this.plugin.slackAccount) this.contentEl.append(el('p', '', `Connected to ${this.plugin.slackAccount.teamName} as @${this.plugin.slackAccount.userName}.`));
    this.contentEl.append(el('p', '', 'Read incoming direct messages and mentions. Optionally include one notes channel and one user group.'));
    const details = el('details', 'aim-home-slack-details');
    details.append(el('summary', '', 'Inbox details'));
    details.append(el('p', 'aim-home-caption', 'Last 7 days · Up to 50 messages per view. This is not Slack’s unread count.'));
    const snapshot = this.plugin.slackSnapshot;
    if (snapshot?.limited) {
      details.append(el('p', 'aim-home-caption', 'Some results were limited in the last refresh.'));
      const limits = el('ul', 'aim-home-caption');
      for (const note of snapshot.limitNotes || []) limits.append(el('li', '', note));
      details.append(limits);
    }
    details.append(el('p', 'aim-home-caption', 'Slack search can group nearby matches and apply saved filters. Replies to older threads may not appear. Open Slack for full context.'));
    this.contentEl.append(details);
    const sourceField = (title, value, placeholder) => { const label=el('label','',title), input=el('input'); input.value=value; input.placeholder=placeholder; input.type='text'; input.maxLength=80; label.append(input); this.contentEl.append(label); return input; };
    const channel=sourceField('Notes channel (optional)',this.plugin.slackSources.channel,'team-notes');
    const group=sourceField('User group (optional)',this.plugin.slackSources.group,'team');
    this.contentEl.append(el('p','aim-home-caption','Leave either field empty to skip that source. Use a channel name and group handle, without # or @.'));
    const label = el('label', '', 'User OAuth Token');
    const input = el('input'); this.input = input;
    input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false; input.maxLength = 2048;
    input.setAttribute('aria-label', 'Slack User OAuth Token'); input.placeholder = this.plugin.slackConnected ? 'Leave empty to keep your saved token' : 'xoxp-…'; label.append(input);
    this.contentEl.append(label, el('p', 'aim-home-caption', 'User scopes: search:read, users:read, im:read, im:history, plus channels:read/channels:history for a notes channel and usergroups:read for a user group. Reinstall the app after changing scopes.'));
    this.contentEl.append(el('p', 'aim-home-caption', 'Your token stays in Obsidian Keychain on this Mac. Messages stay in memory. The last 7 days refresh every 5 minutes while Home and Slack are visible, or when you click Refresh all widgets. Reconnect separately on another Mac.'));
    const message = el('p', 'aim-home-feed-message'); message.setAttribute('role', 'status'); this.contentEl.append(message);
    const actions = el('div', 'aim-home-setup-actions');
    const connect = el('button', 'mod-cta', this.plugin.slackConnected ? 'Replace connection' : 'Connect Slack'); connect.type = 'button';
    const cancel = el('button', '', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', () => this.close());
    const disconnect = el('button', '', 'Disconnect'); disconnect.type = 'button'; disconnect.hidden = !this.plugin.slackConnected;
    const run = async action => {
      if (this.busy) return;
      this.busy = true; connect.disabled = true; disconnect.disabled = true; input.disabled = true;
      homeText(message, 'Checking your account and recent messages…');
      try { await action(); if (!this.closed) { input.value = ''; this.close(); } }
      catch (error) { if (!this.closed) homeText(message, slackErrorMessage(error)); }
      finally { this.busy = false; connect.disabled = false; disconnect.disabled = false; input.disabled = false; }
    };
    connect.addEventListener('click', () => { void run(() => this.plugin.connectSlack(input.value, {channel:channel.value,group:group.value})); });
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); connect.click(); } });
    disconnect.addEventListener('click', () => { void run(() => this.plugin.disconnectSlack()); });
    actions.append(connect, cancel, disconnect); this.contentEl.append(actions); input.focus();
  }
  onClose() {
    this.closed = true; if (this.input) this.input.value = '';
    this.plugin.cancelSlackConnect();
    if (this.plugin.slackModal === this) this.plugin.slackModal = null;
    this.contentEl.replaceChildren();
  }
}

class HomeCalendarModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; }
  onOpen() {
    const doc = this.contentEl.ownerDocument;
    this.contentEl.classList.add('aim-home-setup'); this.contentEl.replaceChildren();
    const el = (tag, cls, text) => homeElement(doc, tag, cls, text);
    this.contentEl.append(el('h2', '', 'Connect Google Calendar'));
    this.contentEl.append(el('p', '', 'Keep your calendar private. Home only reads events; it cannot create, edit or delete them.'));
    const modeLabel = el('label', '', 'Connection method');
    const mode = el('select'); mode.setAttribute('aria-label', 'Connection method');
    for (const [value, title] of [['google', 'Google sign-in · desktop'], ['ical', 'Private iCal link']]) {
      const option = el('option', '', title); option.value = value; mode.append(option);
    }
    mode.value = this.plugin.calendarEnabled ? this.plugin.calendarSource : 'google'; modeLabel.append(mode); this.contentEl.append(modeLabel);
    const googleHelp = el('div'), icalHelp = el('div');
    googleHelp.append(el('p', '', 'Use your own Google Cloud Desktop app client. Enable Calendar API, configure the consent screen, then create a Desktop app client and download its JSON.'));
    googleHelp.append(el('p', 'aim-home-caption', 'Sign-in opens your browser and asks only to view events in calendars you own. Home displays your primary calendar. Your organization may require administrator approval.'));
    icalHelp.append(el('p', '', 'Google Calendar → Settings → your calendar → Integrate calendar → Secret address in iCal format. If only Public address is available, use Google sign-in instead. Do not make your calendar public.'));
    this.contentEl.append(googleHelp, icalHelp);
    const label = el('label'), labelText = el('span');
    const input = el('input'); input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false;
    label.append(labelText, input); this.contentEl.append(label);
    const importLabel = el('label', 'aim-home-import-label', 'Import client JSON');
    const importFile = el('input'); importFile.type = 'file'; importFile.accept = '.json,application/json'; importFile.setAttribute('aria-label', 'Import client JSON');
    importLabel.append(importFile); this.contentEl.append(importLabel);
    this.contentEl.append(el('p', 'aim-home-caption', 'Credentials stay in Obsidian Keychain on this device, not in notes or plugin settings. Events stay in memory. Refreshes about every 10 minutes while the Calendar tab is visible. Refresh all widgets also reads inactive tabs.'));
    const message = el('p', 'aim-home-feed-message'); message.setAttribute('role', 'status'); this.contentEl.append(message);
    importFile.addEventListener('change', async () => {
      const file = importFile.files?.[0]; if (!file) return;
      try {
        if (file.size > 32768) throw new Error('Choose a Desktop OAuth client JSON file.');
        const text = await file.text(); getHomeGoogleAdapter().parseGoogleClient(text);
        input.value = text; homeText(message, 'Desktop client loaded. Ready to sign in.');
      } catch (_) { input.value = ''; homeText(message, 'Could not read a Desktop OAuth client from this file.'); }
      finally { importFile.value = ''; }
    });
    const actions = el('div', 'aim-home-setup-actions');
    const connect = el('button', 'mod-cta'); connect.type = 'button';
    const cancel = el('button', '', 'Cancel sign-in'); cancel.type = 'button'; cancel.hidden = true;
    const disconnect = el('button', '', 'Disconnect'); disconnect.type = 'button'; disconnect.hidden = !this.plugin.calendarEnabled;
    const update = () => {
      const isGoogle = mode.value === 'google'; googleHelp.hidden = !isGoogle; icalHelp.hidden = isGoogle;
      importLabel.hidden = !isGoogle;
      const title = isGoogle ? 'Desktop OAuth client JSON' : 'Secret iCal address';
      homeText(labelText, title); input.setAttribute('aria-label', title);
      input.placeholder = isGoogle ? 'Paste the downloaded Desktop app JSON' : 'https://calendar.google.com/calendar/ical/…';
      homeText(connect, isGoogle ? 'Sign in with Google' : 'Connect read-only'); input.value = ''; homeText(message, '');
    };
    mode.addEventListener('change', update); update();
    connect.addEventListener('click', async () => {
      const isGoogle = mode.value === 'google';
      connect.disabled = true; disconnect.disabled = true; mode.disabled = true; importFile.disabled = true; input.disabled = true; cancel.hidden = !isGoogle;
      homeText(message, isGoogle ? 'Finish sign-in in your browser, then return here…' : 'Checking the calendar…');
      try {
        if (isGoogle) await this.plugin.connectGoogleCalendar(input.value); else await this.plugin.connectCalendar(input.value);
        input.value = ''; this.close();
      } catch (error) { homeText(message, error.message); }
      finally { connect.disabled = false; disconnect.disabled = false; mode.disabled = false; importFile.disabled = false; input.disabled = false; cancel.hidden = true; }
    });
    cancel.addEventListener('click', () => { this.plugin.cancelGoogleSignIn(); homeText(message, 'Cancelling sign-in…'); });
    disconnect.addEventListener('click', async () => {
      connect.disabled = true; disconnect.disabled = true;
      try { await this.plugin.disconnectCalendar(); input.value = ''; this.close(); }
      catch (_) { homeText(message, 'Could not disconnect. Try again.'); }
      finally { connect.disabled = false; disconnect.disabled = false; }
    });
    const google = el('a', '', 'Google account permissions'); google.href = 'https://myaccount.google.com/connections'; google.target = '_blank'; google.rel = 'noopener noreferrer';
    actions.append(connect, cancel, disconnect, google); this.contentEl.append(actions);
    this.contentEl.append(el('p', 'aim-home-caption', 'Disconnect removes this device’s saved connection. You can also revoke the app’s access from Google account permissions.'));
    input.focus();
  }
  onClose() { this.plugin.cancelGoogleSignIn(); this.contentEl.replaceChildren(); if (this.plugin.calendarModal === this) this.plugin.calendarModal = null; }
}

class BoardNotePreview {
  constructor(plugin, entry, file, anchor) {
    this.plugin = plugin; this.entry = entry; this.file = file; this.anchor = anchor;
    this.doc = anchor.ownerDocument; this.win = this.doc.defaultView; this.revision = 0;
  }
  element(tag, className, text) {
    const el = this.doc.createElement(tag); el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  open() {
    this.root = this.element('section','aim-board-preview');
    this.root.setAttribute('role','dialog'); this.root.setAttribute('aria-modal','false');
    this.root.setAttribute('aria-label','Note preview');
    const header = this.element('div','aim-board-preview-header');
    this.title = this.element('h2','aim-board-preview-title');
    this.closeButton = this.element('button','aim-board-preview-close');
    this.closeButton.type = 'button'; this.closeButton.setAttribute('aria-label','Close preview');
    setIcon(this.closeButton,'x'); this.closeButton.addEventListener('click',() => this.close(true));
    header.append(this.title,this.closeButton);
    this.path = this.element('div','aim-board-preview-path');
    this.body = this.element('div','aim-board-preview-body'); this.body.tabIndex = 0;
    this.body.setAttribute('aria-label','Note contents');
    const footer = this.element('div','aim-board-preview-footer');
    this.message = this.element('span','aim-board-preview-message'); this.message.setAttribute('role','status');
    this.openButton = this.element('button','','Open note'); this.openButton.type = 'button';
    this.openButton.addEventListener('click',() => {
      if (this.plugin.app.vault.getAbstractFileByPath(this.file.path) !== this.file) { this.refresh(); return; }
      const file = this.file; this.close();
      void this.plugin.runAction(async() => {
        const existing = this.plugin.app.workspace.getLeavesOfType('markdown').find(leaf => leaf.view.file === file);
        if (existing) await this.plugin.app.workspace.revealLeaf(existing);
        else await this.plugin.app.workspace.getLeaf('tab').openFile(file);
      });
    });
    footer.append(this.message,this.openButton);
    this.root.append(header,this.path,this.body,footer); this.doc.body.append(this.root);
    this.setAnchor(this.anchor);
    this.outside = event => { if (!this.root.contains(event.target) && !this.anchor.contains(event.target)) this.close(); };
    this.keydown = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(true); } };
    this.reposition = () => this.position();
    this.doc.addEventListener('pointerdown',this.outside,true);
    this.root.addEventListener('keydown',this.keydown);
    this.doc.addEventListener('scroll',this.reposition,true);
    this.win.addEventListener('resize',this.reposition);
    this.position(); this.closeButton.focus(); void this.refresh();
  }
  setAnchor(anchor) {
    if (this.anchor !== anchor) this.anchor?.setAttribute('aria-expanded','false');
    this.anchor = anchor; this.anchor.setAttribute('aria-expanded','true');
  }
  position() {
    if (this.closed) return;
    const box = this.entry.host.getBoundingClientRect();
    const width = Math.max(240,Math.min(460,box.width - 20,this.win.innerWidth - 24));
    const top = Math.max(12,Math.min(box.top + 12,this.win.innerHeight - 260));
    this.root.style.width = width + 'px';
    this.root.style.left = Math.max(12,Math.min(box.right - width - 10,this.win.innerWidth - width - 12)) + 'px';
    this.root.style.top = top + 'px';
    this.root.style.maxHeight = Math.max(180,this.win.innerHeight - top - 20) + 'px';
  }
  async refresh() {
    if (this.closed) return;
    const revision = ++this.revision;
    const card = [...(this.entry.boardCards?.values() || [])].find(state => state.file === this.file);
    homeText(this.title,card?.model.title || this.plugin.boardCardModel(this.file).title); homeText(this.path,this.file.path);
    homeText(this.message,'Loading…'); this.body.setAttribute('aria-busy','true');
    try {
      const result = await this.plugin.readBoardPreview(this.file);
      if (this.closed || revision !== this.revision) return;
      const scroll = this.body.scrollTop;
      // Render a small text-only Markdown subset. No embeds, HTML, plugins or remote image requests.
      renderBoardPreviewText(this.doc,this.body,result.body);
      this.body.scrollTop = scroll;
      homeText(this.message,result.truncated ? 'Preview shortened · Open note for the rest' : 'Read-only preview');
      this.openButton.disabled = false;
    } catch (_) {
      if (this.closed || revision !== this.revision) return;
      homeText(this.body,'Preview unavailable. Try opening the note.');
      homeText(this.message,'Could not load preview');
      this.openButton.disabled = this.plugin.app.vault.getAbstractFileByPath(this.file.path) !== this.file;
    } finally {
      if (!this.closed && revision === this.revision) this.body.setAttribute('aria-busy','false');
    }
  }
  close(restoreFocus = false) {
    if (this.closed) return;
    this.closed = true; this.revision++;
    this.doc.removeEventListener('pointerdown',this.outside,true);
    this.doc.removeEventListener('scroll',this.reposition,true); this.win.removeEventListener('resize',this.reposition);
    this.root?.remove(); this.anchor.setAttribute('aria-expanded','false');
    if (restoreFocus && this.anchor.isConnected) this.anchor.focus();
    if (this.entry.boardPreview === this) this.entry.boardPreview = null;
  }
}

class NotePropertyPopover {
  constructor(plugin, anchor, file, key) {
    this.plugin = plugin;
    this.anchor = anchor;
    this.file = file;
    this.key = key;
    this.doc = anchor.ownerDocument;
    this.win = this.doc.defaultView;
    this.mode = "list";
  }

  element(tag, className, text) {
    const el = this.doc.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  button(parent, text, action) {
    const button = this.element("button", "", text);
    button.type = "button";
    button.addEventListener("click", action);
    parent.append(button);
    return button;
  }

  open() {
    this.root = this.element("div", "aim-property-popover");
    this.root.setAttribute("role", "dialog");
    const title = NOTE_FIELDS[this.key] || (this.key === "tags" ? "Tags" : "Other properties");
    this.root.setAttribute("aria-label", title);
    const header = this.element("div", "aim-property-header");
    header.append(this.element("strong", "", title));
    this.button(header, "×", () => this.close(true)).setAttribute("aria-label", "Close");
    this.search = this.element("input", "aim-property-search");
    this.search.type = "search";
    this.search.placeholder = "Search…";
    this.search.setAttribute("aria-label", "Search");
    this.search.addEventListener("input", () => this.renderList());
    this.list = this.element("div", "aim-property-list");
    this.message = this.element("div", "aim-property-message");
    this.message.setAttribute("role", "status");
    this.root.append(header, this.search, this.list, this.message);
    if (this.key === "tags") {
      const controls = this.element("div", "aim-tag-controls");
      this.tagHelp = this.element("p", "aim-tag-help");
      this.hiddenToggle = this.button(controls, "", () => {
        this.showHiddenTags = !this.showHiddenTags;
        this.search.value = "";
        this.renderList();
      });
      controls.prepend(this.tagHelp);
      this.list.before(controls);
    }
    this.doc.body.append(this.root);
    this.anchor.setAttribute("aria-expanded", "true");
    this.outside = (event) => { if (!this.root.contains(event.target) && !this.anchor.contains(event.target)) this.close(); };
    this.keydown = (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.close(true); }
      if (event.key === "ArrowDown" && event.target === this.search) {
        event.preventDefault(); this.list.querySelector("button:not(:disabled)")?.focus();
      }
    };
    this.reposition = () => this.position();
    this.doc.addEventListener("pointerdown", this.outside, true);
    this.doc.addEventListener("keydown", this.keydown, true);
    this.doc.addEventListener("scroll", this.reposition, true);
    this.win.addEventListener("resize", this.reposition);
    this.renderList();
    this.search.focus();
  }

  position() {
    if (this.closed) return;
    const anchor = this.anchor.getBoundingClientRect();
    const box = this.root.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, this.win.innerWidth - box.width - 8));
    const top = anchor.bottom + box.height + 8 < this.win.innerHeight
      ? anchor.bottom + 6 : Math.max(8, anchor.top - box.height - 6);
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
  }

  close(restoreFocus = false) {
    if (this.closed) return;
    this.closed = true;
    this.doc.removeEventListener("pointerdown", this.outside, true);
    this.doc.removeEventListener("keydown", this.keydown, true);
    this.doc.removeEventListener("scroll", this.reposition, true);
    this.win.removeEventListener("resize", this.reposition);
    this.root?.remove();
    this.anchor.setAttribute("aria-expanded", "false");
    if (restoreFocus && this.anchor.isConnected) this.anchor.focus();
    this.onClose?.();
  }

  refresh() {
    if (!this.closed && this.mode === "list") this.renderList();
  }

  async act(action, close = false) {
    if (this.busy) return;
    this.busy = true;
    this.message.textContent = "";
    try {
      await action();
      if (close) this.close(true);
      else this.refresh();
    } catch (error) {
      if (!this.closed) this.message.textContent = error.message || String(error);
    } finally { this.busy = false; }
  }

  option(label, action, { selected = false, disabled = false, detail = "" } = {}) {
    const button = this.button(this.list, `${selected ? "✓ " : ""}${label}`, action);
    button.className = "aim-property-option";
    button.disabled = disabled;
    if (selected) button.setAttribute("aria-pressed", "true");
    if (detail) button.append(this.element("small", "", detail));
    return button;
  }

  renderList() {
    if (this.closed) return;
    this.mode = "list";
    this.search.hidden = false;
    this.list.replaceChildren();
    const query = this.search.value.trim().toLocaleLowerCase();
    const matches = (value) => String(value).toLocaleLowerCase().includes(query);
    const cache = this.plugin.app.metadataCache.getFileCache(this.file) ?? {};
    const fm = cache.frontmatter ?? {};
    const values = this.plugin.propertyValues(this.key);
    if (values) {
      for (const value of values.filter(matches)) {
        const option = this.option(value, () => this.act(() => this.plugin.setNoteProperty(this.file, this.key, value), true), { selected: (this.key === "category" ? this.plugin.categoryValue(fm[this.key]) : fm[this.key]) === value });
        if (this.key === 'category') option.prepend(hubIcon(this.doc,this.plugin.typeIcon(value)));
      }
      if (Object.hasOwn(fm, this.key) && !(this.key === "board_column" && fileHasKanbanTag(cache))) {
        this.option("Clear value", () => this.act(() => this.plugin.setNoteProperty(this.file, this.key, undefined), true));
      }
    } else if (this.key === "tags") {
      const options = this.plugin.tagOptions(this.file, this.showHiddenTags);
      this.tagHelp.textContent = this.showHiddenTags
        ? "Click a tag to restore its suggestion. Notes are unchanged."
        : "Checked tags belong to this note. Right-click a tag to hide its suggestion.";
      this.hiddenToggle.textContent = this.showHiddenTags ? "Back to suggestions" : `Hidden suggestions (${this.plugin.hiddenTagSuggestions.size})`;
      this.hiddenToggle.hidden = !this.showHiddenTags && !this.plugin.hiddenTagSuggestions.size;
      for (const { tag, label, selected, bodyOnly, hidden } of options) {
        if (!matches(label)) continue;
        if (this.showHiddenTags) {
          this.option(label, () => this.act(() => this.plugin.setTagSuggestionHidden(tag, false)), { detail: "Restore suggestion" });
          continue;
        }
        const system = isKanbanTag(tag);
        const option = this.option(label, () => this.act(() => this.plugin.toggleNoteTag(this.file, label)), {
          selected, disabled: system || bodyOnly,
          detail: system ? "Use the board buttons to change membership" : hidden ? "Hidden suggestion · Still used on this note" : bodyOnly ? "In the note body" : "",
        });
        option.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const menu = new Menu();
          menu.addItem((item) => item
            .setTitle(hidden ? "Show in suggestions" : "Hide from suggestions")
            .setIcon(hidden ? "eye" : "eye-off")
            .setDisabled(system)
            .onClick(() => { void this.plugin.runAction(() => this.plugin.setTagSuggestionHidden(tag, !hidden)); }));
          menu.showAtMouseEvent(event);
        });
      }
      const newTag = this.search.value.trim().replace(/^#/, "");
      if (!this.showHiddenTags && newTag && !options.some((item) => item.tag === normalizeTag(newTag)) && !this.plugin.hiddenTagSuggestions.has(normalizeTag(newTag)) && !isKanbanTag(newTag)) {
        this.option(`Add tag: ${newTag}`, () => this.act(() => this.plugin.toggleNoteTag(this.file, newTag)));
      }
    } else {
      for (const key of Object.keys(fm).filter((key) => !RESERVED_PROPERTIES.has(key) && !Object.hasOwn(NOTE_FIELDS, key) && key !== "tags" && key !== "tag").sort()) {
        if (!matches(`${key} ${propertyValueLabel(fm[key])}`)) continue;
        this.option(key, () => this.editProperty(key), { detail: propertyValueLabel(fm[key]) + (MANAGED_PROPERTIES.has(key) ? " · Automatic" : ""), disabled: MANAGED_PROPERTIES.has(key) });
      }
      this.option("＋ Add property", () => this.editProperty(null));
    }
    if (!this.list.children.length) this.list.append(this.element("p", "aim-property-empty", "No results found."));
    this.position();
  }

  editProperty(key) {
    this.mode = "edit";
    this.search.hidden = true;
    this.message.textContent = "";
    this.list.replaceChildren();
    const fm = this.plugin.app.metadataCache.getFileCache(this.file)?.frontmatter ?? {};
    const original = key === null ? "" : fm[key];
    const snapshot = key === null ? undefined : propertySnapshot(fm, key);
    this.button(this.list, "← Properties", () => { this.renderList(); this.search.focus(); });
    const form = this.element("form", "aim-property-form");
    const name = this.element("input");
    name.type = "text"; name.value = key ?? ""; name.disabled = key !== null;
    name.setAttribute("aria-label", "Property name"); name.placeholder = "Property name";
    form.append(name);
    let kind = typeof original === "boolean" ? "boolean" : typeof original === "number" ? "number"
      : Array.isArray(original) && original.every((item) => typeof item === "string") ? "list"
      : typeof original === "object" ? "json" : "text";
    let input;
    const valueHost = this.element("label", "aim-property-value");
    const renderInput = (value) => {
      valueHost.replaceChildren(this.element("span", "", kind === "list" ? "Values (one per line)" : kind === "json" ? "JSON value" : "Value"));
      input = this.element(kind === "boolean" || kind === "number" ? "input" : "textarea");
      input.setAttribute("aria-label", "Value");
      if (kind === "boolean") { input.type = "checkbox"; input.checked = value === true; }
      else if (kind === "number") { input.type = "number"; input.step = "any"; input.value = value === "" ? "" : String(value); }
      else input.value = kind === "json" ? JSON.stringify(value, null, 2) : kind === "list" ? (Array.isArray(value) ? value.join("\n") : "") : String(value ?? "");
      valueHost.append(input);
    };
    if (key === null) {
      const types = this.element("div", "aim-property-types");
      for (const [value, label] of [["text", "Text"], ["number", "Number"], ["boolean", "Checkbox"], ["list", "List"]]) {
        const button = this.button(types, label, () => {
          kind = value;
          for (const child of types.children) child.setAttribute("aria-pressed", String(child === button));
          renderInput("");
        });
        button.setAttribute("aria-pressed", String(value === kind));
      }
      form.append(types);
    }
    renderInput(original);
    form.append(valueHost);
    const actions = this.element("div", "aim-property-actions");
    const save = this.button(actions, "Save", () => {});
    save.type = "submit";
    if (key !== null) this.button(actions, "Remove property", () => this.act(() => this.plugin.setNoteProperty(this.file, key, undefined, snapshot), true));
    form.append(actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.act(async () => {
        const field = name.value.trim();
        const value = kind === "boolean" ? input.checked : kind === "number" ? (input.value.trim() ? Number(input.value) : NaN)
          : kind === "list" ? input.value.split("\n").map((item) => item.trim()).filter(Boolean)
          : kind === "json" ? JSON.parse(input.value) : input.value;
        const expected = key === null ? JSON.stringify({ present: false }) : snapshot;
        await this.plugin.setNoteProperty(this.file, field, value, expected);
      }, true);
    });
    this.list.append(form);
    this.position();
    (key === null ? name : input).focus();
  }
}

class AddCardModal extends Modal {
  constructor(app, { columnValue, defaultFolder, moveTargets, taxonomy, onSubmit }) {
    super(app);
    this.columnValue = columnValue;
    this.taxonomy = taxonomy;
    this.folderCategories = Object.fromEntries(Object.entries(taxonomy.folder_to_category).map(([folder, category]) => [`Hub/${folder}`, category]));
    // defaultFolder may be null (Board view, or DOM scrape didn't match a
    // known view name). In that case we leave the dropdown on a placeholder
    // and require the user to pick.
    this.folder = defaultFolder ?? "";
    this.moveTargets = moveTargets;
    this.title = "";
    // Type (category) defaults to the folder-inferred value and keeps
    // following the Folder dropdown until the user picks a type explicitly
    // (then `categoryTouched` pins it). Priority defaults to medium, matching
    // the kanban template.
    this.category = this.folderCategories[this.folder] ?? "";
    this.categoryTouched = false;
    this.priority = "medium";
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: `Add card to ${this.columnValue}` });

    new Setting(contentEl)
      .setName("Title")
      .addText((text) => {
        text.setPlaceholder("Card title");
        text.onChange((v) => { this.title = v; });
        text.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this.submit();
          }
        });
        setTimeout(() => text.inputEl.focus(), 0);
      });

    let typeDropdown;
    new Setting(contentEl)
      .setName("Folder")
      .addDropdown((dd) => {
        // Placeholder option so the dropdown doesn't silently default to
        // Benchmark when auto-detection fails. Forces the user to choose.
        dd.addOption("", "— Choose folder —");
        for (const target of this.moveTargets) {
          dd.addOption(target.path, target.label);
        }
        dd.setValue(this.folder);
        dd.onChange((v) => {
          this.folder = v;
          // Keep Type in sync with the folder's category unless the user has
          // already overridden it. setValue() doesn't fire onChange, so this
          // programmatic update won't trip `categoryTouched`.
          if (!this.categoryTouched) {
            this.category = this.folderCategories[v] ?? "";
            if (typeDropdown) typeDropdown.setValue(this.category);
          }
        });
      });

    new Setting(contentEl)
      .setName("Type")
      .addDropdown((dd) => {
        typeDropdown = dd;
        dd.addOption("", "— none —");
        for (const c of this.taxonomy.categories) dd.addOption(c, c);
        dd.setValue(this.category);
        dd.onChange((v) => {
          this.category = v;
          this.categoryTouched = true;
        });
      });

    new Setting(contentEl)
      .setName("Priority")
      .addDropdown((dd) => {
        for (const p of this.taxonomy.priorities) dd.addOption(p, p);
        dd.setValue(this.priority);
        dd.onChange((v) => { this.priority = v; });
      });

    new Setting(contentEl)
      .addButton((btn) => btn
        .setButtonText("Create")
        .setCta()
        .onClick(() => this.submit()))
      .addButton((btn) => btn
        .setButtonText("Cancel")
        .onClick(() => this.close()));
  }

  async submit() {
    if (this.submitting) return;
    const v = (this.title || "").trim();
    if (!v) {
      new Notice("Enter a title.");
      return;
    }
    if (!this.folder) {
      new Notice("Pick a folder.");
      return;
    }
    this.submitting = true;
    try {
      const ok = await this.onSubmit({title: v, folder: this.folder, category: this.category || null, priority: this.priority || "medium"});
      if (ok !== false) this.close();
    } catch (error) {
      new Notice(`Could not create card: ${error.message || error}`);
    } finally { this.submitting = false; }
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * Modal for "Add to board" — re-stamp kanban frontmatter onto an existing
 * note. No Title (the file already has a name) and no Folder (it stays put);
 * just Column / Type / Priority, pre-filled by the caller from leftover
 * frontmatter or folder-inferred defaults.
 */
class AddToBoardModal extends Modal {
  constructor(app, { file, column, category, priority, taxonomy, onSubmit }) {
    super(app);
    this.file = file;
    this.taxonomy = taxonomy;
    this.column = column;
    this.category = category;
    this.priority = priority;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: `Add to board: ${this.file.basename}` });

    new Setting(contentEl)
      .setName("Column")
      .addDropdown((dd) => {
        for (const c of this.taxonomy.columns) dd.addOption(c, c);
        dd.setValue(this.column);
        dd.onChange((v) => { this.column = v; });
      });

    new Setting(contentEl)
      .setName("Type")
      .addDropdown((dd) => {
        dd.addOption("", "— none —");
        for (const c of this.taxonomy.categories) dd.addOption(c, c);
        dd.setValue(this.category);
        dd.onChange((v) => { this.category = v; });
      });

    new Setting(contentEl)
      .setName("Priority")
      .addDropdown((dd) => {
        for (const p of this.taxonomy.priorities) dd.addOption(p, p);
        dd.setValue(this.priority);
        dd.onChange((v) => { this.priority = v; });
      });

    new Setting(contentEl)
      .addButton((btn) => btn
        .setButtonText("Add to board")
        .setCta()
        .onClick(async () => {
          if (this.submitting) return;
          this.submitting = true;
          try {
            const ok = await this.onSubmit({column: this.column, category: this.category || null, priority: this.priority || "medium"});
            if (ok !== false) this.close();
          } finally { this.submitting = false; }
        }))
      .addButton((btn) => btn
        .setButtonText("Cancel")
        .onClick(() => this.close()));
  }

  onClose() {
    this.contentEl.empty();
  }
}

class HomeManagerModal extends Modal {
  constructor(plugin, mode, source) {
    super(plugin.app); this.plugin = plugin; this.mode = mode; this.source = source ? JSON.parse(JSON.stringify(source)) : null;
    this.viewId = plugin.homeState.activeView; this.expected = source ? JSON.stringify(source) : undefined; this.busy = false;
  }
  node(tag, cls = '', text = '') { return homeElement(this.contentEl.ownerDocument, tag, cls, text); }
  button(label, action, cls = '') {
    const b = this.node('button',cls,label); b.type = 'button';
    b.addEventListener('click', async () => {
      if (this.busy || !this.plugin.active) return;
      this.busy = true; b.disabled = true; this.error.textContent = '';
      try { await action(); } catch (error) { this.error.textContent = error.message || 'Could not save. Try again.'; }
      finally { this.busy = false; b.disabled = false; }
    }); return b;
  }
  field(label, value = '', placeholder = '') {
    const wrap = this.node('label','aim-home-field'); wrap.append(this.node('span','',label));
    const input = this.node('input'); input.type = 'text'; input.value = value; input.placeholder = placeholder; wrap.append(input); this.body.append(wrap); return input;
  }
  onOpen() { this.render(); }
  render() {
    this.contentEl.empty(); this.contentEl.classList.add('aim-home-manager');
    this.body = this.node('div'); this.error = this.node('p','aim-home-form-error'); this.error.setAttribute('role','alert');
    this.contentEl.append(this.body,this.error);
    if (this.mode === 'document') return this.renderDocument();
    if (this.mode === 'edit' || this.mode === 'bookmark') return this.renderSource();
    if (this.mode === 'views' || this.mode === 'new-view' || this.mode === 'rename-view') return this.renderViews();
    const view = requireHomeView(this.plugin.homeState, this.viewId);
    this.body.append(this.node('h2','',`Pinned · ${view.name}`));
    const list = this.node('div','aim-home-source-list'); this.body.append(list);
    for (const id of view.pins) {
      const source = this.plugin.homeState.sources.find(s => s.id === id);
      const row = this.node('div','aim-home-manager-row');
      row.append(this.node('span','aim-home-source-name',source.title), this.button('Edit',()=>{this.source=JSON.parse(JSON.stringify(source));this.expected=JSON.stringify(source);this.mode='edit';this.render();}),
        this.button('Unpin',async()=>{await this.plugin.pinHomeSource(view.id,id,false);this.render();void this.plugin.refreshHomeCheckpoint();}));
      list.append(row);
    }
    const others = this.plugin.homeState.sources.filter(s => !view.pins.includes(s.id));
    if (others.length) {
      const label = this.node('label','aim-home-field','Pin an existing source'); const select=this.node('select');
      for (const source of others) { const option=this.node('option','',source.title);option.value=source.id;select.append(option); }
      label.append(select);this.body.append(label,this.button('Pin to this view',async()=>{await this.plugin.pinHomeSource(view.id,select.value,true);this.render();void this.plugin.refreshHomeCheckpoint();}),this.button('Forget source',()=>{
        const id=select.value;const confirm=this.node('div','aim-home-form-actions');
        confirm.append(this.node('span','aim-home-caption','Remove from Home? The original file stays untouched.'),this.button('Confirm',async()=>{await this.plugin.forgetHomeSource(id);this.render();}),this.button('Cancel',()=>confirm.remove()));this.body.append(confirm);
      }));
    }
    const actions=this.node('div','aim-home-form-actions'); actions.append(this.button('Add',()=>{this.source=null;this.expected=undefined;this.mode='edit';this.render();},'mod-cta'),this.button('Done',()=>this.close()));this.body.append(actions);
  }
  renderViews() {
    this.body.append(this.node('h2','','Home views'));
    if (this.mode !== 'views') {
      const view = this.mode === 'rename-view' ? requireHomeView(this.plugin.homeState,this.editViewId) : null;
      const name = this.field('View name',view?.name || '','e.g. Reading'); name.maxLength=60;
      const original = view?.name;
      const actions=this.node('div','aim-home-form-actions');actions.append(this.button('Save',async()=>{await this.plugin.saveHomeView(name.value,view?.id,original);this.close();},'mod-cta'),this.button('Cancel',()=>this.close()));this.body.append(actions);name.focus();return;
    }
    for (const view of this.plugin.homeState.views) {
      const row=this.node('div','aim-home-manager-row');row.append(this.node('span','aim-home-source-name',view.name),this.button('Rename',()=>{this.editViewId=view.id;this.mode='rename-view';this.render();}));
      if(this.plugin.homeState.views.length>1) row.append(this.button('Remove',()=>{
        row.replaceChildren(this.node('span','aim-home-source-name',`Remove ${view.name}? Sources and notes stay saved.`),this.button('Remove view',async()=>{await this.plugin.deleteHomeView(view.id);this.render();void this.plugin.refreshHomeCheckpoint();}),this.button('Cancel',()=>this.render()));
      }));this.body.append(row);
    }
    const actions=this.node('div','aim-home-form-actions');actions.append(this.button('Add view',()=>{this.mode='new-view';this.render();},'mod-cta'),this.button('Done',()=>this.close()));this.body.append(actions);
  }
  renderSource() {
    const source=this.source || {title:'',type:'note',target:'',bookmark:'',checkpoint:''};
    this.body.append(this.node('h2','',this.mode==='bookmark'?'Mark place':this.source?'Edit':'Add to Home'));
    if(this.mode==='bookmark') {
      this.body.append(this.node('p','aim-home-caption',source.title));
      const bookmark=this.field('Where did you leave off?',source.bookmark,'A chapter, page, episode or next step');bookmark.maxLength=280;
      const actions=this.node('div','aim-home-form-actions');actions.append(this.button('Save',async()=>{
        await this.plugin.saveHomeSource({...source,bookmark:bookmark.value,readMode:'manual'},this.viewId,this.expected);this.close();
      },'mod-cta'),this.button('Cancel',()=>this.close()));this.body.append(actions);bookmark.focus();return;
    }
    const target=this.field('Note, file, folder or link',source.target,'Choose a note or paste a path / URL');target.maxLength=2048;
    const browse=()=>{
      const selected=this.plugin.chooseHomePath(this.contentEl.ownerDocument.defaultView);
      if(selected && this.plugin.active && target.isConnected) {target.value=selected;target.focus();}
    };
    const pathField=target.parentElement;
    const pathRow=this.node('div','aim-home-path-row');pathField.replaceWith(pathRow);
    const browseButton=this.button('Browse…',browse);browseButton.setAttribute('aria-label','Browse for a file or folder');
    pathRow.append(pathField,browseButton);
    const suggestions=this.node('datalist');suggestions.id=homeId();
    for(const file of this.plugin.app.vault.getMarkdownFiles()) {
      if(file.path.split('/').some(p=>p.startsWith('.')||p.startsWith('_')||p==='Accounts'))continue;
      const o=this.node('option');o.value=file.path;suggestions.append(o);
    }
    target.setAttribute('list',suggestions.id);this.body.append(suggestions);
    this.body.append(this.node('p','aim-home-caption','Markdown shows its next step. Folders use HANDOFF.md, then README.md.'));
    const options=this.node('details','aim-home-add-options');options.append(this.node('summary','','Options'));
    const originalBody=this.body;this.body=options;
    const title=this.field('Display name (optional)',source.title,'Use the file or folder name');title.maxLength=160;
    this.body=originalBody;
    if (this.source) {
      const more=this.node('div','aim-home-form-actions');
      more.append(this.button('Choose document / section',()=>{this.mode='document';this.render();}),this.button('Set bookmark',()=>{this.mode='bookmark';this.render();}));
      if(source.readMode==='manual'||source.checkpoint||source.section) more.append(this.button('Use document automatically',async()=>{
        await this.plugin.saveHomeSource({...source,readMode:'auto',bookmark:'',checkpoint:'',section:''},this.viewId,this.expected);this.close();void this.plugin.refreshHomeCheckpoint();
      }));
      options.append(more);
    }
    this.body.append(options);
    const actions=this.node('div','aim-home-form-actions');actions.append(this.button(this.source?'Save':'Add',async()=>{
      if(!target.value.trim()) {browse();return;}
      const inferred=await this.plugin.inferHomeSource(target.value,this.source);
      // An unchanged prefilled name follows a changed path; explicit names win.
      if(title.value.trim() && (!this.source || title.value !== source.title || inferred.target===source.target)) inferred.title=title.value;
      await this.plugin.saveHomeSource(inferred,this.viewId,this.expected);
      this.close();void this.plugin.refreshHomeCheckpoint();
    },'mod-cta'),this.button('Cancel',()=>this.close()));this.body.append(actions);target.focus();
  }
  renderDocument() {
    const source=this.source;
    if(!source) {this.mode='edit';this.render();return;}
    this.body.append(this.node('h2','','Continue from'),this.node('p','aim-home-caption',source.title));
    const cached=this.documentChoice || this.plugin.homeCheckpoints.get(source.id);
    const path=this.field('Document',cached?.path || source.checkpoint || (source.type==='folder'?source.target.replace(/\/$/,'')+'/HANDOFF.md':source.target.split('#')[0]),'Path to a Markdown file');
    const sections=cached?.value?.sections || [];
    let select;
    if(sections.length) {
      const label=this.node('label','aim-home-field','Section');select=this.node('select');
      const empty=this.node('option','','Choose a section');empty.value='';select.append(empty);
      for(const s of sections) {
        const option=this.node('option','',s.label);option.value=s.id;
        option.disabled=!s.preview || sections.filter(other=>other.id===s.id).length>1;
        select.append(option);
      }
      select.value=source.section || '';label.append(select);this.body.append(label);
    }
    this.body.append(this.node('p','aim-home-caption','You can also choose README, AGENTS, CLAUDE or any Markdown note. Only this document is read.'));
    const actions=this.node('div','aim-home-form-actions');
    actions.append(this.button('Use document',async()=>{
      const documentPath=homeShortText(path.value,2048,'Document path');
      const chosen=documentPath===cached?.path ? select?.value || '' : '';
      const next=validateHomeSource({...source,checkpoint:documentPath,readMode:'auto',section:chosen});
      const value=this.plugin.parseHomeContinuation(await this.plugin.readHomeCheckpointFile(documentPath),chosen);
      if(value.status!=='ready') {
        this.documentChoice={path:documentPath,value};this.render();
        this.error.textContent=value.sections?.length ? 'Choose the section to show. Repeated identical headings need unique names in the document.' : 'No readable section found. Add a next-step heading or use Set bookmark.';
        return;
      }
      await this.plugin.saveHomeSource({...next,section:value.section || ''},this.viewId,this.expected);this.close();void this.plugin.refreshHomeCheckpoint();
    },'mod-cta'),this.button('Set bookmark',()=>{this.mode='bookmark';this.render();}),this.button('Cancel',()=>this.close()));
    this.body.append(actions);path.focus();
  }
  onClose() { this.plugin.homeModals.delete(this);this.contentEl.empty(); }
}

function homeId() { return 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 11); }

function homePlainExcerpt(text) {
  return text.replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_,target,label) => label || target)
    .replace(/`/g, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/\s+/g, ' ').trim();
}

function homeCanRead(source) {
  if (!source || source.readMode === 'manual' || (!source.readMode && source.bookmark && !source.checkpoint)) return false;
  return !!source.checkpoint || source.type === 'folder' || ['note','file'].includes(source.type) && /\.md$/i.test(source.target.split('#')[0]);
}

function homeSourceReadKey(source) {
  return source ? JSON.stringify([source.type,source.target,source.checkpoint,source.section || '',source.readMode || '',homeCanRead(source)]) : '';
}

function homeShortText(value, max, name, optional = false) {
  const text = typeof value === 'string' ? value.trim() : '';
  if ((!text && !optional) || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${name} must be ${optional ? 'at most' : '1–'}${max} characters on one line.`);
  return text;
}

function validateHomeSource(input) {
  const title = homeShortText(input?.title, 160, 'Source name');
  const type = input?.type;
  const target = homeShortText(input?.target, 2048, 'Source path or link');
  const bookmark = homeShortText(input?.bookmark, 280, 'Bookmark', true);
  const checkpoint = homeShortText(input?.checkpoint, 2048, 'Checkpoint path', true);
  if (!['note','file','folder','url','app'].includes(type)) throw new Error('Choose a source type.');
  if (type === 'note' && (target.startsWith('/') || target.startsWith('~') || target.includes('\\') || target.split('#')[0].split('/').some(p => p === '..' || p === '.') || /:\/\//.test(target))) throw new Error('Use a vault-relative note path, with an optional #heading.');
  if ((type === 'file' || type === 'folder') && !target.startsWith('/') && !target.startsWith('~/')) throw new Error('Use an absolute path or ~/ path.');
  if (type === 'url' || type === 'app') {
    let url; try { url = new URL(target); } catch (_) { throw new Error('Use a valid link.'); }
    if (url.username || url.password || (type === 'url' ? !['https:','http:'].includes(url.protocol) :
      !(url.protocol === 'obsidian:' && url.hostname === 'open' || /^steam:\/\/rungameid\/\d+\/?$/.test(target)))) throw new Error('Use a web link, obsidian://open link or steam://rungameid/game-id link.');
  }
  if (checkpoint && (!/\.md$/i.test(checkpoint) || checkpoint.includes('\\') || checkpoint.includes('://') || checkpoint.split('/').some(p => p === '..' || p === '.'))) throw new Error('Checkpoint must be a Markdown file path.');
  const result = {id:typeof input.id === 'string' ? input.id : '',title,type,target,bookmark,checkpoint};
  if (input.readMode !== undefined) {
    if (!['auto','manual'].includes(input.readMode)) throw new Error('Invalid reading mode.');
    result.readMode = input.readMode;
  }
  if (input.section) result.section = homeShortText(input.section,2048,'Section');
  if (input.updatedAt) {
    if (typeof input.updatedAt !== 'string' || !Number.isFinite(Date.parse(input.updatedAt))) throw new Error('Invalid bookmark date.');
    result.updatedAt = input.updatedAt;
  }
  return result;
}

function requireHomeView(state, id) {
  const view = state.views.find(v => v.id === id);
  if (!view) throw new Error('View no longer exists.');
  return view;
}

function homeWorkspaceState(settings) {
  const saved = settings?.homeWorkspace;
  if (saved === undefined) {
    return {version:1,activeView:'work',sources:[],views:[
      {id:'work',name:'Work',widgets:settings?.homeWidgets ? validHomeWidgets(settings.homeWidgets) : ['calendar','continue','youtrack'],pins:[],selected:''},
      {id:'study',name:'Study',widgets:['calendar','continue','links'],pins:[],selected:''},
      {id:'personal',name:'Personal',widgets:['calendar','continue','links'],pins:[],selected:''},
    ]};
  }
  if (!saved || saved.version !== 1 || !Array.isArray(saved.views) || !saved.views.length || saved.views.length > 100 || !Array.isArray(saved.sources) || saved.sources.length > 1000) throw new Error('Invalid Home settings.');
  const state = JSON.parse(JSON.stringify(saved));
  const sources = new Set();
  for (const source of state.sources) {
    validateHomeSource(source);
    if (typeof source.id !== 'string' || !source.id || sources.has(source.id)) throw new Error('Invalid Home source.');
    sources.add(source.id);
  }
  const views = new Set();
  for (const view of state.views) {
    if (typeof view.id !== 'string' || !view.id || views.has(view.id) || !Array.isArray(view.pins) || new Set(view.pins).size !== view.pins.length || view.pins.some(id => !sources.has(id)) || !Array.isArray(view.widgets) || view.widgets.length !== 3 || new Set(view.widgets).size !== 3 || view.widgets.some(id => !Object.hasOwn(HOME_WIDGETS,id)) || (view.selected !== '' && !view.pins.includes(view.selected))) throw new Error('Invalid Home view.');
    homeShortText(view.name,60,'View name'); views.add(view.id);
  }
  if (!views.has(state.activeView)) throw new Error('Invalid Home view.');
  return state;
}

function validHomeWidgets(value) {
  return Array.isArray(value) && value.length === 3 && new Set(value).size === 3 && value.every(id => Object.hasOwn(HOME_WIDGETS, id))
    ? [...value] : ['calendar', 'recent', 'youtrack'];
}

function mailFailure(code) {
  const messages = {
    '-1743':'Mail access was not allowed. Enable Obsidian → Mail in System Settings → Privacy & Security → Automation, then retry.',
    '-1712':'Mail took too long to respond. Open Mail, let it finish syncing, then retry.',
    '-1728':'The message or mailbox is no longer available. Refresh Mail and try again.',
    '-2701':'More than 20 enabled Mail accounts were found. This widget supports up to 20.',
    '-2702':'An account’s inbox could not be identified. Check its inbox in Apple Mail, then retry.',
    '-2703':'An inbox changed during the read. The previous list was kept; try Refresh again.',
    storage:'Could not save the Mail preference on this Mac. Try again.',
    runtime:'The local Mail reader is unavailable. This feature needs macOS and the complete plugin folder.',
  };
  const error = Error(messages[code] || 'Could not read a valid Mail snapshot. Open Mail and try Refresh again.');
  error.mailSafe = true; error.mailCode = code; return error;
}

function parseMailSnapshot(value) {
  if (value?.schema !== 1 || !Array.isArray(value.accounts) || value.accounts.length > 20 || !Array.isArray(value.rows) || value.rows.length > 1000) throw mailFailure('read');
  const text = (v,max) => typeof v === 'string' && v.length <= max && !/[\u0000]/.test(v);
  const accounts = new Map();
  for (const a of value.accounts) {
    if (!text(a.id,512) || !a.id || !text(a.name,256) || typeof a.limited !== 'boolean' || accounts.has(a.id)) throw mailFailure('read');
    accounts.set(a.id,{id:a.id,name:a.name,limited:a.limited});
  }
  const seen = new Set(), counts = new Map();
  const rows = value.rows.map(row => {
    if (!Number.isSafeInteger(row.id) || row.id < 1 || !accounts.has(row.accountId) || !text(row.mailbox,512) || !row.mailbox ||
        !text(row.subject,1024) || !text(row.sender,512) || !text(row.messageId,2048) || !Number.isFinite(row.receivedAt) ||
        row.receivedAt < 0 || row.receivedAt > Date.now() + 86400000 || typeof row.read !== 'boolean') throw mailFailure('read');
    const key = row.accountId + '\n' + row.id;
    if (seen.has(key)) throw mailFailure('read'); seen.add(key);
    counts.set(row.accountId,(counts.get(row.accountId) || 0) + 1);
    if (counts.get(row.accountId) > 50) throw mailFailure('read');
    return {id:row.id,accountId:row.accountId,mailbox:row.mailbox,messageId:row.messageId,subject:row.subject,sender:row.sender,receivedAt:row.receivedAt,read:row.read};
  }).sort((a,b) => b.receivedAt - a.receivedAt || b.id - a.id);
  return {accounts:[...accounts.values()],rows,fetchedAt:new Date().toISOString()};
}

function homeModuleSelection(settings) {
  let modules = validHomeModules(settings?.homeModules);
  // Three occupied legacy slots meant a module was parked by Mail; restore the three basic tiles.
  if (settings?.homeLayoutVersion === 1 && modules.length === 3 && modules.includes('mail')) modules = [...DEFAULT_HOME_MODULES];
  else modules = [...new Set(modules.map(id => id === 'mail' ? 'calendar' : id))];
  if (![1,2].includes(settings?.homeLayoutVersion) && settings?.slackModuleKnown !== true && !modules.includes('slack')) modules.push('slack');
  return DEFAULT_HOME_MODULES.filter(id => modules.includes(id));
}

function validHomeModules(value) {
  return Array.isArray(value) && new Set(value).size === value.length && value.every(id => ['scratchpad','mail',...DEFAULT_HOME_MODULES].includes(id))
    ? value.filter(id => id !== 'scratchpad').slice(0,3) : [...DEFAULT_HOME_MODULES];
}

function quickNotePath(value) {
  return typeof value === 'string' && /^Hub\/Quick Notes\/[^/\\]+\.md$/.test(value);
}

function homeElement(doc, tag, className = '', text = '') {
  const node = doc.createElement(tag); node.className = className; node.textContent = text; return node;
}

function typeIconsFromSettings(settings) {
  const value = settings?.typeIcons;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([type,icon]) =>
    type && !type.includes('/') && typeof icon === 'string' && Object.hasOwn(TYPE_ICONS,icon)));
}
function hubIcon(doc, name, extraClass = '') {
  const icon = doc.createElement('span'); icon.className = 'aim-ui-icon' + (extraClass ? ' ' + extraClass : '');
  icon.setAttribute('aria-hidden','true'); icon.setAttribute('data-icon',name); setIcon(icon,name); return icon;
}
function boardBody(text) { return String(text || '').replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/,'').trim(); }
function boardFileStamp(file) { return [file.path,file.stat.mtime,file.stat.size].join(':'); }
function boardSearchText(text) { return String(text || '').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/ı/g,'i'); }
function boardPlainText(text) {
  return String(text).replace(/!\[\[([^\]]+)\]\]/g,'$1').replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g,'$2')
    .replace(/\[\[([^\]]+)\]\]/g,'$1').replace(/!?\[([^\]]*)\]\([^)]*\)/g,'$1')
    .replace(/(\*\*|__)(.+?)\1/g,'$2').replace(/\*([^*\n]+)\*/g,'$1')
    .replace(/\x60([^\x60]+)\x60/g,'$1').replace(/\s+/g,' ').trim();
}
function renderBoardPreviewText(doc, target, text) {
  target.replaceChildren();
  if (!text.trim()) { const p = doc.createElement('p'); p.textContent = 'This note is empty.'; target.append(p); return; }
  let fence = '', code = null, paragraph = null, list = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.trim().match(/^(\x60{3,}|~{3,})/);
    if (marker) {
      if (!fence) { fence = marker[1][0]; code = doc.createElement('pre'); target.append(code); }
      else if (fence === marker[1][0]) { fence = ''; code = null; }
      paragraph = null; list = null; continue;
    }
    if (fence) { code.textContent += line + '\n'; continue; }
    if (!line.trim()) { paragraph = null; list = null; continue; }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const h = doc.createElement('h' + Math.min(heading[1].length + 2,6));
      h.textContent = boardPlainText(heading[2]); target.append(h); paragraph = null; list = null; continue;
    }
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/);
    if (item) {
      if (!list) { list = doc.createElement('ul'); target.append(list); }
      const li = doc.createElement('li'); li.textContent = boardPlainText(item[1]); list.append(li); paragraph = null; continue;
    }
    list = null;
    if (!paragraph) { paragraph = doc.createElement('p'); target.append(paragraph); }
    paragraph.textContent += (paragraph.textContent ? '\n' : '') + boardPlainText(line);
  }
}
function homeText(node, text) { if (node.textContent !== text) node.textContent = text; }

// Shared widget anatomy: source-specific content never changes the frame tracks.
function homeWidgetFooter(doc, actions, status, legacyClass = 'aim-home-tile-footer') {
  const footer = homeElement(doc,'div',`aim-widget-footer ${legacyClass}`);
  const controls = homeElement(doc,'div','aim-widget-footer-actions');
  controls.append(...actions); footer.append(controls,status); return footer;
}

function homeDateGroup(value, now = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return {key:'invalid',label:'Date unavailable'};
  const key = homeDay(date), yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate()-1);
  return {key,label:key === homeDay(now) ? 'Today' : key === homeDay(yesterday) ? 'Yesterday'
    : new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',...(date.getFullYear() !== now.getFullYear() ? {year:'numeric'} : {})}).format(date)};
}

function homeDay(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function homeDate(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Choose a valid date.');
  const [year, month, date] = day.split('-').map(Number);
  const value = new Date(year, month - 1, date, 12);
  if (homeDay(value) !== day) throw new Error('Choose a valid date.');
  return value;
}

function homeDailyPath(day) {
  const [year, month, date] = day.split('-'); return `${DAILY_FOLDER}/${date}-${month}-${year}.md`;
}

function hiddenTagsFromSettings(settings) {
  return new Set((Array.isArray(settings?.hiddenTagSuggestions) ? settings.hiddenTagSuggestions : [])
    .filter((tag) => typeof tag === "string").map(normalizeTag).filter((tag) => tag && !isKanbanTag(tag)));
}

function frontmatterTags(value) {
  return Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/[,\s]+/).filter(Boolean) : [];
}

function propertyValueLabel(value) {
  if (value === undefined || value === null || value === "") return "—";
  return (typeof value === "object" ? JSON.stringify(value) : String(value)).slice(0, 80);
}

function propertySnapshot(fm, key) {
  return JSON.stringify({ present: Object.hasOwn(fm, key), value: fm[key] });
}

function needsCompletionUpdate(front) {
  return front.board_column === "done"
    ? !front.completed_at || !Number.isFinite(Date.parse(front.completed_at))
    : front.completed_at !== undefined || front.completed_at_source !== undefined;
}

function updateCompletion(front, instant, source) {
  if (front.board_column === "done") {
    if (!front.completed_at || !Number.isFinite(Date.parse(front.completed_at))) {
      front.completed_at = instant;
      front.completed_at_source = source;
    }
  } else {
    delete front.completed_at;
    delete front.completed_at_source;
  }
}

function isKanbanTag(tag) {
  const normalized = normalizeTag(tag);
  return normalized === "kanban" || normalized.startsWith("kanban/");
}

function normalizeTag(t) {
  // tolerate "#kanban", "Kanban", stray whitespace — compare bare + lowercased
  return String(t).trim().replace(/^#/, "").toLowerCase();
}

function fileHasKanbanTag(cache) {
  if (!cache) return false;
  // getAllTags merges frontmatter + inline tags (returns them "#"-prefixed)
  const tags = getAllTags(cache) ?? [];
  return tags.some(isKanbanTag);
}

module.exports = AIMultipleKanbanExtras;

// Local copies control only the linked issue's State; no background mirror.
function validYouTrackWidgetIssue(item, profile) {
  return !!item && validYouTrackId(item.id, profile) && item.assignee === profile.login &&
    item.url === `https://${profile.host}/issue/${item.id}` && typeof item.title === 'string' &&
    item.title.length <= 5000 && typeof item.state === 'string';
}
function validateYouTrackDetail(value, id, profile) {
  if (!value || value.schema !== 1 || value.source !== 'YouTrack MCP' || value.id !== id || value.assignee !== profile?.login ||
      value.url !== `https://${profile?.host}/issue/${id}` || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 5000 ||
      typeof value.description !== 'string' || !Number.isFinite(Date.parse(value.fetchedAt)) ||
      !Array.isArray(value.comments) || value.comments.length > 1000 || !Array.isArray(value.attachments) || value.attachments.length > 1000 ||
      !value.fields || typeof value.fields !== 'object' || !Array.isArray(value.tags)) throw Error('Incomplete issue content. Nothing was imported.');
  let total = 0;
  const names = new Set();
  const Buffer = require('node:buffer').Buffer;
  for (const item of value.attachments) {
    if (!item || typeof item.name !== 'string' || typeof item.fileName !== 'string' || !/^[0-9]{3,4}-[^/\\\x00-\x1f\x7f\[\]#^]+$/.test(item.fileName) ||
        names.has(item.fileName) || !names.add(item.fileName) || !Number.isInteger(item.size) || item.size < 0 || item.size > 20*1024*1024 ||
        typeof item.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.data) ||
        Buffer.byteLength(item.data, 'base64') !== item.size) throw Error('Incomplete attachment. Nothing was imported.');
    total += item.size;
  }
  if (total > 50*1024*1024) throw Error('Attachments exceed 50 MB. Nothing was imported.');
  for (const comment of value.comments) {
    let url; try {url = new URL(comment.url);} catch (_) {}
    if (typeof comment.text !== 'string' || typeof comment.author !== 'string' || !url || url.protocol !== 'https:' ||
        url.hostname !== profile.host || url.username || url.password || url.port || url.pathname !== `/issue/${id}`) throw Error('Incomplete comments. Nothing was imported.');
  }
}
function renderYouTrackLocalNote(detail, column, attachments) {
  const quote = value => JSON.stringify(value);
  const front = {tags:['kanban'], category:'YouTrack', board_column:column,
    priority:({'Show-stopper':'urgent',Critical:'urgent',Urgent:'urgent',Major:'high',Normal:'medium',Minor:'low'})[detail.priority] || 'medium',
    youtrack_import:'local-v1', youtrack_id:detail.id, youtrack_title:`[${detail.id}] ${detail.title}`,
    youtrack_url:detail.url, youtrack_assignee:detail.assignee, youtrack_state:detail.state, youtrack_imported_at:detail.fetchedAt, youtrack_updated_at:detail.updatedAt};
  if (column === 'done') {front.completed_at = new Date().toISOString(); front.completed_at_source='status_change';}
  const inline = value => String(value ?? '').replace(/[\r\n]/g,' ').replace(/([\[\]<>])/g,'\\$1');
  const media = text => text.replace(/!\[[^\]]*\]\(<?youtrack-attachment:\/\/(\d+)>?\)(?:\{[^}\n]*\})?/g, (match,n) => attachments[n-1] ? `![[${attachments[n-1].path}]]` : match)
    .replace(/\[([^\]]*)\]\(<?youtrack-attachment:\/\/(\d+)>?\)/g,(match,label,n)=>attachments[n-1]?`[[${attachments[n-1].path}|${label || attachments[n-1].name.replace(/[\[\]|]/g,'')}]]`:match);
  let body = `---\n${Object.entries(front).filter(([,v])=>v!==undefined).map(([k,v])=>`${k}: ${quote(v)}`).join('\n')}\n---\n\n# ${inline(detail.title)}\n\n[${detail.id} · Open in YouTrack](${detail.url})\n\n> Local working copy. If enabled in YouTrack settings, board status changes the remote issue state. Your writing stays in Obsidian. Imported ${detail.fetchedAt}.\n\n## Description\n\n${media(detail.description)}\n\n`;
  if (Object.keys(detail.fields).length || detail.tags.length) {
    body += '## Source fields\n\n';
    for (const [key,value] of Object.entries(detail.fields)) body += `- **${inline(key)}:** ${inline(typeof value==='object'?JSON.stringify(value):value)}\n`;
    if (detail.tags.length) body += `- **Tags:** ${inline(detail.tags.map(t=>typeof t==='string'?t: t.name || JSON.stringify(t)).join(', '))}\n`;
    body += '\n';
  }
  if (detail.comments.length) {
    body += '## Comments\n\n';
    for (const comment of detail.comments) {
      const date = Number.isFinite(Number(comment.createdAt)) ? new Date(Number(comment.createdAt)).toISOString() : inline(comment.createdAt);
      body += `### ${inline(comment.author)} · ${date}\n\n${media(comment.text)}\n\n[Original comment](${comment.url})\n\n`;
    }
  }
  if (attachments.length) body += '## Attachments\n\n' + attachments.map(item=>`- [[${item.path}|${item.name.replace(/[\[\]|\r\n]/g,' ')}]]`).join('\n') + '\n\n';
  return body + '## My notes\n\n';
}


// Slack read-only adapter. Only these fixed API methods can receive the token.
function slackFailure(kind) {
  const messages = {
    token:'Paste a Slack User OAuth Token starting with xoxp-.',
    keychain:'Slack connection requires Obsidian 1.11.4 or later with working Keychain support.',
    save:'Could not save the Slack connection to Keychain. The previous connection was kept.',
    disconnect:'Could not remove the Slack connection from Keychain. Please retry.',
    storageUnknown:'Could not verify the saved Slack connection in Keychain. Reconnect in Slack settings.',
    cancelled:'Slack request cancelled.', busy:'A Slack request is already running.',
    connection:'Connect Slack on this device before refreshing.',
    network:'Could not reach Slack. Check your connection and try Refresh again.',
    timeout:'Slack took too long to respond. Try Refresh again.',
    invalid:'Slack returned an incomplete response. Try Refresh again.',
    identity:'The Slack account or workspace changed. Reconnect in Slack settings.',
    auth:'Slack access expired or was revoked. Reconnect in Slack settings.',
    search:'Slack search access is unavailable. Check the search:read user scope and reinstall the app.',
    users:'Slack profile access is unavailable. Check the users:read user scope and reinstall the app.',
    groups:'Slack group access is unavailable. Add the usergroups:read user scope and reinstall the app.',
    dmList:'Slack DM access is unavailable. Add the im:read user scope and reinstall the app.',
    dmHistory:'Slack DM messages are unavailable. Add the im:history user scope and reinstall the app.',
    channelList:'Slack channel access is unavailable. Add the channels:read user scope and reinstall the app.',
    channelHistory:'Slack channel messages are unavailable. Add the channels:history user scope and reinstall the app.',
    privateList:'The notes channel was not found among public channels. If it is private, add groups:read and groups:history user scopes, then reinstall the app.',
    privateHistory:'The private notes channel needs the groups:history user scope. Reinstall the app after adding it.',
    channel:'Could not find the selected notes channel. Check its name and your membership.',
    group:'Could not verify membership in the selected user group. Check its handle and membership.',
    legacy:'This workspace does not allow the legacy Slack search API. The connection was not updated.',
  };
  const error = new Error(messages[kind] || messages.network); error.slackSafe = true; error.slackKind = kind; return error;
}
function slackRateLimit(ms) {
  const error = new Error(`Slack is limiting requests. Try again in ${Math.ceil(ms / 1000)} seconds.`);
  error.slackSafe = true; error.retryMs = ms; return error;
}
function slackErrorMessage(error) { return error?.slackSafe ? error.message : slackFailure('network').message; }
function commitSlackSecret(storage, next, failure = 'save') {
  if (!storage?.getSecret || !storage?.setSecret) throw slackFailure('keychain');
  let previous;
  try { previous = storage.getSecret(SLACK_SECRET) || ''; } catch (_) { throw slackFailure('keychain'); }
  try {
    storage.setSecret(SLACK_SECRET, next);
    if ((storage.getSecret(SLACK_SECRET) || '') !== next) throw slackFailure(failure);
  } catch (_) {
    try {
      // A failed setter may already have changed storage. Verify or restore the old credential.
      if ((storage.getSecret(SLACK_SECRET) || '') !== previous) storage.setSecret(SLACK_SECRET, previous);
      if ((storage.getSecret(SLACK_SECRET) || '') !== previous) throw slackFailure('storageUnknown');
    } catch (_) { const error = slackFailure('storageUnknown'); error.slackUncertain = true; throw error; }
    throw slackFailure(failure);
  }
}
function validateSlackToken(value) {
  if (typeof value !== 'string' || !/^xoxp-[A-Za-z0-9-]{10,2043}$/.test(value.trim())) throw slackFailure('token');
  return value.trim();
}
function parseSlackSecret(value) {
  if (!value) return null;
  const saved = JSON.parse(value);
  if (saved.version !== 1 || !/^T[A-Z0-9]+$/.test(saved.account?.teamId) || !/^[UW][A-Z0-9]+$/.test(saved.account?.userId)
      || typeof saved.account?.teamName !== 'string' || typeof saved.account?.userName !== 'string') throw slackFailure('connection');
  validateSlackToken(saved.token); return saved;
}
function slackCleanText(value, names = new Map()) {
  return String(value || '').slice(0,12000)
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_,id) => '@' + (names.get(id) || 'member'))
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<(https?:\/\/[^>|]+)(?:\|([^>]*))?>/g, (_,url,label) => label || url)
    .replace(/<![^>|]+(?:\|([^>]+))?>/g, (_,label) => label || '@group')
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,3000);
}
function slackPermalink(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !/^[a-z0-9-]+\.slack\.com$/.test(url.hostname) || !/^\/archives\/[CGD][A-Z0-9]+\/p\d{16,20}$/.test(url.pathname)) return null;
    for (const key of [...url.searchParams.keys()]) if (!['thread_ts','cid'].includes(key)) url.searchParams.delete(key);
    url.hash = ''; return url.href;
  } catch (_) { return null; }
}
async function readSlackMentions(request, token, expected, current = () => true, nameCache = new Map(), sourceInput = {}) {
  const sources = normalizeSlackSources(sourceInput);
  const SLACK_FEED_CHANNEL = sources.channel, SLACK_FEED_GROUP = sources.group;
  validateSlackToken(token);
  const now = Date.now(), since = now - 7 * 86400000, deadline = now + 90000;
  let batchFailure = null;
  const check = () => { if (!current()) throw slackFailure('cancelled'); if (batchFailure) throw batchFailure; if (Date.now() >= deadline) throw slackFailure('timeout'); };
  const parallel = async (items, action) => {
    let next = 0;
    const worker = async () => {
      while (!batchFailure && next < items.length) {
        const item = items[next++];
        try { check(); await action(item); }
        catch (error) { batchFailure ||= error; }
      }
    };
    await Promise.all(Array.from({length:Math.min(3,items.length)}, worker));
    if (batchFailure) throw batchFailure;
  };
  let calls = 0;
  const api = async (method, params = {}, scopeKind = 'search') => {
    check();
    if (!['auth.test','users.info','search.messages','usergroups.list','conversations.list','conversations.history','conversations.replies'].includes(method) || ++calls > 110) throw slackFailure('invalid');
    const query = new URLSearchParams(params).toString();
    const options = {url:`https://slack.com/api/${method}${query ? '?' + query : ''}`,method:method === 'auth.test' ? 'POST' : 'GET',
      headers:{Authorization:`Bearer ${token}`},throw:false};
    let response, timer;
    try {
      response = await Promise.race([Promise.resolve().then(() => { check(); return request(options); }),
        new Promise((_,reject) => { timer = setTimeout(() => reject(slackFailure('timeout')), Math.min(12000,deadline-Date.now())); })]);
    } catch (error) { throw error?.slackSafe ? error : slackFailure('network'); }
    finally { clearTimeout(timer); }
    check();
    if (response?.status === 429) {
      const header = Object.entries(response.headers || {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
      const seconds = Number(header); throw slackRateLimit(Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds),86400)*1000 : 60000);
    }
    if (response?.status === 401 || response?.status === 403) throw slackFailure('auth');
    if (response?.status !== 200 || typeof response.text !== 'string' || response.text.length > 2*1024*1024) throw slackFailure('invalid');
    let data; try { data = JSON.parse(response.text); } catch (_) { throw slackFailure('invalid'); }
    if (data?.ok !== true) {
      if (['invalid_auth','token_expired','token_revoked','account_inactive','not_authed'].includes(data?.error)) throw slackFailure('auth');
      if (data?.error === 'missing_scope') throw slackFailure(method === 'users.info' ? 'users' : scopeKind);
      if (['deprecated_endpoint','method_deprecated','not_allowed_token_type','enterprise_is_restricted'].includes(data?.error)) throw slackFailure('legacy');
      if (data?.error === 'ratelimited') throw slackRateLimit(60000);
      throw slackFailure('invalid');
    }
    return data;
  };
  const auth = await api('auth.test');
  if (!/^T[A-Z0-9]+$/.test(auth.team_id) || !/^[UW][A-Z0-9]+$/.test(auth.user_id) || auth.bot_id) throw slackFailure('identity');
  if (expected && (expected.teamId !== auth.team_id || expected.userId !== auth.user_id)) throw slackFailure('identity');
  let origin;
  try {
    const base = new URL(auth.url);
    if (base.protocol !== 'https:' || base.username || base.password || base.port || !/^[a-z0-9-]+\.slack\.com$/.test(base.hostname) || base.pathname !== '/') throw Error();
    origin = base.origin;
  } catch (_) { throw slackFailure('identity'); }
  const self = await api('users.info',{user:auth.user_id});
  if (self.user?.id !== auth.user_id || self.user.is_bot || self.user.deleted) throw slackFailure('identity');
  const nameOf = user => slackCleanText(user?.profile?.display_name || user?.profile?.real_name || user?.real_name || user?.name).slice(0,120);
  const account = {teamId:auth.team_id,userId:auth.user_id,teamName:slackCleanText(auth.team || 'Slack workspace').slice(0,120),userName:nameOf(self.user) || slackCleanText(auth.user) || 'You'};
  const names = new Map([[account.userId,account.userName]]), rows = new Map(), limitNotes = new Set();
  const limit = note => limitNotes.add(note);
  const stamp = value => typeof value === 'string' && /^\d{10}\.\d{6}$/.test(value);
  const nextCursor = data => {
    const cursor = data.response_metadata?.next_cursor ?? '';
    if (typeof cursor !== 'string' || cursor.length > 2000 || /[\u0000-\u001f]/.test(cursor)) throw slackFailure('invalid');
    return cursor;
  };
  // Both history markup and search-normalized mentions must use the verified group ID.
  let groupId = '';
  if (SLACK_FEED_GROUP) {
  const groupData = await api('usergroups.list',{include_users:'true'},'groups');
  if (!Array.isArray(groupData.usergroups) || groupData.usergroups.length > 5000) throw slackFailure('invalid');
  const groups = groupData.usergroups.filter(g=>g?.handle === SLACK_FEED_GROUP && !g.date_delete && (!g.team_id || g.team_id === account.teamId));
  if (groups.length !== 1 || !/^S[A-Z0-9]+$/.test(groups[0].id) || !Array.isArray(groups[0].users) || !groups[0].users.includes(account.userId)) throw slackFailure('group');
  groupId = groups[0].id;
  }
  const personalMention = new RegExp(`<@${account.userId}(?:\\|[^>]*)?>`);
  const groupMention = groupId ? new RegExp(`<(?:!subteam\\^|@)${groupId}(?:\\|[^>]*)?>`) : /$a/;
  const conversations = async (types, scopeKind) => {
    const found = new Map(), cursors = new Set(); let cursor = '';
    for (let page=0;page<3;page++) {
      const data = await api('conversations.list',{types,limit:'200',exclude_archived:'false',...(cursor?{cursor}:{})},scopeKind);
      if (!Array.isArray(data.channels) || data.channels.length > 200) throw slackFailure('invalid');
      for (const channel of data.channels) {
        if (!channel || typeof channel.id !== 'string' || !/^[CGD][A-Z0-9]+$/.test(channel.id)) throw slackFailure('invalid');
        found.set(channel.id,channel);
      }
      cursor = nextCursor(data); if (!cursor) return [...found.values()];
      if (cursors.has(cursor)) throw slackFailure('invalid'); cursors.add(cursor);
    }
    limit(types === 'im' ? 'Some DM conversations were not checked.' : 'Channel discovery was limited.');
    return [...found.values()];
  };
  let notes = null, privateChannel = false;
  if (SLACK_FEED_CHANNEL) {
  let channels = await conversations('public_channel','channelList');
  let matched = channels.filter(c=>c.name === SLACK_FEED_CHANNEL && c.is_member === true && !c.is_im && !c.is_mpim);
  privateChannel = false;
  if (!matched.length) {
    channels = await conversations('private_channel','privateList'); privateChannel = true;
    matched = channels.filter(c=>c.name === SLACK_FEED_CHANNEL && c.is_member === true && !c.is_im && !c.is_mpim);
  }
  if (matched.length !== 1) throw slackFailure('channel');
  notes = matched[0];
  }
  const add = (message, channel, source, permalink) => {
    if (!stamp(message?.ts) || typeof message.text !== 'string') { limit('Some unsupported messages were omitted.'); return; }
    const time = Number(message.ts)*1000;
    if (time < since || time > now+60000) return;
    if (['channel_join','channel_leave','group_join','group_leave','message_deleted','message_changed'].includes(message.subtype)) return;
    if (source === 'dm' && message.user === account.userId) return;
    let url = permalink || `${origin}/archives/${channel.id}/p${message.ts.replace('.','')}`;
    if (!permalink && stamp(message.thread_ts) && message.thread_ts !== message.ts) url += '?thread_ts=' + message.thread_ts + '&cid=' + channel.id;
    url = slackPermalink(url); if (!url) { limit('Some invalid message links were omitted.'); return; }
    const sources = new Set([source]);
    if (personalMention.test(message.text)) sources.add('mention');
    if (groupMention.test(message.text)) sources.add('group');
    if (channel.id === notes?.id) sources.add('channel');
    const isDM = channel.is_im === true || channel.id.startsWith('D');
    if (isDM && message.user !== account.userId) sources.add('dm');
    const id = channel.id + ':' + message.ts, previous = rows.get(id);
    if (previous) { for (const s of sources) previous.sources.add(s); return; }
    rows.set(id,{id,time,url,rawText:message.text.slice(0,12000) || (message.files?.length ? 'File attachment' : 'Message without text'),user:message.user,
      author:slackCleanText(message.username || 'Slack member').slice(0,120),channel:isDM?'Direct message':'#'+slackCleanText(channel.name || channel.id).slice(0,120),sources});
  };
  const search = async (term, source, matchesSource) => {
    const query = `${term} after:${new Date(since-86400000).toISOString().slice(0,10)}`; let accepted=0;
    for (let page=1;page<=3;page++) {
      const data = await api('search.messages',{query,sort:'timestamp',sort_dir:'desc',count:'100',page:String(page)});
      const matches = data.messages?.matches;
      if (!Array.isArray(matches) || matches.length > 100) throw slackFailure('invalid');
      const pages = data.messages?.paging?.pages ?? data.messages?.pagination?.page_count;
      if (!Number.isInteger(pages) || pages < 0 || pages > 100000) throw slackFailure('invalid');
      const returned = data.messages?.paging?.page ?? data.messages?.pagination?.page;
      if (returned !== undefined && returned !== page) throw slackFailure('invalid');
      for (const match of matches) {
        if (typeof match?.text !== 'string' || !stamp(match.ts)) { limit('Some unsupported search results were omitted.'); continue; }
        if (!matchesSource(match.text) || Number(match.ts)*1000 < since || Number(match.ts)*1000 > now+60000) continue;
        if (typeof match.channel?.id !== 'string' || !/^[CGD][A-Z0-9]+$/.test(match.channel.id)) { limit('Some unsupported search results were omitted.'); continue; }
        // Take the newest bounded search set; the combined feed is sorted again below.
        if (accepted++ >= 50) { limit('Mention search results were limited.'); continue; }
        if (!slackPermalink(match.permalink)) { limit('Some invalid message links were omitted.'); continue; }
        add(match,match.channel,source,match.permalink);
      }
      if (page >= pages) break;
      if (page === 3 || accepted >= 50) { limit('Mention search results were limited.'); break; }
    }
  };
  await parallel([
    [`<@${account.userId}>`,'mention',text=>personalMention.test(text)],
    // Slack search accepts the visible handle; returned markup must still match the verified group ID.
    ...(SLACK_FEED_GROUP ? [[`@${SLACK_FEED_GROUP}`,'group',text=>groupMention.test(text)]] : []),
  ], args=>search(...args));
  const threads = new Map();
  const history = async (channel,source,pageLimit) => {
    let cursor='';const cursors=new Set();
    const scopeKind=source === 'dm' ? 'dmHistory' : privateChannel ? 'privateHistory' : 'channelHistory';
    for(let page=0;page<pageLimit;page++) {
      const data=await api('conversations.history',{channel:channel.id,oldest:String(since/1000),limit:'100',...(cursor?{cursor}:{})},scopeKind);
      if(!Array.isArray(data.messages)||data.messages.length>100||typeof data.has_more!=='boolean')throw slackFailure('invalid');
      for(const message of data.messages){
        add(message,channel,source);
        if(stamp(message.ts)&&Number(message.reply_count)>0&&stamp(message.latest_reply)&&Number(message.latest_reply)*1000>=since)threads.set(channel.id+':'+message.ts,{channel,source,ts:message.ts,latest:Number(message.latest_reply),scopeKind});
      }
      cursor=nextCursor(data);if(!data.has_more&&!cursor)return;
      if(!cursor){
        // Without a cursor Slack supports time pagination, but this bounded snapshot stops visibly.
        limit('Some '+(source==='dm'?'DM':'channel')+' history was not loaded.');return;
      }
      if(cursors.has(cursor))throw slackFailure('invalid');cursors.add(cursor);
    }
    limit('Some '+(source==='dm'?'DM':'channel')+' history was not loaded.');
  };
  if (notes) await history(notes,'channel',3);
  const dms=(await conversations('im','dmList')).filter(c=>c.is_im===true&&/^D[A-Z0-9]+$/.test(c.id)&&c.user!==account.userId);
  if(dms.length>40)limit('Some DM conversations were not checked.');
  await parallel(dms.slice(0,40), dm=>history(dm,'dm',1));
  if(threads.size>12)limit('Some recent threads were not loaded.');
  await parallel([...threads.values()].sort((a,b)=>b.latest-a.latest).slice(0,12), async thread=>{
    let cursor='';const cursors=new Set();
    for(let page=0;page<2;page++){
      const data=await api('conversations.replies',{channel:thread.channel.id,ts:thread.ts,oldest:String(since/1000),limit:'100',...(cursor?{cursor}:{})},thread.scopeKind);
      if(!Array.isArray(data.messages)||data.messages.length>100||typeof data.has_more!=='boolean')throw slackFailure('invalid');
      for(const message of data.messages)add(message,thread.channel,thread.source);
      cursor=nextCursor(data);if(!data.has_more&&!cursor)break;
      if(!cursor||page===1){limit('Some recent thread replies were not loaded.');break;}
      if(cursors.has(cursor))throw slackFailure('invalid');cursors.add(cursor);
    }
  });
  const sorted=[...rows.values()].sort((a,b)=>b.time-a.time);
  if(sorted.length>50)limit('Each view shows up to 50 of its newest loaded messages.');
  // Retain each source before capping the current view, so busy channels cannot erase mentions.
  const sourceCounts = new Map();
  const visible = sorted.filter(row => {
    let keep = false;
    for (const source of row.sources) {
      const count = sourceCounts.get(source) || 0;
      if (count < 50) keep = true;
      sourceCounts.set(source, count + 1);
    }
    return keep;
  });
  const cachePrefix = account.teamId + ':' + account.userId + ':';
  for (const [key,value] of nameCache) if (!key.startsWith(cachePrefix) || value.expires <= Date.now()) nameCache.delete(key);
  const authors=[...new Set(visible.map(row=>row.user))].filter(id=>/^[UW][A-Z0-9]+$/.test(id)&&!names.has(id));
  for (const id of authors) { const cached = nameCache.get(cachePrefix + id); if (cached) names.set(id,cached.name); }
  await parallel(authors.filter(id=>!names.has(id)).slice(0,12), async id=>{
    try {
      const data=await api('users.info',{user:id});
      if(data.user?.id===id&&nameOf(data.user)) {
        const name = nameOf(data.user); names.set(id,name); nameCache.set(cachePrefix+id,{name,expires:Date.now()+3600000});
        while (nameCache.size>200) nameCache.delete(nameCache.keys().next().value);
      }
    } catch(error) { check(); if(error?.retryMs||error?.slackKind==='auth')throw error; }
  });
  check();
  const fetchedAt = Date.now();
  return {account,fetchedAt,durationMs:fetchedAt-now,limited:limitNotes.size>0,limitNotes:[...limitNotes],rows:visible.map(({rawText,user,sources,...row})=>({...row,sources:[...sources],author:names.get(user)||row.author,text:slackCleanText(rawText.replace(new RegExp(`<(?:!subteam\\^|@)${groupId}(?:\\|[^>]*)?>`,'g'),'@'+SLACK_FEED_GROUP),names)}))};
}

// BEGIN LOCAL CALENDAR BUNDLE
// Generated by scripts/bundle-calendar.cjs; edit calendar.js, not this section.
let homeCalendarAdapter;
function getHomeCalendarAdapter() {
  if (!homeCalendarAdapter) homeCalendarAdapter = (() => {
    const ICAL = (() => { const module = { exports: {} }; const exports = module.exports;
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch */
(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
  typeof define === 'function' && define.amd ? define(factory) :
  (global = typeof globalThis !== 'undefined' ? globalThis : global || self, global.ICAL = factory());
})(this, (function () { 'use strict';

  function _arrayLikeToArray(r, a) {
    (null == a || a > r.length) && (a = r.length);
    for (var e = 0, n = Array(a); e < a; e++) n[e] = r[e];
    return n;
  }
  function _arrayWithHoles(r) {
    if (Array.isArray(r)) return r;
  }
  function _arrayWithoutHoles(r) {
    if (Array.isArray(r)) return _arrayLikeToArray(r);
  }
  function _assertClassBrand(e, t, n) {
    if ("function" == typeof e ? e === t : e.has(t)) return arguments.length < 3 ? t : n;
    throw new TypeError("Private element is not present on this object");
  }
  function _assertThisInitialized(e) {
    if (void 0 === e) throw new ReferenceError("this hasn't been initialised - super() hasn't been called");
    return e;
  }
  function _callSuper(t, o, e) {
    return o = _getPrototypeOf(o), _possibleConstructorReturn(t, _isNativeReflectConstruct() ? Reflect.construct(o, e || [], _getPrototypeOf(t).constructor) : o.apply(t, e));
  }
  function _classCallCheck(a, n) {
    if (!(a instanceof n)) throw new TypeError("Cannot call a class as a function");
  }
  function _construct(t, e, r) {
    if (_isNativeReflectConstruct()) return Reflect.construct.apply(null, arguments);
    var o = [null];
    o.push.apply(o, e);
    var p = new (t.bind.apply(t, o))();
    return r && _setPrototypeOf(p, r.prototype), p;
  }
  function _defineProperties(e, r) {
    for (var t = 0; t < r.length; t++) {
      var o = r[t];
      o.enumerable = o.enumerable || !1, o.configurable = !0, "value" in o && (o.writable = !0), Object.defineProperty(e, _toPropertyKey(o.key), o);
    }
  }
  function _createClass(e, r, t) {
    return r && _defineProperties(e.prototype, r), t && _defineProperties(e, t), Object.defineProperty(e, "prototype", {
      writable: !1
    }), e;
  }
  function _createForOfIteratorHelper(r, e) {
    var t = "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"];
    if (!t) {
      if (Array.isArray(r) || (t = _unsupportedIterableToArray(r)) || e) {
        t && (r = t);
        var n = 0,
          F = function () {};
        return {
          s: F,
          n: function () {
            return n >= r.length ? {
              done: !0
            } : {
              done: !1,
              value: r[n++]
            };
          },
          e: function (r) {
            throw r;
          },
          f: F
        };
      }
      throw new TypeError("Invalid attempt to iterate non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
    }
    var o,
      a = !0,
      u = !1;
    return {
      s: function () {
        t = t.call(r);
      },
      n: function () {
        var r = t.next();
        return a = r.done, r;
      },
      e: function (r) {
        u = !0, o = r;
      },
      f: function () {
        try {
          a || null == t.return || t.return();
        } finally {
          if (u) throw o;
        }
      }
    };
  }
  function _defineProperty(e, r, t) {
    return (r = _toPropertyKey(r)) in e ? Object.defineProperty(e, r, {
      value: t,
      enumerable: !0,
      configurable: !0,
      writable: !0
    }) : e[r] = t, e;
  }
  function _getPrototypeOf(t) {
    return _getPrototypeOf = Object.setPrototypeOf ? Object.getPrototypeOf.bind() : function (t) {
      return t.__proto__ || Object.getPrototypeOf(t);
    }, _getPrototypeOf(t);
  }
  function _inherits(t, e) {
    if ("function" != typeof e && null !== e) throw new TypeError("Super expression must either be null or a function");
    t.prototype = Object.create(e && e.prototype, {
      constructor: {
        value: t,
        writable: !0,
        configurable: !0
      }
    }), Object.defineProperty(t, "prototype", {
      writable: !1
    }), e && _setPrototypeOf(t, e);
  }
  function _isNativeFunction(t) {
    try {
      return -1 !== Function.toString.call(t).indexOf("[native code]");
    } catch (n) {
      return "function" == typeof t;
    }
  }
  function _isNativeReflectConstruct() {
    try {
      var t = !Boolean.prototype.valueOf.call(Reflect.construct(Boolean, [], function () {}));
    } catch (t) {}
    return (_isNativeReflectConstruct = function () {
      return !!t;
    })();
  }
  function _iterableToArray(r) {
    if ("undefined" != typeof Symbol && null != r[Symbol.iterator] || null != r["@@iterator"]) return Array.from(r);
  }
  function _iterableToArrayLimit(r, l) {
    var t = null == r ? null : "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"];
    if (null != t) {
      var e,
        n,
        i,
        u,
        a = [],
        f = !0,
        o = !1;
      try {
        if (i = (t = t.call(r)).next, 0 === l) ; else for (; !(f = (e = i.call(t)).done) && (a.push(e.value), a.length !== l); f = !0);
      } catch (r) {
        o = !0, n = r;
      } finally {
        try {
          if (!f && null != t.return && (u = t.return(), Object(u) !== u)) return;
        } finally {
          if (o) throw n;
        }
      }
      return a;
    }
  }
  function _nonIterableRest() {
    throw new TypeError("Invalid attempt to destructure non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
  }
  function _nonIterableSpread() {
    throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
  }
  function _possibleConstructorReturn(t, e) {
    if (e && ("object" == typeof e || "function" == typeof e)) return e;
    if (void 0 !== e) throw new TypeError("Derived constructors may only return object or undefined");
    return _assertThisInitialized(t);
  }
  function _setPrototypeOf(t, e) {
    return _setPrototypeOf = Object.setPrototypeOf ? Object.setPrototypeOf.bind() : function (t, e) {
      return t.__proto__ = e, t;
    }, _setPrototypeOf(t, e);
  }
  function _slicedToArray(r, e) {
    return _arrayWithHoles(r) || _iterableToArrayLimit(r, e) || _unsupportedIterableToArray(r, e) || _nonIterableRest();
  }
  function _toConsumableArray(r) {
    return _arrayWithoutHoles(r) || _iterableToArray(r) || _unsupportedIterableToArray(r) || _nonIterableSpread();
  }
  function _toPrimitive(t, r) {
    if ("object" != typeof t || !t) return t;
    var e = t[Symbol.toPrimitive];
    if (void 0 !== e) {
      var i = e.call(t, r || "default");
      if ("object" != typeof i) return i;
      throw new TypeError("@@toPrimitive must return a primitive value.");
    }
    return ("string" === r ? String : Number)(t);
  }
  function _toPropertyKey(t) {
    var i = _toPrimitive(t, "string");
    return "symbol" == typeof i ? i : i + "";
  }
  function _typeof(o) {
    "@babel/helpers - typeof";

    return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (o) {
      return typeof o;
    } : function (o) {
      return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o;
    }, _typeof(o);
  }
  function _unsupportedIterableToArray(r, a) {
    if (r) {
      if ("string" == typeof r) return _arrayLikeToArray(r, a);
      var t = {}.toString.call(r).slice(8, -1);
      return "Object" === t && r.constructor && (t = r.constructor.name), "Map" === t || "Set" === t ? Array.from(r) : "Arguments" === t || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t) ? _arrayLikeToArray(r, a) : void 0;
    }
  }
  function _wrapNativeSuper(t) {
    var r = "function" == typeof Map ? new Map() : void 0;
    return _wrapNativeSuper = function (t) {
      if (null === t || !_isNativeFunction(t)) return t;
      if ("function" != typeof t) throw new TypeError("Super expression must either be null or a function");
      if (void 0 !== r) {
        if (r.has(t)) return r.get(t);
        r.set(t, Wrapper);
      }
      function Wrapper() {
        return _construct(t, arguments, _getPrototypeOf(this).constructor);
      }
      return Wrapper.prototype = Object.create(t.prototype, {
        constructor: {
          value: Wrapper,
          enumerable: !1,
          writable: !0,
          configurable: !0
        }
      }), _setPrototypeOf(Wrapper, t);
    }, _wrapNativeSuper(t);
  }

  /* This Source Code Form is subject to the terms of the Mozilla Public
   * License, v. 2.0. If a copy of the MPL was not distributed with this
   * file, You can obtain one at http://mozilla.org/MPL/2.0/.
   * Portions Copyright (C) Philipp Kewisch */
  /**
   * Represents the BINARY value type, which contains extra methods for encoding and decoding.
   *
   * @memberof ICAL
   */
  var Binary = /*#__PURE__*/function () {
    /**
     * Creates a new ICAL.Binary instance
     *
     * @param {String} aValue     The binary data for this value
     */
    function Binary(aValue) {
      _classCallCheck(this, Binary);
      /**
       * The type name, to be used in the jCal object.
       * @default "binary"
       * @constant
       */
      _defineProperty(this, "icaltype", "binary");
      this.value = aValue;
    }
    return _createClass(Binary, [{
      key: "decodeValue",
      value:
      /**
       * Base64 decode the current value
       *
       * @return {String}         The base64-decoded value
       */
      function decodeValue() {
        return this._b64_decode(this.value);
      }

      /**
       * Encodes the passed parameter with base64 and sets the internal
       * value to the result.
       *
       * @param {String} aValue      The raw binary value to encode
       */
    }, {
      key: "setEncodedValue",
      value: function setEncodedValue(aValue) {
        this.value = this._b64_encode(aValue);
      }
    }, {
      key: "_b64_encode",
      value: function _b64_encode(data) {
        // http://kevin.vanzonneveld.net
        // +   original by: Tyler Akins (http://rumkin.com)
        // +   improved by: Bayron Guevara
        // +   improved by: Thunder.m
        // +   improved by: Kevin van Zonneveld (http://kevin.vanzonneveld.net)
        // +   bugfixed by: Pellentesque Malesuada
        // +   improved by: Kevin van Zonneveld (http://kevin.vanzonneveld.net)
        // +   improved by: Rafał Kukawski (http://kukawski.pl)
        // *     example 1: base64_encode('Kevin van Zonneveld');
        // *     returns 1: 'S2V2aW4gdmFuIFpvbm5ldmVsZA=='
        // mozilla has this native
        // - but breaks in 2.0.0.12!
        //if (typeof this.window['atob'] == 'function') {
        //    return atob(data);
        //}
        var b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ" + "abcdefghijklmnopqrstuvwxyz0123456789+/=";
        var o1,
          o2,
          o3,
          h1,
          h2,
          h3,
          h4,
          bits,
          i = 0,
          ac = 0,
          enc = "",
          tmp_arr = [];
        if (!data) {
          return data;
        }
        do {
          // pack three octets into four hexets
          o1 = data.charCodeAt(i++);
          o2 = data.charCodeAt(i++);
          o3 = data.charCodeAt(i++);
          bits = o1 << 16 | o2 << 8 | o3;
          h1 = bits >> 18 & 0x3f;
          h2 = bits >> 12 & 0x3f;
          h3 = bits >> 6 & 0x3f;
          h4 = bits & 0x3f;

          // use hexets to index into b64, and append result to encoded string
          tmp_arr[ac++] = b64.charAt(h1) + b64.charAt(h2) + b64.charAt(h3) + b64.charAt(h4);
        } while (i < data.length);
        enc = tmp_arr.join('');
        var r = data.length % 3;
        return (r ? enc.slice(0, r - 3) : enc) + '==='.slice(r || 3);
      }
    }, {
      key: "_b64_decode",
      value: function _b64_decode(data) {
        // http://kevin.vanzonneveld.net
        // +   original by: Tyler Akins (http://rumkin.com)
        // +   improved by: Thunder.m
        // +      input by: Aman Gupta
        // +   improved by: Kevin van Zonneveld (http://kevin.vanzonneveld.net)
        // +   bugfixed by: Onno Marsman
        // +   bugfixed by: Pellentesque Malesuada
        // +   improved by: Kevin van Zonneveld (http://kevin.vanzonneveld.net)
        // +      input by: Brett Zamir (http://brett-zamir.me)
        // +   bugfixed by: Kevin van Zonneveld (http://kevin.vanzonneveld.net)
        // *     example 1: base64_decode('S2V2aW4gdmFuIFpvbm5ldmVsZA==');
        // *     returns 1: 'Kevin van Zonneveld'
        // mozilla has this native
        // - but breaks in 2.0.0.12!
        //if (typeof this.window['btoa'] == 'function') {
        //    return btoa(data);
        //}
        var b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ" + "abcdefghijklmnopqrstuvwxyz0123456789+/=";
        var o1,
          o2,
          o3,
          h1,
          h2,
          h3,
          h4,
          bits,
          i = 0,
          ac = 0,
          dec = "",
          tmp_arr = [];
        if (!data) {
          return data;
        }
        data += '';
        do {
          // unpack four hexets into three octets using index points in b64
          h1 = b64.indexOf(data.charAt(i++));
          h2 = b64.indexOf(data.charAt(i++));
          h3 = b64.indexOf(data.charAt(i++));
          h4 = b64.indexOf(data.charAt(i++));
          bits = h1 << 18 | h2 << 12 | h3 << 6 | h4;
          o1 = bits >> 16 & 0xff;
          o2 = bits >> 8 & 0xff;
          o3 = bits & 0xff;
          if (h3 == 64) {
            tmp_arr[ac++] = String.fromCharCode(o1);
          } else if (h4 == 64) {
            tmp_arr[ac++] = String.fromCharCode(o1, o2);
          } else {
            tmp_arr[ac++] = String.fromCharCode(o1, o2, o3);
          }
        } while (i < data.length);
        dec = tmp_arr.join('');
        return dec;
      }

      /**
       * The string representation of this value
       * @return {String}
       */
    }, {
      key: "toString",
      value: function toString() {
        return this.value;
      }
    }], [{
      key: "fromString",
      value:
      /**
       * Creates a binary value from the given string.
       *
       * @param {String} aString        The binary value string
       * @return {Binary}               The binary value instance
       */
      function fromString(aString) {
        return new Binary(aString);
      }
    }]);
  }();

  var DURATION_LETTERS = /([PDWHMTS]{1,1})/;
  var DATA_PROPS_TO_COPY = ["weeks", "days", "hours", "minutes", "seconds", "isNegative"];

  /**
   * This class represents the "duration" value type, with various calculation
   * and manipulation methods.
   *
   * @memberof ICAL
   */
  var Duration = /*#__PURE__*/function () {
    /**
     * Creates a new ICAL.Duration instance.
     *
     * @param {Object} data                 An object with members of the duration
     * @param {Number=} data.weeks          Duration in weeks
     * @param {Number=} data.days           Duration in days
     * @param {Number=} data.hours          Duration in hours
     * @param {Number=} data.minutes        Duration in minutes
     * @param {Number=} data.seconds        Duration in seconds
     * @param {Boolean=} data.isNegative    If true, the duration is negative
     */
    function Duration(data) {
      _classCallCheck(this, Duration);
      /**
       * The weeks in this duration
       * @type {Number}
       * @default 0
       */
      _defineProperty(this, "weeks", 0);
      /**
       * The days in this duration
       * @type {Number}
       * @default 0
       */
      _defineProperty(this, "days", 0);
      /**
       * The days in this duration
       * @type {Number}
       * @default 0
       */
      _defineProperty(this, "hours", 0);
      /**
       * The minutes in this duration
       * @type {Number}
       * @default 0
       */
      _defineProperty(this, "minutes", 0);
      /**
       * The seconds in this duration
       * @type {Number}
       * @default 0
       */
      _defineProperty(this, "seconds", 0);
      /**
       * The seconds in this duration
       * @type {Boolean}
       * @default false
       */
      _defineProperty(this, "isNegative", false);
      /**
       * The class identifier.
       * @constant
       * @type {String}
       * @default "icalduration"
       */
      _defineProperty(this, "icalclass", "icalduration");
      /**
       * The type name, to be used in the jCal object.
       * @constant
       * @type {String}
       * @default "duration"
       */
      _defineProperty(this, "icaltype", "duration");
      this.wrappedJSObject = this;
      this.fromData(data);
    }
    return _createClass(Duration, [{
      key: "clone",
      value:
      /**
       * Returns a clone of the duration object.
       *
       * @return {Duration}      The cloned object
       */
      function clone() {
        return Duration.fromData(this);
      }

      /**
       * The duration value expressed as a number of seconds.
       *
       * @return {Number}             The duration value in seconds
       */
    }, {
      key: "toSeconds",
      value: function toSeconds() {
        var seconds = this.seconds + 60 * this.minutes + 3600 * this.hours + 86400 * this.days + 7 * 86400 * this.weeks;
        return this.isNegative ? -seconds : seconds;
      }

      /**
       * Reads the passed seconds value into this duration object. Afterwards,
       * members like {@link ICAL.Duration#days days} and {@link ICAL.Duration#weeks weeks} will be set up
       * accordingly.
       *
       * @param {Number} aSeconds     The duration value in seconds
       * @return {Duration}           Returns this instance
       */
    }, {
      key: "fromSeconds",
      value: function fromSeconds(aSeconds) {
        var secs = Math.abs(aSeconds);
        this.isNegative = aSeconds < 0;
        this.days = trunc(secs / 86400);

        // If we have a flat number of weeks, use them.
        if (this.days % 7 == 0) {
          this.weeks = this.days / 7;
          this.days = 0;
        } else {
          this.weeks = 0;
        }
        secs -= (this.days + 7 * this.weeks) * 86400;
        this.hours = trunc(secs / 3600);
        secs -= this.hours * 3600;
        this.minutes = trunc(secs / 60);
        secs -= this.minutes * 60;
        this.seconds = secs;
        return this;
      }

      /**
       * Sets up the current instance using members from the passed data object.
       *
       * @param {Object} aData                An object with members of the duration
       * @param {Number=} aData.weeks         Duration in weeks
       * @param {Number=} aData.days          Duration in days
       * @param {Number=} aData.hours         Duration in hours
       * @param {Number=} aData.minutes       Duration in minutes
       * @param {Number=} aData.seconds       Duration in seconds
       * @param {Boolean=} aData.isNegative   If true, the duration is negative
       */
    }, {
      key: "fromData",
      value: function fromData(aData) {
        for (var _i = 0, _DATA_PROPS_TO_COPY = DATA_PROPS_TO_COPY; _i < _DATA_PROPS_TO_COPY.length; _i++) {
          var prop = _DATA_PROPS_TO_COPY[_i];
          if (aData && prop in aData) {
            this[prop] = aData[prop];
          } else {
            this[prop] = 0;
          }
        }
      }

      /**
       * Resets the duration instance to the default values, i.e. PT0S
       */
    }, {
      key: "reset",
      value: function reset() {
        this.isNegative = false;
        this.weeks = 0;
        this.days = 0;
        this.hours = 0;
        this.minutes = 0;
        this.seconds = 0;
      }

      /**
       * Compares the duration instance with another one.
       *
       * @param {Duration} aOther             The instance to compare with
       * @return {Number}                     -1, 0 or 1 for less/equal/greater
       */
    }, {
      key: "compare",
      value: function compare(aOther) {
        var thisSeconds = this.toSeconds();
        var otherSeconds = aOther.toSeconds();
        return (thisSeconds > otherSeconds) - (thisSeconds < otherSeconds);
      }

      /**
       * Normalizes the duration instance. For example, a duration with a value
       * of 61 seconds will be normalized to 1 minute and 1 second.
       */
    }, {
      key: "normalize",
      value: function normalize() {
        this.fromSeconds(this.toSeconds());
      }

      /**
       * The string representation of this duration.
       * @return {String}
       */
    }, {
      key: "toString",
      value: function toString() {
        if (this.toSeconds() == 0) {
          return "PT0S";
        } else {
          var str = "";
          if (this.isNegative) str += "-";
          str += "P";
          var hasWeeks = false;
          if (this.weeks) {
            if (this.days || this.hours || this.minutes || this.seconds) {
              str += this.weeks * 7 + this.days + "D";
            } else {
              str += this.weeks + "W";
              hasWeeks = true;
            }
          } else if (this.days) {
            str += this.days + "D";
          }
          if (!hasWeeks) {
            if (this.hours || this.minutes || this.seconds) {
              str += "T";
              if (this.hours) {
                str += this.hours + "H";
              }
              if (this.minutes) {
                str += this.minutes + "M";
              }
              if (this.seconds) {
                str += this.seconds + "S";
              }
            }
          }
          return str;
        }
      }

      /**
       * The iCalendar string representation of this duration.
       * @return {String}
       */
    }, {
      key: "toICALString",
      value: function toICALString() {
        return this.toString();
      }
    }], [{
      key: "fromSeconds",
      value:
      /**
       * Returns a new ICAL.Duration instance from the passed seconds value.
       *
       * @param {Number} aSeconds       The seconds to create the instance from
       * @return {Duration}             The newly created duration instance
       */
      function fromSeconds(aSeconds) {
        return new Duration().fromSeconds(aSeconds);
      }

      /**
       * Checks if the given string is an iCalendar duration value.
       *
       * @param {String} value      The raw ical value
       * @return {Boolean}          True, if the given value is of the
       *                              duration ical type
       */
    }, {
      key: "isValueString",
      value: function isValueString(string) {
        return string[0] === 'P' || string[1] === 'P';
      }

      /**
       * Creates a new {@link ICAL.Duration} instance from the passed string.
       *
       * @param {String} aStr       The string to parse
       * @return {Duration}         The created duration instance
       */
    }, {
      key: "fromString",
      value: function fromString(aStr) {
        var pos = 0;
        var dict = Object.create(null);
        var chunks = 0;
        while ((pos = aStr.search(DURATION_LETTERS)) !== -1) {
          var type = aStr[pos];
          var numeric = aStr.slice(0, Math.max(0, pos));
          aStr = aStr.slice(pos + 1);
          chunks += parseDurationChunk(type, numeric, dict);
        }
        if (chunks < 2) {
          // There must be at least a chunk with "P" and some unit chunk
          throw new Error('invalid duration value: Not enough duration components in "' + aStr + '"');
        }
        return new Duration(dict);
      }

      /**
       * Creates a new ICAL.Duration instance from the given data object.
       *
       * @param {Object} aData                An object with members of the duration
       * @param {Number=} aData.weeks         Duration in weeks
       * @param {Number=} aData.days          Duration in days
       * @param {Number=} aData.hours         Duration in hours
       * @param {Number=} aData.minutes       Duration in minutes
       * @param {Number=} aData.seconds       Duration in seconds
       * @param {Boolean=} aData.isNegative   If true, the duration is negative
       * @return {Duration}                   The createad duration instance
       */
    }, {
      key: "fromData",
      value: function fromData(aData) {
        return new Duration(aData);
      }
    }]);
  }();

  /**
   * Internal helper function to handle a chunk of a duration.
   *
   * @private
   * @param {String} letter type of duration chunk
   * @param {String} number numeric value or -/+
   * @param {Object} dict target to assign values to
   */
  function parseDurationChunk(letter, number, object) {
    var type;
    switch (letter) {
      case 'P':
        if (number && number === '-') {
          object.isNegative = true;
        } else {
          object.isNegative = false;
        }
        // period
        break;
      case 'D':
        type = 'days';
        break;
      case 'W':
        type = 'weeks';
        break;
      case 'H':
        type = 'hours';
        break;
      case 'M':
        type = 'minutes';
        break;
      case 'S':
        type = 'seconds';
        break;
      default:
        // Not a valid chunk
        return 0;
    }
    if (type) {
      if (!number && number !== 0) {
        throw new Error('invalid duration value: Missing number before "' + letter + '"');
      }
      var num = parseInt(number, 10);
      if (isStrictlyNaN(num)) {
        throw new Error('invalid duration value: Invalid number "' + number + '" before "' + letter + '"');
      }
      object[type] = num;
    }
    return 1;
  }

  /**
   * This lets typescript resolve our custom types in the
   * generated d.ts files (jsdoc typedefs are converted to typescript types).
   * Ignore prevents the typedefs from being documented more than once.
   * @ignore
   * @typedef {import("./types.js").jCalComponent} jCalComponent
   * Imports the 'occurrenceDetails' type from the "types.js" module
   */

  /**
   * This class represents the "period" value type, with various calculation and manipulation methods.
   *
   * @memberof ICAL
   */
  var Period = /*#__PURE__*/function () {
    /**
     * Creates a new ICAL.Period instance. The passed data object cannot contain both and end date and
     * a duration.
     *
     * @param {Object} aData                  An object with members of the period
     * @param {Time=} aData.start             The start of the period
     * @param {Time=} aData.end               The end of the period
     * @param {Duration=} aData.duration      The duration of the period
     */
    function Period(aData) {
      _classCallCheck(this, Period);
      /**
       * The start of the period
       * @type {Time}
       */
      _defineProperty(this, "start", null);
      /**
       * The end of the period
       * @type {Time}
       */
      _defineProperty(this, "end", null);
      /**
       * The duration of the period
       * @type {Duration}
       */
      _defineProperty(this, "duration", null);
      /**
       * The class identifier.
       * @constant
       * @type {String}
       * @default "icalperiod"
       */
      _defineProperty(this, "icalclass", "icalperiod");
      /**
       * The type name, to be used in the jCal object.
       * @constant
       * @type {String}
       * @default "period"
       */
      _defineProperty(this, "icaltype", "period");
      this.wrappedJSObject = this;
      if (aData && 'start' in aData) {
        if (aData.start && !(aData.start instanceof Time)) {
          throw new TypeError('.start must be an instance of ICAL.Time');
        }
        this.start = aData.start;
      }
      if (aData && aData.end && aData.duration) {
        throw new Error('cannot accept both end and duration');
      }
      if (aData && 'end' in aData) {
        if (aData.end && !(aData.end instanceof Time)) {
          throw new TypeError('.end must be an instance of ICAL.Time');
        }
        this.end = aData.end;
      }
      if (aData && 'duration' in aData) {
        if (aData.duration && !(aData.duration instanceof Duration)) {
          throw new TypeError('.duration must be an instance of ICAL.Duration');
        }
        this.duration = aData.duration;
      }
    }
    return _createClass(Period, [{
      key: "clone",
      value:
      /**
       * Returns a clone of the duration object.
       *
       * @return {Period}      The cloned object
       */
      function clone() {
        return Period.fromData({
          start: this.start ? this.start.clone() : null,
          end: this.end ? this.end.clone() : null,
          duration: this.duration ? this.duration.clone() : null
        });
      }

      /**
       * Calculates the duration of the period, either directly or by subtracting
       * start from end date.
       *
       * @return {Duration}      The calculated duration
       */
    }, {
      key: "getDuration",
      value: function getDuration() {
        if (this.duration) {
          return this.duration;
        } else {
          return this.end.subtractDate(this.start);
        }
      }

      /**
       * Calculates the end date of the period, either directly or by adding
       * duration to start date.
       *
       * @return {Time}          The calculated end date
       */
    }, {
      key: "getEnd",
      value: function getEnd() {
        if (this.end) {
          return this.end;
        } else {
          var end = this.start.clone();
          end.addDuration(this.duration);
          return end;
        }
      }

      /**
       * Compare this period with a date or other period. To maintain the logic where a.compare(b)
       * returns 1 when a > b, this function will return 1 when the period is after the date, 0 when the
       * date is within the period, and -1 when the period is before the date. When comparing two
       * periods, as soon as they overlap in any way this will return 0.
       *
       * @param {Time|Period} dt    The date or other period to compare with
       */
    }, {
      key: "compare",
      value: function compare(dt) {
        if (dt.compare(this.start) < 0) {
          return 1;
        } else if (dt.compare(this.getEnd()) > 0) {
          return -1;
        } else {
          return 0;
        }
      }

      /**
       * The string representation of this period.
       * @return {String}
       */
    }, {
      key: "toString",
      value: function toString() {
        return this.start + "/" + (this.end || this.duration);
      }

      /**
       * The jCal representation of this period type.
       * @return {Object}
       */
    }, {
      key: "toJSON",
      value: function toJSON() {
        return [this.start.toString(), (this.end || this.duration).toString()];
      }

      /**
       * The iCalendar string representation of this period.
       * @return {String}
       */
    }, {
      key: "toICALString",
      value: function toICALString() {
        return this.start.toICALString() + "/" + (this.end || this.duration).toICALString();
      }
    }], [{
      key: "fromString",
      value:
      /**
       * Creates a new {@link ICAL.Period} instance from the passed string.
       *
       * @param {String} str            The string to parse
       * @param {Property} prop         The property this period will be on
       * @return {Period}               The created period instance
       */
      function fromString(str, prop) {
        var parts = str.split('/');
        if (parts.length !== 2) {
          throw new Error('Invalid string value: "' + str + '" must contain a "/" char.');
        }
        var options = {
          start: Time.fromDateTimeString(parts[0], prop)
        };
        var end = parts[1];
        if (Duration.isValueString(end)) {
          options.duration = Duration.fromString(end);
        } else {
          options.end = Time.fromDateTimeString(end, prop);
        }
        return new Period(options);
      }

      /**
       * Creates a new {@link ICAL.Period} instance from the given data object.
       * The passed data object cannot contain both and end date and a duration.
       *
       * @param {Object} aData                  An object with members of the period
       * @param {Time=} aData.start             The start of the period
       * @param {Time=} aData.end               The end of the period
       * @param {Duration=} aData.duration      The duration of the period
       * @return {Period}                       The period instance
       */
    }, {
      key: "fromData",
      value: function fromData(aData) {
        return new Period(aData);
      }

      /**
       * Returns a new period instance from the given jCal data array. The first
       * member is always the start date string, the second member is either a
       * duration or end date string.
       *
       * @param {jCalComponent} aData           The jCal data array
       * @param {Property} aProp                The property this jCal data is on
       * @param {Boolean} aLenient              If true, data value can be both date and date-time
       * @return {Period}                       The period instance
       */
    }, {
      key: "fromJSON",
      value: function fromJSON(aData, aProp, aLenient) {
        function fromDateOrDateTimeString(aValue, dateProp) {
          if (aLenient) {
            return Time.fromString(aValue, dateProp);
          } else {
            return Time.fromDateTimeString(aValue, dateProp);
          }
        }
        if (Duration.isValueString(aData[1])) {
          return Period.fromData({
            start: fromDateOrDateTimeString(aData[0], aProp),
            duration: Duration.fromString(aData[1])
          });
        } else {
          return Period.fromData({
            start: fromDateOrDateTimeString(aData[0], aProp),
            end: fromDateOrDateTimeString(aData[1], aProp)
          });
        }
      }
    }]);
  }();

  var _Time;

  /**
   * This lets typescript resolve our custom types in the
   * generated d.ts files (jsdoc typedefs are converted to typescript types).
   * Ignore prevents the typedefs from being documented more than once.
   *
   * @ignore
   * @typedef {import("./types.js").weekDay} weekDay
   * Imports the 'weekDay' type from the "types.js" module
   *
   * @ignore
   * @typedef {import("./types.js").timeInit} timeInit
   * Imports the 'timeInit' type from the "types.js" module
   */

  /**
   * @classdesc
   * iCalendar Time representation (similar to JS Date object).  Fully
   * independent of system (OS) timezone / time.  Unlike JS Date, the month
   * January is 1, not zero.
   *
   * @example
   * var time = new ICAL.Time({
   *   year: 2012,
   *   month: 10,
   *   day: 11
   *   minute: 0,
   *   second: 0,
   *   isDate: false
   * });
   *
   *
   * @memberof ICAL
  */
  var Time = /*#__PURE__*/function () {
    // MONDAY

    /**
     * Creates a new ICAL.Time instance.
     *
     * @param {timeInit} data           Time initialization
     * @param {Timezone} zone           timezone this position occurs in
     */
    function Time(data, zone) {
      _classCallCheck(this, Time);
      /**
       * The class identifier.
       * @constant
       * @type {String}
       * @default "icaltime"
       */
      _defineProperty(this, "icalclass", "icaltime");
      _defineProperty(this, "_cachedUnixTime", null);
      /**
       * The timezone for this time.
       * @type {Timezone}
       */
      _defineProperty(this, "zone", null);
      /**
       * Internal uses to indicate that a change has been made and the next read
       * operation must attempt to normalize the value (for example changing the
       * day to 33).
       *
       * @type {Boolean}
       * @private
       */
      _defineProperty(this, "_pendingNormalization", false);
      this.wrappedJSObject = this;

      /**
       * @type {timeInit}
       * @private
       */
      this._time = Object.create(null);

      /* time defaults */
      this._time.year = 0;
      this._time.month = 1;
      this._time.day = 1;
      this._time.hour = 0;
      this._time.minute = 0;
      this._time.second = 0;
      this._time.isDate = false;
      this.fromData(data, zone);
    }
    return _createClass(Time, [{
      key: "icaltype",
      get:
      /**
       * The type name, to be used in the jCal object. This value may change and
       * is strictly defined by the {@link ICAL.Time#isDate isDate} member.
       * @type {String}
       * @default "date-time"
       */
      function get() {
        return this.isDate ? 'date' : 'date-time';
      }
    }, {
      key: "year",
      get:
      /**
       * The year of this date.
       * @type {Number}
       */
      function get() {
        return this._getTimeAttr('year');
      },
      set: function set(val) {
        this._setTimeAttr('year', val);
      }

      /**
       * The month of this date.
       * @type {Number}
       */
    }, {
      key: "month",
      get: function get() {
        return this._getTimeAttr('month');
      },
      set: function set(val) {
        this._setTimeAttr('month', val);
      }

      /**
       * The day of this date.
       * @type {Number}
       */
    }, {
      key: "day",
      get: function get() {
        return this._getTimeAttr('day');
      },
      set: function set(val) {
        this._setTimeAttr('day', val);
      }

      /**
       * The hour of this date-time.
       * @type {Number}
       */
    }, {
      key: "hour",
      get: function get() {
        return this._getTimeAttr('hour');
      },
      set: function set(val) {
        this._setTimeAttr('hour', val);
      }

      /**
       * The minute of this date-time.
       * @type {Number}
       */
    }, {
      key: "minute",
      get: function get() {
        return this._getTimeAttr('minute');
      },
      set: function set(val) {
        this._setTimeAttr('minute', val);
      }

      /**
       * The second of this date-time.
       * @type {Number}
       */
    }, {
      key: "second",
      get: function get() {
        return this._getTimeAttr('second');
      },
      set: function set(val) {
        this._setTimeAttr('second', val);
      }

      /**
       * If true, the instance represents a date (as opposed to a date-time)
       * @type {Boolean}
       */
    }, {
      key: "isDate",
      get: function get() {
        return this._getTimeAttr('isDate');
      },
      set: function set(val) {
        this._setTimeAttr('isDate', val);
      }

      /**
       * @private
       * @param {String} attr             Attribute to get (one of: year, month,
       *                                  day, hour, minute, second, isDate)
       * @return {Number|Boolean}         Current value for the attribute
       */
    }, {
      key: "_getTimeAttr",
      value: function _getTimeAttr(attr) {
        if (this._pendingNormalization) {
          this._normalize();
          this._pendingNormalization = false;
        }
        return this._time[attr];
      }

      /**
       * @private
       * @param {String} attr             Attribute to set (one of: year, month,
       *                                  day, hour, minute, second, isDate)
       * @param {Number|Boolean} val      New value for the attribute
       */
    }, {
      key: "_setTimeAttr",
      value: function _setTimeAttr(attr, val) {
        // Check if isDate will be set and if was not set to normalize date.
        // This avoids losing days when seconds, minutes and hours are zeroed
        // what normalize will do when time is a date.
        if (attr === "isDate" && val && !this._time.isDate) {
          this.adjust(0, 0, 0, 0);
        }
        this._cachedUnixTime = null;
        this._pendingNormalization = true;
        this._time[attr] = val;
      }

      /**
       * Returns a clone of the time object.
       *
       * @return {Time}              The cloned object
       */
    }, {
      key: "clone",
      value: function clone() {
        return new Time(this._time, this.zone);
      }

      /**
       * Reset the time instance to epoch time
       */
    }, {
      key: "reset",
      value: function reset() {
        this.fromData(Time.epochTime);
        this.zone = Timezone.utcTimezone;
      }

      /**
       * Reset the time instance to the given date/time values.
       *
       * @param {Number} year             The year to set
       * @param {Number} month            The month to set
       * @param {Number} day              The day to set
       * @param {Number} hour             The hour to set
       * @param {Number} minute           The minute to set
       * @param {Number} second           The second to set
       * @param {Timezone} timezone       The timezone to set
       */
    }, {
      key: "resetTo",
      value: function resetTo(year, month, day, hour, minute, second, timezone) {
        this.fromData({
          year: year,
          month: month,
          day: day,
          hour: hour,
          minute: minute,
          second: second,
          zone: timezone
        });
      }

      /**
       * Set up the current instance from the Javascript date value.
       *
       * @param {?Date} aDate             The Javascript Date to read, or null to reset
       * @param {Boolean} [useUTC=false]  If true, the UTC values of the date will be used
       */
    }, {
      key: "fromJSDate",
      value: function fromJSDate(aDate, useUTC) {
        if (!aDate) {
          this.reset();
        } else {
          if (useUTC) {
            this.zone = Timezone.utcTimezone;
            this.year = aDate.getUTCFullYear();
            this.month = aDate.getUTCMonth() + 1;
            this.day = aDate.getUTCDate();
            this.hour = aDate.getUTCHours();
            this.minute = aDate.getUTCMinutes();
            this.second = aDate.getUTCSeconds();
          } else {
            this.zone = Timezone.localTimezone;
            this.year = aDate.getFullYear();
            this.month = aDate.getMonth() + 1;
            this.day = aDate.getDate();
            this.hour = aDate.getHours();
            this.minute = aDate.getMinutes();
            this.second = aDate.getSeconds();
          }
        }
        this._cachedUnixTime = null;
        return this;
      }

      /**
       * Sets up the current instance using members from the passed data object.
       *
       * @param {timeInit} aData          Time initialization
       * @param {Timezone=} aZone         Timezone this position occurs in
       */
    }, {
      key: "fromData",
      value: function fromData(aData, aZone) {
        if (aData) {
          for (var _i = 0, _Object$entries = Object.entries(aData); _i < _Object$entries.length; _i++) {
            var _Object$entries$_i = _slicedToArray(_Object$entries[_i], 2),
              key = _Object$entries$_i[0],
              value = _Object$entries$_i[1];
            // ical type cannot be set
            if (key === 'icaltype') continue;
            this[key] = value;
          }
        }
        if (aZone) {
          this.zone = aZone;
        }
        if (aData && !("isDate" in aData)) {
          this.isDate = !("hour" in aData);
        } else if (aData && "isDate" in aData) {
          this.isDate = aData.isDate;
        }
        if (aData && "timezone" in aData) {
          var zone = TimezoneService.get(aData.timezone);
          this.zone = zone || Timezone.localTimezone;
        }
        if (aData && "zone" in aData) {
          this.zone = aData.zone;
        }
        if (!this.zone) {
          this.zone = Timezone.localTimezone;
        }
        this._cachedUnixTime = null;
        return this;
      }

      /**
       * Calculate the day of week.
       * @param {weekDay=} aWeekStart
       *        The week start weekday, defaults to SUNDAY
       * @return {weekDay}
       */
    }, {
      key: "dayOfWeek",
      value: function dayOfWeek(aWeekStart) {
        var firstDow = aWeekStart || Time.SUNDAY;
        var dowCacheKey = (this.year << 12) + (this.month << 8) + (this.day << 3) + firstDow;
        if (dowCacheKey in Time._dowCache) {
          return Time._dowCache[dowCacheKey];
        }

        // Using Zeller's algorithm
        var q = this.day;
        var m = this.month + (this.month < 3 ? 12 : 0);
        var Y = this.year - (this.month < 3 ? 1 : 0);
        var h = q + Y + trunc((m + 1) * 26 / 10) + trunc(Y / 4);
        {
          // eslint-disable-line no-constant-condition
          h += trunc(Y / 100) * 6 + trunc(Y / 400);
        }

        // Normalize to 1 = wkst
        h = (h + 7 - firstDow) % 7 + 1;
        Time._dowCache[dowCacheKey] = h;
        return h;
      }

      /**
       * Calculate the day of year.
       * @return {Number}
       */
    }, {
      key: "dayOfYear",
      value: function dayOfYear() {
        var is_leap = Time.isLeapYear(this.year) ? 1 : 0;
        var diypm = Time.daysInYearPassedMonth;
        return diypm[is_leap][this.month - 1] + this.day;
      }

      /**
       * Returns a copy of the current date/time, rewound to the start of the
       * week. The resulting ICAL.Time instance is of icaltype date, even if this
       * is a date-time.
       *
       * @param {weekDay=} aWeekStart
       *        The week start weekday, defaults to SUNDAY
       * @return {Time}      The start of the week (cloned)
       */
    }, {
      key: "startOfWeek",
      value: function startOfWeek(aWeekStart) {
        var firstDow = aWeekStart || Time.SUNDAY;
        var result = this.clone();
        result.day -= (this.dayOfWeek() + 7 - firstDow) % 7;
        result.isDate = true;
        result.hour = 0;
        result.minute = 0;
        result.second = 0;
        return result;
      }

      /**
       * Returns a copy of the current date/time, shifted to the end of the week.
       * The resulting ICAL.Time instance is of icaltype date, even if this is a
       * date-time.
       *
       * @param {weekDay=} aWeekStart
       *        The week start weekday, defaults to SUNDAY
       * @return {Time}      The end of the week (cloned)
       */
    }, {
      key: "endOfWeek",
      value: function endOfWeek(aWeekStart) {
        var firstDow = aWeekStart || Time.SUNDAY;
        var result = this.clone();
        result.day += (7 - this.dayOfWeek() + firstDow - Time.SUNDAY) % 7;
        result.isDate = true;
        result.hour = 0;
        result.minute = 0;
        result.second = 0;
        return result;
      }

      /**
       * Returns a copy of the current date/time, rewound to the start of the
       * month. The resulting ICAL.Time instance is of icaltype date, even if
       * this is a date-time.
       *
       * @return {Time}      The start of the month (cloned)
       */
    }, {
      key: "startOfMonth",
      value: function startOfMonth() {
        var result = this.clone();
        result.day = 1;
        result.isDate = true;
        result.hour = 0;
        result.minute = 0;
        result.second = 0;
        return result;
      }

      /**
       * Returns a copy of the current date/time, shifted to the end of the
       * month.  The resulting ICAL.Time instance is of icaltype date, even if
       * this is a date-time.
       *
       * @return {Time}      The end of the month (cloned)
       */
    }, {
      key: "endOfMonth",
      value: function endOfMonth() {
        var result = this.clone();
        result.day = Time.daysInMonth(result.month, result.year);
        result.isDate = true;
        result.hour = 0;
        result.minute = 0;
        result.second = 0;
        return result;
      }

      /**
       * Returns a copy of the current date/time, rewound to the start of the
       * year. The resulting ICAL.Time instance is of icaltype date, even if
       * this is a date-time.
       *
       * @return {Time}      The start of the year (cloned)
       */
    }, {
      key: "startOfYear",
      value: function startOfYear() {
        var result = this.clone();
        result.day = 1;
        result.month = 1;
        result.isDate = true;
        result.hour = 0;
        result.minute = 0;
        result.second = 0;
        return result;
      }

      /**
       * Returns a copy of the current date/time, shifted to the end of the
       * year.  The resulting ICAL.Time instance is of icaltype date, even if
       * this is a date-time.
       *
       * @return {Time}      The end of the year (cloned)
       */
    }, {
      key: "endOfYear",
      value: function endOfYear() {
        var result = this.clone();
        result.day = 31;
        result.month = 12;
        result.isDate = true;
        result.hour = 0;
        result.minute = 0;
        result.second = 0;
        return result;
      }

      /**
       * First calculates the start of the week, then returns the day of year for
       * this date. If the day falls into the previous year, the day is zero or negative.
       *
       * @param {weekDay=} aFirstDayOfWeek
       *        The week start weekday, defaults to SUNDAY
       * @return {Number}     The calculated day of year
       */
    }, {
      key: "startDoyWeek",
      value: function startDoyWeek(aFirstDayOfWeek) {
        var firstDow = aFirstDayOfWeek || Time.SUNDAY;
        var delta = this.dayOfWeek() - firstDow;
        if (delta < 0) delta += 7;
        return this.dayOfYear() - delta;
      }

      /**
       * Get the dominical letter for the current year. Letters range from A - G
       * for common years, and AG to GF for leap years.
       *
       * @param {Number} yr           The year to retrieve the letter for
       * @return {String}             The dominical letter.
       */
    }, {
      key: "getDominicalLetter",
      value: function getDominicalLetter() {
        return Time.getDominicalLetter(this.year);
      }

      /**
       * Finds the nthWeekDay relative to the current month (not day).  The
       * returned value is a day relative the month that this month belongs to so
       * 1 would indicate the first of the month and 40 would indicate a day in
       * the following month.
       *
       * @param {Number} aDayOfWeek   Day of the week see the day name constants
       * @param {Number} aPos         Nth occurrence of a given week day values
       *        of 1 and 0 both indicate the first weekday of that type. aPos may
       *        be either positive or negative
       *
       * @return {Number} numeric value indicating a day relative
       *                   to the current month of this time object
       */
    }, {
      key: "nthWeekDay",
      value: function nthWeekDay(aDayOfWeek, aPos) {
        var daysInMonth = Time.daysInMonth(this.month, this.year);
        var weekday;
        var pos = aPos;
        var start = 0;
        var otherDay = this.clone();
        if (pos >= 0) {
          otherDay.day = 1;

          // because 0 means no position has been given
          // 1 and 0 indicate the same day.
          if (pos != 0) {
            // remove the extra numeric value
            pos--;
          }

          // set current start offset to current day.
          start = otherDay.day;

          // find the current day of week
          var startDow = otherDay.dayOfWeek();

          // calculate the difference between current
          // day of the week and desired day of the week
          var offset = aDayOfWeek - startDow;

          // if the offset goes into the past
          // week we add 7 so it goes into the next
          // week. We only want to go forward in time here.
          if (offset < 0)
            // this is really important otherwise we would
            // end up with dates from in the past.
            offset += 7;

          // add offset to start so start is the same
          // day of the week as the desired day of week.
          start += offset;

          // because we are going to add (and multiply)
          // the numeric value of the day we subtract it
          // from the start position so not to add it twice.
          start -= aDayOfWeek;

          // set week day
          weekday = aDayOfWeek;
        } else {
          // then we set it to the last day in the current month
          otherDay.day = daysInMonth;

          // find the ends weekday
          var endDow = otherDay.dayOfWeek();
          pos++;
          weekday = endDow - aDayOfWeek;
          if (weekday < 0) {
            weekday += 7;
          }
          weekday = daysInMonth - weekday;
        }
        weekday += pos * 7;
        return start + weekday;
      }

      /**
       * Checks if current time is the nth weekday, relative to the current
       * month.  Will always return false when rule resolves outside of current
       * month.
       *
       * @param {weekDay} aDayOfWeek                 Day of week to check
       * @param {Number} aPos                        Relative position
       * @return {Boolean}                           True, if it is the nth weekday
       */
    }, {
      key: "isNthWeekDay",
      value: function isNthWeekDay(aDayOfWeek, aPos) {
        var dow = this.dayOfWeek();
        if (aPos === 0 && dow === aDayOfWeek) {
          return true;
        }

        // get pos
        var day = this.nthWeekDay(aDayOfWeek, aPos);
        if (day === this.day) {
          return true;
        }
        return false;
      }

      /**
       * Calculates the ISO 8601 week number. The first week of a year is the
       * week that contains the first Thursday. The year can have 53 weeks, if
       * January 1st is a Friday.
       *
       * Note there are regions where the first week of the year is the one that
       * starts on January 1st, which may offset the week number. Also, if a
       * different week start is specified, this will also affect the week
       * number.
       *
       * @see Time.weekOneStarts
       * @param {weekDay} aWeekStart                  The weekday the week starts with
       * @return {Number}                             The ISO week number
       */
    }, {
      key: "weekNumber",
      value: function weekNumber(aWeekStart) {
        var wnCacheKey = (this.year << 12) + (this.month << 8) + (this.day << 3) + aWeekStart;
        if (wnCacheKey in Time._wnCache) {
          return Time._wnCache[wnCacheKey];
        }
        // This function courtesty of Julian Bucknall, published under the MIT license
        // http://www.boyet.com/articles/publishedarticles/calculatingtheisoweeknumb.html
        // plus some fixes to be able to use different week starts.
        var week1;
        var dt = this.clone();
        dt.isDate = true;
        var isoyear = this.year;
        if (dt.month == 12 && dt.day > 25) {
          week1 = Time.weekOneStarts(isoyear + 1, aWeekStart);
          if (dt.compare(week1) < 0) {
            week1 = Time.weekOneStarts(isoyear, aWeekStart);
          } else {
            isoyear++;
          }
        } else {
          week1 = Time.weekOneStarts(isoyear, aWeekStart);
          if (dt.compare(week1) < 0) {
            week1 = Time.weekOneStarts(--isoyear, aWeekStart);
          }
        }
        var daysBetween = dt.subtractDate(week1).toSeconds() / 86400;
        var answer = trunc(daysBetween / 7) + 1;
        Time._wnCache[wnCacheKey] = answer;
        return answer;
      }

      /**
       * Adds the duration to the current time. The instance is modified in
       * place.
       *
       * @param {Duration} aDuration         The duration to add
       */
    }, {
      key: "addDuration",
      value: function addDuration(aDuration) {
        var mult = aDuration.isNegative ? -1 : 1;

        // because of the duration optimizations it is much
        // more efficient to grab all the values up front
        // then set them directly (which will avoid a normalization call).
        // So we don't actually normalize until we need it.
        var second = this.second;
        var minute = this.minute;
        var hour = this.hour;
        var day = this.day;
        second += mult * aDuration.seconds;
        minute += mult * aDuration.minutes;
        hour += mult * aDuration.hours;
        day += mult * aDuration.days;
        day += mult * 7 * aDuration.weeks;
        this.second = second;
        this.minute = minute;
        this.hour = hour;
        this.day = day;
        this._cachedUnixTime = null;
      }

      /**
       * Subtract the date details (_excluding_ timezone).  Useful for finding
       * the relative difference between two time objects excluding their
       * timezone differences.
       *
       * @param {Time} aDate     The date to subtract
       * @return {Duration}      The difference as a duration
       */
    }, {
      key: "subtractDate",
      value: function subtractDate(aDate) {
        var unixTime = this.toUnixTime() + this.utcOffset();
        var other = aDate.toUnixTime() + aDate.utcOffset();
        return Duration.fromSeconds(unixTime - other);
      }

      /**
       * Subtract the date details, taking timezones into account.
       *
       * @param {Time} aDate  The date to subtract
       * @return {Duration}   The difference in duration
       */
    }, {
      key: "subtractDateTz",
      value: function subtractDateTz(aDate) {
        var unixTime = this.toUnixTime();
        var other = aDate.toUnixTime();
        return Duration.fromSeconds(unixTime - other);
      }

      /**
       * Compares the ICAL.Time instance with another one, or a period.
       *
       * @param {Time|Period} aOther                  The instance to compare with
       * @return {Number}                             -1, 0 or 1 for less/equal/greater
       */
    }, {
      key: "compare",
      value: function compare(other) {
        if (other instanceof Period) {
          return -1 * other.compare(this);
        } else {
          var a = this.toUnixTime();
          var b = other.toUnixTime();
          if (a > b) return 1;
          if (b > a) return -1;
          return 0;
        }
      }

      /**
       * Compares only the date part of this instance with another one.
       *
       * @param {Time} other                  The instance to compare with
       * @param {Timezone} tz                 The timezone to compare in
       * @return {Number}                     -1, 0 or 1 for less/equal/greater
       */
    }, {
      key: "compareDateOnlyTz",
      value: function compareDateOnlyTz(other, tz) {
        var a = this.convertToZone(tz);
        var b = other.convertToZone(tz);
        var rc = 0;
        if ((rc = Time._cmp_attr(a, b, "year")) != 0) return rc;
        if ((rc = Time._cmp_attr(a, b, "month")) != 0) return rc;
        if ((rc = Time._cmp_attr(a, b, "day")) != 0) return rc;
        return rc;
      }

      /**
       * Convert the instance into another timezone. The returned ICAL.Time
       * instance is always a copy.
       *
       * @param {Timezone} zone      The zone to convert to
       * @return {Time}              The copy, converted to the zone
       */
    }, {
      key: "convertToZone",
      value: function convertToZone(zone) {
        var copy = this.clone();
        var zone_equals = this.zone.tzid == zone.tzid;
        if (!this.isDate && !zone_equals) {
          Timezone.convert_time(copy, this.zone, zone);
        }
        copy.zone = zone;
        return copy;
      }

      /**
       * Calculates the UTC offset of the current date/time in the timezone it is
       * in.
       *
       * @return {Number}     UTC offset in seconds
       */
    }, {
      key: "utcOffset",
      value: function utcOffset() {
        if (this.zone == Timezone.localTimezone || this.zone == Timezone.utcTimezone) {
          return 0;
        } else {
          return this.zone.utcOffset(this);
        }
      }

      /**
       * Returns an RFC 5545 compliant ical representation of this object.
       *
       * @return {String} ical date/date-time
       */
    }, {
      key: "toICALString",
      value: function toICALString() {
        var string = this.toString();
        if (string.length > 10) {
          return design.icalendar.value['date-time'].toICAL(string);
        } else {
          return design.icalendar.value.date.toICAL(string);
        }
      }

      /**
       * The string representation of this date/time, in jCal form
       * (including : and - separators).
       * @return {String}
       */
    }, {
      key: "toString",
      value: function toString() {
        var result = this.year + '-' + pad2(this.month) + '-' + pad2(this.day);
        if (!this.isDate) {
          result += 'T' + pad2(this.hour) + ':' + pad2(this.minute) + ':' + pad2(this.second);
          if (this.zone === Timezone.utcTimezone) {
            result += 'Z';
          }
        }
        return result;
      }

      /**
       * Converts the current instance to a Javascript date
       * @return {Date}
       */
    }, {
      key: "toJSDate",
      value: function toJSDate() {
        if (this.zone == Timezone.localTimezone) {
          if (this.isDate) {
            return new Date(this.year, this.month - 1, this.day);
          } else {
            return new Date(this.year, this.month - 1, this.day, this.hour, this.minute, this.second, 0);
          }
        } else {
          return new Date(this.toUnixTime() * 1000);
        }
      }
    }, {
      key: "_normalize",
      value: function _normalize() {
        if (this._time.isDate) {
          this._time.hour = 0;
          this._time.minute = 0;
          this._time.second = 0;
        }
        this.adjust(0, 0, 0, 0);
        return this;
      }

      /**
       * Adjust the date/time by the given offset
       *
       * @param {Number} aExtraDays       The extra amount of days
       * @param {Number} aExtraHours      The extra amount of hours
       * @param {Number} aExtraMinutes    The extra amount of minutes
       * @param {Number} aExtraSeconds    The extra amount of seconds
       * @param {Number=} aTime           The time to adjust, defaults to the
       *                                    current instance.
       */
    }, {
      key: "adjust",
      value: function adjust(aExtraDays, aExtraHours, aExtraMinutes, aExtraSeconds, aTime) {
        var minutesOverflow,
          hoursOverflow,
          daysOverflow = 0,
          yearsOverflow = 0;
        var second, minute, hour, day;
        var daysInMonth;
        var time = aTime || this._time;
        if (!time.isDate) {
          second = time.second + aExtraSeconds;
          time.second = second % 60;
          minutesOverflow = trunc(second / 60);
          if (time.second < 0) {
            time.second += 60;
            minutesOverflow--;
          }
          minute = time.minute + aExtraMinutes + minutesOverflow;
          time.minute = minute % 60;
          hoursOverflow = trunc(minute / 60);
          if (time.minute < 0) {
            time.minute += 60;
            hoursOverflow--;
          }
          hour = time.hour + aExtraHours + hoursOverflow;
          time.hour = hour % 24;
          daysOverflow = trunc(hour / 24);
          if (time.hour < 0) {
            time.hour += 24;
            daysOverflow--;
          }
        }

        // Adjust month and year first, because we need to know what month the day
        // is in before adjusting it.
        if (time.month > 12) {
          yearsOverflow = trunc((time.month - 1) / 12);
        } else if (time.month < 1) {
          yearsOverflow = trunc(time.month / 12) - 1;
        }
        time.year += yearsOverflow;
        time.month -= 12 * yearsOverflow;

        // Now take care of the days (and adjust month if needed)
        day = time.day + aExtraDays + daysOverflow;
        if (day > 0) {
          for (;;) {
            daysInMonth = Time.daysInMonth(time.month, time.year);
            if (day <= daysInMonth) {
              break;
            }
            time.month++;
            if (time.month > 12) {
              time.year++;
              time.month = 1;
            }
            day -= daysInMonth;
          }
        } else {
          while (day <= 0) {
            if (time.month == 1) {
              time.year--;
              time.month = 12;
            } else {
              time.month--;
            }
            day += Time.daysInMonth(time.month, time.year);
          }
        }
        time.day = day;
        this._cachedUnixTime = null;
        return this;
      }

      /**
       * Sets up the current instance from unix time, the number of seconds since
       * January 1st, 1970.
       *
       * @param {Number} seconds      The seconds to set up with
       */
    }, {
      key: "fromUnixTime",
      value: function fromUnixTime(seconds) {
        this.zone = Timezone.utcTimezone;
        // We could use `fromJSDate` here, but this is about twice as fast.
        // We could also clone `epochTime` and use `adjust` for a more
        // ical.js-centric approach, but this is about 100 times as fast.
        var date = new Date(seconds * 1000);
        this.year = date.getUTCFullYear();
        this.month = date.getUTCMonth() + 1;
        this.day = date.getUTCDate();
        if (this._time.isDate) {
          this.hour = 0;
          this.minute = 0;
          this.second = 0;
        } else {
          this.hour = date.getUTCHours();
          this.minute = date.getUTCMinutes();
          this.second = date.getUTCSeconds();
        }
        this._cachedUnixTime = null;
      }

      /**
       * Converts the current instance to seconds since January 1st 1970.
       *
       * @return {Number}         Seconds since 1970
       */
    }, {
      key: "toUnixTime",
      value: function toUnixTime() {
        if (this._cachedUnixTime !== null) {
          return this._cachedUnixTime;
        }
        var offset = this.utcOffset();

        // we use the offset trick to ensure
        // that we are getting the actual UTC time
        var ms = Date.UTC(this.year, this.month - 1, this.day, this.hour, this.minute, this.second - offset);

        // seconds
        this._cachedUnixTime = ms / 1000;
        return this._cachedUnixTime;
      }

      /**
       * Converts time to into Object which can be serialized then re-created
       * using the constructor.
       *
       * @example
       * // toJSON will automatically be called
       * var json = JSON.stringify(mytime);
       *
       * var deserialized = JSON.parse(json);
       *
       * var time = new ICAL.Time(deserialized);
       *
       * @return {Object}
       */
    }, {
      key: "toJSON",
      value: function toJSON() {
        var copy = ['year', 'month', 'day', 'hour', 'minute', 'second', 'isDate'];
        var result = Object.create(null);
        var i = 0;
        var len = copy.length;
        var prop;
        for (; i < len; i++) {
          prop = copy[i];
          result[prop] = this[prop];
        }
        if (this.zone) {
          result.timezone = this.zone.tzid;
        }
        return result;
      }
    }], [{
      key: "daysInMonth",
      value:
      /**
       * Returns the days in the given month
       *
       * @param {Number} month      The month to check
       * @param {Number} year       The year to check
       * @return {Number}           The number of days in the month
       */
      function daysInMonth(month, year) {
        var _daysInMonth = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        var days = 30;
        if (month < 1 || month > 12) return days;
        days = _daysInMonth[month];
        if (month == 2) {
          days += Time.isLeapYear(year);
        }
        return days;
      }

      /**
       * Checks if the year is a leap year
       *
       * @param {Number} year       The year to check
       * @return {Boolean}          True, if the year is a leap year
       */
    }, {
      key: "isLeapYear",
      value: function isLeapYear(year) {
        if (year <= 1752) {
          return year % 4 == 0;
        } else {
          return year % 4 == 0 && year % 100 != 0 || year % 400 == 0;
        }
      }

      /**
       * Create a new ICAL.Time from the day of year and year. The date is returned
       * in floating timezone.
       *
       * @param {Number} aDayOfYear     The day of year
       * @param {Number} aYear          The year to create the instance in
       * @return {Time}                 The created instance with the calculated date
       */
    }, {
      key: "fromDayOfYear",
      value: function fromDayOfYear(aDayOfYear, aYear) {
        var year = aYear;
        var doy = aDayOfYear;
        var tt = new Time();
        tt.auto_normalize = false;
        var is_leap = Time.isLeapYear(year) ? 1 : 0;
        if (doy < 1) {
          year--;
          is_leap = Time.isLeapYear(year) ? 1 : 0;
          doy += Time.daysInYearPassedMonth[is_leap][12];
          return Time.fromDayOfYear(doy, year);
        } else if (doy > Time.daysInYearPassedMonth[is_leap][12]) {
          is_leap = Time.isLeapYear(year) ? 1 : 0;
          doy -= Time.daysInYearPassedMonth[is_leap][12];
          year++;
          return Time.fromDayOfYear(doy, year);
        }
        tt.year = year;
        tt.isDate = true;
        for (var month = 11; month >= 0; month--) {
          if (doy > Time.daysInYearPassedMonth[is_leap][month]) {
            tt.month = month + 1;
            tt.day = doy - Time.daysInYearPassedMonth[is_leap][month];
            break;
          }
        }
        tt.auto_normalize = true;
        return tt;
      }

      /**
       * Returns a new ICAL.Time instance from a date string, e.g 2015-01-02.
       *
       * @deprecated                Use {@link ICAL.Time.fromDateString} instead
       * @param {String} str        The string to create from
       * @return {Time}             The date/time instance
       */
    }, {
      key: "fromStringv2",
      value: function fromStringv2(str) {
        return new Time({
          year: parseInt(str.slice(0, 4), 10),
          month: parseInt(str.slice(5, 7), 10),
          day: parseInt(str.slice(8, 10), 10),
          isDate: true
        });
      }

      /**
       * Returns a new ICAL.Time instance from a date string, e.g 2015-01-02.
       *
       * @param {String} aValue     The string to create from
       * @return {Time}             The date/time instance
       */
    }, {
      key: "fromDateString",
      value: function fromDateString(aValue) {
        // Dates should have no timezone.
        // Google likes to sometimes specify Z on dates
        // we specifically ignore that to avoid issues.

        // YYYY-MM-DD
        // 2012-10-10
        return new Time({
          year: strictParseInt(aValue.slice(0, 4)),
          month: strictParseInt(aValue.slice(5, 7)),
          day: strictParseInt(aValue.slice(8, 10)),
          isDate: true
        });
      }

      /**
       * Returns a new ICAL.Time instance from a date-time string, e.g
       * 2015-01-02T03:04:05. If a property is specified, the timezone is set up
       * from the property's TZID parameter.
       *
       * @param {String} aValue         The string to create from
       * @param {Property=} prop        The property the date belongs to
       * @return {Time}                 The date/time instance
       */
    }, {
      key: "fromDateTimeString",
      value: function fromDateTimeString(aValue, prop) {
        if (aValue.length < 19) {
          throw new Error('invalid date-time value: "' + aValue + '"');
        }
        var zone;
        var zoneId;
        if (aValue.slice(-1) === 'Z') {
          zone = Timezone.utcTimezone;
        } else if (prop) {
          zoneId = prop.getParameter('tzid');
          if (prop.parent) {
            if (prop.parent.name === 'standard' || prop.parent.name === 'daylight') {
              // Per RFC 5545 3.8.2.4 and 3.8.2.2, start/end date-times within
              // these components MUST be specified in local time.
              zone = Timezone.localTimezone;
            } else if (zoneId) {
              // If the desired time zone is defined within the component tree,
              // fetch its definition and prefer that.
              zone = prop.parent.getTimeZoneByID(zoneId);
            }
          }
        }
        var timeData = {
          year: strictParseInt(aValue.slice(0, 4)),
          month: strictParseInt(aValue.slice(5, 7)),
          day: strictParseInt(aValue.slice(8, 10)),
          hour: strictParseInt(aValue.slice(11, 13)),
          minute: strictParseInt(aValue.slice(14, 16)),
          second: strictParseInt(aValue.slice(17, 19))
        };

        // Although RFC 5545 requires that all TZIDs used within a file have a
        // corresponding time zone definition, we may not be parsing the full file
        // or we may be dealing with a non-compliant file; in either case, we can
        // check our own time zone service for the TZID in a last-ditch effort.
        if (zoneId && !zone) {
          timeData.timezone = zoneId;
        }

        // 2012-10-10T10:10:10(Z)?
        return new Time(timeData, zone);
      }

      /**
       * Returns a new ICAL.Time instance from a date or date-time string,
       *
       * @param {String} aValue         The string to create from
       * @param {Property=} prop        The property the date belongs to
       * @return {Time}                 The date/time instance
       */
    }, {
      key: "fromString",
      value: function fromString(aValue, aProperty) {
        if (aValue.length > 10) {
          return Time.fromDateTimeString(aValue, aProperty);
        } else {
          return Time.fromDateString(aValue);
        }
      }

      /**
       * Creates a new ICAL.Time instance from the given Javascript Date.
       *
       * @param {?Date} aDate             The Javascript Date to read, or null to reset
       * @param {Boolean} [useUTC=false]  If true, the UTC values of the date will be used
       */
    }, {
      key: "fromJSDate",
      value: function fromJSDate(aDate, useUTC) {
        var tt = new Time();
        return tt.fromJSDate(aDate, useUTC);
      }

      /**
       * Creates a new ICAL.Time instance from the the passed data object.
       *
       * @param {timeInit} aData          Time initialization
       * @param {Timezone=} aZone         Timezone this position occurs in
       */
    }, {
      key: "now",
      value:
      /**
       * Creates a new ICAL.Time instance from the current moment.
       * The instance is “floating” - has no timezone relation.
       * To create an instance considering the time zone, call
       * ICAL.Time.fromJSDate(new Date(), true)
       * @return {Time}
       */
      function now() {
        return Time.fromJSDate(new Date(), false);
      }

      /**
       * Returns the date on which ISO week number 1 starts.
       *
       * @see Time#weekNumber
       * @param {Number} aYear                  The year to search in
       * @param {weekDay=} aWeekStart           The week start weekday, used for calculation.
       * @return {Time}                         The date on which week number 1 starts
       */
    }, {
      key: "weekOneStarts",
      value: function weekOneStarts(aYear, aWeekStart) {
        var t = Time.fromData({
          year: aYear,
          month: 1,
          day: 1,
          isDate: true
        });
        var dow = t.dayOfWeek();
        var wkst = aWeekStart || Time.DEFAULT_WEEK_START;
        if (dow > Time.THURSDAY) {
          t.day += 7;
        }
        if (wkst > Time.THURSDAY) {
          t.day -= 7;
        }
        t.day -= dow - wkst;
        return t;
      }

      /**
       * Get the dominical letter for the given year. Letters range from A - G for
       * common years, and AG to GF for leap years.
       *
       * @param {Number} yr           The year to retrieve the letter for
       * @return {String}             The dominical letter.
       */
    }, {
      key: "getDominicalLetter",
      value: function getDominicalLetter(yr) {
        var LTRS = "GFEDCBA";
        var dom = (yr + (yr / 4 | 0) + (yr / 400 | 0) - (yr / 100 | 0) - 1) % 7;
        var isLeap = Time.isLeapYear(yr);
        if (isLeap) {
          return LTRS[(dom + 6) % 7] + LTRS[dom];
        } else {
          return LTRS[dom];
        }
      }
    }, {
      key: "epochTime",
      get:
      /**
       * January 1st, 1970 as an ICAL.Time.
       * @type {Time}
       * @constant
       * @instance
       */
      function get() {
        if (!_assertClassBrand(Time, this, _epochTime)._) {
          _epochTime._ = _assertClassBrand(Time, this, Time.fromData({
            year: 1970,
            month: 1,
            day: 1,
            hour: 0,
            minute: 0,
            second: 0,
            isDate: false,
            timezone: "Z"
          }));
        }
        return _assertClassBrand(Time, this, _epochTime)._;
      }
    }, {
      key: "_cmp_attr",
      value: function _cmp_attr(a, b, attr) {
        if (a[attr] > b[attr]) return 1;
        if (a[attr] < b[attr]) return -1;
        return 0;
      }

      /**
       * The days that have passed in the year after a given month. The array has
       * two members, one being an array of passed days for non-leap years, the
       * other analog for leap years.
       * @example
       * var isLeapYear = ICAL.Time.isLeapYear(year);
       * var passedDays = ICAL.Time.daysInYearPassedMonth[isLeapYear][month];
       * @type {Array.<Array.<Number>>}
       */
    }]);
  }();
  _Time = Time;
  _defineProperty(Time, "_dowCache", {});
  _defineProperty(Time, "_wnCache", {});
  _defineProperty(Time, "fromData", function fromData(aData, aZone) {
    var t = new _Time();
    return t.fromData(aData, aZone);
  });
  var _epochTime = {
    _: null
  };
  _defineProperty(Time, "daysInYearPassedMonth", [[0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365], [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335, 366]]);
  _defineProperty(Time, "SUNDAY", 1);
  _defineProperty(Time, "MONDAY", 2);
  _defineProperty(Time, "TUESDAY", 3);
  _defineProperty(Time, "WEDNESDAY", 4);
  _defineProperty(Time, "THURSDAY", 5);
  _defineProperty(Time, "FRIDAY", 6);
  _defineProperty(Time, "SATURDAY", 7);
  /**
   * The default weekday for the WKST part.
   * @constant
   * @default ICAL.Time.MONDAY
   */
  _defineProperty(Time, "DEFAULT_WEEK_START", 2);

  /**
   * This lets typescript resolve our custom types in the
   * generated d.ts files (jsdoc typedefs are converted to typescript types).
   * Ignore prevents the typedefs from being documented more than once.
   *
   * @ignore
   * @typedef {import("./types.js").parserState} parserState
   * Imports the 'parserState' type from the "types.js" module
   * @typedef {import("./types.js").designSet} designSet
   * Imports the 'designSet' type from the "types.js" module
   */

  var CHAR = /[^ \t]/;
  var VALUE_DELIMITER = ':';
  var PARAM_DELIMITER = ';';
  var PARAM_NAME_DELIMITER = '=';
  var DEFAULT_VALUE_TYPE$1 = 'unknown';
  var DEFAULT_PARAM_TYPE = 'text';
  var RFC6868_REPLACE_MAP$1 = {
    "^'": '"',
    "^n": "\n",
    "^^": "^"
  };

  /**
   * Parses iCalendar or vCard data into a raw jCal object. Consult
   * documentation on the {@tutorial layers|layers of parsing} for more
   * details.
   *
   * @function ICAL.parse
   * @memberof ICAL
   * @variation function
   * @todo Fix the API to be more clear on the return type
   * @param {String} input      The string data to parse
   * @return {Object|Object[]}  A single jCal object, or an array thereof
   */
  function parse(input) {
    var state = {};
    var root = state.component = [];
    state.stack = [root];
    parse._eachLine(input, function (err, line) {
      parse._handleContentLine(line, state);
    });

    // when there are still items on the stack
    // throw a fatal error, a component was not closed
    // correctly in that case.
    if (state.stack.length > 1) {
      throw new ParserError('invalid ical body. component began but did not end');
    }
    state = null;
    return root.length == 1 ? root[0] : root;
  }

  /**
   * Parse an iCalendar property value into the jCal for a single property
   *
   * @function ICAL.parse.property
   * @param {String} str
   *   The iCalendar property string to parse
   * @param {designSet=} designSet
   *   The design data to use for this property
   * @return {Object}
   *   The jCal Object containing the property
   */
  parse.property = function (str, designSet) {
    var state = {
      component: [[], []],
      designSet: designSet || design.defaultSet
    };
    parse._handleContentLine(str, state);
    return state.component[1][0];
  };

  /**
   * Convenience method to parse a component. You can use ICAL.parse() directly
   * instead.
   *
   * @function ICAL.parse.component
   * @see ICAL.parse(function)
   * @param {String} str    The iCalendar component string to parse
   * @return {Object}       The jCal Object containing the component
   */
  parse.component = function (str) {
    return parse(str);
  };

  /**
   * An error that occurred during parsing.
   *
   * @param {String} message        The error message
   * @memberof ICAL.parse
   * @extends {Error}
   */
  var ParserError = /*#__PURE__*/function (_Error) {
    function ParserError() {
      var _this;
      _classCallCheck(this, ParserError);
      for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
        args[_key] = arguments[_key];
      }
      _this = _callSuper(this, ParserError, [].concat(args));
      _defineProperty(_this, "name", _this.constructor.name);
      return _this;
    }
    _inherits(ParserError, _Error);
    return _createClass(ParserError);
  }(/*#__PURE__*/_wrapNativeSuper(Error)); // classes & constants
  parse.ParserError = ParserError;

  /**
   * Handles a single line of iCalendar/vCard, updating the state.
   *
   * @private
   * @function ICAL.parse._handleContentLine
   * @param {String} line          The content line to process
   * @param {parserState} state    The current state of the line parsing
   */
  parse._handleContentLine = function (line, state) {
    // break up the parts of the line
    var valuePos = line.indexOf(VALUE_DELIMITER);
    var paramPos = line.indexOf(PARAM_DELIMITER);
    var lastParamIndex;
    var lastValuePos;

    // name of property or begin/end
    var name;
    var value;
    // params is only overridden if paramPos !== -1.
    // we can't do params = params || {} later on
    // because it sacrifices ops.
    var params = {};

    /**
     * Different property cases
     *
     *
     * 1. RRULE:FREQ=foo
     *    // FREQ= is not a param but the value
     *
     * 2. ATTENDEE;ROLE=REQ-PARTICIPANT;
     *    // ROLE= is a param because : has not happened yet
     */
    // when the parameter delimiter is after the
    // value delimiter then it is not a parameter.

    if (paramPos !== -1 && valuePos !== -1) {
      // when the parameter delimiter is after the
      // value delimiter then it is not a parameter.
      if (paramPos > valuePos) {
        paramPos = -1;
      }
    }
    var parsedParams;
    if (paramPos !== -1) {
      name = line.slice(0, Math.max(0, paramPos)).toLowerCase();
      parsedParams = parse._parseParameters(line.slice(Math.max(0, paramPos)), 0, state.designSet);
      if (parsedParams[2] == -1) {
        throw new ParserError("Invalid parameters in '" + line + "'");
      }
      params = parsedParams[0];
      // Handle parameter values with multiple entries
      var parsedParamLength;
      if (typeof parsedParams[1] === 'string') {
        parsedParamLength = parsedParams[1].length;
      } else {
        parsedParamLength = parsedParams[1].reduce(function (accumulator, currentValue) {
          return accumulator + currentValue.length;
        }, 0);
      }
      lastParamIndex = parsedParamLength + parsedParams[2] + paramPos;
      if ((lastValuePos = line.slice(Math.max(0, lastParamIndex)).indexOf(VALUE_DELIMITER)) !== -1) {
        value = line.slice(Math.max(0, lastParamIndex + lastValuePos + 1));
      } else {
        throw new ParserError("Missing parameter value in '" + line + "'");
      }
    } else if (valuePos !== -1) {
      // without parmeters (BEGIN:VCAENDAR, CLASS:PUBLIC)
      name = line.slice(0, Math.max(0, valuePos)).toLowerCase();
      value = line.slice(Math.max(0, valuePos + 1));
      if (name === 'begin') {
        var newComponent = [value.toLowerCase(), [], []];
        if (state.stack.length === 1) {
          state.component.push(newComponent);
        } else {
          state.component[2].push(newComponent);
        }
        state.stack.push(state.component);
        state.component = newComponent;
        if (!state.designSet) {
          state.designSet = design.getDesignSet(state.component[0]);
        }
        return;
      } else if (name === 'end') {
        state.component = state.stack.pop();
        return;
      }
      // If it is not begin/end, then this is a property with an empty value,
      // which should be considered valid.
    } else {
      /**
       * Invalid line.
       * The rational to throw an error is we will
       * never be certain that the rest of the file
       * is sane and it is unlikely that we can serialize
       * the result correctly either.
       */
      throw new ParserError('invalid line (no token ";" or ":") "' + line + '"');
    }
    var valueType;
    var multiValue = false;
    var structuredValue = false;
    var propertyDetails;
    var splitName;
    var ungroupedName;

    // fetch the ungrouped part of the name
    if (state.designSet.propertyGroups && name.indexOf('.') !== -1) {
      splitName = name.split('.');
      params.group = splitName[0];
      ungroupedName = splitName[1];
    } else {
      ungroupedName = name;
    }
    if (ungroupedName in state.designSet.property) {
      propertyDetails = state.designSet.property[ungroupedName];
      if ('multiValue' in propertyDetails) {
        multiValue = propertyDetails.multiValue;
      }
      if ('structuredValue' in propertyDetails) {
        structuredValue = propertyDetails.structuredValue;
      }
      if (value && 'detectType' in propertyDetails) {
        valueType = propertyDetails.detectType(value);
      }
    }

    // attempt to determine value
    if (!valueType) {
      if (!('value' in params)) {
        if (propertyDetails) {
          valueType = propertyDetails.defaultType;
        } else {
          valueType = DEFAULT_VALUE_TYPE$1;
        }
      } else {
        // possible to avoid this?
        valueType = params.value.toLowerCase();
      }
    }
    delete params.value;

    /**
     * Note on `var result` juggling:
     *
     * I observed that building the array in pieces has adverse
     * effects on performance, so where possible we inline the creation.
     * It is a little ugly but resulted in ~2000 additional ops/sec.
     */

    var result;
    if (multiValue && structuredValue) {
      value = parse._parseMultiValue(value, structuredValue, valueType, [], multiValue, state.designSet, structuredValue);
      result = [ungroupedName, params, valueType, value];
    } else if (multiValue) {
      result = [ungroupedName, params, valueType];
      parse._parseMultiValue(value, multiValue, valueType, result, null, state.designSet, false);
    } else if (structuredValue) {
      value = parse._parseMultiValue(value, structuredValue, valueType, [], null, state.designSet, structuredValue);
      result = [ungroupedName, params, valueType, value];
    } else {
      value = parse._parseValue(value, valueType, state.designSet, false);
      result = [ungroupedName, params, valueType, value];
    }
    // rfc6350 requires that in vCard 4.0 the first component is the VERSION
    // component with as value 4.0, note that 3.0 does not have this requirement.
    if (state.component[0] === 'vcard' && state.component[1].length === 0 && !(name === 'version' && value === '4.0')) {
      state.designSet = design.getDesignSet("vcard3");
    }
    state.component[1].push(result);
  };

  /**
   * Parse a value from the raw value into the jCard/jCal value.
   *
   * @private
   * @function ICAL.parse._parseValue
   * @param {String} value          Original value
   * @param {String} type           Type of value
   * @param {Object} designSet      The design data to use for this value
   * @return {Object} varies on type
   */
  parse._parseValue = function (value, type, designSet, structuredValue) {
    if (type in designSet.value && 'fromICAL' in designSet.value[type]) {
      return designSet.value[type].fromICAL(value, structuredValue);
    }
    return value;
  };

  /**
   * Parse parameters from a string to object.
   *
   * @function ICAL.parse._parseParameters
   * @private
   * @param {String} line               A single unfolded line
   * @param {Number} start              Position to start looking for properties
   * @param {Object} designSet          The design data to use for this property
   * @return {Array}                    Array containing key/valye pairs of parsed parameters, the
   *                                      parsed value, and the position of the last parameter found
   */
  parse._parseParameters = function (line, start, designSet) {
    var lastParam = start;
    var pos = 0;
    var delim = PARAM_NAME_DELIMITER;
    var result = {};
    var name, lcname;
    var value,
      valuePos = -1;
    var type, multiValue, mvdelim;

    // find the next '=' sign
    // use lastParam and pos to find name
    // check if " is used if so get value from "->"
    // then increment pos to find next ;

    while (pos !== false && (pos = line.indexOf(delim, pos + 1)) !== -1) {
      name = line.slice(lastParam + 1, pos);
      if (name.length == 0) {
        throw new ParserError("Empty parameter name in '" + line + "'");
      }
      lcname = name.toLowerCase();
      mvdelim = false;
      multiValue = false;
      if (lcname in designSet.param && designSet.param[lcname].valueType) {
        type = designSet.param[lcname].valueType;
      } else {
        type = DEFAULT_PARAM_TYPE;
      }
      if (lcname in designSet.param) {
        multiValue = designSet.param[lcname].multiValue;
        if (designSet.param[lcname].multiValueSeparateDQuote) {
          mvdelim = parse._rfc6868Escape('"' + multiValue + '"');
        }
      }
      var nextChar = line[pos + 1];
      if (nextChar === '"') {
        valuePos = pos + 2;
        pos = line.indexOf('"', valuePos);
        if (multiValue && pos != -1) {
          var extendedValue = true;
          while (extendedValue) {
            if (line[pos + 1] == multiValue && line[pos + 2] == '"') {
              pos = line.indexOf('"', pos + 3);
            } else {
              extendedValue = false;
            }
          }
        }
        if (pos === -1) {
          throw new ParserError('invalid line (no matching double quote) "' + line + '"');
        }
        value = line.slice(valuePos, pos);
        lastParam = line.indexOf(PARAM_DELIMITER, pos);
        var propValuePos = line.indexOf(VALUE_DELIMITER, pos);
        // if either no next parameter or delimeter in property value, let's stop here
        if (lastParam === -1 || propValuePos !== -1 && lastParam > propValuePos) {
          pos = false;
        }
      } else {
        valuePos = pos + 1;

        // move to next ";"
        var nextPos = line.indexOf(PARAM_DELIMITER, valuePos);
        var _propValuePos = line.indexOf(VALUE_DELIMITER, valuePos);
        if (_propValuePos !== -1 && nextPos > _propValuePos) {
          // this is a delimiter in the property value, let's stop here
          nextPos = _propValuePos;
          pos = false;
        } else if (nextPos === -1) {
          // no ";"
          if (_propValuePos === -1) {
            nextPos = line.length;
          } else {
            nextPos = _propValuePos;
          }
          pos = false;
        } else {
          lastParam = nextPos;
          pos = nextPos;
        }
        value = line.slice(valuePos, nextPos);
      }
      var length_before = value.length;
      value = parse._rfc6868Escape(value);
      valuePos += length_before - value.length;
      if (multiValue) {
        var delimiter = mvdelim || multiValue;
        value = parse._parseMultiValue(value, delimiter, type, [], null, designSet);
      } else {
        value = parse._parseValue(value, type, designSet);
      }
      if (multiValue && lcname in result) {
        if (Array.isArray(result[lcname])) {
          result[lcname].push(value);
        } else {
          result[lcname] = [result[lcname], value];
        }
      } else {
        result[lcname] = value;
      }
    }
    return [result, value, valuePos];
  };

  /**
   * Internal helper for rfc6868. Exposing this on ICAL.parse so that
   * hackers can disable the rfc6868 parsing if the really need to.
   *
   * @function ICAL.parse._rfc6868Escape
   * @param {String} val        The value to escape
   * @return {String}           The escaped value
   */
  parse._rfc6868Escape = function (val) {
    return val.replace(/\^['n^]/g, function (x) {
      return RFC6868_REPLACE_MAP$1[x];
    });
  };

  /**
   * Parse a multi value string. This function is used either for parsing
   * actual multi-value property's values, or for handling parameter values. It
   * can be used for both multi-value properties and structured value properties.
   *
   * @private
   * @function ICAL.parse._parseMultiValue
   * @param {String} buffer           The buffer containing the full value
   * @param {String} delim            The multi-value delimiter
   * @param {String} type             The value type to be parsed
   * @param {Array.<?>} result        The array to append results to, varies on value type
   * @param {String} innerMulti       The inner delimiter to split each value with
   * @param {designSet} designSet     The design data for this value
   * @return {?|Array.<?>}            Either an array of results, or the first result
   */
  parse._parseMultiValue = function (buffer, delim, type, result, innerMulti, designSet, structuredValue) {
    var pos = 0;
    var lastPos = 0;
    var value;
    if (delim.length === 0) {
      return buffer;
    }

    // split each piece
    while ((pos = unescapedIndexOf(buffer, delim, lastPos)) !== -1) {
      value = buffer.slice(lastPos, pos);
      if (innerMulti) {
        value = parse._parseMultiValue(value, innerMulti, type, [], null, designSet, structuredValue);
      } else {
        value = parse._parseValue(value, type, designSet, structuredValue);
      }
      result.push(value);
      lastPos = pos + delim.length;
    }

    // on the last piece take the rest of string
    value = buffer.slice(lastPos);
    if (innerMulti) {
      value = parse._parseMultiValue(value, innerMulti, type, [], null, designSet, structuredValue);
    } else {
      value = parse._parseValue(value, type, designSet, structuredValue);
    }
    result.push(value);
    return result.length == 1 ? result[0] : result;
  };

  /**
   * Process a complete buffer of iCalendar/vCard data line by line, correctly
   * unfolding content. Each line will be processed with the given callback
   *
   * @private
   * @function ICAL.parse._eachLine
   * @param {String} buffer                         The buffer to process
   * @param {function(?String, String)} callback    The callback for each line
   */
  parse._eachLine = function (buffer, callback) {
    var len = buffer.length;
    var lastPos = buffer.search(CHAR);
    var pos = lastPos;
    var line;
    var firstChar;
    var newlineOffset;
    do {
      pos = buffer.indexOf('\n', lastPos) + 1;
      if (pos > 1 && buffer[pos - 2] === '\r') {
        newlineOffset = 2;
      } else {
        newlineOffset = 1;
      }
      if (pos === 0) {
        pos = len;
        newlineOffset = 0;
      }
      firstChar = buffer[lastPos];
      if (firstChar === ' ' || firstChar === '\t') {
        // add to line
        line += buffer.slice(lastPos + 1, pos - newlineOffset);
      } else {
        if (line) callback(null, line);
        // push line
        line = buffer.slice(lastPos, pos - newlineOffset);
      }
      lastPos = pos;
    } while (pos !== len);

    // extra ending line
    line = line.trim();
    if (line.length) callback(null, line);
  };

  var OPTIONS = ["tzid", "location", "tznames", "latitude", "longitude"];

  /**
   * Timezone representation.
   *
   * @example
   * var vcalendar;
   * var timezoneComp = vcalendar.getFirstSubcomponent('vtimezone');
   * var tzid = timezoneComp.getFirstPropertyValue('tzid');
   *
   * var timezone = new ICAL.Timezone({
   *   component: timezoneComp,
   *   tzid
   * });
   *
   * @memberof ICAL
   */
  var Timezone = /*#__PURE__*/function () {
    /**
     * Creates a new ICAL.Timezone instance, by passing in a tzid and component.
     *
     * @param {Component|Object} data options for class
     * @param {String|Component} data.component
     *        If data is a simple object, then this member can be set to either a
     *        string containing the component data, or an already parsed
     *        ICAL.Component
     * @param {String} data.tzid      The timezone identifier
     * @param {String} data.location  The timezone locationw
     * @param {String} data.tznames   An alternative string representation of the
     *                                  timezone
     * @param {Number} data.latitude  The latitude of the timezone
     * @param {Number} data.longitude The longitude of the timezone
     */
    function Timezone(data) {
      _classCallCheck(this, Timezone);
      /**
       * Timezone identifier
       * @type {String}
       */
      _defineProperty(this, "tzid", "");
      /**
       * Timezone location
       * @type {String}
       */
      _defineProperty(this, "location", "");
      /**
       * Alternative timezone name, for the string representation
       * @type {String}
       */
      _defineProperty(this, "tznames", "");
      /**
       * The primary latitude for the timezone.
       * @type {Number}
       */
      _defineProperty(this, "latitude", 0.0);
      /**
       * The primary longitude for the timezone.
       * @type {Number}
       */
      _defineProperty(this, "longitude", 0.0);
      /**
       * The vtimezone component for this timezone.
       * @type {Component}
       */
      _defineProperty(this, "component", null);
      /**
       * The year this timezone has been expanded to. All timezone transition
       * dates until this year are known and can be used for calculation
       *
       * @private
       * @type {Number}
       */
      _defineProperty(this, "expandedUntilYear", 0);
      /**
       * The class identifier.
       * @constant
       * @type {String}
       * @default "icaltimezone"
       */
      _defineProperty(this, "icalclass", "icaltimezone");
      this.wrappedJSObject = this;
      this.fromData(data);
    }
    return _createClass(Timezone, [{
      key: "fromData",
      value:
      /**
       * Sets up the current instance using members from the passed data object.
       *
       * @param {Component|Object} aData options for class
       * @param {String|Component} aData.component
       *        If aData is a simple object, then this member can be set to either a
       *        string containing the component data, or an already parsed
       *        ICAL.Component
       * @param {String} aData.tzid      The timezone identifier
       * @param {String} aData.location  The timezone locationw
       * @param {String} aData.tznames   An alternative string representation of the
       *                                  timezone
       * @param {Number} aData.latitude  The latitude of the timezone
       * @param {Number} aData.longitude The longitude of the timezone
       */
      function fromData(aData) {
        this.expandedUntilYear = 0;
        this.changes = [];
        if (aData instanceof Component) {
          // Either a component is passed directly
          this.component = aData;
        } else {
          // Otherwise the component may be in the data object
          if (aData && "component" in aData) {
            if (typeof aData.component == "string") {
              // If a string was passed, parse it as a component
              var jCal = parse(aData.component);
              this.component = new Component(jCal);
            } else if (aData.component instanceof Component) {
              // If it was a component already, then just set it
              this.component = aData.component;
            } else {
              // Otherwise just null out the component
              this.component = null;
            }
          }

          // Copy remaining passed properties
          for (var _i = 0, _OPTIONS = OPTIONS; _i < _OPTIONS.length; _i++) {
            var prop = _OPTIONS[_i];
            if (aData && prop in aData) {
              this[prop] = aData[prop];
            }
          }
        }

        // If we have a component but no TZID, attempt to get it from the
        // component's properties.
        if (this.component instanceof Component && !this.tzid) {
          this.tzid = this.component.getFirstPropertyValue('tzid');
        }
        return this;
      }

      /**
       * Finds the utcOffset the given time would occur in this timezone.
       *
       * @param {Time} tt         The time to check for
       * @return {Number}         utc offset in seconds
       */
    }, {
      key: "utcOffset",
      value: function utcOffset(tt) {
        if (this == Timezone.utcTimezone || this == Timezone.localTimezone) {
          return 0;
        }
        this._ensureCoverage(tt.year);
        if (!this.changes.length) {
          return 0;
        }
        var tt_change = {
          year: tt.year,
          month: tt.month,
          day: tt.day,
          hour: tt.hour,
          minute: tt.minute,
          second: tt.second
        };
        var change_num = this._findNearbyChange(tt_change);
        var change_num_to_use = -1;
        var step = 1;

        // TODO: replace with bin search?
        for (;;) {
          var change = clone(this.changes[change_num], true);
          if (change.utcOffset < change.prevUtcOffset) {
            Timezone.adjust_change(change, 0, 0, 0, change.utcOffset);
          } else {
            Timezone.adjust_change(change, 0, 0, 0, change.prevUtcOffset);
          }
          var cmp = Timezone._compare_change_fn(tt_change, change);
          if (cmp >= 0) {
            change_num_to_use = change_num;
          } else {
            step = -1;
          }
          if (step == -1 && change_num_to_use != -1) {
            break;
          }
          change_num += step;
          if (change_num < 0) {
            return 0;
          }
          if (change_num >= this.changes.length) {
            break;
          }
        }
        var zone_change = this.changes[change_num_to_use];
        var utcOffset_change = zone_change.utcOffset - zone_change.prevUtcOffset;
        if (utcOffset_change < 0 && change_num_to_use > 0) {
          var tmp_change = clone(zone_change, true);
          Timezone.adjust_change(tmp_change, 0, 0, 0, tmp_change.prevUtcOffset);
          if (Timezone._compare_change_fn(tt_change, tmp_change) < 0) {
            var prev_zone_change = this.changes[change_num_to_use - 1];
            var want_daylight = false; // TODO

            if (zone_change.is_daylight != want_daylight && prev_zone_change.is_daylight == want_daylight) {
              zone_change = prev_zone_change;
            }
          }
        }

        // TODO return is_daylight?
        return zone_change.utcOffset;
      }
    }, {
      key: "_findNearbyChange",
      value: function _findNearbyChange(change) {
        // find the closest match
        var idx = binsearchInsert(this.changes, change, Timezone._compare_change_fn);
        if (idx >= this.changes.length) {
          return this.changes.length - 1;
        }
        return idx;
      }
    }, {
      key: "_ensureCoverage",
      value: function _ensureCoverage(aYear) {
        if (Timezone._minimumExpansionYear == -1) {
          var today = Time.now();
          Timezone._minimumExpansionYear = today.year;
        }
        var changesEndYear = aYear;
        if (changesEndYear < Timezone._minimumExpansionYear) {
          changesEndYear = Timezone._minimumExpansionYear;
        }
        changesEndYear += Timezone.EXTRA_COVERAGE;
        if (!this.changes.length || this.expandedUntilYear < aYear) {
          var subcomps = this.component.getAllSubcomponents();
          var compLen = subcomps.length;
          var compIdx = 0;
          for (; compIdx < compLen; compIdx++) {
            this._expandComponent(subcomps[compIdx], changesEndYear, this.changes);
          }
          this.changes.sort(Timezone._compare_change_fn);
          this.expandedUntilYear = changesEndYear;
        }
      }
    }, {
      key: "_expandComponent",
      value: function _expandComponent(aComponent, aYear, changes) {
        if (!aComponent.hasProperty("dtstart") || !aComponent.hasProperty("tzoffsetto") || !aComponent.hasProperty("tzoffsetfrom")) {
          return null;
        }
        var dtstart = aComponent.getFirstProperty("dtstart").getFirstValue();
        var change;
        function convert_tzoffset(offset) {
          return offset.factor * (offset.hours * 3600 + offset.minutes * 60);
        }
        function init_changes() {
          var changebase = {};
          changebase.is_daylight = aComponent.name == "daylight";
          changebase.utcOffset = convert_tzoffset(aComponent.getFirstProperty("tzoffsetto").getFirstValue());
          changebase.prevUtcOffset = convert_tzoffset(aComponent.getFirstProperty("tzoffsetfrom").getFirstValue());
          return changebase;
        }
        if (!aComponent.hasProperty("rrule") && !aComponent.hasProperty("rdate")) {
          change = init_changes();
          change.year = dtstart.year;
          change.month = dtstart.month;
          change.day = dtstart.day;
          change.hour = dtstart.hour;
          change.minute = dtstart.minute;
          change.second = dtstart.second;
          Timezone.adjust_change(change, 0, 0, 0, -change.prevUtcOffset);
          changes.push(change);
        } else {
          var props = aComponent.getAllProperties("rdate");
          var _iterator = _createForOfIteratorHelper(props),
            _step;
          try {
            for (_iterator.s(); !(_step = _iterator.n()).done;) {
              var rdate = _step.value;
              var time = rdate.getFirstValue();
              change = init_changes();
              change.year = time.year;
              change.month = time.month;
              change.day = time.day;
              if (time.isDate) {
                change.hour = dtstart.hour;
                change.minute = dtstart.minute;
                change.second = dtstart.second;
                if (dtstart.zone != Timezone.utcTimezone) {
                  Timezone.adjust_change(change, 0, 0, 0, -change.prevUtcOffset);
                }
              } else {
                change.hour = time.hour;
                change.minute = time.minute;
                change.second = time.second;
                if (time.zone != Timezone.utcTimezone) {
                  Timezone.adjust_change(change, 0, 0, 0, -change.prevUtcOffset);
                }
              }
              changes.push(change);
            }
          } catch (err) {
            _iterator.e(err);
          } finally {
            _iterator.f();
          }
          var rrule = aComponent.getFirstProperty("rrule");
          if (rrule) {
            rrule = rrule.getFirstValue();
            change = init_changes();
            if (rrule.until && rrule.until.zone == Timezone.utcTimezone) {
              rrule.until.adjust(0, 0, 0, change.prevUtcOffset);
              rrule.until.zone = Timezone.localTimezone;
            }
            var iterator = rrule.iterator(dtstart);
            var occ;
            while (occ = iterator.next()) {
              change = init_changes();
              if (occ.year > aYear || !occ) {
                break;
              }
              change.year = occ.year;
              change.month = occ.month;
              change.day = occ.day;
              change.hour = occ.hour;
              change.minute = occ.minute;
              change.second = occ.second;
              change.isDate = occ.isDate;
              Timezone.adjust_change(change, 0, 0, 0, -change.prevUtcOffset);
              changes.push(change);
            }
          }
        }
        return changes;
      }

      /**
       * The string representation of this timezone.
       * @return {String}
       */
    }, {
      key: "toString",
      value: function toString() {
        return this.tznames ? this.tznames : this.tzid;
      }
    }], [{
      key: "_compare_change_fn",
      value: function _compare_change_fn(a, b) {
        if (a.year < b.year) return -1;else if (a.year > b.year) return 1;
        if (a.month < b.month) return -1;else if (a.month > b.month) return 1;
        if (a.day < b.day) return -1;else if (a.day > b.day) return 1;
        if (a.hour < b.hour) return -1;else if (a.hour > b.hour) return 1;
        if (a.minute < b.minute) return -1;else if (a.minute > b.minute) return 1;
        if (a.second < b.second) return -1;else if (a.second > b.second) return 1;
        return 0;
      }

      /**
       * Convert the date/time from one zone to the next.
       *
       * @param {Time} tt                  The time to convert
       * @param {Timezone} from_zone       The source zone to convert from
       * @param {Timezone} to_zone         The target zone to convert to
       * @return {Time}                    The converted date/time object
       */
    }, {
      key: "convert_time",
      value: function convert_time(tt, from_zone, to_zone) {
        if (tt.isDate || from_zone.tzid == to_zone.tzid || from_zone == Timezone.localTimezone || to_zone == Timezone.localTimezone) {
          tt.zone = to_zone;
          return tt;
        }
        var utcOffset = from_zone.utcOffset(tt);
        tt.adjust(0, 0, 0, -utcOffset);
        utcOffset = to_zone.utcOffset(tt);
        tt.adjust(0, 0, 0, utcOffset);
        return null;
      }

      /**
       * Creates a new ICAL.Timezone instance from the passed data object.
       *
       * @param {Component|Object} aData options for class
       * @param {String|Component} aData.component
       *        If aData is a simple object, then this member can be set to either a
       *        string containing the component data, or an already parsed
       *        ICAL.Component
       * @param {String} aData.tzid      The timezone identifier
       * @param {String} aData.location  The timezone locationw
       * @param {String} aData.tznames   An alternative string representation of the
       *                                  timezone
       * @param {Number} aData.latitude  The latitude of the timezone
       * @param {Number} aData.longitude The longitude of the timezone
       */
    }, {
      key: "fromData",
      value: function fromData(aData) {
        var tt = new Timezone();
        return tt.fromData(aData);
      }

      /**
       * The instance describing the UTC timezone
       * @type {Timezone}
       * @constant
       * @instance
       */
    }, {
      key: "utcTimezone",
      get: function get() {
        if (!_assertClassBrand(Timezone, this, _utcTimezone)._) {
          _utcTimezone._ = _assertClassBrand(Timezone, this, Timezone.fromData({
            tzid: "UTC"
          }));
        }
        return _assertClassBrand(Timezone, this, _utcTimezone)._;
      }

      /**
       * The instance describing the local timezone
       * @type {Timezone}
       * @constant
       * @instance
       */
    }, {
      key: "localTimezone",
      get: function get() {
        if (!_assertClassBrand(Timezone, this, _localTimezone)._) {
          _localTimezone._ = _assertClassBrand(Timezone, this, Timezone.fromData({
            tzid: "floating"
          }));
        }
        return _assertClassBrand(Timezone, this, _localTimezone)._;
      }

      /**
       * Adjust a timezone change object.
       * @private
       * @param {Object} change     The timezone change object
       * @param {Number} days       The extra amount of days
       * @param {Number} hours      The extra amount of hours
       * @param {Number} minutes    The extra amount of minutes
       * @param {Number} seconds    The extra amount of seconds
       */
    }, {
      key: "adjust_change",
      value: function adjust_change(change, days, hours, minutes, seconds) {
        return Time.prototype.adjust.call(change, days, hours, minutes, seconds, change);
      }
    }]);
  }();
  var _utcTimezone = {
    _: null
  };
  var _localTimezone = {
    _: null
  };
  _defineProperty(Timezone, "_minimumExpansionYear", -1);
  _defineProperty(Timezone, "EXTRA_COVERAGE", 5);

  /* This Source Code Form is subject to the terms of the Mozilla Public
   * License, v. 2.0. If a copy of the MPL was not distributed with this
   * file, You can obtain one at http://mozilla.org/MPL/2.0/.
   * Portions Copyright (C) Philipp Kewisch */

  var zones = null;

  /**
   * @classdesc
   * Singleton class to contain timezones.  Right now it is all manual registry in
   * the future we may use this class to download timezone information or handle
   * loading pre-expanded timezones.
   *
   * @exports module:ICAL.TimezoneService
   * @memberof ICAL
   */
  var TimezoneService = {
    get count() {
      if (zones === null) {
        return 0;
      }
      return Object.keys(zones).length;
    },
    reset: function reset() {
      zones = Object.create(null);
      var utc = Timezone.utcTimezone;
      zones.Z = utc;
      zones.UTC = utc;
      zones.GMT = utc;
    },
    _hard_reset: function _hard_reset() {
      zones = null;
    },
    /**
     * Checks if timezone id has been registered.
     *
     * @param {String} tzid     Timezone identifier (e.g. America/Los_Angeles)
     * @return {Boolean}        False, when not present
     */
    has: function has(tzid) {
      if (zones === null) {
        return false;
      }
      return !!zones[tzid];
    },
    /**
     * Returns a timezone by its tzid if present.
     *
     * @param {String} tzid               Timezone identifier (e.g. America/Los_Angeles)
     * @return {Timezone | undefined}     The timezone, or undefined if not found
     */
    get: function get(tzid) {
      if (zones === null) {
        this.reset();
      }
      return zones[tzid];
    },
    /**
     * Registers a timezone object or component.
     *
     * @param {Component|Timezone} timezone
     *        The initialized zone or vtimezone.
     *
     * @param {String=} name
     *        The name of the timezone. Defaults to the component's TZID if not
     *        passed.
     */
    register: function register(timezone, name) {
      if (zones === null) {
        this.reset();
      }

      // This avoids a breaking change by the change of argument order
      // TODO remove in v3
      if (typeof timezone === "string" && name instanceof Timezone) {
        var _ref = [name, timezone];
        timezone = _ref[0];
        name = _ref[1];
      }
      if (!name) {
        if (timezone instanceof Timezone) {
          name = timezone.tzid;
        } else {
          if (timezone.name === 'vtimezone') {
            timezone = new Timezone(timezone);
            name = timezone.tzid;
          }
        }
      }
      if (!name) {
        throw new TypeError("Neither a timezone nor a name was passed");
      }
      if (timezone instanceof Timezone) {
        zones[name] = timezone;
      } else {
        throw new TypeError('timezone must be ICAL.Timezone or ICAL.Component');
      }
    },
    /**
     * Removes a timezone by its tzid from the list.
     *
     * @param {String} tzid     Timezone identifier (e.g. America/Los_Angeles)
     * @return {?Timezone}      The removed timezone, or null if not registered
     */
    remove: function remove(tzid) {
      if (zones === null) {
        return null;
      }
      return delete zones[tzid];
    }
  };

  /**
   * Helper functions used in various places within ical.js
   * @module ICAL.helpers
   */

  /**
   * Compiles a list of all referenced TZIDs in all subcomponents and
   * removes any extra VTIMEZONE subcomponents. In addition, if any TZIDs
   * are referenced by a component, but a VTIMEZONE does not exist,
   * an attempt will be made to generate a VTIMEZONE using ICAL.TimezoneService.
   *
   * @param {Component} vcal     The top-level VCALENDAR component.
   * @return {Component}         The ICAL.Component that was passed in.
   */
  function updateTimezones(vcal) {
    var allsubs, properties, vtimezones, reqTzid, i;
    if (!vcal || vcal.name !== "vcalendar") {
      //not a top-level vcalendar component
      return vcal;
    }

    //Store vtimezone subcomponents in an object reference by tzid.
    //Store properties from everything else in another array
    allsubs = vcal.getAllSubcomponents();
    properties = [];
    vtimezones = {};
    for (i = 0; i < allsubs.length; i++) {
      if (allsubs[i].name === "vtimezone") {
        var tzid = allsubs[i].getFirstProperty("tzid").getFirstValue();
        vtimezones[tzid] = allsubs[i];
      } else {
        properties = properties.concat(allsubs[i].getAllProperties());
      }
    }

    //create an object with one entry for each required tz
    reqTzid = {};
    for (i = 0; i < properties.length; i++) {
      var _tzid = properties[i].getParameter("tzid");
      if (_tzid) {
        reqTzid[_tzid] = true;
      }
    }

    //delete any vtimezones that are not on the reqTzid list.
    for (var _i = 0, _Object$entries = Object.entries(vtimezones); _i < _Object$entries.length; _i++) {
      var _Object$entries$_i = _slicedToArray(_Object$entries[_i], 2),
        _tzid2 = _Object$entries$_i[0],
        comp = _Object$entries$_i[1];
      if (!reqTzid[_tzid2]) {
        vcal.removeSubcomponent(comp);
      }
    }

    //create any missing, but registered timezones
    for (var _i2 = 0, _Object$keys = Object.keys(reqTzid); _i2 < _Object$keys.length; _i2++) {
      var _tzid3 = _Object$keys[_i2];
      if (!vtimezones[_tzid3] && TimezoneService.has(_tzid3)) {
        vcal.addSubcomponent(TimezoneService.get(_tzid3).component);
      }
    }
    return vcal;
  }

  /**
   * Checks if the given type is of the number type and also NaN.
   *
   * @param {Number} number     The number to check
   * @return {Boolean}          True, if the number is strictly NaN
   */
  function isStrictlyNaN(number) {
    return typeof number === 'number' && isNaN(number);
  }

  /**
   * Parses a string value that is expected to be an integer, when the valid is
   * not an integer throws a decoration error.
   *
   * @param {String} string     Raw string input
   * @return {Number}           Parsed integer
   */
  function strictParseInt(string) {
    var result = parseInt(string, 10);
    if (isStrictlyNaN(result)) {
      throw new Error('Could not extract integer from "' + string + '"');
    }
    return result;
  }

  /**
   * Creates or returns a class instance of a given type with the initialization
   * data if the data is not already an instance of the given type.
   *
   * @example
   * var time = new ICAL.Time(...);
   * var result = ICAL.helpers.formatClassType(time, ICAL.Time);
   *
   * (result instanceof ICAL.Time)
   * // => true
   *
   * result = ICAL.helpers.formatClassType({}, ICAL.Time);
   * (result isntanceof ICAL.Time)
   * // => true
   *
   *
   * @param {Object} data       object initialization data
   * @param {Object} type       object type (like ICAL.Time)
   * @return {?}                An instance of the found type.
   */
  function formatClassType(data, type) {
    if (typeof data === 'undefined') {
      return undefined;
    }
    if (data instanceof type) {
      return data;
    }
    return new type(data);
  }

  /**
   * Identical to indexOf but will only match values when they are not preceded
   * by a backslash character.
   *
   * @param {String} buffer         String to search
   * @param {String} search         Value to look for
   * @param {Number} pos            Start position
   * @return {Number}               The position, or -1 if not found
   */
  function unescapedIndexOf(buffer, search, pos) {
    while ((pos = buffer.indexOf(search, pos)) !== -1) {
      if (pos > 0 && buffer[pos - 1] === '\\') {
        pos += 1;
      } else {
        return pos;
      }
    }
    return -1;
  }

  /**
   * Find the index for insertion using binary search.
   *
   * @param {Array} list            The list to search
   * @param {?} seekVal             The value to insert
   * @param {function(?,?)} cmpfunc The comparison func, that can
   *                                  compare two seekVals
   * @return {Number}               The insert position
   */
  function binsearchInsert(list, seekVal, cmpfunc) {
    if (!list.length) return 0;
    var low = 0,
      high = list.length - 1,
      mid,
      cmpval;
    while (low <= high) {
      mid = low + Math.floor((high - low) / 2);
      cmpval = cmpfunc(seekVal, list[mid]);
      if (cmpval < 0) high = mid - 1;else if (cmpval > 0) low = mid + 1;else break;
    }
    if (cmpval < 0) return mid; // insertion is displacing, so use mid outright.
    else if (cmpval > 0) return mid + 1;else return mid;
  }

  /**
   * Clone the passed object or primitive. By default a shallow clone will be
   * executed.
   *
   * @param {*} aSrc            The thing to clone
   * @param {Boolean=} aDeep    If true, a deep clone will be performed
   * @return {*}                The copy of the thing
   */
  function clone(aSrc, aDeep) {
    if (!aSrc || _typeof(aSrc) != "object") {
      return aSrc;
    } else if (aSrc instanceof Date) {
      return new Date(aSrc.getTime());
    } else if ("clone" in aSrc) {
      return aSrc.clone();
    } else if (Array.isArray(aSrc)) {
      var arr = [];
      for (var i = 0; i < aSrc.length; i++) {
        arr.push(aDeep ? clone(aSrc[i], true) : aSrc[i]);
      }
      return arr;
    } else {
      var obj = {};
      for (var _i3 = 0, _Object$entries2 = Object.entries(aSrc); _i3 < _Object$entries2.length; _i3++) {
        var _Object$entries2$_i = _slicedToArray(_Object$entries2[_i3], 2),
          name = _Object$entries2$_i[0],
          value = _Object$entries2$_i[1];
        if (aDeep) {
          obj[name] = clone(value, true);
        } else {
          obj[name] = value;
        }
      }
      return obj;
    }
  }

  /**
   * Performs iCalendar line folding. A line ending character is inserted and
   * the next line begins with a whitespace.
   *
   * @example
   * SUMMARY:This line will be fold
   *  ed right in the middle of a word.
   *
   * @param {String} aLine      The line to fold
   * @return {String}           The folded line
   */
  function foldline(aLine) {
    var result = "";
    var line = aLine || "",
      pos = 0,
      line_length = 0;
    //pos counts position in line for the UTF-16 presentation
    //line_length counts the bytes for the UTF-8 presentation
    while (line.length) {
      var cp = line.codePointAt(pos);
      if (cp < 128) ++line_length;else if (cp < 2048) line_length += 2; //needs 2 UTF-8 bytes
      else if (cp < 65536) line_length += 3;else line_length += 4; //cp is less than 1114112
      if (line_length < ICALmodule.foldLength + 1) pos += cp > 65535 ? 2 : 1;else {
        result += ICALmodule.newLineChar + " " + line.slice(0, Math.max(0, pos));
        line = line.slice(Math.max(0, pos));
        pos = line_length = 0;
      }
    }
    return result.slice(ICALmodule.newLineChar.length + 1);
  }

  /**
   * Pads the given string or number with zeros so it will have at least two
   * characters.
   *
   * @param {String|Number} data    The string or number to pad
   * @return {String}               The number padded as a string
   */
  function pad2(data) {
    if (typeof data !== 'string') {
      // handle fractions.
      if (typeof data === 'number') {
        data = parseInt(data);
      }
      data = String(data);
    }
    var len = data.length;
    switch (len) {
      case 0:
        return '00';
      case 1:
        return '0' + data;
      default:
        return data;
    }
  }

  /**
   * Truncates the given number, correctly handling negative numbers.
   *
   * @param {Number} number     The number to truncate
   * @return {Number}           The truncated number
   */
  function trunc(number) {
    return number < 0 ? Math.ceil(number) : Math.floor(number);
  }

  /**
   * Poor-man's cross-browser object extension. Doesn't support all the
   * features, but enough for our usage. Note that the target's properties are
   * not overwritten with the source properties.
   *
   * @example
   * var child = ICAL.helpers.extend(parent, {
   *   "bar": 123
   * });
   *
   * @param {Object} source     The object to extend
   * @param {Object} target     The object to extend with
   * @return {Object}           Returns the target.
   */
  function extend(source, target) {
    for (var key in source) {
      var descr = Object.getOwnPropertyDescriptor(source, key);
      if (descr && !Object.getOwnPropertyDescriptor(target, key)) {
        Object.defineProperty(target, key, descr);
      }
    }
    return target;
  }

  var helpers = /*#__PURE__*/Object.freeze({
    __proto__: null,
    binsearchInsert: binsearchInsert,
    clone: clone,
    extend: extend,
    foldline: foldline,
    formatClassType: formatClassType,
    isStrictlyNaN: isStrictlyNaN,
    pad2: pad2,
    strictParseInt: strictParseInt,
    trunc: trunc,
    unescapedIndexOf: unescapedIndexOf,
    updateTimezones: updateTimezones
  });

  /**
   * This class represents the "utc-offset" value type, with various calculation and manipulation
   * methods.
   *
   * @memberof ICAL
   */
  var UtcOffset = /*#__PURE__*/function () {
    /**
     * Creates a new ICAL.UtcOffset instance.
     *
     * @param {Object} aData          An object with members of the utc offset
     * @param {Number=} aData.hours   The hours for the utc offset
     * @param {Number=} aData.minutes The minutes in the utc offset
     * @param {Number=} aData.factor  The factor for the utc-offset, either -1 or 1
     */
    function UtcOffset(aData) {
      _classCallCheck(this, UtcOffset);
      /**
       * The hours in the utc-offset
       * @type {Number}
       */
      _defineProperty(this, "hours", 0);
      /**
       * The minutes in the utc-offset
       * @type {Number}
       */
      _defineProperty(this, "minutes", 0);
      /**
       * The sign of the utc offset, 1 for positive offset, -1 for negative
       * offsets.
       * @type {Number}
       */
      _defineProperty(this, "factor", 1);
      /**
       * The type name, to be used in the jCal object.
       * @constant
       * @type {String}
       * @default "utc-offset"
       */
      _defineProperty(this, "icaltype", "utc-offset");
      this.fromData(aData);
    }
    return _createClass(UtcOffset, [{
      key: "clone",
      value:
      /**
       * Returns a clone of the utc offset object.
       *
       * @return {UtcOffset}     The cloned object
       */
      function clone() {
        return UtcOffset.fromSeconds(this.toSeconds());
      }

      /**
       * Sets up the current instance using members from the passed data object.
       *
       * @param {Object} aData          An object with members of the utc offset
       * @param {Number=} aData.hours   The hours for the utc offset
       * @param {Number=} aData.minutes The minutes in the utc offset
       * @param {Number=} aData.factor  The factor for the utc-offset, either -1 or 1
       */
    }, {
      key: "fromData",
      value: function fromData(aData) {
        if (aData) {
          for (var _i = 0, _Object$entries = Object.entries(aData); _i < _Object$entries.length; _i++) {
            var _Object$entries$_i = _slicedToArray(_Object$entries[_i], 2),
              key = _Object$entries$_i[0],
              value = _Object$entries$_i[1];
            this[key] = value;
          }
        }
        this._normalize();
      }

      /**
       * Sets up the current instance from the given seconds value. The seconds
       * value is truncated to the minute. Offsets are wrapped when the world
       * ends, the hour after UTC+14:00 is UTC-12:00.
       *
       * @param {Number} aSeconds         The seconds to convert into an offset
       */
    }, {
      key: "fromSeconds",
      value: function fromSeconds(aSeconds) {
        var secs = Math.abs(aSeconds);
        this.factor = aSeconds < 0 ? -1 : 1;
        this.hours = trunc(secs / 3600);
        secs -= this.hours * 3600;
        this.minutes = trunc(secs / 60);
        return this;
      }

      /**
       * Convert the current offset to a value in seconds
       *
       * @return {Number}                 The offset in seconds
       */
    }, {
      key: "toSeconds",
      value: function toSeconds() {
        return this.factor * (60 * this.minutes + 3600 * this.hours);
      }

      /**
       * Compare this utc offset with another one.
       *
       * @param {UtcOffset} other             The other offset to compare with
       * @return {Number}                     -1, 0 or 1 for less/equal/greater
       */
    }, {
      key: "compare",
      value: function compare(other) {
        var a = this.toSeconds();
        var b = other.toSeconds();
        return (a > b) - (b > a);
      }
    }, {
      key: "_normalize",
      value: function _normalize() {
        // Range: 97200 seconds (with 1 hour inbetween)
        var secs = this.toSeconds();
        var factor = this.factor;
        while (secs < -43200) {
          // = UTC-12:00
          secs += 97200;
        }
        while (secs > 50400) {
          // = UTC+14:00
          secs -= 97200;
        }
        this.fromSeconds(secs);

        // Avoid changing the factor when on zero seconds
        if (secs == 0) {
          this.factor = factor;
        }
      }

      /**
       * The iCalendar string representation of this utc-offset.
       * @return {String}
       */
    }, {
      key: "toICALString",
      value: function toICALString() {
        return design.icalendar.value['utc-offset'].toICAL(this.toString());
      }

      /**
       * The string representation of this utc-offset.
       * @return {String}
       */
    }, {
      key: "toString",
      value: function toString() {
        return (this.factor == 1 ? "+" : "-") + pad2(this.hours) + ':' + pad2(this.minutes);
      }
    }], [{
      key: "fromString",
      value:
      /**
       * Creates a new {@link ICAL.UtcOffset} instance from the passed string.
       *
       * @param {String} aString    The string to parse
       * @return {Duration}         The created utc-offset instance
       */
      function fromString(aString) {
        // -05:00
        var options = {};
        //TODO: support seconds per rfc5545 ?
        options.factor = aString[0] === '+' ? 1 : -1;
        options.hours = strictParseInt(aString.slice(1, 3));
        options.minutes = strictParseInt(aString.slice(4, 6));
        return new UtcOffset(options);
      }

      /**
       * Creates a new {@link ICAL.UtcOffset} instance from the passed seconds
       * value.
       *
       * @param {Number} aSeconds       The number of seconds to convert
       */
    }, {
      key: "fromSeconds",
      value: function fromSeconds(aSeconds) {
        var instance = new UtcOffset();
        instance.fromSeconds(aSeconds);
        return instance;
      }
    }]);
  }();

  /**
   * Describes a vCard time, which has slight differences to the ICAL.Time.
   * Properties can be null if not specified, for example for dates with
   * reduced accuracy or truncation.
   *
   * Note that currently not all methods are correctly re-implemented for
   * VCardTime. For example, comparison will have undefined results when some
   * members are null.
   *
   * Also, normalization is not yet implemented for this class!
   *
   * @memberof ICAL
   * @extends {Time}
   */
  var VCardTime = /*#__PURE__*/function (_Time) {
    /**
     * Creates a new ICAL.VCardTime instance.
     *
     * @param {Object} data                           The data for the time instance
     * @param {Number=} data.year                     The year for this date
     * @param {Number=} data.month                    The month for this date
     * @param {Number=} data.day                      The day for this date
     * @param {Number=} data.hour                     The hour for this date
     * @param {Number=} data.minute                   The minute for this date
     * @param {Number=} data.second                   The second for this date
     * @param {Timezone|UtcOffset} zone               The timezone to use
     * @param {String} icaltype                       The type for this date/time object
     */
    function VCardTime(data, zone, icaltype) {
      var _this;
      _classCallCheck(this, VCardTime);
      _this = _callSuper(this, VCardTime, [data, zone]);
      /**
       * The class identifier.
       * @constant
       * @type {String}
       * @default "vcardtime"
       */
      _defineProperty(_this, "icalclass", "vcardtime");
      /**
       * The type name, to be used in the jCal object.
       * @type {String}
       * @default "date-and-or-time"
       */
      _defineProperty(_this, "icaltype", "date-and-or-time");
      _this.icaltype = icaltype || "date-and-or-time";
      return _this;
    }
    _inherits(VCardTime, _Time);
    return _createClass(VCardTime, [{
      key: "clone",
      value:
      /**
       * Returns a clone of the vcard date/time object.
       *
       * @return {VCardTime}     The cloned object
       */
      function clone() {
        return new VCardTime(this._time, this.zone, this.icaltype);
      }
    }, {
      key: "_normalize",
      value: function _normalize() {
        return this;
      }

      /**
       * @inheritdoc
       */
    }, {
      key: "utcOffset",
      value: function utcOffset() {
        if (this.zone instanceof UtcOffset) {
          return this.zone.toSeconds();
        } else {
          return Time.prototype.utcOffset.apply(this, arguments);
        }
      }

      /**
       * Returns an RFC 6350 compliant representation of this object.
       *
       * @return {String}         vcard date/time string
       */
    }, {
      key: "toICALString",
      value: function toICALString() {
        return design.vcard.value[this.icaltype].toICAL(this.toString());
      }

      /**
       * The string representation of this date/time, in jCard form
       * (including : and - separators).
       * @return {String}
       */
    }, {
      key: "toString",
      value: function toString() {
        var y = this.year,
          m = this.month,
          d = this.day;
        var h = this.hour,
          mm = this.minute,
          s = this.second;
        var hasYear = y !== null,
          hasMonth = m !== null,
          hasDay = d !== null;
        var hasHour = h !== null,
          hasMinute = mm !== null,
          hasSecond = s !== null;
        var datepart = (hasYear ? pad2(y) + (hasMonth || hasDay ? '-' : '') : hasMonth || hasDay ? '--' : '') + (hasMonth ? pad2(m) : '') + (hasDay ? '-' + pad2(d) : '');
        var timepart = (hasHour ? pad2(h) : '-') + (hasHour && hasMinute ? ':' : '') + (hasMinute ? pad2(mm) : '') + (!hasHour && !hasMinute ? '-' : '') + (hasMinute && hasSecond ? ':' : '') + (hasSecond ? pad2(s) : '');
        var zone;
        if (this.zone === Timezone.utcTimezone) {
          zone = 'Z';
        } else if (this.zone instanceof UtcOffset) {
          zone = this.zone.toString();
        } else if (this.zone === Timezone.localTimezone) {
          zone = '';
        } else if (this.zone instanceof Timezone) {
          var offset = UtcOffset.fromSeconds(this.zone.utcOffset(this));
          zone = offset.toString();
        } else {
          zone = '';
        }
        switch (this.icaltype) {
          case "time":
            return timepart + zone;
          case "date-and-or-time":
          case "date-time":
            return datepart + (timepart == '--' ? '' : 'T' + timepart + zone);
          case "date":
            return datepart;
        }
        return null;
      }
    }], [{
      key: "fromDateAndOrTimeString",
      value:
      /**
       * Returns a new ICAL.VCardTime instance from a date and/or time string.
       *
       * @param {String} aValue     The string to create from
       * @param {String} aIcalType  The type for this instance, e.g. date-and-or-time
       * @return {VCardTime}        The date/time instance
       */
      function fromDateAndOrTimeString(aValue, aIcalType) {
        function part(v, s, e) {
          return v ? strictParseInt(v.slice(s, s + e)) : null;
        }
        var parts = aValue.split('T');
        var dt = parts[0],
          tmz = parts[1];
        var splitzone = tmz ? design.vcard.value.time._splitZone(tmz) : [];
        var zone = splitzone[0],
          tm = splitzone[1];
        var dtlen = dt ? dt.length : 0;
        var tmlen = tm ? tm.length : 0;
        var hasDashDate = dt && dt[0] == '-' && dt[1] == '-';
        var hasDashTime = tm && tm[0] == '-';
        var o = {
          year: hasDashDate ? null : part(dt, 0, 4),
          month: hasDashDate && (dtlen == 4 || dtlen == 7) ? part(dt, 2, 2) : dtlen == 7 ? part(dt, 5, 2) : dtlen == 10 ? part(dt, 5, 2) : null,
          day: dtlen == 5 ? part(dt, 3, 2) : dtlen == 7 && hasDashDate ? part(dt, 5, 2) : dtlen == 10 ? part(dt, 8, 2) : null,
          hour: hasDashTime ? null : part(tm, 0, 2),
          minute: hasDashTime && tmlen == 3 ? part(tm, 1, 2) : tmlen > 4 ? hasDashTime ? part(tm, 1, 2) : part(tm, 3, 2) : null,
          second: tmlen == 4 ? part(tm, 2, 2) : tmlen == 6 ? part(tm, 4, 2) : tmlen == 8 ? part(tm, 6, 2) : null
        };
        if (zone == 'Z') {
          zone = Timezone.utcTimezone;
        } else if (zone && zone[3] == ':') {
          zone = UtcOffset.fromString(zone);
        } else {
          zone = null;
        }
        return new VCardTime(o, zone, aIcalType);
      }
    }]);
  }(Time);

  /**
   * This lets typescript resolve our custom types in the
   * generated d.ts files (jsdoc typedefs are converted to typescript types).
   * Ignore prevents the typedefs from being documented more than once.
   *
   * @ignore
   * @typedef {import("./types.js").weekDay} weekDay
   * Imports the 'weekDay' type from the "types.js" module
   */

  /**
   * An iterator for a single recurrence rule. This class usually doesn't have to be instanciated
   * directly, the convenience method {@link ICAL.Recur#iterator} can be used.
   *
   * @memberof ICAL
   */
  var RecurIterator = /*#__PURE__*/function () {
    /**
     * Creates a new ICAL.RecurIterator instance. The options object may contain additional members
     * when resuming iteration from a previous run.
     *
     * @param {Object} options                The iterator options
     * @param {Recur} options.rule            The rule to iterate.
     * @param {Time} options.dtstart          The start date of the event.
     * @param {Boolean=} options.initialized  When true, assume that options are
     *        from a previously constructed iterator. Initialization will not be
     *        repeated.
     */
    function RecurIterator(options) {
      _classCallCheck(this, RecurIterator);
      /**
       * True when iteration is finished.
       * @type {Boolean}
       */
      _defineProperty(this, "completed", false);
      /**
       * The rule that is being iterated
       * @type {Recur}
       */
      _defineProperty(this, "rule", null);
      /**
       * The start date of the event being iterated.
       * @type {Time}
       */
      _defineProperty(this, "dtstart", null);
      /**
       * The last occurrence that was returned from the
       * {@link RecurIterator#next} method.
       * @type {Time}
       */
      _defineProperty(this, "last", null);
      /**
       * The sequence number from the occurrence
       * @type {Number}
       */
      _defineProperty(this, "occurrence_number", 0);
      /**
       * The indices used for the {@link ICAL.RecurIterator#by_data} object.
       * @type {Object}
       * @private
       */
      _defineProperty(this, "by_indices", null);
      /**
       * If true, the iterator has already been initialized
       * @type {Boolean}
       * @private
       */
      _defineProperty(this, "initialized", false);
      /**
       * The initializd by-data.
       * @type {Object}
       * @private
       */
      _defineProperty(this, "by_data", null);
      /**
       * The expanded yeardays
       * @type {Array}
       * @private
       */
      _defineProperty(this, "days", null);
      /**
       * The index in the {@link ICAL.RecurIterator#days} array.
       * @type {Number}
       * @private
       */
      _defineProperty(this, "days_index", 0);
      this.fromData(options);
    }
    return _createClass(RecurIterator, [{
      key: "fromData",
      value:
      /**
       * Initialize the recurrence iterator from the passed data object. This
       * method is usually not called directly, you can initialize the iterator
       * through the constructor.
       *
       * @param {Object} options                The iterator options
       * @param {Recur} options.rule            The rule to iterate.
       * @param {Time} options.dtstart          The start date of the event.
       * @param {Boolean=} options.initialized  When true, assume that options are
       *        from a previously constructed iterator. Initialization will not be
       *        repeated.
       */
      function fromData(options) {
        this.rule = formatClassType(options.rule, Recur);
        if (!this.rule) {
          throw new Error('iterator requires a (ICAL.Recur) rule');
        }
        this.dtstart = formatClassType(options.dtstart, Time);
        if (!this.dtstart) {
          throw new Error('iterator requires a (ICAL.Time) dtstart');
        }
        if (options.by_data) {
          this.by_data = options.by_data;
        } else {
          this.by_data = clone(this.rule.parts, true);
        }
        if (options.occurrence_number) this.occurrence_number = options.occurrence_number;
        this.days = options.days || [];
        if (options.last) {
          this.last = formatClassType(options.last, Time);
        }
        this.by_indices = options.by_indices;
        if (!this.by_indices) {
          this.by_indices = {
            "BYSECOND": 0,
            "BYMINUTE": 0,
            "BYHOUR": 0,
            "BYDAY": 0,
            "BYMONTH": 0,
            "BYWEEKNO": 0,
            "BYMONTHDAY": 0
          };
        }
        this.initialized = options.initialized || false;
        if (!this.initialized) {
          try {
            this.init();
          } catch (e) {
            if (e instanceof InvalidRecurrenceRuleError) {
              // Init may error if there are no possible recurrence instances from
              // the rule, but we don't want to bubble this error up. Instead, we
              // create an empty iterator.
              this.completed = true;
            } else {
              // Propagate other errors to consumers.
              throw e;
            }
          }
        }
      }

      /**
       * Initialize the iterator
       * @private
       */
    }, {
      key: "init",
      value: function init() {
        var _this = this;
        this.initialized = true;
        this.last = this.dtstart.clone();
        var parts = this.by_data;
        if ("BYDAY" in parts) {
          // libical does this earlier when the rule is loaded, but we postpone to
          // now so we can preserve the original order.
          this.sort_byday_rules(parts.BYDAY);
        }

        // The BYYEARDAY may only appear with BYDAY
        if ("BYYEARDAY" in parts) {
          if ("BYMONTH" in parts || "BYWEEKNO" in parts || "BYMONTHDAY" in parts) {
            throw new Error("Invalid BYYEARDAY rule");
          }
        }

        // BYWEEKNO and BYMONTHDAY rule parts may not both appear
        if ("BYWEEKNO" in parts && "BYMONTHDAY" in parts) {
          throw new Error("BYWEEKNO does not fit to BYMONTHDAY");
        }

        // For MONTHLY recurrences (FREQ=MONTHLY) neither BYYEARDAY nor
        // BYWEEKNO may appear.
        if (this.rule.freq == "MONTHLY" && ("BYYEARDAY" in parts || "BYWEEKNO" in parts)) {
          throw new Error("For MONTHLY recurrences neither BYYEARDAY nor BYWEEKNO may appear");
        }

        // For WEEKLY recurrences (FREQ=WEEKLY) neither BYMONTHDAY nor
        // BYYEARDAY may appear.
        if (this.rule.freq == "WEEKLY" && ("BYYEARDAY" in parts || "BYMONTHDAY" in parts)) {
          throw new Error("For WEEKLY recurrences neither BYMONTHDAY nor BYYEARDAY may appear");
        }

        // BYYEARDAY may only appear in YEARLY rules
        if (this.rule.freq != "YEARLY" && "BYYEARDAY" in parts) {
          throw new Error("BYYEARDAY may only appear in YEARLY rules");
        }
        this.last.second = this.setup_defaults("BYSECOND", "SECONDLY", this.dtstart.second);
        this.last.minute = this.setup_defaults("BYMINUTE", "MINUTELY", this.dtstart.minute);
        this.last.hour = this.setup_defaults("BYHOUR", "HOURLY", this.dtstart.hour);
        this.last.day = this.setup_defaults("BYMONTHDAY", "DAILY", this.dtstart.day);
        this.last.month = this.setup_defaults("BYMONTH", "MONTHLY", this.dtstart.month);
        if (this.rule.freq == "WEEKLY") {
          if ("BYDAY" in parts) {
            var _this$ruleDayOfWeek = this.ruleDayOfWeek(parts.BYDAY[0], this.rule.wkst),
              _this$ruleDayOfWeek2 = _slicedToArray(_this$ruleDayOfWeek, 2),
              dow = _this$ruleDayOfWeek2[1];
            var wkdy = dow - this.last.dayOfWeek(this.rule.wkst);
            if (this.last.dayOfWeek(this.rule.wkst) < dow && wkdy >= 0 || wkdy < 0) {
              // Initial time is after first day of BYDAY data
              this.last.day += wkdy;
            }
          } else {
            var dayName = Recur.numericDayToIcalDay(this.dtstart.dayOfWeek());
            parts.BYDAY = [dayName];
          }
        }
        if (this.rule.freq == "YEARLY") {
          // Some yearly recurrence rules may be specific enough to not actually
          // occur on a yearly basis, e.g. the 29th day of February or the fifth
          // Monday of a given month. The standard isn't clear on the intended
          // behavior in these cases, but `libical` at least will iterate until it
          // finds a matching year.
          // CAREFUL: Some rules may specify an occurrence that can never happen,
          // e.g. the first Monday of April so long as it falls on the 15th
          // through the 21st. Detecting these is non-trivial, so ensure that we
          // stop iterating at some point.
          var untilYear = this.rule.until ? this.rule.until.year : 20000;
          while (this.last.year <= untilYear) {
            this.expand_year_days(this.last.year);
            if (this.days.length > 0) {
              break;
            }
            this.increment_year(this.rule.interval);
          }
          if (this.days.length == 0) {
            throw new InvalidRecurrenceRuleError();
          }

          // If there's no occurrence in this year, try the following years. This
          // would only happen looking for day 366 or -366.
          if (!this._nextByYearDay() && !this.next_year() && !this.next_year() && !this.next_year()) {
            // This should not be possible, but just in case it is, stop.
            throw new InvalidRecurrenceRuleError();
          }
        }
        if (this.rule.freq == "MONTHLY") {
          if (this.has_by_data("BYDAY")) {
            var tempLast = null;
            var initLast = this.last.clone();
            var daysInMonth = Time.daysInMonth(this.last.month, this.last.year);

            // Check every weekday in BYDAY with relative dow and pos.
            var _iterator = _createForOfIteratorHelper(this.by_data.BYDAY),
              _step;
            try {
              for (_iterator.s(); !(_step = _iterator.n()).done;) {
                var bydow = _step.value;
                this.last = initLast.clone();
                var _this$ruleDayOfWeek3 = this.ruleDayOfWeek(bydow),
                  _this$ruleDayOfWeek4 = _slicedToArray(_this$ruleDayOfWeek3, 2),
                  pos = _this$ruleDayOfWeek4[0],
                  _dow = _this$ruleDayOfWeek4[1];
                var dayOfMonth = this.last.nthWeekDay(_dow, pos);

                // If |pos| >= 6, the byday is invalid for a monthly rule.
                if (pos >= 6 || pos <= -6) {
                  throw new Error("Malformed values in BYDAY part");
                }

                // If a Byday with pos=+/-5 is not in the current month it
                // must be searched in the next months.
                if (dayOfMonth > daysInMonth || dayOfMonth <= 0) {
                  // Skip if we have already found a "last" in this month.
                  if (tempLast && tempLast.month == initLast.month) {
                    continue;
                  }
                  while (dayOfMonth > daysInMonth || dayOfMonth <= 0) {
                    this.increment_month();
                    daysInMonth = Time.daysInMonth(this.last.month, this.last.year);
                    dayOfMonth = this.last.nthWeekDay(_dow, pos);
                  }
                }
                this.last.day = dayOfMonth;
                if (!tempLast || this.last.compare(tempLast) < 0) {
                  tempLast = this.last.clone();
                }
              }
            } catch (err) {
              _iterator.e(err);
            } finally {
              _iterator.f();
            }
            this.last = tempLast.clone();

            //XXX: This feels like a hack, but we need to initialize
            //     the BYMONTHDAY case correctly and byDayAndMonthDay handles
            //     this case. It accepts a special flag which will avoid incrementing
            //     the initial value without the flag days that match the start time
            //     would be missed.
            if (this.has_by_data('BYMONTHDAY')) {
              this._byDayAndMonthDay(true);
            }
            if (this.last.day > daysInMonth || this.last.day == 0) {
              throw new Error("Malformed values in BYDAY part");
            }
          } else if (this.has_by_data("BYMONTHDAY")) {
            // Change the day value so that normalisation won't change the month.
            this.last.day = 1;

            // Get a sorted list of days in the starting month that match the rule.
            var normalized = this.normalizeByMonthDayRules(this.last.year, this.last.month, this.rule.parts.BYMONTHDAY).filter(function (d) {
              return d >= _this.last.day;
            });
            if (normalized.length) {
              // There's at least one valid day, use it.
              this.last.day = normalized[0];
              this.by_data.BYMONTHDAY = normalized;
            } else {
              // There's no occurrence in this month, find the next valid month.
              // The longest possible sequence of skipped months is February-April-June,
              // so we might need to call next_month up to three times.
              if (!this.next_month() && !this.next_month() && !this.next_month()) {
                throw new InvalidRecurrenceRuleError();
              }
            }
          }
        }
      }

      /**
       * Retrieve the next occurrence from the iterator.
       * @return {Time}
       */
    }, {
      key: "next",
      value: function next() {
        var again = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : false;
        var before = this.last ? this.last.clone() : null;
        if (this.rule.count && this.occurrence_number >= this.rule.count || this.rule.until && this.last.compare(this.rule.until) > 0) {
          this.completed = true;
        }
        if (this.completed) {
          return null;
        }
        if (this.occurrence_number == 0 && this.last.compare(this.dtstart) >= 0) {
          // First of all, give the instance that was initialized
          this.occurrence_number++;
          return this.last;
        }
        var valid;
        var invalid_count = 0;
        do {
          valid = 1;
          switch (this.rule.freq) {
            case "SECONDLY":
              this.next_second();
              break;
            case "MINUTELY":
              this.next_minute();
              break;
            case "HOURLY":
              this.next_hour();
              break;
            case "DAILY":
              this.next_day();
              break;
            case "WEEKLY":
              this.next_week();
              break;
            case "MONTHLY":
              valid = this.next_month();
              if (valid) {
                invalid_count = 0;
              } else if (++invalid_count == 336) {
                // We've been through all 91 month variations and not found a recurrence. Stop.
                // (12 months and 29-day February × 7 starting days.)
                this.completed = true;
                return null;
              }
              break;
            case "YEARLY":
              valid = this.next_year();
              if (valid) {
                invalid_count = 0;
              } else if (++invalid_count == 28) {
                // We've been through all 14 year variations and not found a recurrence. Stop.
                // (365-day and 366-day years × 7 starting days.)
                this.completed = true;
                return null;
              }
              break;
            default:
              return null;
          }
        } while (!this.check_contracting_rules() || this.last.compare(this.dtstart) < 0 || !valid);
        if (this.last.compare(before) == 0) {
          if (again) {
            throw new Error("Same occurrence found twice, protecting you from death by recursion");
          }
          this.next(true);
        }
        if (this.rule.until && this.last.compare(this.rule.until) > 0) {
          this.completed = true;
          return null;
        } else {
          this.occurrence_number++;
          return this.last;
        }
      }
    }, {
      key: "next_second",
      value: function next_second() {
        return this.next_generic("BYSECOND", "SECONDLY", "second", "minute");
      }
    }, {
      key: "increment_second",
      value: function increment_second(inc) {
        return this.increment_generic(inc, "second", 60, "minute");
      }
    }, {
      key: "next_minute",
      value: function next_minute() {
        return this.next_generic("BYMINUTE", "MINUTELY", "minute", "hour", "next_second");
      }
    }, {
      key: "increment_minute",
      value: function increment_minute(inc) {
        return this.increment_generic(inc, "minute", 60, "hour");
      }
    }, {
      key: "next_hour",
      value: function next_hour() {
        return this.next_generic("BYHOUR", "HOURLY", "hour", "monthday", "next_minute");
      }
    }, {
      key: "increment_hour",
      value: function increment_hour(inc) {
        this.increment_generic(inc, "hour", 24, "monthday");
      }
    }, {
      key: "next_day",
      value: function next_day() {
        var this_freq = this.rule.freq == "DAILY";
        if (this.next_hour() == 0) {
          return 0;
        }
        if (this_freq) {
          this.increment_monthday(this.rule.interval);
        } else {
          this.increment_monthday(1);
        }
        return 0;
      }
    }, {
      key: "next_week",
      value: function next_week() {
        var end_of_data = 0;
        if (this.next_weekday_by_week() == 0) {
          return end_of_data;
        }
        if (this.has_by_data("BYWEEKNO")) {
          this.by_indices.BYWEEKNO++;
          if (this.by_indices.BYWEEKNO == this.by_data.BYWEEKNO.length) {
            this.by_indices.BYWEEKNO = 0;
            end_of_data = 1;
          }

          // HACK should be first month of the year
          this.last.month = 1;
          this.last.day = 1;
          var week_no = this.by_data.BYWEEKNO[this.by_indices.BYWEEKNO];
          this.last.day += 7 * week_no;
          if (end_of_data) {
            this.increment_year(1);
          }
        } else {
          // Jump to the next week
          this.increment_monthday(7 * this.rule.interval);
        }
        return end_of_data;
      }

      /**
       * Normalize each by day rule for a given year/month.
       * Takes into account ordering and negative rules
       *
       * @private
       * @param {Number} year         Current year.
       * @param {Number} month        Current month.
       * @param {Array}  rules        Array of rules.
       *
       * @return {Array} sorted and normalized rules.
       *                 Negative rules will be expanded to their
       *                 correct positive values for easier processing.
       */
    }, {
      key: "normalizeByMonthDayRules",
      value: function normalizeByMonthDayRules(year, month, rules) {
        var daysInMonth = Time.daysInMonth(month, year);

        // XXX: This is probably bad for performance to allocate
        //      a new array for each month we scan, if possible
        //      we should try to optimize this...
        var newRules = [];
        var ruleIdx = 0;
        var len = rules.length;
        var rule;
        for (; ruleIdx < len; ruleIdx++) {
          rule = parseInt(rules[ruleIdx], 10);
          if (isNaN(rule)) {
            throw new Error('Invalid BYMONTHDAY value');
          }

          // if this rule falls outside of given
          // month discard it.
          if (Math.abs(rule) > daysInMonth) {
            continue;
          }

          // negative case
          if (rule < 0) {
            // we add (not subtract it is a negative number)
            // one from the rule because 1 === last day of month
            rule = daysInMonth + (rule + 1);
          } else if (rule === 0) {
            // skip zero: it is invalid.
            continue;
          }

          // only add unique items...
          if (newRules.indexOf(rule) === -1) {
            newRules.push(rule);
          }
        }

        // unique and sort
        return newRules.sort(function (a, b) {
          return a - b;
        });
      }

      /**
       * NOTES:
       * We are given a list of dates in the month (BYMONTHDAY) (23, etc..)
       * Also we are given a list of days (BYDAY) (MO, 2SU, etc..) when
       * both conditions match a given date (this.last.day) iteration stops.
       *
       * @private
       * @param {Boolean=} isInit     When given true will not increment the
       *                                current day (this.last).
       */
    }, {
      key: "_byDayAndMonthDay",
      value: function _byDayAndMonthDay(isInit) {
        var byMonthDay; // setup in initMonth
        var byDay = this.by_data.BYDAY;
        var date;
        var dateIdx = 0;
        var dateLen; // setup in initMonth
        var dayLen = byDay.length;

        // we are not valid by default
        var dataIsValid = 0;
        var daysInMonth;
        var self = this;
        // we need a copy of this, because a DateTime gets normalized
        // automatically if the day is out of range. At some points we
        // set the last day to 0 to start counting.
        var lastDay = this.last.day;
        function initMonth() {
          daysInMonth = Time.daysInMonth(self.last.month, self.last.year);
          byMonthDay = self.normalizeByMonthDayRules(self.last.year, self.last.month, self.by_data.BYMONTHDAY);
          dateLen = byMonthDay.length;

          // For the case of more than one occurrence in one month
          // we have to be sure to start searching after the last
          // found date or at the last BYMONTHDAY, unless we are
          // initializing the iterator because in this case we have
          // to consider the last found date too.
          while (byMonthDay[dateIdx] <= lastDay && !(isInit && byMonthDay[dateIdx] == lastDay) && dateIdx < dateLen - 1) {
            dateIdx++;
          }
        }
        function nextMonth() {
          // since the day is incremented at the start
          // of the loop below, we need to start at 0
          lastDay = 0;
          self.increment_month();
          dateIdx = 0;
          initMonth();
        }
        initMonth();

        // should come after initMonth
        if (isInit) {
          lastDay -= 1;
        }

        // Use a counter to avoid an infinite loop with malformed rules.
        // Stop checking after 4 years so we consider also a leap year.
        var monthsCounter = 48;
        while (!dataIsValid && monthsCounter) {
          monthsCounter--;
          // increment the current date. This is really
          // important otherwise we may fall into the infinite
          // loop trap. The initial date takes care of the case
          // where the current date is the date we are looking
          // for.
          date = lastDay + 1;
          if (date > daysInMonth) {
            nextMonth();
            continue;
          }

          // find next date
          var next = byMonthDay[dateIdx++];

          // this logic is dependent on the BYMONTHDAYS
          // being in order (which is done by #normalizeByMonthDayRules)
          if (next >= date) {
            // if the next month day is in the future jump to it.
            lastDay = next;
          } else {
            // in this case the 'next' monthday has past
            // we must move to the month.
            nextMonth();
            continue;
          }

          // Now we can loop through the day rules to see
          // if one matches the current month date.
          for (var dayIdx = 0; dayIdx < dayLen; dayIdx++) {
            var parts = this.ruleDayOfWeek(byDay[dayIdx]);
            var pos = parts[0];
            var dow = parts[1];
            this.last.day = lastDay;
            if (this.last.isNthWeekDay(dow, pos)) {
              // when we find the valid one we can mark
              // the conditions as met and break the loop.
              // (Because we have this condition above
              //  it will also break the parent loop).
              dataIsValid = 1;
              break;
            }
          }

          // It is completely possible that the combination
          // cannot be matched in the current month.
          // When we reach the end of possible combinations
          // in the current month we iterate to the next one.
          // since dateIdx is incremented right after getting
          // "next", we don't need dateLen -1 here.
          if (!dataIsValid && dateIdx === dateLen) {
            nextMonth();
            continue;
          }
        }
        if (monthsCounter <= 0) {
          // Checked 4 years without finding a Byday that matches
          // a Bymonthday. Maybe the rule is not correct.
          throw new Error("Malformed values in BYDAY combined with BYMONTHDAY parts");
        }
        return dataIsValid;
      }
    }, {
      key: "next_month",
      value: function next_month() {
        var data_valid = 1;
        if (this.next_hour() == 0) {
          return data_valid;
        }
        if (this.has_by_data("BYDAY") && this.has_by_data("BYMONTHDAY")) {
          data_valid = this._byDayAndMonthDay();
        } else if (this.has_by_data("BYDAY")) {
          var daysInMonth = Time.daysInMonth(this.last.month, this.last.year);
          var setpos = 0;
          var setpos_total = 0;
          if (this.has_by_data("BYSETPOS")) {
            var last_day = this.last.day;
            for (var _day = 1; _day <= daysInMonth; _day++) {
              this.last.day = _day;
              if (this.is_day_in_byday(this.last)) {
                setpos_total++;
                if (_day <= last_day) {
                  setpos++;
                }
              }
            }
            this.last.day = last_day;
          }
          data_valid = 0;
          var day;
          for (day = this.last.day + 1; day <= daysInMonth; day++) {
            this.last.day = day;
            if (this.is_day_in_byday(this.last)) {
              if (!this.has_by_data("BYSETPOS") || this.check_set_position(++setpos) || this.check_set_position(setpos - setpos_total - 1)) {
                data_valid = 1;
                break;
              }
            }
          }
          if (day > daysInMonth) {
            this.last.day = 1;
            this.increment_month();
            if (this.is_day_in_byday(this.last)) {
              if (!this.has_by_data("BYSETPOS") || this.check_set_position(1)) {
                data_valid = 1;
              }
            } else {
              data_valid = 0;
            }
          }
        } else if (this.has_by_data("BYMONTHDAY")) {
          this.by_indices.BYMONTHDAY++;
          if (this.by_indices.BYMONTHDAY >= this.by_data.BYMONTHDAY.length) {
            this.by_indices.BYMONTHDAY = 0;
            this.increment_month();
            if (this.by_indices.BYMONTHDAY >= this.by_data.BYMONTHDAY.length) {
              return 0;
            }
          }
          var _daysInMonth = Time.daysInMonth(this.last.month, this.last.year);
          var _day2 = this.by_data.BYMONTHDAY[this.by_indices.BYMONTHDAY];
          if (_day2 < 0) {
            _day2 = _daysInMonth + _day2 + 1;
          }
          if (_day2 > _daysInMonth) {
            this.last.day = 1;
            data_valid = this.is_day_in_byday(this.last);
          } else {
            this.last.day = _day2;
          }
        } else {
          this.increment_month();
          var _daysInMonth2 = Time.daysInMonth(this.last.month, this.last.year);
          if (this.by_data.BYMONTHDAY[0] > _daysInMonth2) {
            data_valid = 0;
          } else {
            this.last.day = this.by_data.BYMONTHDAY[0];
          }
        }
        return data_valid;
      }
    }, {
      key: "next_weekday_by_week",
      value: function next_weekday_by_week() {
        var end_of_data = 0;
        if (this.next_hour() == 0) {
          return end_of_data;
        }
        if (!this.has_by_data("BYDAY")) {
          return 1;
        }
        for (;;) {
          var tt = new Time();
          this.by_indices.BYDAY++;
          if (this.by_indices.BYDAY == Object.keys(this.by_data.BYDAY).length) {
            this.by_indices.BYDAY = 0;
            end_of_data = 1;
          }
          var coded_day = this.by_data.BYDAY[this.by_indices.BYDAY];
          var parts = this.ruleDayOfWeek(coded_day);
          var dow = parts[1];
          dow -= this.rule.wkst;
          if (dow < 0) {
            dow += 7;
          }
          tt.year = this.last.year;
          tt.month = this.last.month;
          tt.day = this.last.day;
          var startOfWeek = tt.startDoyWeek(this.rule.wkst);
          if (dow + startOfWeek < 1) {
            // The selected date is in the previous year
            if (!end_of_data) {
              continue;
            }
          }
          var next = Time.fromDayOfYear(startOfWeek + dow, this.last.year);

          /**
           * The normalization horrors below are due to
           * the fact that when the year/month/day changes
           * it can effect the other operations that come after.
           */
          this.last.year = next.year;
          this.last.month = next.month;
          this.last.day = next.day;
          return end_of_data;
        }
      }
    }, {
      key: "next_year",
      value: function next_year() {
        if (this.next_hour() == 0) {
          return 0;
        }
        if (this.days.length == 0 || ++this.days_index == this.days.length) {
          this.days_index = 0;
          this.increment_year(this.rule.interval);
          if (this.has_by_data("BYMONTHDAY")) {
            this.by_data.BYMONTHDAY = this.normalizeByMonthDayRules(this.last.year, this.last.month, this.rule.parts.BYMONTHDAY);
          }
          this.expand_year_days(this.last.year);
          if (this.days.length == 0) {
            return 0;
          }
        }
        return this._nextByYearDay();
      }
    }, {
      key: "_nextByYearDay",
      value: function _nextByYearDay() {
        var doy = this.days[this.days_index];
        var year = this.last.year;
        if (Math.abs(doy) == 366 && !Time.isLeapYear(this.last.year)) {
          return 0;
        }
        if (doy < 1) {
          // Time.fromDayOfYear(doy, year) indexes relative to the
          // start of the given year. That is different from the
          // semantics of BYYEARDAY where negative indexes are an
          // offset from the end of the given year.
          doy += 1;
          year += 1;
        }
        var next = Time.fromDayOfYear(doy, year);
        this.last.day = next.day;
        this.last.month = next.month;
        return 1;
      }

      /**
       * @param dow (eg: '1TU', '-1MO')
       * @param {weekDay=} aWeekStart The week start weekday
       * @return [pos, numericDow] (eg: [1, 3]) numericDow is relative to aWeekStart
       */
    }, {
      key: "ruleDayOfWeek",
      value: function ruleDayOfWeek(dow, aWeekStart) {
        var matches = dow.match(/([+-]?[0-9])?(MO|TU|WE|TH|FR|SA|SU)/);
        if (matches) {
          var pos = parseInt(matches[1] || 0, 10);
          dow = Recur.icalDayToNumericDay(matches[2], aWeekStart);
          return [pos, dow];
        } else {
          return [0, 0];
        }
      }
    }, {
      key: "next_generic",
      value: function next_generic(aRuleType, aInterval, aDateAttr, aFollowingAttr, aPreviousIncr) {
        var has_by_rule = aRuleType in this.by_data;
        var this_freq = this.rule.freq == aInterval;
        var end_of_data = 0;
        if (aPreviousIncr && this[aPreviousIncr]() == 0) {
          return end_of_data;
        }
        if (has_by_rule) {
          this.by_indices[aRuleType]++;
          var dta = this.by_data[aRuleType];
          if (this.by_indices[aRuleType] == dta.length) {
            this.by_indices[aRuleType] = 0;
            end_of_data = 1;
          }
          this.last[aDateAttr] = dta[this.by_indices[aRuleType]];
        } else if (this_freq) {
          this["increment_" + aDateAttr](this.rule.interval);
        }
        if (has_by_rule && end_of_data && this_freq) {
          this["increment_" + aFollowingAttr](1);
        }
        return end_of_data;
      }
    }, {
      key: "increment_monthday",
      value: function increment_monthday(inc) {
        for (var i = 0; i < inc; i++) {
          var daysInMonth = Time.daysInMonth(this.last.month, this.last.year);
          this.last.day++;
          if (this.last.day > daysInMonth) {
            this.last.day -= daysInMonth;
            this.increment_month();
          }
        }
      }
    }, {
      key: "increment_month",
      value: function increment_month() {
        this.last.day = 1;
        if (this.has_by_data("BYMONTH")) {
          this.by_indices.BYMONTH++;
          if (this.by_indices.BYMONTH == this.by_data.BYMONTH.length) {
            this.by_indices.BYMONTH = 0;
            this.increment_year(1);
          }
          this.last.month = this.by_data.BYMONTH[this.by_indices.BYMONTH];
        } else {
          if (this.rule.freq == "MONTHLY") {
            this.last.month += this.rule.interval;
          } else {
            this.last.month++;
          }
          this.last.month--;
          var years = trunc(this.last.month / 12);
          this.last.month %= 12;
          this.last.month++;
          if (years != 0) {
            this.increment_year(years);
          }
        }
        if (this.has_by_data("BYMONTHDAY")) {
          this.by_data.BYMONTHDAY = this.normalizeByMonthDayRules(this.last.year, this.last.month, this.rule.parts.BYMONTHDAY);
        }
      }
    }, {
      key: "increment_year",
      value: function increment_year(inc) {
        // Don't jump into the next month if this.last is Feb 29.
        this.last.day = 1;
        this.last.year += inc;
      }
    }, {
      key: "increment_generic",
      value: function increment_generic(inc, aDateAttr, aFactor, aNextIncrement) {
        this.last[aDateAttr] += inc;
        var nextunit = trunc(this.last[aDateAttr] / aFactor);
        this.last[aDateAttr] %= aFactor;
        if (nextunit != 0) {
          this["increment_" + aNextIncrement](nextunit);
        }
      }
    }, {
      key: "has_by_data",
      value: function has_by_data(aRuleType) {
        return aRuleType in this.rule.parts;
      }
    }, {
      key: "expand_year_days",
      value: function expand_year_days(aYear) {
        var t = new Time();
        this.days = [];

        // We need our own copy with a few keys set
        var parts = {};
        var rules = ["BYDAY", "BYWEEKNO", "BYMONTHDAY", "BYMONTH", "BYYEARDAY"];
        for (var _i = 0, _rules = rules; _i < _rules.length; _i++) {
          var part = _rules[_i];
          if (part in this.rule.parts) {
            parts[part] = this.rule.parts[part];
          }
        }
        if ("BYMONTH" in parts && "BYWEEKNO" in parts) {
          var valid = 1;
          var validWeeks = {};
          t.year = aYear;
          t.isDate = true;
          for (var monthIdx = 0; monthIdx < this.by_data.BYMONTH.length; monthIdx++) {
            var month = this.by_data.BYMONTH[monthIdx];
            t.month = month;
            t.day = 1;
            var first_week = t.weekNumber(this.rule.wkst);
            t.day = Time.daysInMonth(month, aYear);
            var last_week = t.weekNumber(this.rule.wkst);
            for (monthIdx = first_week; monthIdx < last_week; monthIdx++) {
              validWeeks[monthIdx] = 1;
            }
          }
          for (var weekIdx = 0; weekIdx < this.by_data.BYWEEKNO.length && valid; weekIdx++) {
            var weekno = this.by_data.BYWEEKNO[weekIdx];
            if (weekno < 52) {
              valid &= validWeeks[weekIdx];
            } else {
              valid = 0;
            }
          }
          if (valid) {
            delete parts.BYMONTH;
          } else {
            delete parts.BYWEEKNO;
          }
        }
        var partCount = Object.keys(parts).length;
        if (partCount == 0) {
          var t1 = this.dtstart.clone();
          t1.year = this.last.year;
          this.days.push(t1.dayOfYear());
        } else if (partCount == 1 && "BYMONTH" in parts) {
          var _iterator2 = _createForOfIteratorHelper(this.by_data.BYMONTH),
            _step2;
          try {
            for (_iterator2.s(); !(_step2 = _iterator2.n()).done;) {
              var _month = _step2.value;
              var t2 = this.dtstart.clone();
              t2.year = aYear;
              t2.month = _month;
              t2.isDate = true;
              this.days.push(t2.dayOfYear());
            }
          } catch (err) {
            _iterator2.e(err);
          } finally {
            _iterator2.f();
          }
        } else if (partCount == 1 && "BYMONTHDAY" in parts) {
          var _iterator3 = _createForOfIteratorHelper(this.by_data.BYMONTHDAY),
            _step3;
          try {
            for (_iterator3.s(); !(_step3 = _iterator3.n()).done;) {
              var monthday = _step3.value;
              var t3 = this.dtstart.clone();
              if (monthday < 0) {
                var daysInMonth = Time.daysInMonth(t3.month, aYear);
                monthday = monthday + daysInMonth + 1;
              }
              t3.day = monthday;
              t3.year = aYear;
              t3.isDate = true;
              this.days.push(t3.dayOfYear());
            }
          } catch (err) {
            _iterator3.e(err);
          } finally {
            _iterator3.f();
          }
        } else if (partCount == 2 && "BYMONTHDAY" in parts && "BYMONTH" in parts) {
          var _iterator4 = _createForOfIteratorHelper(this.by_data.BYMONTH),
            _step4;
          try {
            for (_iterator4.s(); !(_step4 = _iterator4.n()).done;) {
              var _month2 = _step4.value;
              var _daysInMonth3 = Time.daysInMonth(_month2, aYear);
              var _iterator5 = _createForOfIteratorHelper(this.by_data.BYMONTHDAY),
                _step5;
              try {
                for (_iterator5.s(); !(_step5 = _iterator5.n()).done;) {
                  var _monthday = _step5.value;
                  if (_monthday < 0) {
                    _monthday = _monthday + _daysInMonth3 + 1;
                  }
                  t.day = _monthday;
                  t.month = _month2;
                  t.year = aYear;
                  t.isDate = true;
                  this.days.push(t.dayOfYear());
                }
              } catch (err) {
                _iterator5.e(err);
              } finally {
                _iterator5.f();
              }
            }
          } catch (err) {
            _iterator4.e(err);
          } finally {
            _iterator4.f();
          }
        } else if (partCount == 1 && "BYWEEKNO" in parts) ; else if (partCount == 2 && "BYWEEKNO" in parts && "BYMONTHDAY" in parts) ; else if (partCount == 1 && "BYDAY" in parts) {
          this.days = this.days.concat(this.expand_by_day(aYear));
        } else if (partCount == 2 && "BYDAY" in parts && "BYMONTH" in parts) {
          var _iterator6 = _createForOfIteratorHelper(this.by_data.BYMONTH),
            _step6;
          try {
            for (_iterator6.s(); !(_step6 = _iterator6.n()).done;) {
              var _month3 = _step6.value;
              var _daysInMonth4 = Time.daysInMonth(_month3, aYear);
              t.year = aYear;
              t.month = _month3;
              t.day = 1;
              t.isDate = true;
              var first_dow = t.dayOfWeek();
              var doy_offset = t.dayOfYear() - 1;
              t.day = _daysInMonth4;
              var last_dow = t.dayOfWeek();
              if (this.has_by_data("BYSETPOS")) {
                var by_month_day = [];
                for (var day = 1; day <= _daysInMonth4; day++) {
                  t.day = day;
                  if (this.is_day_in_byday(t)) {
                    by_month_day.push(day);
                  }
                }
                for (var spIndex = 0; spIndex < by_month_day.length; spIndex++) {
                  if (this.check_set_position(spIndex + 1) || this.check_set_position(spIndex - by_month_day.length)) {
                    this.days.push(doy_offset + by_month_day[spIndex]);
                  }
                }
              } else {
                var _iterator7 = _createForOfIteratorHelper(this.by_data.BYDAY),
                  _step7;
                try {
                  for (_iterator7.s(); !(_step7 = _iterator7.n()).done;) {
                    var coded_day = _step7.value;
                    var bydayParts = this.ruleDayOfWeek(coded_day);
                    var pos = bydayParts[0];
                    var dow = bydayParts[1];
                    var month_day = void 0;
                    var first_matching_day = (dow + 7 - first_dow) % 7 + 1;
                    var last_matching_day = _daysInMonth4 - (last_dow + 7 - dow) % 7;
                    if (pos == 0) {
                      for (var _day3 = first_matching_day; _day3 <= _daysInMonth4; _day3 += 7) {
                        this.days.push(doy_offset + _day3);
                      }
                    } else if (pos > 0) {
                      month_day = first_matching_day + (pos - 1) * 7;
                      if (month_day <= _daysInMonth4) {
                        this.days.push(doy_offset + month_day);
                      }
                    } else {
                      month_day = last_matching_day + (pos + 1) * 7;
                      if (month_day > 0) {
                        this.days.push(doy_offset + month_day);
                      }
                    }
                  }
                } catch (err) {
                  _iterator7.e(err);
                } finally {
                  _iterator7.f();
                }
              }
            }
            // Return dates in order of occurrence (1,2,3,...) instead
            // of by groups of weekdays (1,8,15,...,2,9,16,...).
          } catch (err) {
            _iterator6.e(err);
          } finally {
            _iterator6.f();
          }
          this.days.sort(function (a, b) {
            return a - b;
          }); // Comparator function allows to sort numbers.
        } else if (partCount == 2 && "BYDAY" in parts && "BYMONTHDAY" in parts) {
          var expandedDays = this.expand_by_day(aYear);
          var _iterator8 = _createForOfIteratorHelper(expandedDays),
            _step8;
          try {
            for (_iterator8.s(); !(_step8 = _iterator8.n()).done;) {
              var _day4 = _step8.value;
              var tt = Time.fromDayOfYear(_day4, aYear);
              if (this.by_data.BYMONTHDAY.indexOf(tt.day) >= 0) {
                this.days.push(_day4);
              }
            }
          } catch (err) {
            _iterator8.e(err);
          } finally {
            _iterator8.f();
          }
        } else if (partCount == 3 && "BYDAY" in parts && "BYMONTHDAY" in parts && "BYMONTH" in parts) {
          var _expandedDays = this.expand_by_day(aYear);
          var _iterator9 = _createForOfIteratorHelper(_expandedDays),
            _step9;
          try {
            for (_iterator9.s(); !(_step9 = _iterator9.n()).done;) {
              var _day5 = _step9.value;
              var _tt = Time.fromDayOfYear(_day5, aYear);
              if (this.by_data.BYMONTH.indexOf(_tt.month) >= 0 && this.by_data.BYMONTHDAY.indexOf(_tt.day) >= 0) {
                this.days.push(_day5);
              }
            }
          } catch (err) {
            _iterator9.e(err);
          } finally {
            _iterator9.f();
          }
        } else if (partCount == 2 && "BYDAY" in parts && "BYWEEKNO" in parts) {
          var _expandedDays2 = this.expand_by_day(aYear);
          var _iterator0 = _createForOfIteratorHelper(_expandedDays2),
            _step0;
          try {
            for (_iterator0.s(); !(_step0 = _iterator0.n()).done;) {
              var _day6 = _step0.value;
              var _tt2 = Time.fromDayOfYear(_day6, aYear);
              var _weekno = _tt2.weekNumber(this.rule.wkst);
              if (this.by_data.BYWEEKNO.indexOf(_weekno)) {
                this.days.push(_day6);
              }
            }
          } catch (err) {
            _iterator0.e(err);
          } finally {
            _iterator0.f();
          }
        } else if (partCount == 3 && "BYDAY" in parts && "BYWEEKNO" in parts && "BYMONTHDAY" in parts) ; else if (partCount == 1 && "BYYEARDAY" in parts) {
          this.days = this.days.concat(this.by_data.BYYEARDAY);
        } else if (partCount == 2 && "BYYEARDAY" in parts && "BYDAY" in parts) {
          var _daysInYear = Time.isLeapYear(aYear) ? 366 : 365;
          var _expandedDays3 = new Set(this.expand_by_day(aYear));
          var _iterator1 = _createForOfIteratorHelper(this.by_data.BYYEARDAY),
            _step1;
          try {
            for (_iterator1.s(); !(_step1 = _iterator1.n()).done;) {
              var doy = _step1.value;
              if (doy < 0) {
                doy += _daysInYear + 1;
              }
              if (_expandedDays3.has(doy)) {
                this.days.push(doy);
              }
            }
          } catch (err) {
            _iterator1.e(err);
          } finally {
            _iterator1.f();
          }
        } else {
          this.days = [];
        }
        var daysInYear = Time.isLeapYear(aYear) ? 366 : 365;
        this.days.sort(function (a, b) {
          if (a < 0) a += daysInYear + 1;
          if (b < 0) b += daysInYear + 1;
          return a - b;
        });
        return 0;
      }
    }, {
      key: "expand_by_day",
      value: function expand_by_day(aYear) {
        var days_list = [];
        var tmp = this.last.clone();
        tmp.year = aYear;
        tmp.month = 1;
        tmp.day = 1;
        tmp.isDate = true;
        var start_dow = tmp.dayOfWeek();
        tmp.month = 12;
        tmp.day = 31;
        tmp.isDate = true;
        var end_dow = tmp.dayOfWeek();
        var end_year_day = tmp.dayOfYear();
        var _iterator10 = _createForOfIteratorHelper(this.by_data.BYDAY),
          _step10;
        try {
          for (_iterator10.s(); !(_step10 = _iterator10.n()).done;) {
            var day = _step10.value;
            var parts = this.ruleDayOfWeek(day);
            var pos = parts[0];
            var dow = parts[1];
            if (pos == 0) {
              var tmp_start_doy = (dow + 7 - start_dow) % 7 + 1;
              for (var doy = tmp_start_doy; doy <= end_year_day; doy += 7) {
                days_list.push(doy);
              }
            } else if (pos > 0) {
              var first = void 0;
              if (dow >= start_dow) {
                first = dow - start_dow + 1;
              } else {
                first = dow - start_dow + 8;
              }
              days_list.push(first + (pos - 1) * 7);
            } else {
              var last = void 0;
              pos = -pos;
              if (dow <= end_dow) {
                last = end_year_day - end_dow + dow;
              } else {
                last = end_year_day - end_dow + dow - 7;
              }
              days_list.push(last - (pos - 1) * 7);
            }
          }
        } catch (err) {
          _iterator10.e(err);
        } finally {
          _iterator10.f();
        }
        return days_list;
      }
    }, {
      key: "is_day_in_byday",
      value: function is_day_in_byday(tt) {
        if (this.by_data.BYDAY) {
          var _iterator11 = _createForOfIteratorHelper(this.by_data.BYDAY),
            _step11;
          try {
            for (_iterator11.s(); !(_step11 = _iterator11.n()).done;) {
              var day = _step11.value;
              var parts = this.ruleDayOfWeek(day);
              var pos = parts[0];
              var dow = parts[1];
              var this_dow = tt.dayOfWeek();
              if (pos == 0 && dow == this_dow || tt.nthWeekDay(dow, pos) == tt.day) {
                return 1;
              }
            }
          } catch (err) {
            _iterator11.e(err);
          } finally {
            _iterator11.f();
          }
        }
        return 0;
      }

      /**
       * Checks if given value is in BYSETPOS.
       *
       * @private
       * @param {Numeric} aPos position to check for.
       * @return {Boolean} false unless BYSETPOS rules exist
       *                   and the given value is present in rules.
       */
    }, {
      key: "check_set_position",
      value: function check_set_position(aPos) {
        if (this.has_by_data('BYSETPOS')) {
          var idx = this.by_data.BYSETPOS.indexOf(aPos);
          // negative numbers are not false-y
          return idx !== -1;
        }
        return false;
      }
    }, {
      key: "sort_byday_rules",
      value: function sort_byday_rules(aRules) {
        for (var i = 0; i < aRules.length; i++) {
          for (var j = 0; j < i; j++) {
            var one = this.ruleDayOfWeek(aRules[j], this.rule.wkst)[1];
            var two = this.ruleDayOfWeek(aRules[i], this.rule.wkst)[1];
            if (one > two) {
              var tmp = aRules[i];
              aRules[i] = aRules[j];
              aRules[j] = tmp;
            }
          }
        }
      }
    }, {
      key: "check_contract_restriction",
      value: function check_contract_restriction(aRuleType, v) {
        var indexMapValue = RecurIterator._indexMap[aRuleType];
        var ruleMapValue = RecurIterator._expandMap[this.rule.freq][indexMapValue];
        var pass = false;
        if (aRuleType in this.by_data && ruleMapValue == RecurIterator.CONTRACT) {
          var ruleType = this.by_data[aRuleType];
          var _iterator12 = _createForOfIteratorHelper(ruleType),
            _step12;
          try {
            for (_iterator12.s(); !(_step12 = _iterator12.n()).done;) {
              var bydata = _step12.value;
              if (bydata == v) {
                pass = true;
                break;
              }
            }
          } catch (err) {
            _iterator12.e(err);
          } finally {
            _iterator12.f();
          }
        } else {
          // Not a contracting byrule or has no data, test passes
          pass = true;
        }
        return pass;
      }
    }, {
      key: "check_contracting_rules",
      value: function check_contracting_rules() {
        var dow = this.last.dayOfWeek();
        var weekNo = this.last.weekNumber(this.rule.wkst);
        var doy = this.last.dayOfYear();
        return this.check_contract_restriction("BYSECOND", this.last.second) && this.check_contract_restriction("BYMINUTE", this.last.minute) && this.check_contract_restriction("BYHOUR", this.last.hour) && this.check_contract_restriction("BYDAY", Recur.numericDayToIcalDay(dow)) && this.check_contract_restriction("BYWEEKNO", weekNo) && this.check_contract_restriction("BYMONTHDAY", this.last.day) && this.check_contract_restriction("BYMONTH", this.last.month) && this.check_contract_restriction("BYYEARDAY", doy);
      }
    }, {
      key: "setup_defaults",
      value: function setup_defaults(aRuleType, req, deftime) {
        var indexMapValue = RecurIterator._indexMap[aRuleType];
        var ruleMapValue = RecurIterator._expandMap[this.rule.freq][indexMapValue];
        if (ruleMapValue != RecurIterator.CONTRACT) {
          if (!(aRuleType in this.by_data)) {
            this.by_data[aRuleType] = [deftime];
          }
          if (this.rule.freq != req) {
            return this.by_data[aRuleType][0];
          }
        }
        return deftime;
      }

      /**
       * Convert iterator into a serialize-able object.  Will preserve current
       * iteration sequence to ensure the seamless continuation of the recurrence
       * rule.
       * @return {Object}
       */
    }, {
      key: "toJSON",
      value: function toJSON() {
        var result = Object.create(null);
        result.initialized = this.initialized;
        result.rule = this.rule.toJSON();
        result.dtstart = this.dtstart.toJSON();
        result.by_data = this.by_data;
        result.days = this.days;
        result.last = this.last.toJSON();
        result.by_indices = this.by_indices;
        result.occurrence_number = this.occurrence_number;
        return result;
      }
    }]);
  }();
  /**
   * An error indicating that a recurrence rule is invalid and produces no
   * occurrences.
   *
   * @extends {Error}
   * @class
   */
  _defineProperty(RecurIterator, "_indexMap", {
    "BYSECOND": 0,
    "BYMINUTE": 1,
    "BYHOUR": 2,
    "BYDAY": 3,
    "BYMONTHDAY": 4,
    "BYYEARDAY": 5,
    "BYWEEKNO": 6,
    "BYMONTH": 7,
    "BYSETPOS": 8
  });
  _defineProperty(RecurIterator, "_expandMap", {
    "SECONDLY": [1, 1, 1, 1, 1, 1, 1, 1],
    "MINUTELY": [2, 1, 1, 1, 1, 1, 1, 1],
    "HOURLY": [2, 2, 1, 1, 1, 1, 1, 1],
    "DAILY": [2, 2, 2, 1, 1, 1, 1, 1],
    "WEEKLY": [2, 2, 2, 2, 3, 3, 1, 1],
    "MONTHLY": [2, 2, 2, 2, 2, 3, 3, 1],
    "YEARLY": [2, 2, 2, 2, 2, 2, 2, 2]
  });
  _defineProperty(RecurIterator, "UNKNOWN", 0);
  _defineProperty(RecurIterator, "CONTRACT", 1);
  _defineProperty(RecurIterator, "EXPAND", 2);
  _defineProperty(RecurIterator, "ILLEGAL", 3);
  var InvalidRecurrenceRuleError = /*#__PURE__*/function (_Error) {
    function InvalidRecurrenceRuleError() {
      _classCallCheck(this, InvalidRecurrenceRuleError);
      return _callSuper(this, InvalidRecurrenceRuleError, ["Recurrence rule has no valid occurrences"]);
    }
    _inherits(InvalidRecurrenceRuleError, _Error);
    return _createClass(InvalidRecurrenceRuleError);
  }(/*#__PURE__*/_wrapNativeSuper(Error));

  /**
   * This lets typescript resolve our custom types in the
   * generated d.ts files (jsdoc typedefs are converted to typescript types).
   * Ignore prevents the typedefs from being documented more than once.
   *
   * @ignore
   * @typedef {import("./types.js").weekDay} weekDay
   * Imports the 'weekDay' type from the "types.js" module
   * @typedef {import("./types.js").frequencyValues} frequencyValues
   * Imports the 'frequencyValues' type from the "types.js" module
   */

  var VALID_DAY_NAMES = /^(SU|MO|TU|WE|TH|FR|SA)$/;
  var VALID_BYDAY_PART = /^([+-])?(5[0-3]|[1-4][0-9]|[1-9])?(SU|MO|TU|WE|TH|FR|SA)$/;
  var DOW_MAP = {
    SU: Time.SUNDAY,
    MO: Time.MONDAY,
    TU: Time.TUESDAY,
    WE: Time.WEDNESDAY,
    TH: Time.THURSDAY,
    FR: Time.FRIDAY,
    SA: Time.SATURDAY
  };
  var REVERSE_DOW_MAP = Object.fromEntries(Object.entries(DOW_MAP).map(function (entry) {
    return entry.reverse();
  }));
  var ALLOWED_FREQ = ['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

  /**
   * This class represents the "recur" value type, used for example by RRULE. It provides methods to
   * calculate occurrences among others.
   *
   * @memberof ICAL
   */
  var Recur = /*#__PURE__*/function () {
    /**
     * Create a new instance of the Recur class.
     *
     * @param {Object} data                               An object with members of the recurrence
     * @param {frequencyValues=} data.freq                The frequency value
     * @param {Number=} data.interval                     The INTERVAL value
     * @param {weekDay=} data.wkst                        The week start value
     * @param {Time=} data.until                          The end of the recurrence set
     * @param {Number=} data.count                        The number of occurrences
     * @param {Array.<Number>=} data.bysecond             The seconds for the BYSECOND part
     * @param {Array.<Number>=} data.byminute             The minutes for the BYMINUTE part
     * @param {Array.<Number>=} data.byhour               The hours for the BYHOUR part
     * @param {Array.<String>=} data.byday                The BYDAY values
     * @param {Array.<Number>=} data.bymonthday           The days for the BYMONTHDAY part
     * @param {Array.<Number>=} data.byyearday            The days for the BYYEARDAY part
     * @param {Array.<Number>=} data.byweekno             The weeks for the BYWEEKNO part
     * @param {Array.<Number>=} data.bymonth              The month for the BYMONTH part
     * @param {Array.<Number>=} data.bysetpos             The positionals for the BYSETPOS part
     */
    function Recur(data) {
      _classCallCheck(this, Recur);
      /**
       * An object holding the BY-parts of the recurrence rule
       * @memberof ICAL.Recur
       * @typedef {Object} byParts
       * @property {Array.<Number>=} BYSECOND            The seconds for the BYSECOND part
       * @property {Array.<Number>=} BYMINUTE            The minutes for the BYMINUTE part
       * @property {Array.<Number>=} BYHOUR              The hours for the BYHOUR part
       * @property {Array.<String>=} BYDAY               The BYDAY values
       * @property {Array.<Number>=} BYMONTHDAY          The days for the BYMONTHDAY part
       * @property {Array.<Number>=} BYYEARDAY           The days for the BYYEARDAY part
       * @property {Array.<Number>=} BYWEEKNO            The weeks for the BYWEEKNO part
       * @property {Array.<Number>=} BYMONTH             The month for the BYMONTH part
       * @property {Array.<Number>=} BYSETPOS            The positionals for the BYSETPOS part
       */
      /**
       * An object holding the BY-parts of the recurrence rule
       * @type {byParts}
       */
      _defineProperty(this, "parts", null);
      /**
       * The interval value for the recurrence rule.
       * @type {Number}
       */
      _defineProperty(this, "interval", 1);
      /**
       * The week start day
       *
       * @type {weekDay}
       * @default ICAL.Time.MONDAY
       */
      _defineProperty(this, "wkst", Time.MONDAY);
      /**
       * The end of the recurrence
       * @type {?Time}
       */
      _defineProperty(this, "until", null);
      /**
       * The maximum number of occurrences
       * @type {?Number}
       */
      _defineProperty(this, "count", null);
      /**
       * The frequency value.
       * @type {frequencyValues}
       */
      _defineProperty(this, "freq", null);
      /**
       * The class identifier.
       * @constant
       * @type {String}
       * @default "icalrecur"
       */
      _defineProperty(this, "icalclass", "icalrecur");
      /**
       * The type name, to be used in the jCal object.
       * @constant
       * @type {String}
       * @default "recur"
       */
      _defineProperty(this, "icaltype", "recur");
      this.wrappedJSObject = this;
      this.parts = {};
      if (data && _typeof(data) === 'object') {
        this.fromData(data);
      }
    }
    return _createClass(Recur, [{
      key: "iterator",
      value:
      /**
       * Create a new iterator for this recurrence rule. The passed start date
       * must be the start date of the event, not the start of the range to
       * search in.
       *
       * @example
       * let recur = comp.getFirstPropertyValue('rrule');
       * let dtstart = comp.getFirstPropertyValue('dtstart');
       * let iter = recur.iterator(dtstart);
       * for (let next = iter.next(); next; next = iter.next()) {
       *   if (next.compare(rangeStart) < 0) {
       *     continue;
       *   }
       *   console.log(next.toString());
       * }
       *
       * @param {Time} aStart        The item's start date
       * @return {RecurIterator}     The recurrence iterator
       */
      function iterator(aStart) {
        return new RecurIterator({
          rule: this,
          dtstart: aStart
        });
      }

      /**
       * Returns a clone of the recurrence object.
       *
       * @return {Recur}      The cloned object
       */
    }, {
      key: "clone",
      value: function clone() {
        return new Recur(this.toJSON());
      }

      /**
       * Checks if the current rule is finite, i.e. has a count or until part.
       *
       * @return {Boolean}        True, if the rule is finite
       */
    }, {
      key: "isFinite",
      value: function isFinite() {
        return !!(this.count || this.until);
      }

      /**
       * Checks if the current rule has a count part, and not limited by an until
       * part.
       *
       * @return {Boolean}        True, if the rule is by count
       */
    }, {
      key: "isByCount",
      value: function isByCount() {
        return !!(this.count && !this.until);
      }

      /**
       * Adds a component (part) to the recurrence rule. This is not a component
       * in the sense of {@link ICAL.Component}, but a part of the recurrence
       * rule, i.e. BYMONTH.
       *
       * @param {String} aType            The name of the component part
       * @param {Array|String} aValue     The component value
       */
    }, {
      key: "addComponent",
      value: function addComponent(aType, aValue) {
        var ucname = aType.toUpperCase();
        if (ucname in this.parts) {
          this.parts[ucname].push(aValue);
        } else {
          this.parts[ucname] = [aValue];
        }
      }

      /**
       * Sets the component value for the given by-part.
       *
       * @param {String} aType        The component part name
       * @param {Array} aValues       The component values
       */
    }, {
      key: "setComponent",
      value: function setComponent(aType, aValues) {
        this.parts[aType.toUpperCase()] = aValues.slice();
      }

      /**
       * Gets (a copy) of the requested component value.
       *
       * @param {String} aType        The component part name
       * @return {Array}              The component part value
       */
    }, {
      key: "getComponent",
      value: function getComponent(aType) {
        var ucname = aType.toUpperCase();
        return ucname in this.parts ? this.parts[ucname].slice() : [];
      }

      /**
       * Retrieves the next occurrence after the given recurrence id. See the
       * guide on {@tutorial terminology} for more details.
       *
       * NOTE: Currently, this method iterates all occurrences from the start
       * date. It should not be called in a loop for performance reasons. If you
       * would like to get more than one occurrence, you can iterate the
       * occurrences manually, see the example on the
       * {@link ICAL.Recur#iterator iterator} method.
       *
       * @param {Time} aStartTime        The start of the event series
       * @param {Time} aRecurrenceId     The date of the last occurrence
       * @return {Time}                  The next occurrence after
       */
    }, {
      key: "getNextOccurrence",
      value: function getNextOccurrence(aStartTime, aRecurrenceId) {
        var iter = this.iterator(aStartTime);
        var next;
        do {
          next = iter.next();
        } while (next && next.compare(aRecurrenceId) <= 0);
        if (next && aRecurrenceId.zone) {
          next.zone = aRecurrenceId.zone;
        }
        return next;
      }

      /**
       * Sets up the current instance using members from the passed data object.
       *
       * @param {Object} data                               An object with members of the recurrence
       * @param {frequencyValues=} data.freq                The frequency value
       * @param {Number=} data.interval                     The INTERVAL value
       * @param {weekDay=} data.wkst                        The week start value
       * @param {Time=} data.until                          The end of the recurrence set
       * @param {Number=} data.count                        The number of occurrences
       * @param {Array.<Number>=} data.bysecond             The seconds for the BYSECOND part
       * @param {Array.<Number>=} data.byminute             The minutes for the BYMINUTE part
       * @param {Array.<Number>=} data.byhour               The hours for the BYHOUR part
       * @param {Array.<String>=} data.byday                The BYDAY values
       * @param {Array.<Number>=} data.bymonthday           The days for the BYMONTHDAY part
       * @param {Array.<Number>=} data.byyearday            The days for the BYYEARDAY part
       * @param {Array.<Number>=} data.byweekno             The weeks for the BYWEEKNO part
       * @param {Array.<Number>=} data.bymonth              The month for the BYMONTH part
       * @param {Array.<Number>=} data.bysetpos             The positionals for the BYSETPOS part
       */
    }, {
      key: "fromData",
      value: function fromData(data) {
        for (var key in data) {
          var uckey = key.toUpperCase();
          if (uckey in partDesign) {
            if (Array.isArray(data[key])) {
              this.parts[uckey] = data[key];
            } else {
              this.parts[uckey] = [data[key]];
            }
          } else {
            this[key] = data[key];
          }
        }
        if (this.interval && typeof this.interval != "number") {
          optionDesign.INTERVAL(this.interval, this);
        }
        if (this.wkst && typeof this.wkst != "number") {
          this.wkst = Recur.icalDayToNumericDay(this.wkst);
        }
        if (this.until && !(this.until instanceof Time)) {
          this.until = Time.fromString(this.until);
        }
      }

      /**
       * The jCal representation of this recurrence type.
       * @return {Object}
       */
    }, {
      key: "toJSON",
      value: function toJSON() {
        var res = Object.create(null);
        res.freq = this.freq;
        if (this.count) {
          res.count = this.count;
        }
        if (this.interval > 1) {
          res.interval = this.interval;
        }
        for (var _i = 0, _Object$entries = Object.entries(this.parts); _i < _Object$entries.length; _i++) {
          var _Object$entries$_i = _slicedToArray(_Object$entries[_i], 2),
            k = _Object$entries$_i[0],
            kparts = _Object$entries$_i[1];
          if (Array.isArray(kparts) && kparts.length == 1) {
            res[k.toLowerCase()] = kparts[0];
          } else {
            res[k.toLowerCase()] = clone(kparts);
          }
        }
        if (this.until) {
          res.until = this.until.toString();
        }
        if ('wkst' in this && this.wkst !== Time.DEFAULT_WEEK_START) {
          res.wkst = Recur.numericDayToIcalDay(this.wkst);
        }
        return res;
      }

      /**
       * The string representation of this recurrence rule.
       * @return {String}
       */
    }, {
      key: "toString",
      value: function toString() {
        // TODO retain order
        var str = "FREQ=" + this.freq;
        if (this.count) {
          str += ";COUNT=" + this.count;
        }
        if (this.interval > 1) {
          str += ";INTERVAL=" + this.interval;
        }
        for (var _i2 = 0, _Object$entries2 = Object.entries(this.parts); _i2 < _Object$entries2.length; _i2++) {
          var _Object$entries2$_i = _slicedToArray(_Object$entries2[_i2], 2),
            k = _Object$entries2$_i[0],
            v = _Object$entries2$_i[1];
          str += ";" + k + "=" + v;
        }
        if (this.until) {
          str += ';UNTIL=' + this.until.toICALString();
        }
        if ('wkst' in this && this.wkst !== Time.DEFAULT_WEEK_START) {
          str += ';WKST=' + Recur.numericDayToIcalDay(this.wkst);
        }
        return str;
      }
    }], [{
      key: "fromString",
      value:
      /**
       * Creates a new {@link ICAL.Recur} instance from the passed string.
       *
       * @param {String} string         The string to parse
       * @return {Recur}                The created recurrence instance
       */
      function fromString(string) {
        var data = this._stringToData(string, false);
        return new Recur(data);
      }

      /**
       * Creates a new {@link ICAL.Recur} instance using members from the passed
       * data object.
       *
       * @param {Object} aData                              An object with members of the recurrence
       * @param {frequencyValues=} aData.freq               The frequency value
       * @param {Number=} aData.interval                    The INTERVAL value
       * @param {weekDay=} aData.wkst                       The week start value
       * @param {Time=} aData.until                         The end of the recurrence set
       * @param {Number=} aData.count                       The number of occurrences
       * @param {Array.<Number>=} aData.bysecond            The seconds for the BYSECOND part
       * @param {Array.<Number>=} aData.byminute            The minutes for the BYMINUTE part
       * @param {Array.<Number>=} aData.byhour              The hours for the BYHOUR part
       * @param {Array.<String>=} aData.byday               The BYDAY values
       * @param {Array.<Number>=} aData.bymonthday          The days for the BYMONTHDAY part
       * @param {Array.<Number>=} aData.byyearday           The days for the BYYEARDAY part
       * @param {Array.<Number>=} aData.byweekno            The weeks for the BYWEEKNO part
       * @param {Array.<Number>=} aData.bymonth             The month for the BYMONTH part
       * @param {Array.<Number>=} aData.bysetpos            The positionals for the BYSETPOS part
       */
    }, {
      key: "fromData",
      value: function fromData(aData) {
        return new Recur(aData);
      }

      /**
       * Converts a recurrence string to a data object, suitable for the fromData
       * method.
       *
       * @private
       * @param {String} string     The string to parse
       * @param {Boolean} fmtIcal   If true, the string is considered to be an
       *                              iCalendar string
       * @return {Recur}            The recurrence instance
       */
    }, {
      key: "_stringToData",
      value: function _stringToData(string, fmtIcal) {
        var dict = Object.create(null);

        // split is slower in FF but fast enough.
        // v8 however this is faster then manual split?
        var values = string.split(';');
        var len = values.length;
        for (var i = 0; i < len; i++) {
          var parts = values[i].split('=');
          var ucname = parts[0].toUpperCase();
          var lcname = parts[0].toLowerCase();
          var name = fmtIcal ? lcname : ucname;
          var value = parts[1];
          if (ucname in partDesign) {
            var partArr = value.split(',');
            var partSet = new Set();
            var _iterator = _createForOfIteratorHelper(partArr),
              _step;
            try {
              for (_iterator.s(); !(_step = _iterator.n()).done;) {
                var part = _step.value;
                partSet.add(partDesign[ucname](part));
              }
            } catch (err) {
              _iterator.e(err);
            } finally {
              _iterator.f();
            }
            partArr = _toConsumableArray(partSet);
            dict[name] = partArr.length == 1 ? partArr[0] : partArr;
          } else if (ucname in optionDesign) {
            optionDesign[ucname](value, dict, fmtIcal);
          } else {
            // Don't swallow unknown values. Just set them as they are.
            dict[lcname] = value;
          }
        }
        return dict;
      }

      /**
       * Convert an ical representation of a day (SU, MO, etc..)
       * into a numeric value of that day.
       *
       * @param {String} string     The iCalendar day name
       * @param {weekDay=} aWeekStart
       *        The week start weekday, defaults to SUNDAY
       * @return {Number}           Numeric value of given day
       */
    }, {
      key: "icalDayToNumericDay",
      value: function icalDayToNumericDay(string, aWeekStart) {
        //XXX: this is here so we can deal
        //     with possibly invalid string values.
        var firstDow = aWeekStart || Time.SUNDAY;
        return (DOW_MAP[string] - firstDow + 7) % 7 + 1;
      }

      /**
       * Convert a numeric day value into its ical representation (SU, MO, etc..)
       *
       * @param {Number} num        Numeric value of given day
       * @param {weekDay=} aWeekStart
       *        The week start weekday, defaults to SUNDAY
       * @return {String}           The ICAL day value, e.g SU,MO,...
       */
    }, {
      key: "numericDayToIcalDay",
      value: function numericDayToIcalDay(num, aWeekStart) {
        //XXX: this is here so we can deal with possibly invalid number values.
        //     Also, this allows consistent mapping between day numbers and day
        //     names for external users.
        var firstDow = aWeekStart || Time.SUNDAY;
        var dow = num + firstDow - Time.SUNDAY;
        if (dow > 7) {
          dow -= 7;
        }
        return REVERSE_DOW_MAP[dow];
      }
    }]);
  }();
  function parseNumericValue(type, min, max, value) {
    var result = value;
    if (value[0] === '+') {
      result = value.slice(1);
    }
    result = strictParseInt(result);
    if (min !== undefined && value < min) {
      throw new Error(type + ': invalid value "' + value + '" must be > ' + min);
    }
    if (max !== undefined && value > max) {
      throw new Error(type + ': invalid value "' + value + '" must be < ' + min);
    }
    return result;
  }
  var optionDesign = {
    FREQ: function FREQ(value, dict, fmtIcal) {
      // yes this is actually equal or faster then regex.
      // upside here is we can enumerate the valid values.
      if (ALLOWED_FREQ.indexOf(value) !== -1) {
        dict.freq = value;
      } else {
        throw new Error('invalid frequency "' + value + '" expected: "' + ALLOWED_FREQ.join(', ') + '"');
      }
    },
    COUNT: function COUNT(value, dict, fmtIcal) {
      dict.count = strictParseInt(value);
    },
    INTERVAL: function INTERVAL(value, dict, fmtIcal) {
      dict.interval = strictParseInt(value);
      if (dict.interval < 1) {
        // 0 or negative values are not allowed, some engines seem to generate
        // it though. Assume 1 instead.
        dict.interval = 1;
      }
    },
    UNTIL: function UNTIL(value, dict, fmtIcal) {
      if (value.length > 10) {
        dict.until = design.icalendar.value['date-time'].fromICAL(value);
      } else {
        dict.until = design.icalendar.value.date.fromICAL(value);
      }
      if (!fmtIcal) {
        dict.until = Time.fromString(dict.until);
      }
    },
    WKST: function WKST(value, dict, fmtIcal) {
      if (VALID_DAY_NAMES.test(value)) {
        dict.wkst = Recur.icalDayToNumericDay(value);
      } else {
        throw new Error('invalid WKST value "' + value + '"');
      }
    }
  };
  var partDesign = {
    BYSECOND: parseNumericValue.bind(undefined, 'BYSECOND', 0, 60),
    BYMINUTE: parseNumericValue.bind(undefined, 'BYMINUTE', 0, 59),
    BYHOUR: parseNumericValue.bind(undefined, 'BYHOUR', 0, 23),
    BYDAY: function BYDAY(value) {
      if (VALID_BYDAY_PART.test(value)) {
        return value;
      } else {
        throw new Error('invalid BYDAY value "' + value + '"');
      }
    },
    BYMONTHDAY: parseNumericValue.bind(undefined, 'BYMONTHDAY', -31, 31),
    BYYEARDAY: parseNumericValue.bind(undefined, 'BYYEARDAY', -366, 366),
    BYWEEKNO: parseNumericValue.bind(undefined, 'BYWEEKNO', -53, 53),
    BYMONTH: parseNumericValue.bind(undefined, 'BYMONTH', 1, 12),
    BYSETPOS: parseNumericValue.bind(undefined, 'BYSETPOS', -366, 366)
  };

  /**
   * This lets typescript resolve our custom types in the
   * generated d.ts files (jsdoc typedefs are converted to typescript types).
   * Ignore prevents the typedefs from being documented more than once.
   * @ignore
   * @typedef {import("./types.js").designSet} designSet
   * Imports the 'designSet' type from the "types.js" module
   */

  /** @module ICAL.design */

  var FROM_ICAL_NEWLINE = /\\\\|\\;|\\,|\\[Nn]/g;
  var TO_ICAL_NEWLINE = /\\|;|,|\n/g;
  var FROM_VCARD_NEWLINE = /\\\\|\\,|\\[Nn]/g;
  var TO_VCARD_NEWLINE = /\\|,|\n/g;
  function createTextType(fromNewline, toNewline) {
    var result = {
      matches: /.*/,
      fromICAL: function fromICAL(aValue, structuredEscape) {
        return replaceNewline(aValue, fromNewline, structuredEscape);
      },
      toICAL: function toICAL(aValue, structuredEscape) {
        var regEx = toNewline;
        if (structuredEscape) regEx = new RegExp(regEx.source + '|' + structuredEscape, regEx.flags);
        return aValue.replace(regEx, function (str) {
          switch (str) {
            case "\\":
              return "\\\\";
            case ";":
              return "\\;";
            case ",":
              return "\\,";
            case "\n":
              return "\\n";
            /* c8 ignore next 2 */
            default:
              return str;
          }
        });
      }
    };
    return result;
  }

  // default types used multiple times
  var DEFAULT_TYPE_TEXT = {
    defaultType: "text"
  };
  var DEFAULT_TYPE_TEXT_MULTI = {
    defaultType: "text",
    multiValue: ","
  };
  var DEFAULT_TYPE_TEXT_STRUCTURED = {
    defaultType: "text",
    structuredValue: ";"
  };
  var DEFAULT_TYPE_INTEGER = {
    defaultType: "integer"
  };
  var DEFAULT_TYPE_DATETIME_DATE = {
    defaultType: "date-time",
    allowedTypes: ["date-time", "date"]
  };
  var DEFAULT_TYPE_DATETIME = {
    defaultType: "date-time"
  };
  var DEFAULT_TYPE_URI = {
    defaultType: "uri"
  };
  var DEFAULT_TYPE_UTCOFFSET = {
    defaultType: "utc-offset"
  };
  var DEFAULT_TYPE_RECUR = {
    defaultType: "recur"
  };
  var DEFAULT_TYPE_DATE_ANDOR_TIME = {
    defaultType: "date-and-or-time",
    allowedTypes: ["date-time", "date", "text"]
  };
  function replaceNewlineReplace(string) {
    switch (string) {
      case "\\\\":
        return "\\";
      case "\\;":
        return ";";
      case "\\,":
        return ",";
      case "\\n":
      case "\\N":
        return "\n";
      /* c8 ignore next 2 */
      default:
        return string;
    }
  }
  function replaceNewline(value, newline, structuredEscape) {
    // avoid regex when possible.
    if (value.indexOf('\\') === -1) {
      return value;
    }
    if (structuredEscape) newline = new RegExp(newline.source + '|\\\\' + structuredEscape, newline.flags);
    return value.replace(newline, replaceNewlineReplace);
  }
  var commonProperties = {
    "categories": DEFAULT_TYPE_TEXT_MULTI,
    "url": DEFAULT_TYPE_URI,
    "version": DEFAULT_TYPE_TEXT,
    "uid": DEFAULT_TYPE_TEXT
  };
  var commonValues = {
    "boolean": {
      values: ["TRUE", "FALSE"],
      fromICAL: function fromICAL(aValue) {
        switch (aValue) {
          case 'TRUE':
            return true;
          case 'FALSE':
            return false;
          default:
            //TODO: parser warning
            return false;
        }
      },
      toICAL: function toICAL(aValue) {
        if (aValue) {
          return 'TRUE';
        }
        return 'FALSE';
      }
    },
    "float": {
      matches: /^[+-]?\d+\.\d+$/,
      fromICAL: function fromICAL(aValue) {
        var parsed = parseFloat(aValue);
        if (isStrictlyNaN(parsed)) {
          // TODO: parser warning
          return 0.0;
        }
        return parsed;
      },
      toICAL: function toICAL(aValue) {
        return String(aValue);
      }
    },
    integer: {
      fromICAL: function fromICAL(aValue) {
        var parsed = parseInt(aValue);
        if (isStrictlyNaN(parsed)) {
          return 0;
        }
        return parsed;
      },
      toICAL: function toICAL(aValue) {
        return String(aValue);
      }
    },
    "utc-offset": {
      toICAL: function toICAL(aValue) {
        if (aValue.length < 7) {
          // no seconds
          // -0500
          return aValue.slice(0, 3) + aValue.slice(4, 6);
        } else {
          // seconds
          // -050000
          return aValue.slice(0, 3) + aValue.slice(4, 6) + aValue.slice(7, 9);
        }
      },
      fromICAL: function fromICAL(aValue) {
        if (aValue.length < 6) {
          // no seconds
          // -05:00
          return aValue.slice(0, 3) + ':' + aValue.slice(3, 5);
        } else {
          // seconds
          // -05:00:00
          return aValue.slice(0, 3) + ':' + aValue.slice(3, 5) + ':' + aValue.slice(5, 7);
        }
      },
      decorate: function decorate(aValue) {
        return UtcOffset.fromString(aValue);
      },
      undecorate: function undecorate(aValue) {
        return aValue.toString();
      }
    }
  };
  var icalParams = {
    // Although the syntax is DQUOTE uri DQUOTE, I don't think we should
    // enforce anything aside from it being a valid content line.
    //
    // At least some params require - if multi values are used - DQUOTEs
    // for each of its values - e.g. delegated-from="uri1","uri2"
    // To indicate this, I introduced the new k/v pair
    // multiValueSeparateDQuote: true
    //
    // "ALTREP": { ... },

    // CN just wants a param-value
    // "CN": { ... }

    "cutype": {
      values: ["INDIVIDUAL", "GROUP", "RESOURCE", "ROOM", "UNKNOWN"],
      allowXName: true,
      allowIanaToken: true
    },
    "delegated-from": {
      valueType: "cal-address",
      multiValue: ",",
      multiValueSeparateDQuote: true
    },
    "delegated-to": {
      valueType: "cal-address",
      multiValue: ",",
      multiValueSeparateDQuote: true
    },
    // "DIR": { ... }, // See ALTREP
    "encoding": {
      values: ["8BIT", "BASE64"]
    },
    // "FMTTYPE": { ... }, // See ALTREP
    "fbtype": {
      values: ["FREE", "BUSY", "BUSY-UNAVAILABLE", "BUSY-TENTATIVE"],
      allowXName: true,
      allowIanaToken: true
    },
    // "LANGUAGE": { ... }, // See ALTREP
    "member": {
      valueType: "cal-address",
      multiValue: ",",
      multiValueSeparateDQuote: true
    },
    "partstat": {
      // TODO These values are actually different per-component
      values: ["NEEDS-ACTION", "ACCEPTED", "DECLINED", "TENTATIVE", "DELEGATED", "COMPLETED", "IN-PROCESS"],
      allowXName: true,
      allowIanaToken: true
    },
    "range": {
      values: ["THISANDFUTURE"]
    },
    "related": {
      values: ["START", "END"]
    },
    "reltype": {
      values: ["PARENT", "CHILD", "SIBLING"],
      allowXName: true,
      allowIanaToken: true
    },
    "role": {
      values: ["REQ-PARTICIPANT", "CHAIR", "OPT-PARTICIPANT", "NON-PARTICIPANT"],
      allowXName: true,
      allowIanaToken: true
    },
    "rsvp": {
      values: ["TRUE", "FALSE"]
    },
    "sent-by": {
      valueType: "cal-address"
    },
    "tzid": {
      matches: /^\//
    },
    "value": {
      // since the value here is a 'type' lowercase is used.
      values: ["binary", "boolean", "cal-address", "date", "date-time", "duration", "float", "integer", "period", "recur", "text", "time", "uri", "utc-offset"],
      allowXName: true,
      allowIanaToken: true
    }
  };

  // When adding a value here, be sure to add it to the parameter types!
  var icalValues = extend(commonValues, {
    text: createTextType(FROM_ICAL_NEWLINE, TO_ICAL_NEWLINE),
    uri: {
      // TODO
      /* ... */
    },
    "binary": {
      decorate: function decorate(aString) {
        return Binary.fromString(aString);
      },
      undecorate: function undecorate(aBinary) {
        return aBinary.toString();
      }
    },
    "cal-address": {
      // needs to be an uri
    },
    "date": {
      decorate: function decorate(aValue, aProp) {
        if (design.strict) {
          return Time.fromDateString(aValue, aProp);
        } else {
          return Time.fromString(aValue, aProp);
        }
      },
      /**
       * undecorates a time object.
       */
      undecorate: function undecorate(aValue) {
        return aValue.toString();
      },
      fromICAL: function fromICAL(aValue) {
        // from: 20120901
        // to: 2012-09-01
        if (!design.strict && aValue.length >= 15) {
          // This is probably a date-time, e.g. 20120901T130000Z
          return icalValues["date-time"].fromICAL(aValue);
        } else {
          return aValue.slice(0, 4) + '-' + aValue.slice(4, 6) + '-' + aValue.slice(6, 8);
        }
      },
      toICAL: function toICAL(aValue) {
        // from: 2012-09-01
        // to: 20120901
        var len = aValue.length;
        if (len == 10) {
          return aValue.slice(0, 4) + aValue.slice(5, 7) + aValue.slice(8, 10);
        } else if (len >= 19) {
          return icalValues["date-time"].toICAL(aValue);
        } else {
          //TODO: serialize warning?
          return aValue;
        }
      }
    },
    "date-time": {
      fromICAL: function fromICAL(aValue) {
        // from: 20120901T130000
        // to: 2012-09-01T13:00:00
        if (!design.strict && aValue.length == 8) {
          // This is probably a date, e.g. 20120901
          return icalValues.date.fromICAL(aValue);
        } else {
          var result = aValue.slice(0, 4) + '-' + aValue.slice(4, 6) + '-' + aValue.slice(6, 8) + 'T' + aValue.slice(9, 11) + ':' + aValue.slice(11, 13) + ':' + aValue.slice(13, 15);
          if (aValue[15] && aValue[15] === 'Z') {
            result += 'Z';
          }
          return result;
        }
      },
      toICAL: function toICAL(aValue) {
        // from: 2012-09-01T13:00:00
        // to: 20120901T130000
        var len = aValue.length;
        if (len == 10 && !design.strict) {
          return icalValues.date.toICAL(aValue);
        } else if (len >= 19) {
          var result = aValue.slice(0, 4) + aValue.slice(5, 7) +
          // grab the (DDTHH) segment
          aValue.slice(8, 13) +
          // MM
          aValue.slice(14, 16) +
          // SS
          aValue.slice(17, 19);
          if (aValue[19] && aValue[19] === 'Z') {
            result += 'Z';
          }
          return result;
        } else {
          // TODO: error
          return aValue;
        }
      },
      decorate: function decorate(aValue, aProp) {
        if (design.strict) {
          return Time.fromDateTimeString(aValue, aProp);
        } else {
          return Time.fromString(aValue, aProp);
        }
      },
      undecorate: function undecorate(aValue) {
        return aValue.toString();
      }
    },
    duration: {
      decorate: function decorate(aValue) {
        return Duration.fromString(aValue);
      },
      undecorate: function undecorate(aValue) {
        return aValue.toString();
      }
    },
    period: {
      fromICAL: function fromICAL(string) {
        var parts = string.split('/');
        parts[0] = icalValues['date-time'].fromICAL(parts[0]);
        if (!Duration.isValueString(parts[1])) {
          parts[1] = icalValues['date-time'].fromICAL(parts[1]);
        }
        return parts;
      },
      toICAL: function toICAL(parts) {
        parts = parts.slice();
        if (!design.strict && parts[0].length == 10) {
          parts[0] = icalValues.date.toICAL(parts[0]);
        } else {
          parts[0] = icalValues['date-time'].toICAL(parts[0]);
        }
        if (!Duration.isValueString(parts[1])) {
          if (!design.strict && parts[1].length == 10) {
            parts[1] = icalValues.date.toICAL(parts[1]);
          } else {
            parts[1] = icalValues['date-time'].toICAL(parts[1]);
          }
        }
        return parts.join("/");
      },
      decorate: function decorate(aValue, aProp) {
        return Period.fromJSON(aValue, aProp, !design.strict);
      },
      undecorate: function undecorate(aValue) {
        return aValue.toJSON();
      }
    },
    recur: {
      fromICAL: function fromICAL(string) {
        return Recur._stringToData(string, true);
      },
      toICAL: function toICAL(data) {
        var str = "";
        for (var _i = 0, _Object$entries = Object.entries(data); _i < _Object$entries.length; _i++) {
          var _Object$entries$_i = _slicedToArray(_Object$entries[_i], 2),
            k = _Object$entries$_i[0],
            val = _Object$entries$_i[1];
          if (k == "until") {
            if (val.length > 10) {
              val = icalValues['date-time'].toICAL(val);
            } else {
              val = icalValues.date.toICAL(val);
            }
          } else if (k == "wkst") {
            if (typeof val === 'number') {
              val = Recur.numericDayToIcalDay(val);
            }
          } else if (Array.isArray(val)) {
            val = val.join(",");
          }
          str += k.toUpperCase() + "=" + val + ";";
        }
        return str.slice(0, Math.max(0, str.length - 1));
      },
      decorate: function decorate(aValue) {
        return Recur.fromData(aValue);
      },
      undecorate: function undecorate(aRecur) {
        return aRecur.toJSON();
      }
    },
    time: {
      fromICAL: function fromICAL(aValue) {
        // from: MMHHSS(Z)?
        // to: HH:MM:SS(Z)?
        if (aValue.length < 6) {
          // TODO: parser exception?
          return aValue;
        }

        // HH::MM::SSZ?
        var result = aValue.slice(0, 2) + ':' + aValue.slice(2, 4) + ':' + aValue.slice(4, 6);
        if (aValue[6] === 'Z') {
          result += 'Z';
        }
        return result;
      },
      toICAL: function toICAL(aValue) {
        // from: HH:MM:SS(Z)?
        // to: MMHHSS(Z)?
        if (aValue.length < 8) {
          //TODO: error
          return aValue;
        }
        var result = aValue.slice(0, 2) + aValue.slice(3, 5) + aValue.slice(6, 8);
        if (aValue[8] === 'Z') {
          result += 'Z';
        }
        return result;
      }
    }
  });
  var icalProperties = extend(commonProperties, {
    "action": DEFAULT_TYPE_TEXT,
    "attach": {
      defaultType: "uri"
    },
    "attendee": {
      defaultType: "cal-address"
    },
    "calscale": DEFAULT_TYPE_TEXT,
    "class": DEFAULT_TYPE_TEXT,
    "comment": DEFAULT_TYPE_TEXT,
    "completed": DEFAULT_TYPE_DATETIME,
    "contact": DEFAULT_TYPE_TEXT,
    "created": DEFAULT_TYPE_DATETIME,
    "description": DEFAULT_TYPE_TEXT,
    "dtend": DEFAULT_TYPE_DATETIME_DATE,
    "dtstamp": DEFAULT_TYPE_DATETIME,
    "dtstart": DEFAULT_TYPE_DATETIME_DATE,
    "due": DEFAULT_TYPE_DATETIME_DATE,
    "duration": {
      defaultType: "duration"
    },
    "exdate": {
      defaultType: "date-time",
      allowedTypes: ["date-time", "date"],
      multiValue: ','
    },
    "exrule": DEFAULT_TYPE_RECUR,
    "freebusy": {
      defaultType: "period",
      multiValue: ","
    },
    "geo": {
      defaultType: "float",
      structuredValue: ";"
    },
    "last-modified": DEFAULT_TYPE_DATETIME,
    "location": DEFAULT_TYPE_TEXT,
    "method": DEFAULT_TYPE_TEXT,
    "organizer": {
      defaultType: "cal-address"
    },
    "percent-complete": DEFAULT_TYPE_INTEGER,
    "priority": DEFAULT_TYPE_INTEGER,
    "prodid": DEFAULT_TYPE_TEXT,
    "related-to": DEFAULT_TYPE_TEXT,
    "repeat": DEFAULT_TYPE_INTEGER,
    "rdate": {
      defaultType: "date-time",
      allowedTypes: ["date-time", "date", "period"],
      multiValue: ',',
      detectType: function detectType(string) {
        if (string.indexOf('/') !== -1) {
          return 'period';
        }
        return string.indexOf('T') === -1 ? 'date' : 'date-time';
      }
    },
    "recurrence-id": DEFAULT_TYPE_DATETIME_DATE,
    "resources": DEFAULT_TYPE_TEXT_MULTI,
    "request-status": DEFAULT_TYPE_TEXT_STRUCTURED,
    "rrule": DEFAULT_TYPE_RECUR,
    "sequence": DEFAULT_TYPE_INTEGER,
    "status": DEFAULT_TYPE_TEXT,
    "summary": DEFAULT_TYPE_TEXT,
    "transp": DEFAULT_TYPE_TEXT,
    "trigger": {
      defaultType: "duration",
      allowedTypes: ["duration", "date-time"]
    },
    "tzoffsetfrom": DEFAULT_TYPE_UTCOFFSET,
    "tzoffsetto": DEFAULT_TYPE_UTCOFFSET,
    "tzurl": DEFAULT_TYPE_URI,
    "tzid": DEFAULT_TYPE_TEXT,
    "tzname": DEFAULT_TYPE_TEXT
  });

  // When adding a value here, be sure to add it to the parameter types!
  var vcardValues = extend(commonValues, {
    text: createTextType(FROM_VCARD_NEWLINE, TO_VCARD_NEWLINE),
    uri: createTextType(FROM_VCARD_NEWLINE, TO_VCARD_NEWLINE),
    date: {
      decorate: function decorate(aValue) {
        return VCardTime.fromDateAndOrTimeString(aValue, "date");
      },
      undecorate: function undecorate(aValue) {
        return aValue.toString();
      },
      fromICAL: function fromICAL(aValue) {
        if (aValue.length == 8) {
          return icalValues.date.fromICAL(aValue);
        } else if (aValue[0] == '-' && aValue.length == 6) {
          return aValue.slice(0, 4) + '-' + aValue.slice(4);
        } else {
          return aValue;
        }
      },
      toICAL: function toICAL(aValue) {
        if (aValue.length == 10) {
          return icalValues.date.toICAL(aValue);
        } else if (aValue[0] == '-' && aValue.length == 7) {
          return aValue.slice(0, 4) + aValue.slice(5);
        } else {
          return aValue;
        }
      }
    },
    time: {
      decorate: function decorate(aValue) {
        return VCardTime.fromDateAndOrTimeString("T" + aValue, "time");
      },
      undecorate: function undecorate(aValue) {
        return aValue.toString();
      },
      fromICAL: function fromICAL(aValue) {
        var splitzone = vcardValues.time._splitZone(aValue, true);
        var zone = splitzone[0],
          value = splitzone[1];

        //console.log("SPLIT: ",splitzone);

        if (value.length == 6) {
          value = value.slice(0, 2) + ':' + value.slice(2, 4) + ':' + value.slice(4, 6);
        } else if (value.length == 4 && value[0] != '-') {
          value = value.slice(0, 2) + ':' + value.slice(2, 4);
        } else if (value.length == 5) {
          value = value.slice(0, 3) + ':' + value.slice(3, 5);
        }
        if (zone.length == 5 && (zone[0] == '-' || zone[0] == '+')) {
          zone = zone.slice(0, 3) + ':' + zone.slice(3);
        }
        return value + zone;
      },
      toICAL: function toICAL(aValue) {
        var splitzone = vcardValues.time._splitZone(aValue);
        var zone = splitzone[0],
          value = splitzone[1];
        if (value.length == 8) {
          value = value.slice(0, 2) + value.slice(3, 5) + value.slice(6, 8);
        } else if (value.length == 5 && value[0] != '-') {
          value = value.slice(0, 2) + value.slice(3, 5);
        } else if (value.length == 6) {
          value = value.slice(0, 3) + value.slice(4, 6);
        }
        if (zone.length == 6 && (zone[0] == '-' || zone[0] == '+')) {
          zone = zone.slice(0, 3) + zone.slice(4);
        }
        return value + zone;
      },
      _splitZone: function _splitZone(aValue, isFromIcal) {
        var lastChar = aValue.length - 1;
        var signChar = aValue.length - (isFromIcal ? 5 : 6);
        var sign = aValue[signChar];
        var zone, value;
        if (aValue[lastChar] == 'Z') {
          zone = aValue[lastChar];
          value = aValue.slice(0, Math.max(0, lastChar));
        } else if (aValue.length > 6 && (sign == '-' || sign == '+')) {
          zone = aValue.slice(signChar);
          value = aValue.slice(0, Math.max(0, signChar));
        } else {
          zone = "";
          value = aValue;
        }
        return [zone, value];
      }
    },
    "date-time": {
      decorate: function decorate(aValue) {
        return VCardTime.fromDateAndOrTimeString(aValue, "date-time");
      },
      undecorate: function undecorate(aValue) {
        return aValue.toString();
      },
      fromICAL: function fromICAL(aValue) {
        return vcardValues['date-and-or-time'].fromICAL(aValue);
      },
      toICAL: function toICAL(aValue) {
        return vcardValues['date-and-or-time'].toICAL(aValue);
      }
    },
    "date-and-or-time": {
      decorate: function decorate(aValue) {
        return VCardTime.fromDateAndOrTimeString(aValue, "date-and-or-time");
      },
      undecorate: function undecorate(aValue) {
        return aValue.toString();
      },
      fromICAL: function fromICAL(aValue) {
        var parts = aValue.split('T');
        return (parts[0] ? vcardValues.date.fromICAL(parts[0]) : '') + (parts[1] ? 'T' + vcardValues.time.fromICAL(parts[1]) : '');
      },
      toICAL: function toICAL(aValue) {
        var parts = aValue.split('T');
        return vcardValues.date.toICAL(parts[0]) + (parts[1] ? 'T' + vcardValues.time.toICAL(parts[1]) : '');
      }
    },
    timestamp: icalValues['date-time'],
    "language-tag": {
      matches: /^[a-zA-Z0-9-]+$/ // Could go with a more strict regex here
    },
    "phone-number": {
      fromICAL: function fromICAL(aValue) {
        return Array.from(aValue).filter(function (c) {
          return c === '\\' ? undefined : c;
        }).join('');
      },
      toICAL: function toICAL(aValue) {
        return Array.from(aValue).map(function (c) {
          return c === ',' || c === ";" ? '\\' + c : c;
        }).join('');
      }
    }
  });
  var vcardParams = {
    "type": {
      valueType: "text",
      multiValue: ","
    },
    "value": {
      // since the value here is a 'type' lowercase is used.
      values: ["text", "uri", "date", "time", "date-time", "date-and-or-time", "timestamp", "boolean", "integer", "float", "utc-offset", "language-tag"],
      allowXName: true,
      allowIanaToken: true
    }
  };
  var vcardProperties = extend(commonProperties, {
    "adr": {
      defaultType: "text",
      structuredValue: ";",
      multiValue: ","
    },
    "anniversary": DEFAULT_TYPE_DATE_ANDOR_TIME,
    "bday": DEFAULT_TYPE_DATE_ANDOR_TIME,
    "caladruri": DEFAULT_TYPE_URI,
    "caluri": DEFAULT_TYPE_URI,
    "clientpidmap": DEFAULT_TYPE_TEXT_STRUCTURED,
    "email": DEFAULT_TYPE_TEXT,
    "fburl": DEFAULT_TYPE_URI,
    "fn": DEFAULT_TYPE_TEXT,
    "gender": DEFAULT_TYPE_TEXT_STRUCTURED,
    "geo": DEFAULT_TYPE_URI,
    "impp": DEFAULT_TYPE_URI,
    "key": DEFAULT_TYPE_URI,
    "kind": DEFAULT_TYPE_TEXT,
    "lang": {
      defaultType: "language-tag"
    },
    "logo": DEFAULT_TYPE_URI,
    "member": DEFAULT_TYPE_URI,
    "n": {
      defaultType: "text",
      structuredValue: ";",
      multiValue: ","
    },
    "nickname": DEFAULT_TYPE_TEXT_MULTI,
    "note": DEFAULT_TYPE_TEXT,
    "org": {
      defaultType: "text",
      structuredValue: ";"
    },
    "photo": DEFAULT_TYPE_URI,
    "related": DEFAULT_TYPE_URI,
    "rev": {
      defaultType: "timestamp"
    },
    "role": DEFAULT_TYPE_TEXT,
    "sound": DEFAULT_TYPE_URI,
    "source": DEFAULT_TYPE_URI,
    "tel": {
      defaultType: "uri",
      allowedTypes: ["uri", "text"]
    },
    "title": DEFAULT_TYPE_TEXT,
    "tz": {
      defaultType: "text",
      allowedTypes: ["text", "utc-offset", "uri"]
    },
    "xml": DEFAULT_TYPE_TEXT
  });
  var vcard3Values = extend(commonValues, {
    binary: icalValues.binary,
    date: vcardValues.date,
    "date-time": vcardValues["date-time"],
    "phone-number": vcardValues["phone-number"],
    uri: icalValues.uri,
    text: vcardValues.text,
    time: icalValues.time,
    vcard: icalValues.text,
    "utc-offset": {
      toICAL: function toICAL(aValue) {
        return aValue.slice(0, 7);
      },
      fromICAL: function fromICAL(aValue) {
        return aValue.slice(0, 7);
      },
      decorate: function decorate(aValue) {
        return UtcOffset.fromString(aValue);
      },
      undecorate: function undecorate(aValue) {
        return aValue.toString();
      }
    }
  });
  var vcard3Params = {
    "type": {
      valueType: "text",
      multiValue: ","
    },
    "value": {
      // since the value here is a 'type' lowercase is used.
      values: ["text", "uri", "date", "date-time", "phone-number", "time", "boolean", "integer", "float", "utc-offset", "vcard", "binary"],
      allowXName: true,
      allowIanaToken: true
    }
  };
  var vcard3Properties = extend(commonProperties, {
    fn: DEFAULT_TYPE_TEXT,
    n: {
      defaultType: "text",
      structuredValue: ";",
      multiValue: ","
    },
    nickname: DEFAULT_TYPE_TEXT_MULTI,
    photo: {
      defaultType: "binary",
      allowedTypes: ["binary", "uri"]
    },
    bday: {
      defaultType: "date-time",
      allowedTypes: ["date-time", "date"],
      detectType: function detectType(string) {
        return string.indexOf('T') === -1 ? 'date' : 'date-time';
      }
    },
    adr: {
      defaultType: "text",
      structuredValue: ";",
      multiValue: ","
    },
    label: DEFAULT_TYPE_TEXT,
    tel: {
      defaultType: "phone-number"
    },
    email: DEFAULT_TYPE_TEXT,
    mailer: DEFAULT_TYPE_TEXT,
    tz: {
      defaultType: "utc-offset",
      allowedTypes: ["utc-offset", "text"]
    },
    geo: {
      defaultType: "float",
      structuredValue: ";"
    },
    title: DEFAULT_TYPE_TEXT,
    role: DEFAULT_TYPE_TEXT,
    logo: {
      defaultType: "binary",
      allowedTypes: ["binary", "uri"]
    },
    agent: {
      defaultType: "vcard",
      allowedTypes: ["vcard", "text", "uri"]
    },
    org: DEFAULT_TYPE_TEXT_STRUCTURED,
    note: DEFAULT_TYPE_TEXT_MULTI,
    prodid: DEFAULT_TYPE_TEXT,
    rev: {
      defaultType: "date-time",
      allowedTypes: ["date-time", "date"],
      detectType: function detectType(string) {
        return string.indexOf('T') === -1 ? 'date' : 'date-time';
      }
    },
    "sort-string": DEFAULT_TYPE_TEXT,
    sound: {
      defaultType: "binary",
      allowedTypes: ["binary", "uri"]
    },
    "class": DEFAULT_TYPE_TEXT,
    key: {
      defaultType: "binary",
      allowedTypes: ["binary", "text"]
    }
  });

  /**
   * iCalendar design set
   * @type {designSet}
   */
  var icalSet = {
    name: "ical",
    value: icalValues,
    param: icalParams,
    property: icalProperties,
    propertyGroups: false
  };

  /**
   * vCard 4.0 design set
   * @type {designSet}
   */
  var vcardSet = {
    name: "vcard4",
    value: vcardValues,
    param: vcardParams,
    property: vcardProperties,
    propertyGroups: true
  };

  /**
   * vCard 3.0 design set
   * @type {designSet}
   */
  var vcard3Set = {
    name: "vcard3",
    value: vcard3Values,
    param: vcard3Params,
    property: vcard3Properties,
    propertyGroups: true
  };

  /**
   * The design data, used by the parser to determine types for properties and
   * other metadata needed to produce correct jCard/jCal data.
   *
   * @alias ICAL.design
   * @exports module:ICAL.design
   */
  var design = {
    /**
     * Can be set to false to make the parser more lenient.
     */
    strict: true,
    /**
     * The default set for new properties and components if none is specified.
     * @type {designSet}
     */
    defaultSet: icalSet,
    /**
     * The default type for unknown properties
     * @type {String}
     */
    defaultType: 'unknown',
    /**
     * Holds the design set for known top-level components
     *
     * @type {Object}
     * @property {designSet} vcard       vCard VCARD
     * @property {designSet} vevent      iCalendar VEVENT
     * @property {designSet} vtodo       iCalendar VTODO
     * @property {designSet} vjournal    iCalendar VJOURNAL
     * @property {designSet} valarm      iCalendar VALARM
     * @property {designSet} vtimezone   iCalendar VTIMEZONE
     * @property {designSet} daylight    iCalendar DAYLIGHT
     * @property {designSet} standard    iCalendar STANDARD
     *
     * @example
     * let propertyName = 'fn';
     * let componentDesign = ICAL.design.components.vcard;
     * let propertyDetails = componentDesign.property[propertyName];
     * if (propertyDetails.defaultType == 'text') {
     *   // Yep, sure is...
     * }
     */
    components: {
      vcard: vcardSet,
      vcard3: vcard3Set,
      vevent: icalSet,
      vtodo: icalSet,
      vjournal: icalSet,
      valarm: icalSet,
      vtimezone: icalSet,
      daylight: icalSet,
      standard: icalSet
    },
    /**
     * The design set for iCalendar (rfc5545/rfc7265) components.
     * @type {designSet}
     */
    icalendar: icalSet,
    /**
     * The design set for vCard (rfc6350/rfc7095) components.
     * @type {designSet}
     */
    vcard: vcardSet,
    /**
     * The design set for vCard (rfc2425/rfc2426/rfc7095) components.
     * @type {designSet}
     */
    vcard3: vcard3Set,
    /**
     * Gets the design set for the given component name.
     *
     * @param {String} componentName        The name of the component
     * @return {designSet}      The design set for the component
     */
    getDesignSet: function getDesignSet(componentName) {
      var isInDesign = componentName && componentName in design.components;
      return isInDesign ? design.components[componentName] : design.defaultSet;
    }
  };

  /**
   * This lets typescript resolve our custom types in the
   * generated d.ts files (jsdoc typedefs are converted to typescript types).
   * Ignore prevents the typedefs from being documented more than once.
   *
   * @ignore
   * @typedef {import("./types.js").designSet} designSet
   * Imports the 'designSet' type from the "types.js" module
   */

  var LINE_ENDING = '\r\n';
  var DEFAULT_VALUE_TYPE = 'unknown';
  var RFC6868_REPLACE_MAP = {
    '"': "^'",
    "\n": "^n",
    "^": "^^"
  };

  /**
   * Convert a full jCal/jCard array into a iCalendar/vCard string.
   *
   * @function ICAL.stringify
   * @variation function
   * @param {Array} jCal    The jCal/jCard document
   * @return {String}       The stringified iCalendar/vCard document
   */
  function stringify(jCal) {
    if (typeof jCal[0] == "string") {
      // This is a single component
      jCal = [jCal];
    }
    var i = 0;
    var len = jCal.length;
    var result = '';
    for (; i < len; i++) {
      result += stringify.component(jCal[i]) + LINE_ENDING;
    }
    return result;
  }

  /**
   * Converts an jCal component array into a ICAL string.
   * Recursive will resolve sub-components.
   *
   * Exact component/property order is not saved all
   * properties will come before subcomponents.
   *
   * @function ICAL.stringify.component
   * @param {Array} component
   *        jCal/jCard fragment of a component
   * @param {designSet} designSet
   *        The design data to use for this component
   * @return {String}       The iCalendar/vCard string
   */
  stringify.component = function (component, designSet) {
    var name = component[0].toUpperCase();
    var result = 'BEGIN:' + name + LINE_ENDING;
    var props = component[1];
    var propIdx = 0;
    var propLen = props.length;
    var designSetName = component[0];
    // rfc6350 requires that in vCard 4.0 the first component is the VERSION
    // component with as value 4.0, note that 3.0 does not have this requirement.
    if (designSetName === 'vcard' && component[1].length > 0 && !(component[1][0][0] === "version" && component[1][0][3] === "4.0")) {
      designSetName = "vcard3";
    }
    designSet = designSet || design.getDesignSet(designSetName);
    for (; propIdx < propLen; propIdx++) {
      result += stringify.property(props[propIdx], designSet) + LINE_ENDING;
    }

    // Ignore subcomponents if none exist, e.g. in vCard.
    var comps = component[2] || [];
    var compIdx = 0;
    var compLen = comps.length;
    for (; compIdx < compLen; compIdx++) {
      result += stringify.component(comps[compIdx], designSet) + LINE_ENDING;
    }
    result += 'END:' + name;
    return result;
  };

  /**
   * Converts a single jCal/jCard property to a iCalendar/vCard string.
   *
   * @function ICAL.stringify.property
   * @param {Array} property
   *        jCal/jCard property array
   * @param {designSet} designSet
   *        The design data to use for this property
   * @param {Boolean} noFold
   *        If true, the line is not folded
   * @return {String}       The iCalendar/vCard string
   */
  stringify.property = function (property, designSet, noFold) {
    var name = property[0].toUpperCase();
    var jsName = property[0];
    var params = property[1];
    if (!designSet) {
      designSet = design.defaultSet;
    }
    var groupName = params.group;
    var line;
    if (designSet.propertyGroups && groupName) {
      line = groupName.toUpperCase() + "." + name;
    } else {
      line = name;
    }
    var _loop = function _loop() {
      var _Object$entries$_i = _slicedToArray(_Object$entries[_i], 2),
        paramName = _Object$entries$_i[0],
        value = _Object$entries$_i[1];
      if (designSet.propertyGroups && paramName == 'group') {
        return 1; // continue
      }
      var paramDesign = designSet.param[paramName];
      var multiValue = paramDesign && paramDesign.multiValue;
      if (multiValue && Array.isArray(value)) {
        value = value.map(function (val) {
          val = stringify._rfc6868Unescape(val);
          val = stringify.paramPropertyValue(val, paramDesign.multiValueSeparateDQuote);
          return val;
        });
        value = stringify.multiValue(value, multiValue, "unknown", null, designSet);
      } else {
        value = stringify._rfc6868Unescape(value);
        value = stringify.paramPropertyValue(value);
      }
      line += ';' + paramName.toUpperCase() + '=' + value;
    };
    for (var _i = 0, _Object$entries = Object.entries(params); _i < _Object$entries.length; _i++) {
      if (_loop()) continue;
    }
    if (property.length === 3) {
      // If there are no values, we must assume a blank value
      return line + ':';
    }
    var valueType = property[2];
    var propDetails;
    var multiValue = false;
    var structuredValue = false;
    var isDefault = false;
    if (jsName in designSet.property) {
      propDetails = designSet.property[jsName];
      if ('multiValue' in propDetails) {
        multiValue = propDetails.multiValue;
      }
      if ('structuredValue' in propDetails && Array.isArray(property[3])) {
        structuredValue = propDetails.structuredValue;
      }
      if ('defaultType' in propDetails) {
        if (valueType === propDetails.defaultType) {
          isDefault = true;
        }
      } else {
        if (valueType === DEFAULT_VALUE_TYPE) {
          isDefault = true;
        }
      }
    } else {
      if (valueType === DEFAULT_VALUE_TYPE) {
        isDefault = true;
      }
    }

    // push the VALUE property if type is not the default
    // for the current property.
    if (!isDefault) {
      // value will never contain ;/:/, so we don't escape it here.
      line += ';VALUE=' + valueType.toUpperCase();
    }
    line += ':';
    if (multiValue && structuredValue) {
      line += stringify.multiValue(property[3], structuredValue, valueType, multiValue, designSet, structuredValue);
    } else if (multiValue) {
      line += stringify.multiValue(property.slice(3), multiValue, valueType, null, designSet, false);
    } else if (structuredValue) {
      line += stringify.multiValue(property[3], structuredValue, valueType, null, designSet, structuredValue);
    } else {
      line += stringify.value(property[3], valueType, designSet, false);
    }
    return noFold ? line : foldline(line);
  };

  /**
   * Handles escaping of property values that may contain:
   *
   *    COLON (:), SEMICOLON (;), or COMMA (,)
   *
   * If any of the above are present the result is wrapped
   * in double quotes.
   *
   * @function ICAL.stringify.paramPropertyValue
   * @param {String} value      Raw property value
   * @param {boolean} force     If value should be escaped even when unnecessary
   * @return {String}           Given or escaped value when needed
   */
  stringify.paramPropertyValue = function (value, force) {
    if (!force && value.indexOf(',') === -1 && value.indexOf(':') === -1 && value.indexOf(';') === -1) {
      return value;
    }
    return '"' + value + '"';
  };

  /**
   * Converts an array of ical values into a single
   * string based on a type and a delimiter value (like ",").
   *
   * @function ICAL.stringify.multiValue
   * @param {Array} values      List of values to convert
   * @param {String} delim      Used to join the values (",", ";", ":")
   * @param {String} type       Lowecase ical value type
   *        (like boolean, date-time, etc..)
   * @param {?String} innerMulti If set, each value will again be processed
   *        Used for structured values
   * @param {designSet} designSet
   *        The design data to use for this property
   *
   * @return {String}           iCalendar/vCard string for value
   */
  stringify.multiValue = function (values, delim, type, innerMulti, designSet, structuredValue) {
    var result = '';
    var len = values.length;
    var i = 0;
    for (; i < len; i++) {
      if (innerMulti && Array.isArray(values[i])) {
        result += stringify.multiValue(values[i], innerMulti, type, null, designSet, structuredValue);
      } else {
        result += stringify.value(values[i], type, designSet, structuredValue);
      }
      if (i !== len - 1) {
        result += delim;
      }
    }
    return result;
  };

  /**
   * Processes a single ical value runs the associated "toICAL" method from the
   * design value type if available to convert the value.
   *
   * @function ICAL.stringify.value
   * @param {String|Number} value       A formatted value
   * @param {String} type               Lowercase iCalendar/vCard value type
   *  (like boolean, date-time, etc..)
   * @return {String}                   iCalendar/vCard value for single value
   */
  stringify.value = function (value, type, designSet, structuredValue) {
    if (type in designSet.value && 'toICAL' in designSet.value[type]) {
      return designSet.value[type].toICAL(value, structuredValue);
    }
    return value;
  };

  /**
   * Internal helper for rfc6868. Exposing this on ICAL.stringify so that
   * hackers can disable the rfc6868 parsing if the really need to.
   *
   * @param {String} val        The value to unescape
   * @return {String}           The escaped value
   */
  stringify._rfc6868Unescape = function (val) {
    return val.replace(/[\n^"]/g, function (x) {
      return RFC6868_REPLACE_MAP[x];
    });
  };

  /* This Source Code Form is subject to the terms of the Mozilla Public
   * License, v. 2.0. If a copy of the MPL was not distributed with this
   * file, You can obtain one at http://mozilla.org/MPL/2.0/.
   * Portions Copyright (C) Philipp Kewisch */

  var NAME_INDEX$1 = 0;
  var PROP_INDEX = 1;
  var TYPE_INDEX = 2;
  var VALUE_INDEX = 3;

  /**
   * This lets typescript resolve our custom types in the
   * generated d.ts files (jsdoc typedefs are converted to typescript types).
   * Ignore prevents the typedefs from being documented more than once.
   * @ignore
   * @typedef {import("./types.js").designSet} designSet
   * Imports the 'designSet' type from the "types.js" module
   * @typedef {import("./types.js").Geo} Geo
   * Imports the 'Geo' type from the "types.js" module
   */

  /**
   * Provides a layer on top of the raw jCal object for manipulating a single property, with its
   * parameters and value.
   *
   * @memberof ICAL
   */
  var Property = /*#__PURE__*/function () {
    /**
     * Creates a new ICAL.Property instance.
     *
     * It is important to note that mutations done in the wrapper directly mutate the jCal object used
     * to initialize.
     *
     * Can also be used to create new properties by passing the name of the property (as a String).
     *
     * @param {Array|String} jCal         Raw jCal representation OR the new name of the property
     * @param {Component=} parent         Parent component
     */
    function Property(jCal, parent) {
      _classCallCheck(this, Property);
      this._parent = parent || null;
      if (typeof jCal === 'string') {
        // We are creating the property by name and need to detect the type
        this.jCal = [jCal, {}, design.defaultType];
        this.jCal[TYPE_INDEX] = this.getDefaultType();
      } else {
        this.jCal = jCal;
      }
      this._updateType();
    }

    /**
     * The value type for this property
     * @type {String}
     */
    return _createClass(Property, [{
      key: "type",
      get: function get() {
        return this.jCal[TYPE_INDEX];
      }

      /**
       * The name of this property, in lowercase.
       * @type {String}
       */
    }, {
      key: "name",
      get: function get() {
        return this.jCal[NAME_INDEX$1];
      }

      /**
       * The parent component for this property.
       * @type {Component}
       */
    }, {
      key: "parent",
      get: function get() {
        return this._parent;
      },
      set: function set(p) {
        // Before setting the parent, check if the design set has changed. If it
        // has, we later need to update the type if it was unknown before.
        var designSetChanged = !this._parent || p && p._designSet != this._parent._designSet;
        this._parent = p;
        if (this.type == design.defaultType && designSetChanged) {
          this.jCal[TYPE_INDEX] = this.getDefaultType();
          this._updateType();
        }
      }

      /**
       * The design set for this property, e.g. icalendar vs vcard
       *
       * @type {designSet}
       * @private
       */
    }, {
      key: "_designSet",
      get: function get() {
        return this.parent ? this.parent._designSet : design.defaultSet;
      }

      /**
       * Updates the type metadata from the current jCal type and design set.
       *
       * @private
       */
    }, {
      key: "_updateType",
      value: function _updateType() {
        var designSet = this._designSet;
        if (this.type in designSet.value) {
          if ('decorate' in designSet.value[this.type]) {
            this.isDecorated = true;
          } else {
            this.isDecorated = false;
          }
          if (this.name in designSet.property) {
            this.isMultiValue = 'multiValue' in designSet.property[this.name];
            this.isStructuredValue = 'structuredValue' in designSet.property[this.name];
          }
        }
      }

      /**
       * Hydrate a single value. The act of hydrating means turning the raw jCal
       * value into a potentially wrapped object, for example {@link ICAL.Time}.
       *
       * @private
       * @param {Number} index        The index of the value to hydrate
       * @return {?Object}             The decorated value.
       */
    }, {
      key: "_hydrateValue",
      value: function _hydrateValue(index) {
        if (this._values && this._values[index]) {
          return this._values[index];
        }

        // for the case where there is no value.
        if (this.jCal.length <= VALUE_INDEX + index) {
          return null;
        }
        if (this.isDecorated) {
          if (!this._values) {
            this._values = [];
          }
          return this._values[index] = this._decorate(this.jCal[VALUE_INDEX + index]);
        } else {
          return this.jCal[VALUE_INDEX + index];
        }
      }

      /**
       * Decorate a single value, returning its wrapped object. This is used by
       * the hydrate function to actually wrap the value.
       *
       * @private
       * @param {?} value         The value to decorate
       * @return {Object}         The decorated value
       */
    }, {
      key: "_decorate",
      value: function _decorate(value) {
        return this._designSet.value[this.type].decorate(value, this);
      }

      /**
       * Undecorate a single value, returning its raw jCal data.
       *
       * @private
       * @param {Object} value         The value to undecorate
       * @return {?}                   The undecorated value
       */
    }, {
      key: "_undecorate",
      value: function _undecorate(value) {
        return this._designSet.value[this.type].undecorate(value, this);
      }

      /**
       * Sets the value at the given index while also hydrating it. The passed
       * value can either be a decorated or undecorated value.
       *
       * @private
       * @param {?} value             The value to set
       * @param {Number} index        The index to set it at
       */
    }, {
      key: "_setDecoratedValue",
      value: function _setDecoratedValue(value, index) {
        if (!this._values) {
          this._values = [];
        }
        if (_typeof(value) === 'object' && 'icaltype' in value) {
          // decorated value
          this.jCal[VALUE_INDEX + index] = this._undecorate(value);
          this._values[index] = value;
        } else {
          // undecorated value
          this.jCal[VALUE_INDEX + index] = value;
          this._values[index] = this._decorate(value);
        }
      }

      /**
       * Gets a parameter on the property.
       *
       * @param {String}        name   Parameter name (lowercase)
       * @return {Array|String}        Parameter value
       */
    }, {
      key: "getParameter",
      value: function getParameter(name) {
        if (name in this.jCal[PROP_INDEX]) {
          return this.jCal[PROP_INDEX][name];
        } else {
          return undefined;
        }
      }

      /**
       * Gets first parameter on the property.
       *
       * @param {String}        name   Parameter name (lowercase)
       * @return {String}        Parameter value
       */
    }, {
      key: "getFirstParameter",
      value: function getFirstParameter(name) {
        var parameters = this.getParameter(name);
        if (Array.isArray(parameters)) {
          return parameters[0];
        }
        return parameters;
      }

      /**
       * Sets a parameter on the property.
       *
       * @param {String}       name     The parameter name
       * @param {Array|String} value    The parameter value
       */
    }, {
      key: "setParameter",
      value: function setParameter(name, value) {
        var lcname = name.toLowerCase();
        if (typeof value === "string" && lcname in this._designSet.param && 'multiValue' in this._designSet.param[lcname]) {
          value = [value];
        }
        this.jCal[PROP_INDEX][name] = value;
      }

      /**
       * Removes a parameter
       *
       * @param {String} name     The parameter name
       */
    }, {
      key: "removeParameter",
      value: function removeParameter(name) {
        delete this.jCal[PROP_INDEX][name];
      }

      /**
       * Get the default type based on this property's name.
       *
       * @return {String}     The default type for this property
       */
    }, {
      key: "getDefaultType",
      value: function getDefaultType() {
        var name = this.jCal[NAME_INDEX$1];
        var designSet = this._designSet;
        if (name in designSet.property) {
          var details = designSet.property[name];
          if ('defaultType' in details) {
            return details.defaultType;
          }
        }
        return design.defaultType;
      }

      /**
       * Sets type of property and clears out any existing values of the current
       * type.
       *
       * @param {String} type     New iCAL type (see design.*.values)
       */
    }, {
      key: "resetType",
      value: function resetType(type) {
        this.removeAllValues();
        this.jCal[TYPE_INDEX] = type;
        this._updateType();
      }

      /**
       * Finds the first property value.
       *
       * @return {Binary | Duration | Period |
       * Recur | Time | UtcOffset | Geo | string | null}         First property value
       */
    }, {
      key: "getFirstValue",
      value: function getFirstValue() {
        return this._hydrateValue(0);
      }

      /**
       * Gets all values on the property.
       *
       * NOTE: this creates an array during each call.
       *
       * @return {Array}          List of values
       */
    }, {
      key: "getValues",
      value: function getValues() {
        var len = this.jCal.length - VALUE_INDEX;
        if (len < 1) {
          // it is possible for a property to have no value.
          return [];
        }
        var i = 0;
        var result = [];
        for (; i < len; i++) {
          result[i] = this._hydrateValue(i);
        }
        return result;
      }

      /**
       * Removes all values from this property
       */
    }, {
      key: "removeAllValues",
      value: function removeAllValues() {
        if (this._values) {
          this._values.length = 0;
        }
        this.jCal.length = 3;
      }

      /**
       * Sets the values of the property.  Will overwrite the existing values.
       * This can only be used for multi-value properties.
       *
       * @param {Array} values    An array of values
       */
    }, {
      key: "setValues",
      value: function setValues(values) {
        if (!this.isMultiValue) {
          throw new Error(this.name + ': does not not support mulitValue.\n' + 'override isMultiValue');
        }
        var len = values.length;
        var i = 0;
        this.removeAllValues();
        if (len > 0 && _typeof(values[0]) === 'object' && 'icaltype' in values[0]) {
          this.resetType(values[0].icaltype);
        }
        if (this.isDecorated) {
          for (; i < len; i++) {
            this._setDecoratedValue(values[i], i);
          }
        } else {
          for (; i < len; i++) {
            this.jCal[VALUE_INDEX + i] = values[i];
          }
        }
      }

      /**
       * Sets the current value of the property. If this is a multi-value
       * property, all other values will be removed.
       *
       * @param {String|Object} value     New property value.
       */
    }, {
      key: "setValue",
      value: function setValue(value) {
        this.removeAllValues();
        if (_typeof(value) === 'object' && 'icaltype' in value) {
          this.resetType(value.icaltype);
        }
        if (this.isDecorated) {
          this._setDecoratedValue(value, 0);
        } else {
          this.jCal[VALUE_INDEX] = value;
        }
      }

      /**
       * Returns the Object representation of this component. The returned object
       * is a live jCal object and should be cloned if modified.
       * @return {Object}
       */
    }, {
      key: "toJSON",
      value: function toJSON() {
        return this.jCal;
      }

      /**
       * The string representation of this component.
       * @return {String}
       */
    }, {
      key: "toICALString",
      value: function toICALString() {
        return stringify.property(this.jCal, this._designSet, true);
      }
    }], [{
      key: "fromString",
      value:
      /**
       * Create an {@link ICAL.Property} by parsing the passed iCalendar string.
       *
       * @param {String} str            The iCalendar string to parse
       * @param {designSet=} designSet  The design data to use for this property
       * @return {Property}             The created iCalendar property
       */
      function fromString(str, designSet) {
        return new Property(parse.property(str, designSet));
      }
    }]);
  }();

  /**
   * This lets typescript resolve our custom types in the
   * generated d.ts files (jsdoc typedefs are converted to typescript types).
   * Ignore prevents the typedefs from being documented more than once.
   * @ignore
   * @typedef {import("./types.js").designSet} designSet
   * Imports the 'designSet' type from the "types.js" module
   * @typedef {import("./types.js").Geo} Geo
   * Imports the 'Geo' type from the "types.js" module
   */

  var NAME_INDEX = 0;
  var PROPERTY_INDEX = 1;
  var COMPONENT_INDEX = 2;
  var PROPERTY_NAME_INDEX = 0;
  var PROPERTY_VALUE_INDEX = 3;

  /**
   * Wraps a jCal component, adding convenience methods to add, remove and update subcomponents and
   * properties.
   *
   * @memberof ICAL
   */
  var Component = /*#__PURE__*/function () {
    /**
     * Creates a new Component instance.
     *
     * @param {Array|String} jCal         Raw jCal component data OR name of new
     *                                      component
     * @param {Component=} parent     Parent component to associate
     */
    function Component(jCal, parent) {
      _classCallCheck(this, Component);
      /**
       * Hydrated properties are inserted into the _properties array at the same
       * position as in the jCal array, so it is possible that the array contains
       * undefined values for unhydrdated properties. To avoid iterating the
       * array when checking if all properties have been hydrated, we save the
       * count here.
       *
       * @type {Number}
       * @private
       */
      _defineProperty(this, "_hydratedPropertyCount", 0);
      /**
       * The same count as for _hydratedPropertyCount, but for subcomponents
       *
       * @type {Number}
       * @private
       */
      _defineProperty(this, "_hydratedComponentCount", 0);
      /**
       * A cache of hydrated time zone objects which may be used by consumers, keyed
       * by time zone ID.
       *
       * @type {Map}
       * @private
       */
      _defineProperty(this, "_timezoneCache", null);
      /**
       * @private
       */
      _defineProperty(this, "_components", null);
      /**
       * @private
       */
      _defineProperty(this, "_properties", null);
      if (typeof jCal === 'string') {
        // jCal spec (name, properties, components)
        jCal = [jCal, [], []];
      }

      // mostly for legacy reasons.
      this.jCal = jCal;
      this.parent = parent || null;
      if (!this.parent && this.name === 'vcalendar') {
        this._timezoneCache = new Map();
      }
    }
    return _createClass(Component, [{
      key: "name",
      get:
      /**
       * The name of this component
       *
       * @type {String}
       */
      function get() {
        return this.jCal[NAME_INDEX];
      }

      /**
       * The design set for this component, e.g. icalendar vs vcard
       *
       * @type {designSet}
       * @private
       */
    }, {
      key: "_designSet",
      get: function get() {
        var parentDesign = this.parent && this.parent._designSet;
        if (!parentDesign && this.name == "vcard") {
          var _this$jCal$PROPERTY_I;
          // We can't decide on vcard3 vs vcard4 just based on the component name, the version number is
          // in the version property. We also can't use hydrated properties here because it would lead
          // to recursion, but the spec says that the version property needs to be the very first one.
          var versionProp = (_this$jCal$PROPERTY_I = this.jCal[PROPERTY_INDEX]) === null || _this$jCal$PROPERTY_I === void 0 ? void 0 : _this$jCal$PROPERTY_I[0];
          if (versionProp && versionProp[PROPERTY_NAME_INDEX] == "version" && versionProp[PROPERTY_VALUE_INDEX] == "3.0") {
            return design.getDesignSet("vcard3");
          }
        }
        return parentDesign || design.getDesignSet(this.name);
      }

      /**
       * @private
       */
    }, {
      key: "_hydrateComponent",
      value: function _hydrateComponent(index) {
        if (!this._components) {
          this._components = [];
          this._hydratedComponentCount = 0;
        }
        if (this._components[index]) {
          return this._components[index];
        }
        var comp = new Component(this.jCal[COMPONENT_INDEX][index], this);
        this._hydratedComponentCount++;
        return this._components[index] = comp;
      }

      /**
       * @private
       */
    }, {
      key: "_hydrateProperty",
      value: function _hydrateProperty(index) {
        if (!this._properties) {
          this._properties = [];
          this._hydratedPropertyCount = 0;
        }
        if (this._properties[index]) {
          return this._properties[index];
        }
        var prop = new Property(this.jCal[PROPERTY_INDEX][index], this);
        this._hydratedPropertyCount++;
        return this._properties[index] = prop;
      }

      /**
       * Finds first sub component, optionally filtered by name.
       *
       * @param {String=} name        Optional name to filter by
       * @return {?Component}     The found subcomponent
       */
    }, {
      key: "getFirstSubcomponent",
      value: function getFirstSubcomponent(name) {
        if (name) {
          var i = 0;
          var comps = this.jCal[COMPONENT_INDEX];
          var len = comps.length;
          for (; i < len; i++) {
            if (comps[i][NAME_INDEX] === name) {
              var result = this._hydrateComponent(i);
              return result;
            }
          }
        } else {
          if (this.jCal[COMPONENT_INDEX].length) {
            return this._hydrateComponent(0);
          }
        }

        // ensure we return a value (strict mode)
        return null;
      }

      /**
       * Finds all sub components, optionally filtering by name.
       *
       * @param {String=} name            Optional name to filter by
       * @return {Component[]}       The found sub components
       */
    }, {
      key: "getAllSubcomponents",
      value: function getAllSubcomponents(name) {
        var jCalLen = this.jCal[COMPONENT_INDEX].length;
        var i = 0;
        if (name) {
          var comps = this.jCal[COMPONENT_INDEX];
          var result = [];
          for (; i < jCalLen; i++) {
            if (name === comps[i][NAME_INDEX]) {
              result.push(this._hydrateComponent(i));
            }
          }
          return result;
        } else {
          if (!this._components || this._hydratedComponentCount !== jCalLen) {
            for (; i < jCalLen; i++) {
              this._hydrateComponent(i);
            }
          }
          return this._components || [];
        }
      }

      /**
       * Returns true when a named property exists.
       *
       * @param {String} name     The property name
       * @return {Boolean}        True, when property is found
       */
    }, {
      key: "hasProperty",
      value: function hasProperty(name) {
        var props = this.jCal[PROPERTY_INDEX];
        var len = props.length;
        var i = 0;
        for (; i < len; i++) {
          // 0 is property name
          if (props[i][NAME_INDEX] === name) {
            return true;
          }
        }
        return false;
      }

      /**
       * Finds the first property, optionally with the given name.
       *
       * @param {String=} name        Lowercase property name
       * @return {?Property}     The found property
       */
    }, {
      key: "getFirstProperty",
      value: function getFirstProperty(name) {
        if (name) {
          var i = 0;
          var props = this.jCal[PROPERTY_INDEX];
          var len = props.length;
          for (; i < len; i++) {
            if (props[i][NAME_INDEX] === name) {
              var result = this._hydrateProperty(i);
              return result;
            }
          }
        } else {
          if (this.jCal[PROPERTY_INDEX].length) {
            return this._hydrateProperty(0);
          }
        }
        return null;
      }

      /**
       * Returns first property's value, if available.
       *
       * @param {String=} name                    Lowercase property name
       * @return {Binary | Duration | Period |
       * Recur | Time | UtcOffset | Geo | string | null}         The found property value.
       */
    }, {
      key: "getFirstPropertyValue",
      value: function getFirstPropertyValue(name) {
        var prop = this.getFirstProperty(name);
        if (prop) {
          return prop.getFirstValue();
        }
        return null;
      }

      /**
       * Get all properties in the component, optionally filtered by name.
       *
       * @param {String=} name        Lowercase property name
       * @return {Property[]}    List of properties
       */
    }, {
      key: "getAllProperties",
      value: function getAllProperties(name) {
        var jCalLen = this.jCal[PROPERTY_INDEX].length;
        var i = 0;
        if (name) {
          var props = this.jCal[PROPERTY_INDEX];
          var result = [];
          for (; i < jCalLen; i++) {
            if (name === props[i][NAME_INDEX]) {
              result.push(this._hydrateProperty(i));
            }
          }
          return result;
        } else {
          if (!this._properties || this._hydratedPropertyCount !== jCalLen) {
            for (; i < jCalLen; i++) {
              this._hydrateProperty(i);
            }
          }
          return this._properties || [];
        }
      }

      /**
       * @private
       */
    }, {
      key: "_removeObjectByIndex",
      value: function _removeObjectByIndex(jCalIndex, cache, index) {
        cache = cache || [];
        // remove cached version
        if (cache[index]) {
          var obj = cache[index];
          if ("parent" in obj) {
            obj.parent = null;
          }
        }
        cache.splice(index, 1);

        // remove it from the jCal
        this.jCal[jCalIndex].splice(index, 1);
      }

      /**
       * @private
       */
    }, {
      key: "_removeObject",
      value: function _removeObject(jCalIndex, cache, nameOrObject) {
        var i = 0;
        var objects = this.jCal[jCalIndex];
        var len = objects.length;
        var cached = this[cache];
        if (typeof nameOrObject === 'string') {
          for (; i < len; i++) {
            if (objects[i][NAME_INDEX] === nameOrObject) {
              this._removeObjectByIndex(jCalIndex, cached, i);
              return true;
            }
          }
        } else if (cached) {
          for (; i < len; i++) {
            if (cached[i] && cached[i] === nameOrObject) {
              this._removeObjectByIndex(jCalIndex, cached, i);
              return true;
            }
          }
        }
        return false;
      }

      /**
       * @private
       */
    }, {
      key: "_removeAllObjects",
      value: function _removeAllObjects(jCalIndex, cache, name) {
        var cached = this[cache];

        // Unfortunately we have to run through all children to reset their
        // parent property.
        var objects = this.jCal[jCalIndex];
        var i = objects.length - 1;

        // descending search required because splice
        // is used and will effect the indices.
        for (; i >= 0; i--) {
          if (!name || objects[i][NAME_INDEX] === name) {
            this._removeObjectByIndex(jCalIndex, cached, i);
          }
        }
      }

      /**
       * Adds a single sub component.
       *
       * @param {Component} component        The component to add
       * @return {Component}                 The passed in component
       */
    }, {
      key: "addSubcomponent",
      value: function addSubcomponent(component) {
        if (!this._components) {
          this._components = [];
          this._hydratedComponentCount = 0;
        }
        if (component.parent) {
          component.parent.removeSubcomponent(component);
        }
        var idx = this.jCal[COMPONENT_INDEX].push(component.jCal);
        this._components[idx - 1] = component;
        this._hydratedComponentCount++;
        component.parent = this;
        return component;
      }

      /**
       * Removes a single component by name or the instance of a specific
       * component.
       *
       * @param {Component|String} nameOrComp    Name of component, or component
       * @return {Boolean}                            True when comp is removed
       */
    }, {
      key: "removeSubcomponent",
      value: function removeSubcomponent(nameOrComp) {
        var removed = this._removeObject(COMPONENT_INDEX, '_components', nameOrComp);
        if (removed) {
          this._hydratedComponentCount--;
        }
        return removed;
      }

      /**
       * Removes all components or (if given) all components by a particular
       * name.
       *
       * @param {String=} name            Lowercase component name
       */
    }, {
      key: "removeAllSubcomponents",
      value: function removeAllSubcomponents(name) {
        var removed = this._removeAllObjects(COMPONENT_INDEX, '_components', name);
        this._hydratedComponentCount = 0;
        return removed;
      }

      /**
       * Adds an {@link ICAL.Property} to the component.
       *
       * @param {Property} property      The property to add
       * @return {Property}              The passed in property
       */
    }, {
      key: "addProperty",
      value: function addProperty(property) {
        if (!(property instanceof Property)) {
          throw new TypeError('must be instance of ICAL.Property');
        }
        if (!this._properties) {
          this._properties = [];
          this._hydratedPropertyCount = 0;
        }
        if (property.parent) {
          property.parent.removeProperty(property);
        }
        var idx = this.jCal[PROPERTY_INDEX].push(property.jCal);
        this._properties[idx - 1] = property;
        this._hydratedPropertyCount++;
        property.parent = this;
        return property;
      }

      /**
       * Helper method to add a property with a value to the component.
       *
       * @param {String}               name         Property name to add
       * @param {String|Number|Object} value        Property value
       * @return {Property}                    The created property
       */
    }, {
      key: "addPropertyWithValue",
      value: function addPropertyWithValue(name, value) {
        var prop = new Property(name);
        prop.setValue(value);
        this.addProperty(prop);
        return prop;
      }

      /**
       * Helper method that will update or create a property of the given name
       * and sets its value. If multiple properties with the given name exist,
       * only the first is updated.
       *
       * @param {String}               name         Property name to update
       * @param {String|Number|Object} value        Property value
       * @return {Property}                    The created property
       */
    }, {
      key: "updatePropertyWithValue",
      value: function updatePropertyWithValue(name, value) {
        var prop = this.getFirstProperty(name);
        if (prop) {
          prop.setValue(value);
        } else {
          prop = this.addPropertyWithValue(name, value);
        }
        return prop;
      }

      /**
       * Removes a single property by name or the instance of the specific
       * property.
       *
       * @param {String|Property} nameOrProp     Property name or instance to remove
       * @return {Boolean}                            True, when deleted
       */
    }, {
      key: "removeProperty",
      value: function removeProperty(nameOrProp) {
        var removed = this._removeObject(PROPERTY_INDEX, '_properties', nameOrProp);
        if (removed) {
          this._hydratedPropertyCount--;
        }
        return removed;
      }

      /**
       * Removes all properties associated with this component, optionally
       * filtered by name.
       *
       * @param {String=} name        Lowercase property name
       * @return {Boolean}            True, when deleted
       */
    }, {
      key: "removeAllProperties",
      value: function removeAllProperties(name) {
        var removed = this._removeAllObjects(PROPERTY_INDEX, '_properties', name);
        this._hydratedPropertyCount = 0;
        return removed;
      }

      /**
       * Returns the Object representation of this component. The returned object
       * is a live jCal object and should be cloned if modified.
       * @return {Object}
       */
    }, {
      key: "toJSON",
      value: function toJSON() {
        return this.jCal;
      }

      /**
       * The string representation of this component.
       * @return {String}
       */
    }, {
      key: "toString",
      value: function toString() {
        return stringify.component(this.jCal, this._designSet);
      }

      /**
       * Retrieve a time zone definition from the component tree, if any is present.
       * If the tree contains no time zone definitions or the TZID cannot be
       * matched, returns null.
       *
       * @param {String} tzid     The ID of the time zone to retrieve
       * @return {Timezone}  The time zone corresponding to the ID, or null
       */
    }, {
      key: "getTimeZoneByID",
      value: function getTimeZoneByID(tzid) {
        // VTIMEZONE components can only appear as a child of the VCALENDAR
        // component; walk the tree if we're not the root.
        if (this.parent) {
          return this.parent.getTimeZoneByID(tzid);
        }

        // If there is no time zone cache, we are probably parsing an incomplete
        // file and will have no time zone definitions.
        if (!this._timezoneCache) {
          return null;
        }
        if (this._timezoneCache.has(tzid)) {
          return this._timezoneCache.get(tzid);
        }

        // If the time zone is not already cached, hydrate it from the
        // subcomponents.
        var zones = this.getAllSubcomponents('vtimezone');
        var _iterator = _createForOfIteratorHelper(zones),
          _step;
        try {
          for (_iterator.s(); !(_step = _iterator.n()).done;) {
            var zone = _step.value;
            if (zone.getFirstProperty('tzid').getFirstValue() === tzid) {
              var hydratedZone = new Timezone({
                component: zone,
                tzid: tzid
              });
              this._timezoneCache.set(tzid, hydratedZone);
              return hydratedZone;
            }
          }

          // Per the standard, we should always have a time zone defined in a file
          // for any referenced TZID, but don't blow up if the file is invalid.
        } catch (err) {
          _iterator.e(err);
        } finally {
          _iterator.f();
        }
        return null;
      }
    }], [{
      key: "fromString",
      value:
      /**
       * Create an {@link ICAL.Component} by parsing the passed iCalendar string.
       *
       * @param {String} str        The iCalendar string to parse
       */
      function fromString(str) {
        return new Component(parse.component(str));
      }
    }]);
  }();

  /**
   * Primary class for expanding recurring rules.  Can take multiple rrules, rdates, exdate(s) and
   * iterate (in order) over each next occurrence.
   *
   * Once initialized this class can also be serialized saved and continue iteration from the last
   * point.
   *
   * NOTE: it is intended that this class is to be used with {@link ICAL.Event} which handles recurrence
   * exceptions.
   *
   * @example
   * // assuming event is a parsed ical component
   * var event;
   *
   * var expand = new ICAL.RecurExpansion({
   *   component: event,
   *   dtstart: event.getFirstPropertyValue('dtstart')
   * });
   *
   * // remember there are infinite rules so it is a good idea to limit the scope of the iterations
   * // then resume later on.
   *
   * // next is always an ICAL.Time or null
   * var next;
   *
   * while (someCondition && (next = expand.next())) {
   *   // do something with next
   * }
   *
   * // save instance for later
   * var json = JSON.stringify(expand);
   *
   * //...
   *
   * // NOTE: if the component's properties have changed you will need to rebuild the class and start
   * // over. This only works when the component's recurrence info is the same.
   * var expand = new ICAL.RecurExpansion(JSON.parse(json));
   *
   * @memberof ICAL
   */
  var RecurExpansion = /*#__PURE__*/function () {
    /**
     * Creates a new ICAL.RecurExpansion instance.
     *
     * The options object can be filled with the specified initial values. It can also contain
     * additional members, as a result of serializing a previous expansion state, as shown in the
     * example.
     *
     * @param {Object} options
     *        Recurrence expansion options
     * @param {Time} options.dtstart
     *        Start time of the event
     * @param {Component=} options.component
     *        Component for expansion, required if not resuming.
     */
    function RecurExpansion(options) {
      _classCallCheck(this, RecurExpansion);
      /**
       * True when iteration is fully completed.
       * @type {Boolean}
       */
      _defineProperty(this, "complete", false);
      /**
       * Array of rrule iterators.
       *
       * @type {RecurIterator[]}
       * @private
       */
      _defineProperty(this, "ruleIterators", null);
      /**
       * Array of rdate instances.
       *
       * @type {Time[]}
       * @private
       */
      _defineProperty(this, "ruleDates", null);
      /**
       * Array of exdate instances.
       *
       * @type {Time[]}
       * @private
       */
      _defineProperty(this, "exDates", null);
      /**
       * Current position in ruleDates array.
       * @type {Number}
       * @private
       */
      _defineProperty(this, "ruleDateInc", 0);
      /**
       * Current position in exDates array
       * @type {Number}
       * @private
       */
      _defineProperty(this, "exDateInc", 0);
      /**
       * Current negative date.
       *
       * @type {Time}
       * @private
       */
      _defineProperty(this, "exDate", null);
      /**
       * Current additional date.
       *
       * @type {Time}
       * @private
       */
      _defineProperty(this, "ruleDate", null);
      /**
       * Start date of recurring rules.
       *
       * @type {Time}
       */
      _defineProperty(this, "dtstart", null);
      /**
       * Last expanded time
       *
       * @type {Time}
       */
      _defineProperty(this, "last", null);
      this.ruleDates = [];
      this.exDates = [];
      this.fromData(options);
    }
    return _createClass(RecurExpansion, [{
      key: "fromData",
      value:
      /**
       * Initialize the recurrence expansion from the data object. The options
       * object may also contain additional members, see the
       * {@link ICAL.RecurExpansion constructor} for more details.
       *
       * @param {Object} options
       *        Recurrence expansion options
       * @param {Time} options.dtstart
       *        Start time of the event
       * @param {Component=} options.component
       *        Component for expansion, required if not resuming.
       */
      function fromData(options) {
        var start = formatClassType(options.dtstart, Time);
        if (!start) {
          throw new Error('.dtstart (ICAL.Time) must be given');
        } else {
          this.dtstart = start;
        }
        if (options.component) {
          this._init(options.component);
        } else {
          this.last = formatClassType(options.last, Time) || start.clone();
          if (!options.ruleIterators) {
            throw new Error('.ruleIterators or .component must be given');
          }
          this.ruleIterators = options.ruleIterators.map(function (item) {
            return formatClassType(item, RecurIterator);
          });
          this.ruleDateInc = options.ruleDateInc;
          this.exDateInc = options.exDateInc;
          if (options.ruleDates) {
            this.ruleDates = options.ruleDates.map(function (item) {
              return formatClassType(item, Time);
            });
            this.ruleDate = this.ruleDates[this.ruleDateInc];
          }
          if (options.exDates) {
            this.exDates = options.exDates.map(function (item) {
              return formatClassType(item, Time);
            });
            this.exDate = this.exDates[this.exDateInc];
          }
          if (typeof options.complete !== 'undefined') {
            this.complete = options.complete;
          }
        }
      }

      /**
       * Compare two ICAL.Time objects.  When the second parameter is a DATE and the first parameter is
       * DATE-TIME, strip the time and compare only the days.
       *
       * @private
       * @param {Time} a   The one object to compare
       * @param {Time} b   The other object to compare
       */
    }, {
      key: "_compare_special",
      value: function _compare_special(a, b) {
        if (!a.isDate && b.isDate) return new Time({
          year: a.year,
          month: a.month,
          day: a.day
        }).compare(b);
        return a.compare(b);
      }

      /**
       * Retrieve the next occurrence in the series.
       * @return {Time}
       */
    }, {
      key: "next",
      value: function next() {
        var iter;
        var next;
        var compare;
        var maxTries = 500;
        var currentTry = 0;
        while (true) {
          if (currentTry++ > maxTries) {
            throw new Error('max tries have occurred, rule may be impossible to fulfill.');
          }
          next = this.ruleDate;
          iter = this._nextRecurrenceIter(this.last);

          // no more matches
          // because we increment the rule day or rule
          // _after_ we choose a value this should be
          // the only spot where we need to worry about the
          // end of events.
          if (!next && !iter) {
            // there are no more iterators or rdates
            this.complete = true;
            break;
          }

          // no next rule day or recurrence rule is first.
          if (!next || iter && next.compare(iter.last) > 0) {
            // must be cloned, recur will reuse the time element.
            next = iter.last.clone();
            // move to next so we can continue
            iter.next();
          }

          // if the ruleDate is still next increment it.
          if (this.ruleDate === next) {
            this._nextRuleDay();
          }
          this.last = next;

          // check the negative rules
          if (this.exDate) {
            // EXDATE can be in DATE format, but DTSTART is in DATE-TIME format
            compare = this._compare_special(this.last, this.exDate);
            if (compare > 0) {
              this._nextExDay();
            }

            // if the current rule is excluded skip it.
            if (compare === 0) {
              this._nextExDay();
              continue;
            }
          }

          //XXX: The spec states that after we resolve the final
          //     list of dates we execute exdate this seems somewhat counter
          //     intuitive to what I have seen most servers do so for now
          //     I exclude based on the original date not the one that may
          //     have been modified by the exception.
          return this.last;
        }
      }

      /**
       * Converts object into a serialize-able format. This format can be passed
       * back into the expansion to resume iteration.
       * @return {Object}
       */
    }, {
      key: "toJSON",
      value: function toJSON() {
        function toJSON(item) {
          return item.toJSON();
        }
        var result = Object.create(null);
        result.ruleIterators = this.ruleIterators.map(toJSON);
        if (this.ruleDates) {
          result.ruleDates = this.ruleDates.map(toJSON);
        }
        if (this.exDates) {
          result.exDates = this.exDates.map(toJSON);
        }
        result.ruleDateInc = this.ruleDateInc;
        result.exDateInc = this.exDateInc;
        result.last = this.last.toJSON();
        result.dtstart = this.dtstart.toJSON();
        result.complete = this.complete;
        return result;
      }

      /**
       * Extract all dates from the properties in the given component. The
       * properties will be filtered by the property name.
       *
       * @private
       * @param {Component} component             The component to search in
       * @param {String} propertyName             The property name to search for
       * @return {Time[]}                         The extracted dates.
       */
    }, {
      key: "_extractDates",
      value: function _extractDates(component, propertyName) {
        var result = [];
        var props = component.getAllProperties(propertyName);
        for (var i = 0, len = props.length; i < len; i++) {
          var _iterator = _createForOfIteratorHelper(props[i].getValues()),
            _step;
          try {
            for (_iterator.s(); !(_step = _iterator.n()).done;) {
              var prop = _step.value;
              var idx = binsearchInsert(result, prop, function (a, b) {
                return a.compare(b);
              });

              // ordered insert
              result.splice(idx, 0, prop);
            }
          } catch (err) {
            _iterator.e(err);
          } finally {
            _iterator.f();
          }
        }
        return result;
      }

      /**
       * Initialize the recurrence expansion.
       *
       * @private
       * @param {Component} component    The component to initialize from.
       */
    }, {
      key: "_init",
      value: function _init(component) {
        this.ruleIterators = [];
        this.last = this.dtstart.clone();

        // to provide api consistency non-recurring
        // events can also use the iterator though it will
        // only return a single time.
        if (!component.hasProperty('rdate') && !component.hasProperty('rrule') && !component.hasProperty('recurrence-id')) {
          this.ruleDate = this.last.clone();
          this.complete = true;
          return;
        }
        if (component.hasProperty('rdate')) {
          this.ruleDates = this._extractDates(component, 'rdate');

          // special hack for cases where first rdate is prior
          // to the start date. We only check for the first rdate.
          // This is mostly for google's crazy recurring date logic
          // (contacts birthdays).
          if (this.ruleDates[0] && this.ruleDates[0].compare(this.dtstart) < 0) {
            this.ruleDateInc = 0;
            this.last = this.ruleDates[0].clone();
          } else {
            this.ruleDateInc = binsearchInsert(this.ruleDates, this.last, function (a, b) {
              return a.compare(b);
            });
          }
          this.ruleDate = this.ruleDates[this.ruleDateInc];
        }
        if (component.hasProperty('rrule')) {
          var rules = component.getAllProperties('rrule');
          var i = 0;
          var len = rules.length;
          var rule;
          var iter;
          for (; i < len; i++) {
            rule = rules[i].getFirstValue();
            iter = rule.iterator(this.dtstart);
            this.ruleIterators.push(iter);

            // increment to the next occurrence so future
            // calls to next return times beyond the initial iteration.
            // XXX: I find this suspicious might be a bug?
            iter.next();
          }
        }
        if (component.hasProperty('exdate')) {
          this.exDates = this._extractDates(component, 'exdate');
          // if we have a .last day we increment the index to beyond it.
          // When DTSTART is in DATE-TIME format, EXDATE is in DATE format and EXDATE is
          // the date of DTSTART, _compare_special finds this out and compareTime fails.
          this.exDateInc = binsearchInsert(this.exDates, this.last, this._compare_special);
          this.exDate = this.exDates[this.exDateInc];
        }
      }

      /**
       * Advance to the next exdate
       * @private
       */
    }, {
      key: "_nextExDay",
      value: function _nextExDay() {
        this.exDate = this.exDates[++this.exDateInc];
      }

      /**
       * Advance to the next rule date
       * @private
       */
    }, {
      key: "_nextRuleDay",
      value: function _nextRuleDay() {
        this.ruleDate = this.ruleDates[++this.ruleDateInc];
      }

      /**
       * Find and return the recurrence rule with the most recent event and
       * return it.
       *
       * @private
       * @return {?RecurIterator}    Found iterator.
       */
    }, {
      key: "_nextRecurrenceIter",
      value: function _nextRecurrenceIter() {
        var iters = this.ruleIterators;
        if (iters.length === 0) {
          return null;
        }
        var len = iters.length;
        var iter;
        var iterTime;
        var iterIdx = 0;
        var chosenIter;

        // loop through each iterator
        for (; iterIdx < len; iterIdx++) {
          iter = iters[iterIdx];
          iterTime = iter.last;

          // if iteration is complete
          // then we must exclude it from
          // the search and remove it.
          if (iter.completed) {
            len--;
            if (iterIdx !== 0) {
              iterIdx--;
            }
            iters.splice(iterIdx, 1);
            continue;
          }

          // find the most recent possible choice
          if (!chosenIter || chosenIter.last.compare(iterTime) > 0) {
            // that iterator is saved
            chosenIter = iter;
          }
        }

        // the chosen iterator is returned but not mutated
        // this iterator contains the most recent event.
        return chosenIter;
      }
    }]);
  }();

  /**
   * This lets typescript resolve our custom types in the
   * generated d.ts files (jsdoc typedefs are converted to typescript types).
   * Ignore prevents the typedefs from being documented more than once.
   * @ignore
   * @typedef {import("./types.js").frequencyValues} frequencyValues
   * Imports the 'frequencyValues' type from the "types.js" module
   * @typedef {import("./types.js").occurrenceDetails} occurrenceDetails
   * Imports the 'occurrenceDetails' type from the "types.js" module
   */

  /**
   * ICAL.js is organized into multiple layers. The bottom layer is a raw jCal
   * object, followed by the component/property layer. The highest level is the
   * event representation, which this class is part of. See the
   * {@tutorial layers} guide for more details.
   *
   * @memberof ICAL
   */
  var Event = /*#__PURE__*/function () {
    /**
     * Creates a new ICAL.Event instance.
     *
     * @param {Component=} component              The ICAL.Component to base this event on
     * @param {Object} [options]                  Options for this event
     * @param {Boolean=} options.strictExceptions  When true, will verify exceptions are related by
     *                                              their UUID
     * @param {Array<Component|Event>=} options.exceptions
     *          Exceptions to this event, either as components or events. If not
     *            specified exceptions will automatically be set in relation of
     *            component's parent
     */
    function Event(component, options) {
      _classCallCheck(this, Event);
      /**
       * List of related event exceptions.
       *
       * @type {Event[]}
       */
      _defineProperty(this, "exceptions", null);
      /**
       * When true, will verify exceptions are related by their UUID.
       *
       * @type {Boolean}
       */
      _defineProperty(this, "strictExceptions", false);
      if (!(component instanceof Component)) {
        options = component;
        component = null;
      }
      if (component) {
        this.component = component;
      } else {
        this.component = new Component('vevent');
      }
      this._rangeExceptionCache = Object.create(null);
      this.exceptions = Object.create(null);
      this.rangeExceptions = [];
      if (options && options.strictExceptions) {
        this.strictExceptions = options.strictExceptions;
      }
      if (options && options.exceptions) {
        options.exceptions.forEach(this.relateException, this);
      } else if (this.component.parent && !this.isRecurrenceException()) {
        this.component.parent.getAllSubcomponents('vevent').forEach(function (event) {
          if (event.hasProperty('recurrence-id')) {
            this.relateException(event);
          }
        }, this);
      }
    }
    return _createClass(Event, [{
      key: "relateException",
      value:
      /**
       * Relates a given event exception to this object.  If the given component
       * does not share the UID of this event it cannot be related and will throw
       * an exception.
       *
       * If this component is an exception it cannot have other exceptions
       * related to it.
       *
       * @param {Component|Event} obj       Component or event
       */
      function relateException(obj) {
        if (this.isRecurrenceException()) {
          throw new Error('cannot relate exception to exceptions');
        }
        if (obj instanceof Component) {
          obj = new Event(obj);
        }
        if (this.strictExceptions && obj.uid !== this.uid) {
          throw new Error('attempted to relate unrelated exception');
        }
        var id = obj.recurrenceId.toString();

        // we don't sort or manage exceptions directly
        // here the recurrence expander handles that.
        this.exceptions[id] = obj;

        // index RANGE=THISANDFUTURE exceptions so we can
        // look them up later in getOccurrenceDetails.
        if (obj.modifiesFuture()) {
          var item = [obj.recurrenceId.toUnixTime(), id];

          // we keep them sorted so we can find the nearest
          // value later on...
          var idx = binsearchInsert(this.rangeExceptions, item, compareRangeException);
          this.rangeExceptions.splice(idx, 0, item);
        }
      }

      /**
       * Checks if this record is an exception and has the RANGE=THISANDFUTURE
       * value.
       *
       * @return {Boolean}        True, when exception is within range
       */
    }, {
      key: "modifiesFuture",
      value: function modifiesFuture() {
        if (!this.component.hasProperty('recurrence-id')) {
          return false;
        }
        var range = this.component.getFirstProperty('recurrence-id').getParameter('range');
        return range === Event.THISANDFUTURE;
      }

      /**
       * Finds the range exception nearest to the given date.
       *
       * @param {Time} time   usually an occurrence time of an event
       * @return {?Event}     the related event/exception or null
       */
    }, {
      key: "findRangeException",
      value: function findRangeException(time) {
        if (!this.rangeExceptions.length) {
          return null;
        }
        var utc = time.toUnixTime();
        var idx = binsearchInsert(this.rangeExceptions, [utc], compareRangeException);
        idx -= 1;

        // occurs before
        if (idx < 0) {
          return null;
        }
        var rangeItem = this.rangeExceptions[idx];

        /* c8 ignore next 4 */
        if (utc < rangeItem[0]) {
          // sanity check only
          return null;
        }
        return rangeItem[1];
      }

      /**
       * Returns the occurrence details based on its start time.  If the
       * occurrence has an exception will return the details for that exception.
       *
       * NOTE: this method is intend to be used in conjunction
       *       with the {@link ICAL.Event#iterator iterator} method.
       *
       * @param {Time} occurrence               time occurrence
       * @return {occurrenceDetails}            Information about the occurrence
       */
    }, {
      key: "getOccurrenceDetails",
      value: function getOccurrenceDetails(occurrence) {
        var id = occurrence.toString();
        var utcId = occurrence.convertToZone(Timezone.utcTimezone).toString();
        var item;
        var result = {
          //XXX: Clone?
          recurrenceId: occurrence
        };
        if (id in this.exceptions) {
          item = result.item = this.exceptions[id];
          result.startDate = item.startDate;
          result.endDate = item.endDate;
          result.item = item;
        } else if (utcId in this.exceptions) {
          item = this.exceptions[utcId];
          result.startDate = item.startDate;
          result.endDate = item.endDate;
          result.item = item;
        } else {
          // range exceptions (RANGE=THISANDFUTURE) have a
          // lower priority then direct exceptions but
          // must be accounted for first. Their item is
          // always the first exception with the range prop.
          var rangeExceptionId = this.findRangeException(occurrence);
          var end;
          if (rangeExceptionId) {
            var exception = this.exceptions[rangeExceptionId];

            // range exception must modify standard time
            // by the difference (if any) in start/end times.
            result.item = exception;
            var startDiff = this._rangeExceptionCache[rangeExceptionId];
            if (!startDiff) {
              var original = exception.recurrenceId.clone();
              var newStart = exception.startDate.clone();

              // zones must be same otherwise subtract may be incorrect.
              original.zone = newStart.zone;
              startDiff = newStart.subtractDate(original);
              this._rangeExceptionCache[rangeExceptionId] = startDiff;
            }
            var start = occurrence.clone();
            start.zone = exception.startDate.zone;
            start.addDuration(startDiff);
            end = start.clone();
            end.addDuration(exception.duration);
            result.startDate = start;
            result.endDate = end;
          } else {
            // no range exception standard expansion
            end = occurrence.clone();
            end.addDuration(this.duration);
            result.endDate = end;
            result.startDate = occurrence;
            result.item = this;
          }
        }
        return result;
      }

      /**
       * Builds a recur expansion instance for a specific point in time (defaults
       * to startDate).
       *
       * @param {Time=} startTime     Starting point for expansion
       * @return {RecurExpansion}    Expansion object
       */
    }, {
      key: "iterator",
      value: function iterator(startTime) {
        return new RecurExpansion({
          component: this.component,
          dtstart: startTime || this.startDate
        });
      }

      /**
       * Checks if the event is recurring
       *
       * @return {Boolean}        True, if event is recurring
       */
    }, {
      key: "isRecurring",
      value: function isRecurring() {
        var comp = this.component;
        return comp.hasProperty('rrule') || comp.hasProperty('rdate');
      }

      /**
       * Checks if the event describes a recurrence exception. See
       * {@tutorial terminology} for details.
       *
       * @return {Boolean}    True, if the event describes a recurrence exception
       */
    }, {
      key: "isRecurrenceException",
      value: function isRecurrenceException() {
        return this.component.hasProperty('recurrence-id');
      }

      /**
       * Returns the types of recurrences this event may have.
       *
       * Returned as an object with the following possible keys:
       *
       *    - YEARLY
       *    - MONTHLY
       *    - WEEKLY
       *    - DAILY
       *    - MINUTELY
       *    - SECONDLY
       *
       * @return {Object.<frequencyValues, Boolean>}
       *          Object of recurrence flags
       */
    }, {
      key: "getRecurrenceTypes",
      value: function getRecurrenceTypes() {
        var rules = this.component.getAllProperties('rrule');
        var i = 0;
        var len = rules.length;
        var result = Object.create(null);
        for (; i < len; i++) {
          var value = rules[i].getFirstValue();
          result[value.freq] = true;
        }
        return result;
      }

      /**
       * The uid of this event
       * @type {String}
       */
    }, {
      key: "uid",
      get: function get() {
        return this._firstProp('uid');
      },
      set: function set(value) {
        this._setProp('uid', value);
      }

      /**
       * The start date
       * @type {Time}
       */
    }, {
      key: "startDate",
      get: function get() {
        return this._firstProp('dtstart');
      },
      set: function set(value) {
        this._setTime('dtstart', value);
      }

      /**
       * The end date. This can be the result directly from the property, or the
       * end date calculated from start date and duration. Setting the property
       * will remove any duration properties.
       * @type {Time}
       */
    }, {
      key: "endDate",
      get: function get() {
        var endDate = this._firstProp('dtend');
        if (!endDate) {
          var duration = this._firstProp('duration');
          endDate = this.startDate.clone();
          if (duration) {
            endDate.addDuration(duration);
          } else if (endDate.isDate) {
            endDate.day += 1;
          }
        }
        return endDate;
      },
      set: function set(value) {
        if (this.component.hasProperty('duration')) {
          this.component.removeProperty('duration');
        }
        this._setTime('dtend', value);
      }

      /**
       * The duration. This can be the result directly from the property, or the
       * duration calculated from start date and end date. Setting the property
       * will remove any `dtend` properties.
       * @type {Duration}
       */
    }, {
      key: "duration",
      get: function get() {
        var duration = this._firstProp('duration');
        if (!duration) {
          return this.endDate.subtractDateTz(this.startDate);
        }
        return duration;
      },
      set: function set(value) {
        if (this.component.hasProperty('dtend')) {
          this.component.removeProperty('dtend');
        }
        this._setProp('duration', value);
      }

      /**
       * The location of the event.
       * @type {String}
       */
    }, {
      key: "location",
      get: function get() {
        return this._firstProp('location');
      },
      set: function set(value) {
        this._setProp('location', value);
      }

      /**
       * The attendees in the event
       * @type {Property[]}
       */
    }, {
      key: "attendees",
      get: function get() {
        //XXX: This is way lame we should have a better
        //     data structure for this later.
        return this.component.getAllProperties('attendee');
      }

      /**
       * The event summary
       * @type {String}
       */
    }, {
      key: "summary",
      get: function get() {
        return this._firstProp('summary');
      },
      set: function set(value) {
        this._setProp('summary', value);
      }

      /**
       * The event description.
       * @type {String}
       */
    }, {
      key: "description",
      get: function get() {
        return this._firstProp('description');
      },
      set: function set(value) {
        this._setProp('description', value);
      }

      /**
       * The event color from [rfc7986](https://datatracker.ietf.org/doc/html/rfc7986)
       * @type {String}
       */
    }, {
      key: "color",
      get: function get() {
        return this._firstProp('color');
      },
      set: function set(value) {
        this._setProp('color', value);
      }

      /**
       * The organizer value as an uri. In most cases this is a mailto: uri, but
       * it can also be something else, like urn:uuid:...
       * @type {String}
       */
    }, {
      key: "organizer",
      get: function get() {
        return this._firstProp('organizer');
      },
      set: function set(value) {
        this._setProp('organizer', value);
      }

      /**
       * The sequence value for this event. Used for scheduling
       * see {@tutorial terminology}.
       * @type {Number}
       */
    }, {
      key: "sequence",
      get: function get() {
        return this._firstProp('sequence');
      },
      set: function set(value) {
        this._setProp('sequence', value);
      }

      /**
       * The recurrence id for this event. See {@tutorial terminology} for details.
       * @type {Time}
       */
    }, {
      key: "recurrenceId",
      get: function get() {
        return this._firstProp('recurrence-id');
      },
      set: function set(value) {
        this._setTime('recurrence-id', value);
      }

      /**
       * Set/update a time property's value.
       * This will also update the TZID of the property.
       *
       * TODO: this method handles the case where we are switching
       * from a known timezone to an implied timezone (one without TZID).
       * This does _not_ handle the case of moving between a known
       *  (by TimezoneService) timezone to an unknown timezone...
       *
       * We will not add/remove/update the VTIMEZONE subcomponents
       *  leading to invalid ICAL data...
       * @private
       * @param {String} propName     The property name
       * @param {Time} time           The time to set
       */
    }, {
      key: "_setTime",
      value: function _setTime(propName, time) {
        var prop = this.component.getFirstProperty(propName);
        if (!prop) {
          prop = new Property(propName);
          this.component.addProperty(prop);
        }

        // utc and local don't get a tzid
        if (time.zone === Timezone.localTimezone || time.zone === Timezone.utcTimezone) {
          // remove the tzid
          prop.removeParameter('tzid');
        } else {
          prop.setParameter('tzid', time.zone.tzid);
        }
        prop.setValue(time);
      }
    }, {
      key: "_setProp",
      value: function _setProp(name, value) {
        this.component.updatePropertyWithValue(name, value);
      }
    }, {
      key: "_firstProp",
      value: function _firstProp(name) {
        return this.component.getFirstPropertyValue(name);
      }

      /**
       * The string representation of this event.
       * @return {String}
       */
    }, {
      key: "toString",
      value: function toString() {
        return this.component.toString();
      }
    }]);
  }();
  _defineProperty(Event, "THISANDFUTURE", 'THISANDFUTURE');
  function compareRangeException(a, b) {
    if (a[0] > b[0]) return 1;
    if (b[0] > a[0]) return -1;
    return 0;
  }

  /**
   * The ComponentParser is used to process a String or jCal Object,
   * firing callbacks for various found components, as well as completion.
   *
   * @example
   * var options = {
   *   // when false no events will be emitted for type
   *   parseEvent: true,
   *   parseTimezone: true
   * };
   *
   * var parser = new ICAL.ComponentParser(options);
   *
   * parser.onevent(eventComponent) {
   *   //...
   * }
   *
   * // ontimezone, etc...
   *
   * parser.oncomplete = function() {
   *
   * };
   *
   * parser.process(stringOrComponent);
   *
   * @memberof ICAL
   */
  var ComponentParser = /*#__PURE__*/function () {
    /**
     * Creates a new ICAL.ComponentParser instance.
     *
     * @param {Object=} options                   Component parser options
     * @param {Boolean} options.parseEvent        Whether events should be parsed
     * @param {Boolean} options.parseTimezeone    Whether timezones should be parsed
     */
    function ComponentParser(options) {
      _classCallCheck(this, ComponentParser);
      /**
       * When true, parse events
       *
       * @type {Boolean}
       */
      _defineProperty(this, "parseEvent", true);
      /**
       * When true, parse timezones
       *
       * @type {Boolean}
       */
      _defineProperty(this, "parseTimezone", true);
      /* SAX like events here for reference */
      /**
       * Fired when parsing is complete
       * @callback
       */
      _defineProperty(this, "oncomplete", /* c8 ignore next */function () {});
      /**
       * Fired if an error occurs during parsing.
       *
       * @callback
       * @param {Error} err details of error
       */
      _defineProperty(this, "onerror", /* c8 ignore next */function (err) {});
      /**
       * Fired when a top level component (VTIMEZONE) is found
       *
       * @callback
       * @param {Timezone} component     Timezone object
       */
      _defineProperty(this, "ontimezone", /* c8 ignore next */function (component) {});
      /**
       * Fired when a top level component (VEVENT) is found.
       *
       * @callback
       * @param {Event} component    Top level component
       */
      _defineProperty(this, "onevent", /* c8 ignore next */function (component) {});
      if (typeof options === 'undefined') {
        options = {};
      }
      for (var _i = 0, _Object$entries = Object.entries(options); _i < _Object$entries.length; _i++) {
        var _Object$entries$_i = _slicedToArray(_Object$entries[_i], 2),
          key = _Object$entries$_i[0],
          value = _Object$entries$_i[1];
        this[key] = value;
      }
    }
    return _createClass(ComponentParser, [{
      key: "process",
      value:
      /**
       * Process a string or parse ical object.  This function itself will return
       * nothing but will start the parsing process.
       *
       * Events must be registered prior to calling this method.
       *
       * @param {Component|String|Object} ical      The component to process,
       *        either in its final form, as a jCal Object, or string representation
       */
      function process(ical) {
        //TODO: this is sync now in the future we will have a incremental parser.
        if (typeof ical === 'string') {
          ical = parse(ical);
        }
        if (!(ical instanceof Component)) {
          ical = new Component(ical);
        }
        var components = ical.getAllSubcomponents();
        var i = 0;
        var len = components.length;
        var component;
        for (; i < len; i++) {
          component = components[i];
          switch (component.name) {
            case 'vtimezone':
              if (this.parseTimezone) {
                var tzid = component.getFirstPropertyValue('tzid');
                if (tzid) {
                  this.ontimezone(new Timezone({
                    tzid: tzid,
                    component: component
                  }));
                }
              }
              break;
            case 'vevent':
              if (this.parseEvent) {
                this.onevent(new Event(component));
              }
              break;
            default:
              continue;
          }
        }

        //XXX: ideally we should do a "nextTick" here
        //     so in all cases this is actually async.
        this.oncomplete();
      }
    }]);
  }();

  /* This Source Code Form is subject to the terms of the Mozilla Public
   * License, v. 2.0. If a copy of the MPL was not distributed with this
   * file, You can obtain one at http://mozilla.org/MPL/2.0/.
   * Portions Copyright (C) Philipp Kewisch */


  /**
   * The main ICAL module. Provides access to everything else.
   *
   * @alias ICAL
   * @namespace ICAL
   * @property {ICAL.design} design
   * @property {ICAL.helpers} helpers
   */
  var ICALmodule = {
    /**
     * The number of characters before iCalendar line folding should occur
     * @type {Number}
     * @default 75
     */
    foldLength: 75,
    debug: false,
    /**
     * The character(s) to be used for a newline. The default value is provided by
     * rfc5545.
     * @type {String}
     * @default "\r\n"
     */
    newLineChar: '\r\n',
    Binary: Binary,
    Component: Component,
    ComponentParser: ComponentParser,
    Duration: Duration,
    Event: Event,
    Period: Period,
    Property: Property,
    Recur: Recur,
    RecurExpansion: RecurExpansion,
    RecurIterator: RecurIterator,
    Time: Time,
    Timezone: Timezone,
    TimezoneService: TimezoneService,
    UtcOffset: UtcOffset,
    VCardTime: VCardTime,
    parse: parse,
    stringify: stringify,
    design: design,
    helpers: helpers
  };

  return ICALmodule;

}));

return module.exports; })();
'use strict';
// A read-only iCalendar adapter. Parsing stays local; this module makes no requests.

const { meetingLink } = getHomeMeetingLinks();

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
return { validateGoogleCalendarUrl, calendarAgenda };

  })();
  return homeCalendarAdapter;
}
// END LOCAL CALENDAR BUNDLE

let homeGoogleAdapter;
function getHomeGoogleAdapter() {
  if (!homeGoogleAdapter) homeGoogleAdapter = (() => {
'use strict';
const { meetingLink } = getHomeMeetingLinks();
// Read-only Calendar API adapter. Only the temporary OAuth callback uses Node.
const GOOGLE_SCOPE='https://www.googleapis.com/auth/calendar.events.owned.readonly';
function parseGoogleClient(value) {
  let c;try {c=JSON.parse(value).installed;}catch(_){}
  if(!c || typeof c.client_id!=='string' || !/^[\w-]+\.apps\.googleusercontent\.com$/.test(c.client_id) ||
     (c.client_secret!==undefined && (typeof c.client_secret!=='string' || c.client_secret.length>500)))
    throw Error('Paste the downloaded OAuth client JSON for a Desktop app.');
  return {clientId:c.client_id,clientSecret:c.client_secret||''};
}
function googleAuthorizationUrl(client,redirect,state,challenge) {
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search=new URLSearchParams({client_id:client.clientId,redirect_uri:redirect,response_type:'code',scope:GOOGLE_SCOPE,
    state,code_challenge:challenge,code_challenge_method:'S256',access_type:'offline',prompt:'consent'}).toString();
  return url.href;
}
async function startGoogleAuthorization(client,{timeoutMs=180000}={}) {
  let http,crypto;try {http=require('http');crypto=require('crypto');}catch(_){throw Error('Google sign-in is available in desktop Obsidian.');}
  const verifier=crypto.randomBytes(32).toString('base64url'),state=crypto.randomBytes(32).toString('hex');
  const challenge=crypto.createHash('sha256').update(verifier).digest('base64url');
  let resolveResult,rejectResult,timer,settled=false,redirect;
  const result=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
  result.catch(()=>{}); // Cancellation may precede the browser opener finishing.
  const finish=(error,code)=>{
    if(settled)return;settled=true;clearTimeout(timer);server.close();server.closeIdleConnections?.();if(error)server.closeAllConnections?.();
    if(error)rejectResult(error);else resolveResult({code,verifier,redirect});
  };
  const server=http.createServer((req,res)=>{
    res.setHeader('Content-Type','text/plain; charset=utf-8');res.setHeader('Cache-Control','no-store');
    res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Connection','close');
    let url;try{url=new URL(req.url,'http://127.0.0.1');}catch(_){}
    if(settled || req.method!=='GET' || !url || url.pathname!=='/callback' || req.url.length>8192 || url.searchParams.get('state')!==state) {
      res.writeHead(400);res.end('Invalid sign-in response. Return to Obsidian.');return;
    }
    const code=url.searchParams.get('code');
    if(url.searchParams.has('error') || !code){res.end('Sign-in was not completed. Return to Obsidian.');finish(Error('Google sign-in was declined or blocked by your organization.'));return;}
    res.end('Google returned your sign-in. Return to Obsidian to check the connection.');finish(null,code);
  });
  server.requestTimeout=10000;server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{
    server.once('error',()=>reject(Error('Could not open the local sign-in callback.')));
    server.listen(0,'127.0.0.1',resolve);
  });
  server.on('error',()=>finish(Error('Local sign-in connection failed.')));
  redirect=`http://127.0.0.1:${server.address().port}/callback`;
  timer=setTimeout(()=>finish(Error('Google sign-in timed out. Try again.')),timeoutMs);
  return {url:googleAuthorizationUrl(client,redirect,state,challenge),result,cancel:()=>finish(Error('Google sign-in cancelled.'))};
}
function googleFailure(stage,status,data) {
  const error=data?.error;
  const reasons=typeof error==='string'?[error]:[
    ...(Array.isArray(error?.errors)?error.errors.map(item=>item?.reason):[]),
    ...(Array.isArray(error?.details)?error.details.map(item=>item?.reason):[])
  ];
  let help='Check account access and try again.';
  if(reasons.some(reason=>reason==='SERVICE_DISABLED'||reason==='accessNotConfigured'))
    help='Google Calendar API is not enabled. Enable it in the same Google Cloud project as this Desktop client, then try again.';
  else if(reasons.some(reason=>reason==='ACCESS_TOKEN_SCOPE_INSUFFICIENT'||reason==='insufficientPermissions'))
    help='Calendar read permission is missing. Sign in again and allow the requested calendar permission.';
  else if(reasons.includes('invalid_grant'))
    help=stage==='Google token refresh'?'The saved sign-in is no longer valid. Reconnect Google Calendar.':'The sign-in code was rejected. Start a new sign-in and keep this window open.';
  else if(reasons.some(reason=>reason==='invalid_client'||reason==='unauthorized_client'))
    help='The Desktop client was rejected. Import its current OAuth client JSON and check the client configuration.';
  else if(reasons.includes('access_denied'))help='Account access was denied. Check the account or organization policy.';
  else if(status===429 || reasons.some(reason=>['rateLimitExceeded','userRateLimitExceeded','quotaExceeded'].includes(reason)))
    help='Google temporarily limited requests. Wait before trying again.';
  else if(status===401)help='The sign-in is no longer valid. Reconnect Google Calendar.';
  // Only fixed local text and numeric HTTP status escape this boundary. Never show remote messages or metadata.
  return Error(`${stage} failed${Number.isInteger(status)&&status>=100&&status<=599?` (HTTP ${status})`:''}. ${help}`);
}
async function googleRequest(request,args,stage) {
  let timer,r,timedOut=false;
  try {
    r=await Promise.race([request({...args,throw:false}),new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;reject(Error());},20000);})]);
  }catch(_){throw Error(`${stage} ${timedOut?'timed out':'could not connect to Google (network error)'}. Check the connection and try again.`);}
  finally{clearTimeout(timer);}
  let data;try{data=r?.json ?? JSON.parse(r?.text);}catch(_){}
  if(r?.status!==200)throw googleFailure(stage,r?.status,data);
  if(!data || typeof data!=='object')throw Error(`${stage} returned an unreadable response. Try again.`);
  return data;
}
async function tokenRequest(request,client,params,requireRefresh) {
  const body=new URLSearchParams({client_id:client.clientId,...params});if(client.clientSecret)body.set('client_secret',client.clientSecret);
  const data=await googleRequest(request,{url:'https://oauth2.googleapis.com/token',method:'POST',contentType:'application/x-www-form-urlencoded',body:body.toString()},requireRefresh?'Google token exchange':'Google token refresh');
  if((requireRefresh || data.scope) && (typeof data.scope!=='string' || !data.scope.split(' ').includes(GOOGLE_SCOPE)))throw Error('Read-only calendar permission was not granted.');
  if(typeof data.access_token!=='string' || !data.access_token || (requireRefresh && typeof data.refresh_token!=='string'))throw Error('Google did not return a usable sign-in. Try again.');
  return {accessToken:data.access_token,refreshToken:data.refresh_token||client.refreshToken,expiresAt:Date.now()+Math.max(60,Number(data.expires_in)||3600)*1000};
}
function exchangeGoogleCode(request,client,code,verifier,redirect) {
  return tokenRequest(request,client,{code,code_verifier:verifier,redirect_uri:redirect,grant_type:'authorization_code'},true);
}
function refreshGoogleToken(request,client) {return tokenRequest(request,client,{refresh_token:client.refreshToken,grant_type:'refresh_token'},false);}
function googleEventDate(value) {
  if(value?.date && /^\d{4}-\d{2}-\d{2}$/.test(value.date))return new Date(value.date+'T00:00:00');
  if(typeof value?.dateTime==='string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value.dateTime))return new Date(value.dateTime);
  throw Error('Google returned an unsupported event date.');
}
async function fetchGoogleEvents(request,token,from,until) {
  const result=[];let pageToken='';const seen=new Set();
  for(let page=0;page<20;page++) {
    const url=new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    url.search=new URLSearchParams({timeMin:from.toISOString(),timeMax:until.toISOString(),singleEvents:'true',orderBy:'startTime',showDeleted:'false',maxResults:'250',...(pageToken?{pageToken}:{})}).toString();
    const data=await googleRequest(request,{url:url.href,method:'GET',headers:{Authorization:`Bearer ${token}`}},'Google Calendar API');
    if(!Array.isArray(data.items))throw Error('Google returned an incomplete calendar response.');
    for(const item of data.items){
      if(item.status==='cancelled')continue;
      const start=googleEventDate(item.start),end=googleEventDate(item.end);
      if(!Number.isFinite(+start)||!Number.isFinite(+end))throw Error('Google returned an invalid event date.');
      const video = Array.isArray(item.conferenceData?.entryPoints) ? item.conferenceData.entryPoints.filter(p=>p?.entryPointType==='video').map(p=>p.uri) : [];
      const joinUrl = meetingLink([...video, item.hangoutLink], [item.location, item.description]);
      result.push({id:item.id,title:typeof item.summary==='string'?item.summary:'Untitled event',start:start.toISOString(),end:end.toISOString(),allDay:!!item.start.date,joinUrl});
    }
    if(!data.nextPageToken)return result;
    if(typeof data.nextPageToken!=='string'||seen.has(data.nextPageToken))throw Error('Google calendar pagination failed.');
    pageToken=data.nextPageToken;seen.add(pageToken);
  }
  throw Error('This calendar range is too large. Choose a smaller range.');
}
return {GOOGLE_SCOPE,parseGoogleClient,googleAuthorizationUrl,startGoogleAuthorization,exchangeGoogleCode,refreshGoogleToken,fetchGoogleEvents};

  })();
  return homeGoogleAdapter;
}

function getHomeMeetingLinks() {
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
return { safeMeetingUrl, meetingProvider, meetingLink };

}
