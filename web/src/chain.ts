import { SigningCosmWasmClient, CosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import { DirectSecp256k1HdWallet, type OfflineSigner } from '@cosmjs/proto-signing'
import { GasPrice } from '@cosmjs/stargate'

export const NET = {
  chainId: 'mechain_400-1',
  chainName: 'ME Network Testnet (Hub)',
  rpc: 'https://beta-hub-26657.explorer-testnet.me',
  rest: 'https://beta-hub-1317.explorer-testnet.me',
  prefix: 'me',
  denom: 'umec',
  symbol: 'MEC',
  decimals: 8,
  gasPrice: '0.1umec',
  explorer: 'https://www.explorer-testnet.me',
  faucet: 'https://www.mec.me/en-US/faucet',
}

/** Deployed escrow contract. A value saved by the Deploy page overrides the built-in one. */
const BUILT_IN_CONTRACT = import.meta.env.VITE_CONTRACT ?? ''
export const getContract = (): string => {
  try { return localStorage.getItem('lockedin.contract') || BUILT_IN_CONTRACT } catch { return BUILT_IN_CONTRACT }
}
export const setContract = (addr: string) => { try { localStorage.setItem('lockedin.contract', addr) } catch { /* ignore */ } }

// ------------------------------------------------------------------ types (mirror the contract)
export type Submission = {
  id: number; creator: string; post_url: string
  status: 'pending' | 'approved' | 'rejected' | 'claimed'
  submitted_at: number; resolved_at: number; note: string
}
export type Campaign = {
  id: number; brand: string; title: string; brief: string; required_tag: string
  denom: string; payout: string; max_creators: number; review_secs: number
  deadline: number; created_at: number; budget: string; paid: string; refunded: string
  paid_count: number; pending_count: number; closed: boolean; submissions: Submission[]
}

// ------------------------------------------------------------------ amounts
export const toBase = (display: string): string => {
  const s = display.trim()
  if (!/^[0-9]+([.][0-9]+)?$/.test(s)) throw new Error('Enter a number like 2 or 0.5')
  const [w, f = ''] = s.split('.')
  if (f.length > NET.decimals) throw new Error(`Max ${NET.decimals} decimal places`)
  return (BigInt(w) * 10n ** BigInt(NET.decimals) + BigInt((f + '0'.repeat(NET.decimals)).slice(0, NET.decimals))).toString()
}
export const fromBase = (base: string | bigint, maxFrac = 4): string => {
  const v = BigInt(base)
  const unit = 10n ** BigInt(NET.decimals)
  const w = v / unit
  let f = (v % unit).toString().padStart(NET.decimals, '0').slice(0, maxFrac).replace(/0+$/, '')
  return w.toLocaleString('en-US') + (f ? '.' + f : '')
}

// ------------------------------------------------------------------ clients
let readClient: Promise<CosmWasmClient> | null = null
export const reader = () => (readClient ??= CosmWasmClient.connect(NET.rpc))

export async function listCampaigns(): Promise<Campaign[]> {
  const c = getContract(); if (!c) return []
  const r = await (await reader()).queryContractSmart(c, { campaigns: { limit: 50 } })
  return r.campaigns
}
export async function getCampaign(id: number): Promise<Campaign> {
  return (await reader()).queryContractSmart(getContract(), { campaign: { id } })
}
export async function balanceOf(addr: string): Promise<string> {
  const b = await (await reader()).getBalance(addr, NET.denom)
  return b.amount
}

/** ME ID lookup on the Hub's DID module. */
const meIdCache = new Map<string, Promise<{ did: string; kycLevel: string } | null>>()
export function meIdOf(addr: string) {
  if (!meIdCache.has(addr)) {
    meIdCache.set(addr, fetch(`${NET.rest}/metaearth/did/did?address=${encodeURIComponent(addr)}`)
      .then(r => r.ok ? r.json() : null)
      .then(j => j?.info?.did ? { did: String(j.info.did), kycLevel: String(j.info.kycLevel ?? j.info.kyc_level ?? '') } : null)
      .catch(() => null))
  }
  return meIdCache.get(addr)!
}

// ------------------------------------------------------------------ wallets
export type Wallet = { address: string; kind: 'keplr' | 'local'; client: SigningCosmWasmClient }

const KEY = 'lockedin.localMnemonic'

async function signingFrom(signer: OfflineSigner) {
  return SigningCosmWasmClient.connectWithSigner(NET.rpc, signer, { gasPrice: GasPrice.fromString(NET.gasPrice) })
}

export function hasLocalWallet() { try { return !!localStorage.getItem(KEY) } catch { return false } }
export function exportLocalMnemonic() { try { return localStorage.getItem(KEY) ?? '' } catch { return '' } }
export function forgetLocalWallet() { try { localStorage.removeItem(KEY) } catch { /* ignore */ } }

export async function connectLocal(mnemonic?: string): Promise<Wallet> {
  let m = mnemonic?.trim()
  if (!m) { try { m = localStorage.getItem(KEY) ?? '' } catch { m = '' } }
  const w = m
    ? await DirectSecp256k1HdWallet.fromMnemonic(m, { prefix: NET.prefix })
    : await DirectSecp256k1HdWallet.generate(12, { prefix: NET.prefix })
  try { localStorage.setItem(KEY, w.mnemonic) } catch { /* ignore */ }
  const [acc] = await w.getAccounts()
  return { address: acc.address, kind: 'local', client: await signingFrom(w) }
}

declare global { interface Window { keplr?: any; getOfflineSigner?: any } }

export async function connectKeplr(): Promise<Wallet> {
  const k = window.keplr
  if (!k) throw new Error('Keplr is not installed in this browser')
  await k.experimentalSuggestChain({
    chainId: NET.chainId, chainName: NET.chainName, rpc: NET.rpc, rest: NET.rest,
    bip44: { coinType: 118 },
    bech32Config: { bech32PrefixAccAddr: 'me', bech32PrefixAccPub: 'mepub', bech32PrefixValAddr: 'mevaloper', bech32PrefixValPub: 'mevaloperpub', bech32PrefixConsAddr: 'mevalcons', bech32PrefixConsPub: 'mevalconspub' },
    currencies: [{ coinDenom: NET.symbol, coinMinimalDenom: NET.denom, coinDecimals: NET.decimals }],
    feeCurrencies: [{ coinDenom: NET.symbol, coinMinimalDenom: NET.denom, coinDecimals: NET.decimals, gasPriceStep: { low: 0.1, average: 0.12, high: 0.2 } }],
    stakeCurrency: { coinDenom: NET.symbol, coinMinimalDenom: NET.denom, coinDecimals: NET.decimals },
    features: ['cosmwasm'],
  })
  await k.enable(NET.chainId)
  const signer: OfflineSigner = k.getOfflineSignerAuto ? await k.getOfflineSignerAuto(NET.chainId) : window.getOfflineSigner(NET.chainId)
  const [acc] = await signer.getAccounts()
  return { address: acc.address, kind: 'keplr', client: await signingFrom(signer) }
}

// ------------------------------------------------------------------ transactions
export async function exec(w: Wallet, msg: object, funds: { denom: string; amount: string }[] = [], memo = 'LockedIn') {
  const r = await w.client.execute(w.address, getContract(), msg, 'auto', memo, funds)
  return r.transactionHash
}

export async function deployContract(w: Wallet, wasm: Uint8Array) {
  const up = await w.client.upload(w.address, wasm, 'auto', 'LockedIn bounty escrow')
  const inst = await w.client.instantiate(w.address, up.codeId, {}, 'LockedIn bounty escrow v0.1', 'auto', { admin: w.address })
  return { codeId: up.codeId, address: inst.contractAddress, uploadTx: up.transactionHash, instantiateTx: inst.transactionHash }
}

export const txUrl = (hash: string) => `${NET.rest}/cosmos/tx/v1beta1/txs/${hash}`
export const short = (a: string) => a ? a.slice(0, 7) + '…' + a.slice(-5) : ''

/** Turn chain errors into plain words. */
export function plainError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  const contract = m.match(/message index: [0-9]+: (.*?): execute wasm contract failed/) || m.match(/execute wasm contract failed: (.*?)(?:: execute wasm contract failed|$)/)
  if (contract) return contract[1].replace(/^Generic error: /, '')
  if (/does not exist on chain/.test(m)) return 'This wallet has no MEC yet. Get test MEC from the faucet first.'
  if (/insufficient funds/.test(m)) return 'Not enough MEC in this wallet for the budget plus fees.'
  if (/Request rejected/.test(m)) return 'You cancelled the request in your wallet.'
  return m.length > 220 ? m.slice(0, 220) + '…' : m
}
