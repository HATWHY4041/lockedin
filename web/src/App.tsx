import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  NET, type Campaign, type Submission, type Wallet,
  balanceOf, connectKeplr, connectLocal, deployContract, exec, exportLocalMnemonic, forgetLocalWallet,
  fromBase, getCampaign, getContract, hasLocalWallet, listCampaigns, meIdOf, plainError, setContract, short, toBase, txUrl,
} from './chain'

// ------------------------------------------------------------------ tiny router
function useRoute() {
  const [hash, setHash] = useState(location.hash || '#/')
  useEffect(() => { const f = () => { setHash(location.hash || '#/'); window.scrollTo(0, 0) }; addEventListener('hashchange', f); return () => removeEventListener('hashchange', f) }, [])
  return hash.slice(1)
}
const go = (p: string) => { location.hash = p }

// ------------------------------------------------------------------ time helpers
const nowS = () => Math.floor(Date.now() / 1000)
// chain block time trails the wall clock a little; wait this long before offering a claim
const CLAIM_BUFFER = 20
function useTick(ms = 1000) { const [, s] = useState(0); useEffect(() => { const t = setInterval(() => s(x => x + 1), ms); return () => clearInterval(t) }, [ms]) }
function span(secs: number) {
  if (secs <= 0) return '0m'
  const d = Math.floor(secs / 86400), h = Math.floor(secs % 86400 / 3600), m = Math.floor(secs % 3600 / 60)
  if (d) return `${d}d ${h}h`; if (h) return `${h}h ${m}m`; return `${Math.max(m, 1)}m`
}
const when = (t: number) => new Date(t * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

// ------------------------------------------------------------------ toast
type Toast = { kind: 'ok' | 'err' | 'busy'; text: string; tx?: string }
let pushToast: (t: Toast | null) => void = () => {}

async function run(label: string, fn: () => Promise<string | void>, after?: () => void) {
  pushToast({ kind: 'busy', text: label + '…' })
  try {
    const tx = await fn()
    pushToast({ kind: 'ok', text: label + ' — done', tx: tx || undefined })
    after?.()
    return true
  } catch (e) {
    pushToast({ kind: 'err', text: plainError(e) })
    return false
  }
}

// ------------------------------------------------------------------ small components
function MeIdBadge({ addr }: { addr: string }) {
  const [id, setId] = useState<{ did: string } | null | undefined>(undefined)
  useEffect(() => { let on = true; meIdOf(addr).then(v => on && setId(v)); return () => { on = false } }, [addr])
  if (id === undefined) return null
  return id
    ? <span className="badge ok" title={`ME ID ${id.did}`}>✓ ME ID</span>
    : <span className="badge dim" title="This address has no ME ID yet">no ME ID</span>
}

function Addr({ a, you }: { a: string; you?: string }) {
  return <span className="addr" title={a}>{a === you ? 'You' : short(a)} <MeIdBadge addr={a} /></span>
}

function Status({ s }: { s: Submission['status'] }) {
  const label = { pending: 'In review', approved: 'Paid', rejected: 'Rejected', claimed: 'Paid (auto)' }[s]
  return <span className={'status ' + s}>{label}</span>
}

function Meter({ c }: { c: Campaign }) {
  const pct = (n: number) => `${(n / c.max_creators) * 100}%`
  return (
    <div className="meter" title={`${c.paid_count} paid · ${c.pending_count} in review · ${c.max_creators - c.paid_count - c.pending_count} open`}>
      <i style={{ width: pct(c.paid_count) }} className="paid" />
      <i style={{ width: pct(c.pending_count) }} className="pend" />
    </div>
  )
}

function escrowLeft(c: Campaign) {
  return BigInt(c.budget) - BigInt(c.paid) - BigInt(c.refunded)
}

// ------------------------------------------------------------------ wallet
function WalletButton({ w, setW, bal }: { w: Wallet | null; setW: (w: Wallet | null) => void; bal: string | null }) {
  const [open, setOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [phrase, setPhrase] = useState('')
  const [showKey, setShowKey] = useState(false)

  const pick = async (fn: () => Promise<Wallet>) => {
    try { setW(await fn()); setOpen(false); setImporting(false) } catch (e) { pushToast({ kind: 'err', text: plainError(e) }) }
  }

  if (w) return (
    <div className="wallet">
      <button className="chip" onClick={() => setOpen(!open)}>
        <span className="dot" /> {short(w.address)} <b>{bal === null ? '…' : fromBase(bal, 2)} MEC</b>
      </button>
      {open && <div className="pop">
        <div className="row"><code className="full">{w.address}</code></div>
        <div className="row"><MeIdBadge addr={w.address} /> <span className="muted">{w.kind === 'keplr' ? 'Keplr wallet' : 'Quick wallet in this browser'}</span></div>
        <div className="btns">
          <button onClick={() => { navigator.clipboard?.writeText(w.address); pushToast({ kind: 'ok', text: 'Address copied' }) }}>Copy address</button>
          <a className="btn" href={NET.faucet} target="_blank" rel="noreferrer">Get test MEC ↗</a>
        </div>
        {w.kind === 'local' && <>
          <button className="link" onClick={() => setShowKey(!showKey)}>{showKey ? 'Hide' : 'Show'} recovery phrase</button>
          {showKey && <p className="secret">{exportLocalMnemonic()}<br /><small>Anyone with these words controls this wallet. Testnet only.</small></p>}
        </>}
        <button className="link danger" onClick={() => { if (w.kind === 'local' && !confirm('Disconnect? Keep your recovery phrase if you want this wallet back.')) return; if (w.kind === 'local') forgetLocalWallet(); setW(null); setOpen(false) }}>Disconnect</button>
      </div>}
    </div>
  )

  return (
    <div className="wallet">
      <button className="primary" onClick={() => setOpen(!open)}>Connect wallet</button>
      {open && <div className="pop">
        <h4>Connect to ME testnet</h4>
        <button className="opt" onClick={() => pick(connectKeplr)}><b>Keplr</b><span>Adds ME Network testnet to Keplr for you</span></button>
        <button className="opt" onClick={() => pick(() => connectLocal())}><b>{hasLocalWallet() ? 'My quick wallet' : 'Create a quick wallet'}</b><span>A testnet wallet kept in this browser. No extension needed.</span></button>
        {!importing
          ? <button className="link" onClick={() => setImporting(true)}>Import a recovery phrase</button>
          : <div className="col"><textarea placeholder="12 or 24 words" value={phrase} onChange={e => setPhrase(e.target.value)} /><button onClick={() => pick(() => connectLocal(phrase))}>Import</button></div>}
      </div>}
    </div>
  )
}

// ------------------------------------------------------------------ pages
function Home({ list, loading, w }: { list: Campaign[]; loading: boolean; w: Wallet | null }) {
  useTick(30000)
  const [filter, setFilter] = useState<'open' | 'all' | 'mine'>('open')
  const shown = list.filter(c => filter === 'all' ? true
    : filter === 'mine' ? (w && (c.brand === w.address || c.submissions.some(s => s.creator === w.address)))
    : !c.closed && c.deadline > nowS() && c.paid_count + c.pending_count < c.max_creators)
  const locked = list.reduce((s, c) => s + escrowLeft(c), 0n)
  const paid = list.reduce((s, c) => s + BigInt(c.paid), 0n)

  return <>
    <section className="hero">
      <div>
        <p className="eyebrow">Creator bounties · ME Network</p>
        <h1>The money is <em>locked in</em><br />before you post.</h1>
        <p className="lede">Brands lock the full campaign budget in an on-chain escrow. Creators post, submit the link, and get paid the moment it's approved. If the brand goes quiet, the creator can claim the payout anyway.</p>
        <div className="btns"><button className="primary big" onClick={() => go('/new')}>Launch a campaign</button><button className="big" onClick={() => document.getElementById('campaigns')?.scrollIntoView({ behavior: 'smooth' })}>Find a bounty</button></div>
      </div>
      <div className="stats">
        <div><b>{fromBase(locked, 2)}</b><span>MEC in escrow now</span></div>
        <div><b>{fromBase(paid, 2)}</b><span>MEC paid to creators</span></div>
        <div><b>{list.length}</b><span>campaigns on-chain</span></div>
      </div>
    </section>

    <section className="how">
      <div><span>01</span><h3>Brand locks the budget</h3><p>Payout × number of creators goes into the contract. It can't be pulled back before the deadline.</p></div>
      <div><span>02</span><h3>Creator posts &amp; submits</h3><p>Make the post, drop the link on-chain. Your slot is reserved while it's reviewed.</p></div>
      <div><span>03</span><h3>Approve = instant pay</h3><p>Approved posts are paid on the spot. No review in time? The creator claims it themselves.</p></div>
    </section>

    <section id="campaigns">
      <div className="bar">
        <h2>Bounties</h2>
        <div className="tabs">{(['open', 'all', 'mine'] as const).map(f => <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f === 'open' ? 'Open' : f === 'all' ? 'All' : 'Mine'}</button>)}</div>
      </div>
      {!getContract() ? <div className="empty">No escrow contract is set yet. <a href="#/deploy">Deploy it</a>.</div>
        : loading ? <div className="empty">Reading the chain…</div>
        : shown.length === 0 ? <div className="empty">{filter === 'mine' && !w ? 'Connect a wallet to see your campaigns.' : 'Nothing here yet.'} <a href="#/new">Launch the first one →</a></div>
        : <div className="grid">{shown.map(c => <Card key={c.id} c={c} />)}</div>}
    </section>
  </>
}

function Card({ c }: { c: Campaign }) {
  const left = c.deadline - nowS()
  const open = c.max_creators - c.paid_count - c.pending_count
  return (
    <a className="card" href={`#/c/${c.id}`}>
      <div className="top"><span className="pay">{fromBase(c.payout)} <small>MEC</small></span><span className="per">per creator</span></div>
      <h3>{c.title}</h3>
      {c.required_tag && <p className="tag">{c.required_tag}</p>}
      <Meter c={c} />
      <div className="meta">
        <span>{c.closed || left <= 0 ? 'Ended' : `${span(left)} left`}</span>
        <span>{open > 0 && !c.closed && left > 0 ? `${open} of ${c.max_creators} slots open` : 'Full'}</span>
      </div>
      <div className="lock">🔒 {fromBase(escrowLeft(c), 2)} MEC in escrow</div>
    </a>
  )
}

function NewCampaign({ w, onDone }: { w: Wallet | null; onDone: () => void }) {
  const [f, setF] = useState({ title: '', brief: '', tag: '', payout: '1', creators: '5', days: '7', review: '24' })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value })
  let budget = '', err = ''
  try { budget = (BigInt(toBase(f.payout || '0')) * BigInt(Math.max(0, parseInt(f.creators) || 0))).toString() } catch (e) { err = (e as Error).message }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!w) return pushToast({ kind: 'err', text: 'Connect a wallet first' })
    const payout = toBase(f.payout)
    const n = parseInt(f.creators)
    const msg = { create_campaign: { title: f.title.trim(), brief: f.brief.trim(), required_tag: f.tag.trim(), payout, max_creators: n, review_secs: Math.round(parseFloat(f.review) * 3600), deadline: nowS() + Math.round(parseFloat(f.days) * 86400) } }
    await run('Locking the budget in escrow', () => exec(w, msg, [{ denom: NET.denom, amount: budget }]), onDone)
  }

  return (
    <section className="form-wrap">
      <a className="back" href="#/">← Bounties</a>
      <h1>Launch a campaign</h1>
      <p className="lede">The whole budget is locked when you publish. Creators can see it's there before they post.</p>
      <form className="form" onSubmit={submit}>
        <label>Campaign title<input required maxLength={100} value={f.title} onChange={set('title')} placeholder="Post a thread about our launch" /></label>
        <label>What should creators post?<textarea maxLength={1000} value={f.brief} onChange={set('brief')} placeholder="Explain the product in your own words. At least 3 posts in a thread, include one screenshot, tag us." /></label>
        <label>Required tag or handle <small>(shown to creators, checked by you)</small><input maxLength={100} value={f.tag} onChange={set('tag')} placeholder="#MEHarbor @_MetaEarth_" /></label>
        <div className="two">
          <label>Payout per creator (MEC)<input required inputMode="decimal" value={f.payout} onChange={set('payout')} /></label>
          <label>Number of creators<input required type="number" min={1} max={200} value={f.creators} onChange={set('creators')} /></label>
        </div>
        <div className="two">
          <label>Campaign runs for<select value={f.days} onChange={set('days')}>
            <option value="0.0417">1 hour (demo)</option><option value="1">1 day</option><option value="3">3 days</option><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option></select></label>
          <label>You must review within<select value={f.review} onChange={set('review')}>
            <option value="0.0167">1 minute (demo)</option><option value="1">1 hour</option><option value="12">12 hours</option><option value="24">24 hours</option><option value="72">3 days</option></select></label>
        </div>
        <div className="sum">
          {err ? <span className="danger">{err}</span> : <>Budget to lock: <b>{fromBase(budget || '0', 8)} MEC</b> <span className="muted">+ a small network fee</span></>}
        </div>
        <p className="fine">If you don't review a submission within the window, the creator can claim the payout. After the deadline you can withdraw anything not paid out.</p>
        <button className="primary big" disabled={!!err || !w}>{w ? 'Lock budget & publish' : 'Connect a wallet to publish'}</button>
      </form>
    </section>
  )
}

