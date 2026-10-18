const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=path.join(__dirname,'../google-calendar.js');
function api(){assert.ok(fs.existsSync(source),'Read-only Google sign-in adapter must be implemented');return require(source);}
test('Agenda retains video conference links, prefers structured video, and extracts safe Zoom/Meet links',async()=>{
 const a=api();const base={start:{date:'2026-10-17'},end:{date:'2026-10-18'}};
 const items=[
  {...base,conferenceData:{entryPoints:[{entryPointType:'phone',uri:'tel:+123'},{entryPointType:'video',uri:'https://us02web.zoom.us/j/123?pwd=abc'}]},hangoutLink:'https://meet.google.com/aaa-bbbb-ccc'},
  {...base,hangoutLink:'https://meet.google.com/aaa-bbbb-ccc'},
  {...base,description:'Notes <a href="https://zoom.us/j/123?pwd=a&amp;from=b">Join</a>'},
  {...base,location:'Call (https://meet.google.com/ddd-eeee-fff).'},
  {...base,description:'https://zoom.us.evil.test/j/123 https://meet.google.com@evil.test/x javascript:alert(1)'},
  {...base,conferenceData:{entryPoints:[{entryPointType:'video',uri:'javascript:alert(1)'}]}}
 ];
 const events=await a.fetchGoogleEvents(async()=>({status:200,json:{items}}),'fake',new Date('2026-10-01'),new Date('2026-11-01'));
 assert.deepEqual(events.map(e=>e.joinUrl||''),['https://us02web.zoom.us/j/123?pwd=abc','https://meet.google.com/aaa-bbbb-ccc','https://zoom.us/j/123?pwd=a&from=b','https://meet.google.com/ddd-eeee-fff','','']);
});
const client={installed:{client_id:'123-fixture.apps.googleusercontent.com',client_secret:'fixture-only',redirect_uris:['http://localhost']}};
test('Google sign-in accepts desktop clients and requests only owned calendar event read access',()=>{
 const a=api();const c=a.parseGoogleClient(JSON.stringify(client));assert.equal(c.clientId,client.installed.client_id);
 assert.throws(()=>a.parseGoogleClient(JSON.stringify({web:client.installed})),/Desktop/);
 assert.throws(()=>a.parseGoogleClient('{bad'),/Desktop/);
 const url=new URL(a.googleAuthorizationUrl(c,'http://127.0.0.1:54321/callback','state','challenge'));
 assert.equal(url.origin,'https://accounts.google.com');assert.equal(url.searchParams.get('scope'),'https://www.googleapis.com/auth/calendar.events.owned.readonly');
 assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('access_type'),'offline');
 assert.ok(!url.href.includes('fixture-only'));
});
test('Google API pagination returns recurring-instance results without trusting remote next-page URLs',async()=>{
 const a=api(),requests=[];
 const request=async args=>{requests.push(args);return {status:200,json:requests.length===1?{items:[{id:'1',summary:'Meeting',start:{dateTime:'2026-10-16T10:00:00+03:00'},end:{dateTime:'2026-10-16T11:00:00+03:00'}}],nextPageToken:'page-two'}:{items:[{id:'2',summary:'Day off',start:{date:'2026-10-17'},end:{date:'2026-10-18'}},{id:'3',status:'cancelled'}]}};};
 const result=await a.fetchGoogleEvents(request,'access-token',new Date('2026-10-16'),new Date('2026-10-20'));
 assert.equal(result.length,2);assert.equal(result[0].start,'2026-10-16T07:00:00.000Z');assert.equal(result[1].allDay,true);
 for(const r of requests){const u=new URL(r.url);assert.equal(r.method,'GET');assert.equal(u.origin,'https://www.googleapis.com');assert.equal(u.searchParams.get('singleEvents'),'true');assert.equal(r.headers.Authorization,'Bearer access-token');assert.ok(!r.url.includes('access-token'));}
 assert.equal(new URL(requests[1].url).searchParams.get('pageToken'),'page-two');
});
test('Google token exchange and refresh keep secrets in POST bodies and redact failures',async()=>{
 const a=api(),requests=[],c=a.parseGoogleClient(JSON.stringify(client));
 const request=async args=>{requests.push(args);return {status:200,json:{access_token:'access',refresh_token:'refresh',expires_in:3600,scope:a.GOOGLE_SCOPE}};};
 const token=await a.exchangeGoogleCode(request,c,'code','verifier','http://127.0.0.1:54321/callback');assert.equal(token.refreshToken,'refresh');
 await a.refreshGoogleToken(request,{...c,refreshToken:'refresh'});
 for(const r of requests){assert.equal(r.url,'https://oauth2.googleapis.com/token');assert.equal(r.method,'POST');assert.ok(r.body.includes('client_secret='));}
 await assert.rejects(a.refreshGoogleToken(async()=>{throw Error('SECRET');},{...c,refreshToken:'refresh'}),e=>!e.message.includes('SECRET'));
 await assert.rejects(a.exchangeGoogleCode(async()=>({status:200,json:{access_token:'access',refresh_token:'refresh',expires_in:3600,scope:'other'}}),c,'code','verifier','http://127.0.0.1:54321/callback'),/permission/);
});
test('OAuth loopback rejects wrong state, accepts only local callback, and closes after completion',async()=>{
 const a=api();const session=await a.startGoogleAuthorization(a.parseGoogleClient(JSON.stringify(client)),{timeoutMs:1000});
 const auth=new URL(session.url),redirect=auth.searchParams.get('redirect_uri');assert.equal(new URL(redirect).hostname,'127.0.0.1');
 assert.equal((await fetch(redirect+'?state=wrong&code=bad')).status,400);
 const accepted=await fetch(redirect+'?state='+auth.searchParams.get('state')+'&code=code-ok');assert.equal(accepted.status,200);
 const result=await session.result;assert.equal(result.code,'code-ok');assert.ok(result.verifier.length>=43);
 await assert.rejects(fetch(redirect));
});
test('OAuth timeout and cancellation close the listener and never expose callback data',async()=>{
 const a=api(),c=a.parseGoogleClient(JSON.stringify(client));
 const cancelled=await a.startGoogleAuthorization(c,{timeoutMs:1000});const rejected=assert.rejects(cancelled.result,/cancel/i);cancelled.cancel();await rejected;
 const timed=await a.startGoogleAuthorization(c,{timeoutMs:10});await assert.rejects(timed.result,/timed out/i);
 await assert.rejects(fetch(new URL(timed.url).searchParams.get('redirect_uri')));
});
test('Calendar setup errors distinguish disabled API, permissions, token exchange and safe unknown failures',async()=>{
 const a=api(),c=a.parseGoogleClient(JSON.stringify(client));
 const events=request=>a.fetchGoogleEvents(request,'ACCESS_SECRET',new Date('2026-10-01'),new Date('2026-11-01'));
 const response=(status,json)=>async()=>({status,json});
 await assert.rejects(events(response(403,{error:{message:'SECRET',details:[{reason:'SERVICE_DISABLED',metadata:{consumer:'PRIVATE_PROJECT'}}]}})),e=>/Calendar API.*403.*not enabled/.test(e.message)&&!e.message.includes('SECRET')&&!e.message.includes('PRIVATE_PROJECT'));
 await assert.rejects(events(response(403,{error:{errors:[{reason:'accessNotConfigured'}]}})),/not enabled/);
 await assert.rejects(events(response(403,{error:{details:[{reason:'ACCESS_TOKEN_SCOPE_INSUFFICIENT'}]}})),/permission/);
 await assert.rejects(a.exchangeGoogleCode(response(400,{error:'invalid_grant',error_description:'CODE_SECRET'}),c,'code','verifier','http://127.0.0.1/callback'),e=>/Google token exchange.*400.*sign-in code/.test(e.message)&&!e.message.includes('CODE_SECRET'));
 await assert.rejects(events(response(503,{error:{errors:[{reason:'ACCESS_SECRET'}],message:'PRIVATE_MEETING'}})),e=>/Calendar API.*503/.test(e.message)&&!e.message.includes('SECRET')&&!e.message.includes('PRIVATE_MEETING'));
 await assert.rejects(events(async()=>{throw Error('ACCESS_SECRET');}),e=>/Calendar API.*network/.test(e.message)&&!e.message.includes('SECRET'));
 await assert.rejects(events(async()=>({status:403,get json(){throw Error('PRIVATE');},text:'not json PRIVATE'})),e=>/Calendar API.*403/.test(e.message)&&!e.message.includes('PRIVATE'));
});
