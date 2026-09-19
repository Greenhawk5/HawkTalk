# HawkTalk Production Smoke-Test Checklist

Execute these tests manually after deployment (Step I of the deployment runbook).
Record PASS/FAIL for each item. Do NOT execute destructive tests against production.

---

## 1. Worker /healthz

```bash
curl -s https://<WORKER_HOSTNAME>/healthz
```

Expected: `{"status":"ok"}` with HTTP 200.
Verify response headers include `X-Request-ID`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.

## 2. Telegram Webhook Authentication

Send a POST to `/telegram/webhook` without the `X-Telegram-Bot-Api-Secret-Token` header.

Expected: HTTP 401 `{"error":"Unauthorized"}`.
Send with an incorrect secret token. Expected: HTTP 401.
Send with non-JSON content type. Expected: HTTP 400.
Send with body exceeding 256KB. Expected: HTTP 413.

## 3. Normal Private-Chat Message

From the owner's Telegram account, send a normal text message to the bot in a private chat.

Expected: Bot responds with an AI-generated reply within ~30 seconds.
Verify the response correlates with the message content.

## 4. Duplicate Telegram Update

Re-send the exact same update payload (same `update_id`) via curl or by triggering a Telegram redelivery.

Expected: Bot does NOT regenerate an AI response. If the original delivery succeeded, no duplicate message appears. If the original failed, the stored assistant text is delivered.

## 5. Quota/Rate Limit Behavior

Send messages rapidly until the configured rate limit or quota is hit.

Expected: Bot responds with a deterministic policy rejection message (no AI runs). Subsequent messages within the window are also rejected. After the window resets, messages succeed again.

## 6. /fast Command

Send `/fast Tell me about clouds` in a private chat.

Expected: Bot uses the fast routing profile. Response should arrive quickly.

## 7. /smart Command

Send `/smart Explain quantum entanglement` in a private chat.

Expected: Bot uses the smart routing profile. Response may take longer but should be more detailed.

## 8. /research Command

Send `/research latest developments in fusion energy` in a private chat.

Expected: Bot uses the research routing profile with web search tools enabled. Response should reference external sources if available.

## 9. /remember Command

Send `/remember My favorite color is blue` in a private chat.

Expected: Bot confirms the memory was stored. If semantic memory is unavailable (no Vectorize/AI binding), returns "Memory is currently unavailable."

## 10. /memories Command

Send `/memories` in a private chat.

Expected: Bot lists previously stored memories. If none exist, indicates no memories found.

## 11. /forget Command

Send `/forget My favorite color is blue` in a private chat.

Expected: Bot confirms the memory was removed.

## 12. Semantic Memory Recall in Ordinary Conversation

After storing a memory via `/remember`, send a regular message that relates to that memory (e.g., "What colors do I like?").

Expected: The AI response incorporates the stored memory context. If semantic memory is unavailable, conversation proceeds normally without memory context.

## 13. Owner Isolation

From a second Telegram account (non-owner), send a message to the bot.

Expected: The second user gets their own conversation context. They cannot access the owner's memories, conversations, or admin features. User records are separate in the database.

## 14. Blocked-User Behavior

Using the admin CMS, block a test user. Then have that user send a message.

Expected: The blocked user receives a rejection or no response (per admission policy). No AI runs for blocked users.

## 15. Admin Access

Send `/admin` in a private chat from the owner's account.

Expected: Admin UI inline keyboard appears. Non-admin users sending `/admin` should not see admin controls (it's treated as a normal message or rejected).

## 16. Malformed Telegram Update

Send a POST to `/telegram/webhook` with valid secret token but malformed JSON body (e.g., `{invalid`).

Expected: HTTP 400 `{"error":"Bad request"}`. No crash, no stack trace in response.

Send valid JSON but missing required Telegram update fields (e.g., `{"foo": "bar"}`).

Expected: HTTP 400 `{"error":"Bad request"}`.

## 17. Provider Failure/Failover

If possible, temporarily invalidate one AI provider credential via the admin CMS. Send a message.

Expected: The router falls back to another available provider. If all providers fail, the user gets a generic error ("Something went wrong"), not a stack trace or credential leak.

## 18. Web Search Unavailable Behavior

If web search tools are not configured or the search API is unreachable, send `/research test query`.

Expected: The bot handles the tool failure gracefully. It may return a partial response without web results or a bounded error message. It must NOT crash or expose internal error details.

## 19. Safe External Error Messages

For every error scenario above, verify:

- Response body never contains stack traces
- Response body never contains internal service names, database errors, or file paths
- Response body never contains secret values (tokens, keys)
- All error responses use generic language ("Something went wrong", "Bad request", "Unauthorized")
- `X-Request-ID` header is present on error responses for log correlation

---

## Test Execution Record

| # | Test | Result | Notes |
|---|------|--------|-------|
| 1 | /healthz | | |
| 2 | Webhook auth | | |
| 3 | Normal message | | |
| 4 | Duplicate update | | |
| 5 | Quota/rate limit | | |
| 6 | /fast | | |
| 7 | /smart | | |
| 8 | /research | | |
| 9 | /remember | | |
| 10 | /memories | | |
| 11 | /forget | | |
| 12 | Memory recall | | |
| 13 | Owner isolation | | |
| 14 | Blocked user | | |
| 15 | Admin access | | |
| 16 | Malformed update | | |
| 17 | Provider failover | | |
| 18 | Web search down | | |
| 19 | Safe errors | | |