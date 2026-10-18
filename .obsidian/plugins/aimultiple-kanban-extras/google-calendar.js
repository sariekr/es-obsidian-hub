'use strict';
const { meetingLink } = require('./meeting-links.js');
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
module.exports={GOOGLE_SCOPE,parseGoogleClient,googleAuthorizationUrl,startGoogleAuthorization,exchangeGoogleCode,refreshGoogleToken,fetchGoogleEvents};
