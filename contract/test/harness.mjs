// Minimal wasmvm-1.x host to exercise the contract end to end in Node.
import fs from 'fs';
import assert from 'assert';

const wasmPath = new URL('../bounty_escrow.wasm', import.meta.url);
const bin = fs.readFileSync(wasmPath);
const store = new Map();
const enc = new TextEncoder(), dec = new TextDecoder();

let now = 1_800_000_000; // seconds
const bank = {}; // addr -> amount (umec, BigInt)
const CONTRACT = 'me1contract';
bank[CONTRACT] = 0n;

async function instance() {
  let mem;
  const read = (rp) => { const v = new DataView(mem.buffer); const off = v.getUint32(rp, true), len = v.getUint32(rp + 8, true); return new Uint8Array(mem.buffer.slice(off, off + len)); };
  let exp;
  const write = (bytes) => { const rp = exp.allocate(bytes.length); const v = new DataView(mem.buffer); const off = v.getUint32(rp, true); new Uint8Array(mem.buffer, off, bytes.length).set(bytes); v.setUint32(rp + 8, bytes.length, true); return rp; };
  const env = {
    db_read: (k) => { const key = dec.decode(read(k)); return store.has(key) ? write(store.get(key)) : 0; },
    db_write: (k, v) => { store.set(dec.decode(read(k)), read(v)); },
    db_remove: (k) => { store.delete(dec.decode(read(k))); },
    addr_validate: () => 0, debug: (p) => console.log('debug', dec.decode(read(p))), abort: () => { throw new Error('abort'); },
  };
  const { instance } = await WebAssembly.instantiate(bin, { env });
  exp = instance.exports; mem = exp.memory;
  return { exp, write: (o) => write(enc.encode(JSON.stringify(o))), readJson: (p) => JSON.parse(dec.decode(read(p))) };
}
const envObj = () => ({ block: { height: 1, time: String(BigInt(now) * 1_000_000_000n), chain_id: 'mechain_400-1' }, transaction: { index: 0 }, contract: { address: CONTRACT } });

async function exec(sender, msg, funds = []) {
  for (const f of funds) { bank[sender] = (bank[sender] ?? 0n) - BigInt(f.amount); bank[CONTRACT] += BigInt(f.amount); }
  const i = await instance();
  const res = i.readJson(i.exp.execute(i.write(envObj()), i.write({ sender, funds }), i.write(msg)));
  if (res.error) { for (const f of funds) { bank[sender] += BigInt(f.amount); bank[CONTRACT] -= BigInt(f.amount); } return res; }
  for (const m of res.ok.messages) { const s = m.msg.bank.send; for (const c of s.amount) { bank[CONTRACT] -= BigInt(c.amount); bank[s.to_address] = (bank[s.to_address] ?? 0n) + BigInt(c.amount); } }
  return res;
}
async function q(msg) {
  const i = await instance();
  const res = i.readJson(i.exp.query(i.write(envObj()), i.write(msg)));
  if (res.error) return res;
  return JSON.parse(Buffer.from(res.ok, 'base64').toString());
}
const ok = (r) => { if (r.error) throw new Error('unexpected error: ' + r.error); return r.ok; };
const bad = (r, frag) => { assert.ok(r.error, 'expected error containing ' + frag); assert.ok(r.error.includes(frag), `got "${r.error}", wanted "${frag}"`); };

// --- scenario
{ const i = await instance(); ok(i.readJson(i.exp.instantiate(i.write(envObj()), i.write({ sender: 'me1admin', funds: [] }), i.write({})))); }
assert.deepEqual((await q({ config: {} })).campaign_count, 0);

const brand = 'me1brand', alice = 'me1alice', bob = 'me1bob', carol = 'me1carol';
const create = { create_campaign: { title: 'Launch week thread', brief: 'Post a thread about our launch', required_tag: '#MEHarbor', payout: '5000000', max_creators: 2, review_secs: 3600, deadline: now + 86400 } };
bad(await exec(brand, create, [{ denom: 'umec', amount: '9999999' }]), 'must equal');
let r = ok(await exec(brand, create, [{ denom: 'umec', amount: '10000000' }]));
assert.equal(r.attributes.find(a => a.key === 'campaign_id').value, '1');
assert.equal(bank[CONTRACT], 10000000n);

bad(await exec(brand, { submit: { campaign_id: 1, post_url: 'https://x.com/b/1' } }), 'brand cannot');
bad(await exec(alice, { submit: { campaign_id: 1, post_url: 'http://x.com/a/1' } }), 'https://');
ok(await exec(alice, { submit: { campaign_id: 1, post_url: 'https://x.com/alice/status/1' } }));
bad(await exec(alice, { submit: { campaign_id: 1, post_url: 'https://x.com/alice/status/2' } }), 'already');
ok(await exec(bob, { submit: { campaign_id: 1, post_url: 'https://x.com/bob/status/1' } }));
bad(await exec(carol, { submit: { campaign_id: 1, post_url: 'https://x.com/carol/status/1' } }), 'slots');

bad(await exec(alice, { approve: { campaign_id: 1, submission_id: 1 } }), 'only the brand');
r = ok(await exec(brand, { approve: { campaign_id: 1, submission_id: 1 } }));
assert.equal(bank[alice], 5000000n);

ok(await exec(brand, { reject: { campaign_id: 1, submission_id: 2, reason: 'missing tag' } }));
// carol can now take the freed slot
ok(await exec(carol, { submit: { campaign_id: 1, post_url: 'https://x.com/carol/status/9' } }));
bad(await exec(carol, { claim: { campaign_id: 1, submission_id: 3 } }), 'not ended');
now += 3601; // brand goes silent
bad(await exec(brand, { reject: { campaign_id: 1, submission_id: 3 } }), 'review window has ended');
ok(await exec(carol, { claim: { campaign_id: 1, submission_id: 3 } }));
assert.equal(bank[carol], 5000000n);

bad(await exec(brand, { withdraw: { campaign_id: 1 } }), 'locked');
now += 86400;
bad(await exec(brand, { withdraw: { campaign_id: 1 } }), 'nothing to withdraw');
assert.equal(bank[CONTRACT], 0n);

// second campaign: refund path with a pending submission reserved
ok(await exec(brand, { create_campaign: { ...create.create_campaign, title: 'Second', max_creators: 3, deadline: now + 1000 } }, [{ denom: 'umec', amount: '15000000' }]));
ok(await exec(bob, { submit: { campaign_id: 2, post_url: 'https://x.com/bob/status/2' } }));
now += 1001;
bad(await exec(carol, { submit: { campaign_id: 2, post_url: 'https://x.com/carol/status/2' } }), 'deadline');
r = ok(await exec(brand, { withdraw: { campaign_id: 2 } }));
assert.equal(r.attributes.find(a => a.key === 'amount').value, '10000000'); // 5M stays reserved for bob
ok(await exec(brand, { approve: { campaign_id: 2, submission_id: 1 } }));
assert.equal(bank[CONTRACT], 0n);

const list = await q({ campaigns: {} });
assert.equal(list.campaigns.length, 2);
assert.equal(list.campaigns[0].id, 2);
const c1 = await q({ campaign: { id: 1 } });
assert.deepEqual(c1.submissions.map(s => s.status), ['approved', 'rejected', 'claimed']);
bad(await q({ campaign: { id: 9 } }), 'not found');
bad(await exec(brand, { nonsense: {} }), 'unknown');
console.log('ALL TESTS PASSED');
console.log(JSON.stringify(c1, null, 1).slice(0, 600));
