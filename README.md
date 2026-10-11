<div align="center">
  <h1>Personal Mail</h1>
  <p><em>A receive-only, single-user mail server that runs entirely on Cloudflare Workers</em></p>
</div>

Personal Mail gathers your mail into one private mailbox: a catch-all of aliases on your own domain, plus any existing accounts you pull in over IMAP. It sorts everything on the server, groups the Inbox into categories with an AI model, and serves it over [JMAP](https://jmap.io/), so standard open-source mail clients can read it. It never sends mail.

The whole server is a single Worker in your own Cloudflare account, behind Cloudflare Access. Nothing runs on your own machines.

## Features

- **One mailbox for every address**: unlimited aliases on your own domain, plus existing accounts pulled in over IMAP. The import is read-only, so nothing on those servers is moved, deleted or marked as read.
- **Disposable aliases**: an alias is created the first time mail arrives for it. If one leaks, purge it: its mail is deleted and new mail to it is rejected.
- **Server-side sorting**: VIP senders, rules by sender, domain, recipient or `+tag`, and spam filtering. Changing a rule re-sorts the mail it already filed.
- **Verified VIPs**: a sender only counts as a VIP when the message is authenticated, checked by a built-in DKIM verifier.
- **AI inbox categories**: Primary, Transactions, Updates and Promotions, plus your own categories described in plain words. Classification stays within the Workers AI free daily allowance ([benchmark](deploy/clef/bench/results/REPORT.md)).
- **Full-text search** across subjects, senders, recipients, bodies and attachment names.
- **Real-time push** to every connected client, with no polling.
- **Privacy by default**: no read receipts, remote images and tracking pixels blocked until you load them through an image proxy, and attachments always served as sandboxed downloads.

## Stack

- **Backend:** TypeScript, Cloudflare Workers, Durable Objects (SQLite + FTS5), R2, Queues, Email Routing
- **Mail:** `postal-mime` for parsing, plus an IMAP client and a DKIM verifier (RSA and Ed25519) written for Workers
- **API:** JMAP Core and Mail (RFC 8620/8621), push over Server-Sent Events
- **AI:** Workers AI (`@cf/cloudflare/clef`)
- **Auth:** Cloudflare Access, with JWT verification in the Worker
- **Tests:** Vitest with `@cloudflare/vitest-pool-workers`

## Clients

Because the server speaks standard JMAP, its clients are forks of existing open-source apps, maintained in separate repositories:

- **Web:** a fork of [jmap-webmail](https://github.com/root-fr/jmap-webmail) (MIT), served by the Worker
- **Android:** a fork of [Sterna Mail](https://codeberg.org/emon/sterna-mail) (GPL-3.0), with new-mail notifications from its own connection

## Prerequisites

- A Cloudflare account on the [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/) plan
- A domain on Cloudflare with [Email Routing](https://developers.cloudflare.com/email-routing/) enabled
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) to sign in
- Node.js 22 or later

## Getting Started

```sh
cd worker
npm install
cp .dev.vars.example .dev.vars   # signs in local requests, so no Access is needed
mkdir -p web                     # or `npm run build:web` to include the web client
npm run dev
```

To deliver a test message to the local server:

```sh
curl -X POST "http://127.0.0.1:8787/cdn-cgi/handler/email?from=a@example.org&to=hello@example.com" \
  --data-binary @message.eml
```

Run the checks with `npm run typecheck` and `npm test`.

## Deploy

From `worker/`:

1. **Create the storage**

   ```sh
   npx wrangler login
   npx wrangler r2 bucket create personal-mail
   npx wrangler queues create personal-mail-ingest
   ```

2. **Configure** `wrangler.jsonc`: set your mail hostname in `routes`, your login email in `ACCESS_ALLOWED_EMAILS`, and your accounts in `IMAP_SOURCES` (or leave it empty).
3. **Deploy** with `npm run deploy`. The Worker answers 404 to every request until Access is configured.
4. **Set up Cloudflare Access**: add a self-hosted application for the mail hostname with an Allow policy for your email, plus a Service Auth policy if you use the Android app. Set `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and, for the app, `ACCESS_SERVICE_TOKENS`, then deploy again.
5. **Route mail to the Worker**: in Email Routing, set the catch-all action to *Send to a Worker* and choose `personal-mail`. Turn on subaddressing for `+tag` addresses.
6. **Add IMAP passwords**: run `npx wrangler secret put <passwordSecret>` for each account in `IMAP_SOURCES`. An account starts syncing once its secret exists.

## Configuration

| Variable | Purpose |
|---|---|
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | Your Access team domain and the application's AUD tag (required) |
| `ACCESS_ALLOWED_EMAILS` | Emails allowed to sign in |
| `ACCESS_SERVICE_TOKENS` | Service-token client ids allowed in, for the Android app |
| `IMAP_SOURCES` | Accounts to import: host, user, folders and the name of the password secret |
| `CLASSIFIER_MODEL` | `clef`, `clef-flash`, or `""` to turn off AI categories |
| `CLASSIFIER_DAILY_NEURONS` | Daily Workers AI budget for categories (default 9,500) |

Personal Mail is single-user: anyone who passes the Access policy can read the whole mailbox.

## Architecture

```
┌───────────────┐   ┌─────────────────┐
│ Email Routing │──>│ email() handler │──┐
└───────────────┘   └─────────────────┘  │   ┌──────────┐   ┌───────────────────┐
                                         ├──>│ R2 (raw) │──>│ Queue consumer    │
┌───────────────┐   ┌─────────────────┐  │   └──────────┘   │ parse, DKIM       │
│ IMAP accounts │──>│ ImapSource DO   │──┘                  └─────────┬─────────┘
└───────────────┘   └─────────────────┘                               │
                                                                      v
┌───────────────┐   ┌─────────────────┐                     ┌───────────────────┐
│ Web / Android │──>│ Worker fetch()  │──────── JMAP ──────>│ Mailbox DO        │
│ clients       │<──│ behind Access   │<─────── push ───────│ SQLite + FTS5     │
└───────────────┘   └─────────────────┘                     │ rules, categories │
                                                            └───────────────────┘
```

## License

MIT, see [LICENSE](LICENSE).
