// eqd: keeps MathJax loaded and answers render requests over a Unix socket.
//
// Started by the eqview mod as a child of the Claude Code session. It prints
// one line, `EQD_READY {"socket": "..."}`, once it is listening, and exits when
// its parent goes away.
//
//   POST /render  { items: [{ tex, display }], cell: [w, h], fg, scale, maxColumns }
//             ->  [{ ok, png, columns, rows } | { ok: false, error }]
//   GET  /health  -> { ok: true, pid, rendered }

import { mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { render, type RenderOptions } from './render.ts'

type Item = { tex: string; display?: boolean }
type RenderRequest = Partial<RenderOptions> & { items?: Item[] }

const runDir = process.env.EQVIEW_RUN_DIR ?? join(homedir(), '.cache', 'eqview', 'run')
mkdirSync(runDir, { recursive: true, mode: 0o700 })
const socket = join(runDir, `eqd-${process.pid}.sock`)
rmSync(socket, { force: true })

let rendered = 0

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const server = Bun.serve({
  unix: socket,
  async fetch(request) {
    const { pathname } = new URL(request.url)
    if (pathname === '/health') return json({ ok: true, pid: process.pid, rendered })
    if (pathname !== '/render' || request.method !== 'POST') return json({ error: 'not found' }, 404)

    let body: RenderRequest
    try {
      body = (await request.json()) as RenderRequest
    } catch {
      return json({ error: 'body is not JSON' }, 400)
    }
    const cell = body.cell
    if (!Array.isArray(cell) || cell.length !== 2 || !Array.isArray(body.items)) {
      return json({ error: 'need items and cell: [width, height]' }, 400)
    }
    const options: RenderOptions = {
      cell: [Number(cell[0]), Number(cell[1])],
      fg: typeof body.fg === 'string' ? body.fg : '#e6e6e6',
      scale: typeof body.scale === 'number' && body.scale > 0 ? body.scale : 1,
      maxColumns: typeof body.maxColumns === 'number' ? body.maxColumns : 120,
      baselineShift: typeof body.baselineShift === 'number' ? body.baselineShift : 0,
    }

    const results = body.items.map(item => {
      rendered += 1

      return render(String(item.tex ?? ''), item.display !== false, options)
    })

    return json(results)
  },
})

function stop(): void {
  server.stop(true)
  rmSync(socket, { force: true })
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)

// Reparented to init: the Claude Code session that started us is gone.
const parent = process.ppid
setInterval(() => {
  if (process.ppid !== parent) stop()
}, 5000).unref?.()

// Typeset once so the first real request does not pay MathJax's warm-up.
render('x^2', true, { cell: [8, 16], fg: '#000', scale: 1, maxColumns: 40 })

console.log(`EQD_READY ${JSON.stringify({ socket, pid: process.pid })}`)
