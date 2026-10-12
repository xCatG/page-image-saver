const test = require('node:test');
const assert = require('node:assert/strict');
const {takeoverStatusText} = require('../extension_helpers.js');
const summary = {productsCaptured: 7, gone: 3, skipped: 2, failed: 1, pending: 9};
const counters = 'captured 7 · gone 3 · skipped 2 · failed 1 · pending 9';
for (const [name, run, expected] of [
  ['active page beats future deadline', {status:'running', current:{url:'https://shop.test/bra'}, nextNavigationAt:12000}, 'Running · Current URL: https://shop.test/bra'],
  ['saved wait rounds up', {status:'running', current:null, nextNavigationAt:11501}, 'Waiting — next navigation in 2 s · Current URL: none (between pages)'],
  ['due wait is running', {status:'running', current:null, nextNavigationAt:10000}, 'Running · Current URL: none (between pages)'],
  ['paused reason beats wait', {status:'paused', reason:'HTTP 429', nextNavigationAt:12000}, 'Paused — HTTP 429 · Current URL: none (between pages)'],
  ['complete', {status:'complete'}, 'Finished · Current URL: none (between pages)'],
  ['gaps', {status:'finished_with_gaps', reason:'one failed'}, 'Finished with gaps — one failed · Current URL: none (between pages)'],
  ['stopped', {status:'stopped', reason:'stopped by user'}, 'Stopped — stopped by user · Current URL: none (between pages)'],
  ['preview', {status:'preview'}, 'Ready · Current URL: none (between pages)'],
]) test(name, () => assert.equal(takeoverStatusText(run, summary, 10000), `${expected} · ${counters}`));