function CampaignPage({ id, w, refreshAll }: { id: number; w: Wallet | null; refreshAll: () => void }) {
  useTick(1000)
  const [c, setC] = useState<Campaign | null>(null)
  const [err, setErr] = useState('')
  const [url, setUrl] = useState('')
  const load = useCallback(() => getCampaign(id).then(setC).catch(e => setErr(plainError(e))), [id])
  useEffect(() => { load() }, [load])
  const after = () => { load(); refreshAll() }

  if (err) return <section className="form-wrap"><a className="back" href="#/">← Bounties</a><div className="empty">{err}</div></section>
  if (!c) return <section className="form-wrap"><div className="empty">Reading the chain…</div></section>

  const me = w?.address
  const isBrand = me === c.brand
  const mine = c.submissions.find(s => s.creator === me)
  const t = nowS()
  const ended = t >= c.deadline
  const slotsOpen = c.max_creators - c.paid_count - c.pending_count
  const canSubmit = !!w && !isBrand && !c.closed && !ended && slotsOpen > 0 && (!mine || mine.status === 'rejected')
  const avail = escrowLeft(c) - BigInt(c.payout) * BigInt(c.pending_count)
  const act = (label: string, msg: object) => w && run(label, () => exec(w, msg), after)

  return (
    <section className="detail">
      <a className="back" href="#/">← Bounties</a>
      <div className="head">
        <div>
          <p className="eyebrow">Campaign #{c.id} · by <Addr a={c.brand} you={me} /></p>
          <h1>{c.title}</h1>
          {c.required_tag && <p className="tag big">{c.required_tag}</p>}
          {c.brief && <p className="brief">{c.brief}</p>}
        </div>
        <aside className="vault">
          <div className="pay">{fromBase(c.payout)} <small>MEC / creator</small></div>
          <Meter c={c} />
          <dl>
            <dt>In escrow</dt><dd>{fromBase(escrowLeft(c))} MEC</dd>
            <dt>Paid out</dt><dd>{fromBase(c.paid)} MEC · {c.paid_count} creators</dd>
            <dt>Slots open</dt><dd>{Math.max(slotsOpen, 0)} of {c.max_creators}</dd>
            <dt>Review window</dt><dd>{span(c.review_secs)}</dd>
            <dt>{ended ? 'Ended' : 'Ends in'}</dt><dd>{ended ? when(c.deadline) : span(c.deadline - t)}</dd>
          </dl>
          {isBrand && ended && avail > 0n && <button className="primary" onClick={() => act('Withdrawing leftover budget', { withdraw: { campaign_id: c.id } })}>Withdraw {fromBase(avail)} MEC</button>}
          {isBrand && !ended && <p className="fine">Budget stays locked until the deadline.</p>}
        </aside>
      </div>

      {canSubmit && <form className="submit" onSubmit={e => { e.preventDefault(); act('Submitting your post', { submit: { campaign_id: c.id, post_url: url.trim() } }) }}>
        <h3>{mine ? 'Submit a new post' : 'Posted it? Submit your link'}</h3>
        <div className="inline"><input required type="url" pattern="https://.*" placeholder="https://x.com/you/status/…" value={url} onChange={e => setUrl(e.target.value)} /><button className="primary">Submit</button></div>
        <p className="fine">Your slot is reserved while the brand reviews. If they don't respond within {span(c.review_secs)}, you can claim the {fromBase(c.payout)} MEC yourself.</p>
      </form>}
      {!w && !ended && slotsOpen > 0 && <div className="empty">Connect a wallet to take this bounty.</div>}

      <h2>Submissions <span className="muted">({c.submissions.length})</span></h2>
      {c.submissions.length === 0 ? <div className="empty">No submissions yet.</div> :
        <div className="subs">{[...c.submissions].reverse().map(s => {
          const due = s.submitted_at + c.review_secs + CLAIM_BUFFER
          const overdue = t >= due
          return (
            <div key={s.id} className={'sub ' + s.status}>
              <div className="who"><Addr a={s.creator} you={me} /><Status s={s.status} /></div>
              <a className="url" href={s.post_url} target="_blank" rel="noreferrer">{s.post_url.replace('https://', '')} ↗</a>
              <div className="when">
                Submitted {when(s.submitted_at)}
                {s.status === 'pending' && <> · {overdue ? <b className="warn">review window over</b> : <>review closes in <b>{span(due - t)}</b></>}</>}
                {s.note && <> · <i>{s.note}</i></>}
              </div>
              <div className="acts">
                {isBrand && s.status === 'pending' && <>
                  <button className="primary" onClick={() => act('Approving & paying', { approve: { campaign_id: c.id, submission_id: s.id } })}>Approve &amp; pay</button>
                  {!overdue && <button onClick={() => { const reason = prompt('Why is this rejected? (shown to the creator)') ?? ''; act('Rejecting', { reject: { campaign_id: c.id, submission_id: s.id, reason } }) }}>Reject</button>}
                </>}
                {s.creator === me && s.status === 'pending' && overdue && <button className="primary" onClick={() => act('Claiming your payout', { claim: { campaign_id: c.id, submission_id: s.id } })}>Claim {fromBase(c.payout)} MEC</button>}
              </div>
            </div>
          )
        })}</div>}
    </section>
  )
}

