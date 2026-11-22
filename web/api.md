# diff API, for agents

diff ({{origin}}) shows what changed between two texts: a Before and an After, with removed words struck, added words green and moved sentences tagged. Humans open a link; agents use this JSON API. No login, no API key.

- Base URL: `{{origin}}`
- Every write needs the header `X-Diff: 1` and `Content-Type: application/json`.
- Machine-readable spec: `{{origin}}/openapi.json`

## Identity

A user is an id (22 letters and digits) plus a display name. Send it as the header `X-User: <user id>`.

- **Act as the human**: they can copy their user id from the app (the "Connect agent" button). Your edits then show under their name.
- **Act as yourself**: send no `X-User`. The first call creates a new user and returns its id in `you.id`; send that id as `X-User` on later calls. Give yourself a name that says you are an agent, e.g. `"name": "John's agent"`.
- A user id names who made a version. It grants no access: access comes only from a diff's link token.

## One call: new user, name, diff, links

```http
POST {{origin}}/api/diffs
X-Diff: 1
Content-Type: application/json

{"before": "Our webinar platform is easy to use.", "after": "Our webinar platform is simple to use.", "name": "John's agent"}
```

Response `201`:

```json
{
  "urls": {"edit": "{{origin}}/<edit token>", "view": "{{origin}}/<view token>"},
  "edit": "<edit token>", "view": "<view token>", "rev": 1,
  "you": {"id": "<your user id>", "name": "John's agent"},
  "head": {"n": 1, "authors": ["John's agent"], "createdAt": 0, "updatedAt": 0, "name": null}
}
```

- Give a human `urls.edit` to let them edit, or `urls.view` for read-only.
- `name` is optional; it renames the calling user (new or `X-User`).
- `left`/`right` are accepted as aliases for `before`/`after`.

## Read a diff

`GET {{origin}}/api/d/<token>` returns `role` (`edit` or `view`), `rev`, `head.left` and `head.right` (the Before and After texts of the latest version), `versions`, and `urls`.

## Update a diff (edit token only)

```http
PUT {{origin}}/api/d/<edit token>
X-Diff: 1
X-User: <user id>
Content-Type: application/json

{"before": "...", "after": "...", "base": 3}
```

- `base` is the `rev` you last read. If someone saved since, you get `409 {"error": "conflict", "rev": <current>}`: read again, merge, retry.
- Omit `base` to save without checking; your save becomes a new version, so nothing is overwritten.
- Versions: saves by the same user within 30 minutes amend the latest version; another user's save starts a new one.

## Other calls

| Call | What it does |
|---|---|
| `GET /api/me` | Your `{id, name}` |
| `PUT /api/me` `{"name": "..."}` | Rename yourself (1–40 characters) |
| `GET /api/d/<token>/v/<n>` | One version's `left` and `right` |
| `PUT /api/d/<token>/v/<n>/name` `{"name": "Sent to client"}` | Name a version; `null` clears it |
| `POST /api/d/<token>/v/<n>/restore` | Copy an old version on top as a new version |
| `PUT /api/d/<token>/settings` `{"versioning": false}` | Turn automatic versions off or on |

## Limits and errors

- 100 new diffs or versions per IP per day; 120 saves per minute; a diff holds up to 1 MB of text (Before and After together, UTF-8).
- Errors are JSON `{"error": "..."}`: `400` bad input, `403` view-only link or missing `X-Diff`, `404` unknown token, `409` conflict, `413` too large, `429` rate limit.
- Links are private and never indexed. Treat an edit link like a password.
