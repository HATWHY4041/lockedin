# LockedIn — creator bounties with the money locked in

**Live app:** https://lockedin-me.vercel.app
**Network:** ME Network testnet Hub (`mechain_400-1`)
**Contract:** `me1tcp3spfzrglsgzyh424cgy0gpua903x9c0au6xkzx63f50dlsayq2me52e` (code ID 25)
**Built for:** MetaEarth Hackathon 2026 — HARBOR · Track: Consumer Products and Payments

## The problem

Brands pay crypto creators for posts all the time: threads, explainers, campaign content. Today it runs on trust:

- Creators do the work first and hope the brand pays. Late payments, ghosted invoices and "we changed our mind" are normal.
- Brands can't easily prove they have the budget, so good creators skip new projects.
- Nobody can see how much of a campaign was actually paid out.

## What LockedIn does

LockedIn is an on-chain escrow for creator campaigns on ME Network.

1. **Brand locks the budget.** Payout per creator × number of creators is sent into the contract when the campaign is published. It can't be withdrawn before the deadline.
2. **Creator posts and submits the link.** Their slot is reserved while it's reviewed.
3. **Brand approves → instant payout.** The contract pays the creator in the same transaction.
4. **Brand goes silent → creator claims.** Every campaign has a review window. If the brand doesn't approve or reject in time, the creator can claim the payout themselves. Silence counts as approval.
5. **After the deadline** the brand can withdraw only what was never paid or reserved for pending submissions.

Every step is a transaction on ME Network, so the whole campaign — budget, submissions, payouts — is publicly verifiable.

## How it uses ME Network

- **CosmWasm escrow contract on the ME Hub.** All campaign state and money flows live in the contract (`contract/src/contract.zig`).
- **Native MEC payouts** via bank messages from the contract.
- **ME ID badges.** The app reads the ME ID (DID) module on the Hub for every brand and creator address and shows a "✓ ME ID" badge, so brands can see they're dealing with verified, unique people and creators can see who's behind a campaign.
- **Wallets:** Keplr (the app adds ME testnet for you) or a built-in quick wallet for testnet.

## On-chain run records (ME testnet Hub)

| Step | Tx hash |
|---|---|
| Store contract code (code ID 25) | `79669E12428078BBEA2EB8DF1769013FB118199996F318EA1DACD89DD4808F99` |
| Instantiate contract | `37092FCCB943E581CE737F39F8913442AA0C466207A5C3215ABF2E6458589614` |
| Brand creates campaign #1, locks 0.3 MEC | `F7298D6C855ECA7CC67E6725C6A766CB2CB500402439AFA5B6FAE54139B5F87D` |
| Creator 1 submits | `C89DA8E053C126EA6C35F986244F34067B35695F4578AF3567B55133DCD3F9EE` |
| Creator 2 submits | `E7156BEE703E1E19008EED5B56723D61173FE512693E48284BC984AD628B08A1` |
| Brand approves creator 1 → paid 0.1 MEC | `99E86567925178386DA1DAD9ABD7A058B4858BE3AD8FF5CA45E27CDC0A0F65BB` |
| Early claim rejected by contract ("review window has not ended yet") | `A00D0D8EDF7EAF9026AAF5FBA970592BBA9BF1881C582A1620FD40A7F46EEE86` |
| Brand silent → creator 2 claims 0.1 MEC | `8AE5C77F4BEF0B5348CBC3EBF5475F96123C871F2D4BD8A95216AD1EB5CE8A26` |

Campaign #2 was run end to end through the web app itself (brand and both creators clicking the real UI):

| Step | Tx hash |
|---|---|
| Brand creates campaign #2 in the app, locks 0.3 MEC | `4A3B5B326F076D4F43814E88A304CAE949BC78E5460C0C85FF7D32FF41E58536` |
| Creator A submits in the app | `1BEFD5579498FBA98AB9805A1F41EE8ED397CDBE35A742F3671601831E4F2AE2` |
| Creator B submits in the app | `A1B16F728B6D7B11237E53FB2BA173CC0591F71D9092E6785746D8A3387363D9` |
| Brand clicks "Approve & pay" → creator A paid | `000078EC13CFF98DB54FA6F92A898372B2334A43B30219F1A448F2AF0E43C5BA` |
| Brand silent → creator B clicks "Claim" | `B996DBC3066F5E47E6AC2C575AD2F2C7D1CF6B50A21D09645B12878590BE1AEB` |

Any hash can be checked on the Hub: `https://beta-hub-1317.explorer-testnet.me/cosmos/tx/v1beta1/txs/<hash>`

See them in the app: https://lockedin-me.vercel.app/#/c/1 and https://lockedin-me.vercel.app/#/c/2

## Contract interface

Execute messages:

```json
{ "create_campaign": { "title": "...", "brief": "...", "required_tag": "#tag", "payout": "10000000", "max_creators": 3, "review_secs": 86400, "deadline": 1795120742 } }
{ "submit":   { "campaign_id": 1, "post_url": "https://x.com/..." } }
{ "approve":  { "campaign_id": 1, "submission_id": 1 } }
{ "reject":   { "campaign_id": 1, "submission_id": 1, "reason": "missing tag" } }
{ "claim":    { "campaign_id": 1, "submission_id": 1 } }
{ "withdraw": { "campaign_id": 1 } }
```

Queries: `{ "config": {} }`, `{ "campaign": { "id": 1 } }`, `{ "campaigns": { "limit": 30 } }`.

Rules the contract enforces:

- Funds sent must equal `payout × max_creators` exactly.
- One live submission per creator per campaign; a rejected creator may resubmit.
- Slots: `paid + pending` can never exceed `max_creators`.
- The brand can reject only inside the review window; after it, only the creator can act (claim).
- Withdraw only after the deadline, and pending submissions stay reserved.

### Why Zig?

ME's Hub runs wasmd 0.43 / wasmvm 1.4, which only accepts plain (MVP) WebAssembly with no floating-point instructions. The contract implements the CosmWasm `interface_version_8` ABI directly in Zig, compiled with `-mcpu mvp`. The build is checked to contain zero float ops and only the `db_read` / `db_write` host imports.

## Run it yourself

```bash
# contract
pip install ziglang==0.17.1
sh contract/build.sh               # -> contract/bounty_escrow.wasm
node contract/test/harness.mjs     # full lifecycle tests on a simulated wasmvm host

# web app
cd web && npm install && npm run dev
# set VITE_CONTRACT=<contract address> to point at a deployment,
# or use the Contract page in the app to deploy a fresh copy from your wallet.
```

Get testnet MEC from https://www.mec.me/en-US/faucet.

## Repository layout

```
contract/src/contract.zig   escrow contract (CosmWasm ABI, Zig)
contract/test/harness.mjs   simulated-chain test suite
contract/build.sh           build script
web/                        React + CosmJS app (Vite), deployed on Vercel
```

## Roadmap

- Stablecoin (USDT) campaign budgets via CW20 / bridged tokens on ME.
- Optional "ME ID required" campaigns, enforced on-chain.
- Automatic post checks (tag/handle present) before approval.
- Rollapp per agency for high-volume creator programs.