function Deploy({ w }: { w: Wallet | null }) {
  const [addr, setAddr] = useState(getContract())
  const [log, setLog] = useState<string[]>([])
  const doDeploy = async () => {
    if (!w) return pushToast({ kind: 'err', text: 'Connect a wallet first' })
    const wasm = new Uint8Array(await (await fetch('/bounty_escrow.wasm')).arrayBuffer())
    await run('Uploading & instantiating the contract', async () => {
      const r = await deployContract(w, wasm)
      setContract(r.address); setAddr(r.address)
      setLog([`Code ID: ${r.codeId}`, `Contract: ${r.address}`, `Upload tx: ${r.uploadTx}`, `Instantiate tx: ${r.instantiateTx}`])
      return r.instantiateTx
    })
  }
  return (
    <section className="form-wrap">
      <a className="back" href="#/">← Bounties</a>
      <h1>Contract</h1>
      <p className="lede">The escrow is a CosmWasm contract on the ME Hub testnet ({NET.chainId}).</p>
      <div className="form">
        <label>Contract address in use<input value={addr} onChange={e => setAddr(e.target.value)} placeholder="me1…" /></label>
        <div className="btns"><button onClick={() => { setContract(addr.trim()); pushToast({ kind: 'ok', text: 'Saved. Reload to use it.' }) }}>Use this address</button>
          <button className="primary" onClick={doDeploy} disabled={!w}>Deploy a fresh copy</button></div>
        {log.length > 0 && <pre className="log">{log.map(l => <div key={l}>{l}</div>)}</pre>}
      </div>
    </section>
  )
}

