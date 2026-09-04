# TikTok — getting it actually posting (no app review required)
2026-09-03

## The distinction that unblocks this

Two different things have been tangled together:

- **TikTok app review** — needed only for *public* auto-posting to *other people's* accounts. Blocked on a multi-creator product that doesn't exist. Long road.
- **TikTok posting working at all** — video lands in Mark's own TikTok **Drafts**, he opens the app and taps publish. **Needs no review, no audit, no approval.** An unaudited app can always act on the developer's own account with `video.upload`.

The second one is finishable now, and it's most of the practical value: no more manual file transfer to the phone, no re-uploading, no losing the caption. The last step (tapping publish) was always going to be manual anyway — that was the whole "approval gate" design.

## Why it isn't working today

Phase 1 (`71394b5`) fixed the *code*. Nothing has fixed the *credential*:

1. **Any existing TikTok token was issued under the old scope.** The app now holds `user.info.basic` + `video.upload`; the old `tiktokAuth.js` header says it was authorized for `video.publish`. A token without `video.upload` cannot call the inbox endpoint. **Re-authorization is required regardless of what's in Render right now.**
2. **There is no route that starts the OAuth flow.** `server.js` only wires `GET /auth/tiktok/callback`. To get a code today, someone has to hand-build TikTok's authorize URL — error-prone and unnecessary.
3. **Unknown, never verified:** whether `TIKTOK_CLIENT_KEY`/`TIKTOK_CLIENT_SECRET` are set on Render, and whether **migration `006_platform_tokens.sql` was ever run** in Supabase. `getValidTikTokToken()` throws without the client key/secret and cannot store anything without the table. This vault has been wrong about "migration was run" before (the creator-access migration, found 09-01) — do not assume either way, check.

## Order of operations

1. Claude Code ships the start route + diagnostic + callback persistence (below).
2. Mark hits the diagnostic, fixes whatever it reports (env vars, migration).
3. Mark hits `/auth/tiktok/start` **signed into TikTok as the account that owns the developer app** — an unaudited app only accepts the developer's own account.
4. Queue one real post, approve it, confirm the video is in TikTok Drafts.

Step 4 is the finish line. Not the portal.

---

## Paste to Claude Code

> Repo: `mindtranceform-backend` (the `OneDrive\Desktop` clone, in sync with `origin/main`). This continues the TikTok work from commit `71394b5`. Verify claims against the code rather than trusting this file.
>
> Goal: make TikTok posting actually work for Mark's own account via the inbox/draft flow. No app review involved. Three changes.
>
> **1. `GET /auth/tiktok/start`** — builds TikTok's OAuth authorize URL and redirects to it. `client_key` from `TIKTOK_CLIENT_KEY`, `response_type=code`, `scope=user.info.basic,video.upload` (exactly the two scopes the app holds — do not include `video.publish`, the app doesn't have it and asking will fail the authorization), `redirect_uri` matching the portal **exactly**: `https://mindtranceform-backend.onrender.com/auth/tiktok/callback`. Generate a random `state`, store it (short-TTL, server-side), and verify it in the callback — reject a mismatch. Check TikTok's current docs for the authorize endpoint and parameter names rather than trusting this description. Gate the route behind `requireAdmin` if that can be done without breaking the browser redirect flow; if it can't, say so rather than silently leaving it open.
>
> **2. Callback persists instead of printing.** `tiktokAuth.js` currently renders the raw access and refresh tokens in HTML for copy-paste into Render env vars. Change it to write them straight into `platform_tokens` via `tokenStore`'s existing save path (platform `tiktok`, with the real `expires_in`/`refresh_expires_in` converted to timestamps), then render only a confirmation: connected account handle (call `user.info.basic`), the granted scopes as TikTok returned them, and the access-token expiry. **No token values on the page.** This removes a manual copy-paste step, keeps the refresh-rotation working (the table is already the source of truth), and deletes the clearest artifact of the "internal use" architecture that got the app rejected.
>
> **3. `GET /content/tiktok-status`** (admin-guarded, JSON) — a diagnostic that answers the unknowns in one request **without returning any secret values**. Report: which of `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_ACCESS_TOKEN`, `TIKTOK_REFRESH_TOKEN` are present (booleans only, never the values, never a prefix); whether the `platform_tokens` table exists and whether it holds a `tiktok` row; and for that row, the access-token expiry, refresh-token expiry and stored scope — never the tokens. Distinguish "table missing" from "table empty" explicitly: right now those two failure modes are indistinguishable, which is exactly the trap the `content_posts` work hit in August.
>
> Then tell Mark, concretely, what the diagnostic says is missing.
>
> Do not touch the Developer Portal. Do not start Phase 2 (multi-creator OAuth) — still gated on Mark's decision. Do not put any token in the repo or in the vault; Render env and Supabase only. Report what is deployed and verified live vs. what is merely committed.
