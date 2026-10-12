const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../extension_helpers.js');
const origin = 'chrome-extension://' + 'a'.repeat(32);
const settings = {enabled: true, url: 'http://127.0.0.1:8765', token: 'test-only-token'};
test('receiver fields validate only when enabled and never echo the token', () => {
  assert.deepEqual(h.validateReceiverSettings({enabled:false,url:'bad',token:''}), {});
  for (const url of ['', 'ftp://host', 'http://', 'http://user:secret@host']) assert.ok(h.validateReceiverSettings({...settings,url}).url);
  for (const url of ['http://127.0.0.1:8765/v1/already', 'http://localhost?x=1', 'http://localhost#fragment', 'https://receiver.example']) {
    assert.ok(h.validateReceiverSettings({...settings,url}).url);
  }
  for (const token of ['', ' ', 'bad\nvalue', 'é']) assert.ok(h.validateReceiverSettings({...settings,token}).token);
  assert.deepEqual(h.validateReceiverSettings(settings), {});
  assert.deepEqual(h.validateReceiverSettings({...settings,url:'https://receiver.local'}), {});
});
for (const [status, body, code, text] of [
  [400,{error:'invalid identity',complete:false},'accepted','token accepted'],
  [401,{},'token_rejected','token rejected'],
  [403,{},'origin_rejected','--extension-origin'],
  [500,{},'unexpected','HTTP 500'],
  [400,{error:'other'},'unexpected','HTTP 400'],
  [200,{complete:true},'unexpected','HTTP 200']
]) test(`receiver probe maps ${status}/${code}`, async () => {
  const r=await h.testReceiverConnection(settings,{origin,fetch:async(url,opts)=>{
    assert.equal(url,settings.url+'/v1/already'); assert.equal(opts.method,'POST');
    assert.deepEqual(JSON.parse(opts.body),{identity:{}}); assert.equal(opts.headers['X-Capture-Token'],settings.token);
    assert.equal(opts.redirect,'error');
    return {status,json:async()=>body};
  }});
  assert.equal(r.code,code); assert.ok(r.message.includes(text)); assert.ok(!r.message.includes(settings.token));
  if(status===403) assert.ok(r.message.includes(origin));
});
test('network/CORS failure and timeout identify target without leaking exceptions',async()=>{
  const r=await h.testReceiverConnection(settings,{origin,fetch:async()=>{throw new TypeError(settings.token)}});
  assert.equal(r.code,'unreachable'); assert.match(r.message,/CORS/); assert.ok(r.message.includes(origin)); assert.ok(r.message.includes(settings.url)); assert.ok(!r.message.includes(settings.token));
  const t=await h.testReceiverConnection(settings,{origin,timeoutMs:5,fetch:()=>new Promise(()=>{})});
  assert.equal(t.code,'timeout'); assert.ok(t.message.includes(settings.url));
});
test('invalid probe values do not fetch',async()=>{
  for (const url of ['', 'http://127.0.0.1:8765/v1/already', 'https://receiver.example']) {
    const r=await h.testReceiverConnection({...settings,url},{origin,fetch:()=>assert.fail('must not fetch')});
    assert.equal(r.code,'invalid');
  }
});
