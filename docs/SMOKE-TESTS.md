# HawkTalk Production Smoke-Test Checklist

Run this checklist manually after a deployment.

Record PASS / FAIL / N/A and include sanitized notes.

| # | Test | Expected |
| --- | --- | --- |
| 1 | `/healthz` | HTTP 200 with healthy response and expected security headers |
| 2 | Missing webhook secret | HTTP 401 |
| 3 | Incorrect webhook secret | HTTP 401 |
| 4 | Invalid content type | HTTP 400 |
| 5 | Oversized webhook body | HTTP 413 |
| 6 | Owner private-chat message | AI response is generated |
| 7 | Duplicate Telegram update | No duplicate AI generation |
| 8 | Non-private chat | Request does not enter normal conversation processing |
| 9 | Rate-limit behavior | Deterministic rejection without an AI call |
| 10 | `/fast` | Fast routing profile works |
| 11 | `/smart` | Smart routing profile works |
| 12 | `/research` | Research path executes with bounded external context |
| 13 | `/remember` | Memory is stored or graceful-unavailable response is returned |
| 14 | `/memories` | Owner-scoped memories are listed |
| 15 | `/forget` | Target memory is removed |
| 16 | Memory recall | Relevant stored context can influence the response |
| 17 | Second user isolation | User cannot see another user's state |
| 18 | `/admin` | Only authorized roles receive admin controls |
| 19 | Provider failure | Router fails over or returns a generic error |
| 20 | Safe errors | No secrets, paths, stack traces, or raw upstream details |

## Error-response checks

Across failure cases verify:

- generic user-facing error,
- request correlation ID,
- no stack trace,
- no provider credential,
- no Telegram bot token,
- no internal database detail,
- no raw upstream response,
- no user content leaked to unrelated users.

## Record

```text
Deployment commit:
Deployment date:
Worker hostname:
Tester:

PASS:
FAIL:
N/A:

Notes:
```
