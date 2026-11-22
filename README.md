# diff

Text diff for copy, notes and bullet lists at [diff.brikas.dev](https://diff.brikas.dev). Paste two versions, share an edit or view link, edit while you look. Versions save themselves.

- Spec: [SPEC.md](SPEC.md)
- Diff rules: [web/diffing.ts](web/diffing.ts); one-column view: [web/unified.ts](web/unified.ts)
- Versioning rules: [server/store.ts](server/store.ts)
- Agent API guide: [web/api.md](web/api.md), served at `/api`, with `/openapi.json`
- Keyboard shortcuts: [web/app.ts](web/app.ts) (`SHORTCUTS`), listed in the app under the keyboard icon

```bash
npm ci && npm test && npm run dev   # http://localhost:8787
```

Diff quality eval: 54 generated cases in [eval/](eval/). `eval/render.py` screenshots each case in the running app, `eval/dump.ts` writes the changes as text, and judges score them by [eval/JUDGE.md](eval/JUDGE.md).

Deploy (remote box, as an admin, from `/srv/apps/diff`): `ADMINS="you" deploy/setup-box.sh` once, then `deploy/deploy.sh`. The setup caps everything the app can use: memory, CPU, processes, disk speed, and a fixed-size data disk.

MIT, see [LICENSE](LICENSE).
