const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual process boundary with a fake child; never launch Mail.
function bridge() {
  const calls = [];
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const context = {module:{exports:{}}, require(name) {
    if (name === 'obsidian') return {Plugin:class {}, Modal:class {}};
    if (name === 'child_process') return {execFile(binary,args,options,callback) {
      const child = {kill() {}}; calls.push({binary,args,options,callback,child}); return child;
    }};
    if (name === 'path') return path;
    if (name === 'fs') return {existsSync:()=>true};
    throw Error('Unexpected module: '+name);
  }};
  vm.runInNewContext(source, context);
  const plugin = new context.module.exports();
  Object.assign(plugin,{active:true,mailEnabled:true,mailProcesses:new Set(),mailSupported:()=>true,
    manifest:{dir:'.obsidian/plugins/aimultiple-kanban-extras'},
    app:{vault:{adapter:{getFullPath:p=>'/synthetic/vault/'+p}}}});
  return {plugin,calls};
}

test('Mail bridge pins osascript, passes literal arguments and bounds process time and output',async()=>{
  const {plugin,calls}=bridge();
  const list=plugin.runMailBridge(['list']);
  const a=calls[0];
  assert.equal(a.binary,'/usr/bin/osascript');
  assert.equal(a.options.shell,undefined);
  assert.equal(a.options.timeout,90000);assert.equal(a.options.maxBuffer,4*1024*1024);
  assert.equal(a.options.killSignal,'SIGKILL');
  assert.equal(a.args[2],'/synthetic/vault/.obsidian/plugins/aimultiple-kanban-extras/scripts/read-mail.applescript');
  a.callback(null,JSON.stringify({schema:1,accounts:[],rows:[]}),'');await list;
  assert.equal(plugin.mailProcesses.size,0);
  const literal='$(touch NEVER) " ; `ignored`';
  const open=plugin.runMailBridge(['open',literal,'INBOX','12','fixture@example.test']);
  assert.equal(calls[1].args[4],literal);assert.equal(calls[1].options.timeout,20000);
  calls[1].callback(null,'{"ok":true}','');await open;
  await assert.rejects(plugin.runMailBridge(['delete','12']));assert.equal(calls.length,2);
});

test('Mail bridge hides private process errors and distinguishes permission denial and timeout',async()=>{
  const {plugin,calls}=bridge();
  for (const [error,stdout,stderr,code] of [
    [Error('PRIVATE_BODY'),'','PRIVATE_SENDER (-1743)',-1743],
    [Object.assign(Error('PRIVATE_BODY'),{killed:true}),'','',-1712],
    [null,'{"ok":false,"code":-2702,"stage":"accounts"}','',-2702],
  ]) {
    const job=plugin.runMailBridge(['list']);calls.at(-1).callback(error,stdout,stderr);
    await assert.rejects(job,e=>e.mailCode===code&&!e.message.includes('PRIVATE'));
  }
});

test('Mail opening requires a row from the current snapshot and prevents duplicate opens',async()=>{
  const {plugin,calls}=bridge();
  const row={id:12,accountId:'a',mailbox:'INBOX',messageId:'fixture@example.test'};
  plugin.mailSnapshot={rows:[row]};
  await plugin.openMailMessage({...row});assert.equal(calls.length,0);
  const job=plugin.openMailMessage(row);await plugin.openMailMessage(row);
  assert.equal(calls.length,1);
  assert.deepEqual(Array.from(calls[0].args.slice(3)),['open','a','INBOX','12','fixture@example.test']);
  calls[0].callback(null,'{"ok":true}','');await job;assert.equal(plugin.mailOpenBusy,false);
});