// ------------------------------------------------------------------ app shell
export default function App() {
  const route = useRoute()
  const [w, setW] = useState<Wallet | null>(null)
  const [bal, setBal] = useState<string | null>(null)
  const [list, setList] = useState<Campaign[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<Toast | null>(null)
  pushToast = setToast

  const refresh = useCallback(() => {
    listCampaigns().then(setList).catch(e => setToast({ kind: 'err', text: 'Could not read campaigns: ' + plainError(e) })).finally(() => setLoading(false))
  }, [])
  useEffect(() => { refresh(); const t = setInterval(refresh, 20000); return () => clearInterval(t) }, [refresh])

  // reconnect the quick wallet silently
  useEffect(() => { if (hasLocalWallet()) connectLocal().then(setW).catch(() => {}) }, [])
  useEffect(() => {
    if (!w) { setBal(null); return }
    const f = () => balanceOf(w.address).then(setBal).catch(() => setBal('0'))
    f(); const t = setInterval(f, 8000); return () => clearInterval(t)
  }, [w, list])
  useEffect(() => { if (toast && toast.kind !== 'busy') { const t = setTimeout(() => setToast(null), toast.kind === 'err' ? 9000 : 6000); return () => clearTimeout(t) } }, [toast])

  const page = useMemo(() => {
    if (route.startsWith('/c/')) return <CampaignPage id={parseInt(route.slice(3))} w={w} refreshAll={refresh} />
    if (route.startsWith('/new')) return <NewCampaign w={w} onDone={() => { refresh(); go('/') }} />
    if (route.startsWith('/deploy')) return <Deploy w={w} />
    return <Home list={list} loading={loading} w={w} />
  }, [route, w, list, loading, refresh])

  return <>
    <header>
      <a className="logo" href="#/"><span className="mark">⬢</span> LockedIn</a>
      <nav><a href="#/">Bounties</a><a href="#/new">Launch</a></nav>
      <WalletButton w={w} setW={setW} bal={bal} />
    </header>
    {w && bal === '0' && <div className="banner">This wallet has no MEC yet. <a href={NET.faucet} target="_blank" rel="noreferrer">Get free test MEC ↗</a> and paste <code onClick={() => navigator.clipboard?.writeText(w.address)}>{short(w.address)}</code></div>}
    <main>{page}</main>
    <footer>
      <span>Escrow contract on ME Network testnet · <code title={getContract()}>{short(getContract()) || 'not deployed'}</code></span>
      <span><a href="#/deploy">Contract</a> · Built for MetaEarth HARBOR 2026</span>
    </footer>
    {toast && <div className={'toast ' + toast.kind} onClick={() => setToast(null)}>
      {toast.kind === 'busy' && <span className="spin" />}{toast.text}
      {toast.tx && <a href={txUrl(toast.tx)} target="_blank" rel="noreferrer"> View tx ↗</a>}
    </div>}
  </>
}
