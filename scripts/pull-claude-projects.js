// Pull a whole claude.ai account into one JSON file, for every organization
// the signed-in user can read:
//   - projects: settings + custom instructions, knowledge docs (full text),
//     uploaded files (base64, incl. CSV/XLSX "blob" files), sync sources,
//     project memory
//   - account: profile, memory + memory settings, skills list, styles
//   - chats: the conversation list (links each chat to its project), or with
//     opts.chats = 'full' every conversation with all messages
//
// Read-only: GET requests with the existing session, then one browser
// download (`claudelift-pull-<runId>.json`, or `claude-projects-full-<date>.json`
// when run by hand).
//
// Run in the DevTools console of the claude.ai page (Claude Desktop with
// Developer Mode on → Ctrl+Shift+I, or claude.ai in a browser). ClaudeLift
// sets `globalThis.__CLAUDELIFT_PULL_OPTS = { runId, chats }` before running it.
(async () => {
  if (location.origin !== 'https://claude.ai') {
    console.error('[pull] Wrong window: run this in the DevTools of the claude.ai page (location is ' + location.href + ').')
    return
  }
  const opts = Object.assign({ runId: '', chats: 'list' }, globalThis.__CLAUDELIFT_PULL_OPTS || {})
  const MAX_FILE_BYTES = 60 * 1024 * 1024
  const log = (...a) => console.log('%c[pull]', 'color:#E2571D;font-weight:bold', ...a)

  const getJson = async (url) => {
    const r = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } })
    if (!r.ok) throw new Error(`${r.status} ${url}`)
    return r.json()
  }
  const tryJson = async (url) => {
    try { return await getJson(url) } catch (e) { return { __error: String(e && e.message || e) } }
  }
  const asList = (v) => Array.isArray(v) ? v : (v && (v.data || v.projects || v.items || v.files || v.docs || v.skills)) || []

  // Page through a list endpoint (limit/offset); stop when a page adds nothing.
  const listAll = async (url, pageSize = 100) => {
    const seen = new Map()
    const sep = url.includes('?') ? '&' : '?'
    for (let offset = 0; offset < 100000; offset += pageSize) {
      const page = await tryJson(`${url}${sep}limit=${pageSize}&offset=${offset}`)
      if (page.__error) return { items: [...seen.values()], error: page.__error }
      const items = asList(page)
      let added = 0
      for (const x of items) {
        const key = (x && (x.uuid || x.id)) || JSON.stringify(x)
        if (!seen.has(key)) { seen.set(key, x); added++ }
      }
      if (added === 0 || items.length < pageSize) break
    }
    return { items: [...seen.values()], error: null }
  }

  // Every URL-looking string inside a file record, best candidates first.
  const fileUrls = (obj) => {
    const found = new Set()
    const walk = (v) => {
      if (typeof v === 'string') {
        if (/^\/api\//.test(v) || /^https:\/\/claude\.ai\/api\//.test(v)) found.add(v)
      } else if (v && typeof v === 'object') {
        for (const x of Object.values(v)) walk(x)
      }
    }
    walk(obj)
    const rank = (u) => /original|document|download|content|asset/i.test(u) ? 0 : /preview/i.test(u) ? 1 : /thumbnail/i.test(u) ? 3 : 2
    return [...found].sort((a, b) => rank(a) - rank(b))
  }
  const toBase64 = (blob) => new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(String(fr.result).split(',', 2)[1] || '')
    fr.onerror = () => rej(fr.error)
    fr.readAsDataURL(blob)
  })
  const downloadFile = async (f, org) => {
    // Uploaded originals come from the organization files route ("blob"
    // CSV/XLSX files have no other link); asset links are the fallback.
    const urls = []
    if (f.file_uuid) urls.push(`/api/organizations/${org}/files/${f.file_uuid}/contents`)
    urls.push(...fileUrls(f))
    for (const url of urls) {
      try {
        const r = await fetch(url, { credentials: 'include' })
        if (!r.ok) continue
        const type = r.headers.get('content-type') || ''
        if (type.includes('text/html')) continue
        const blob = await r.blob()
        if (!blob.size) continue
        if (blob.size > MAX_FILE_BYTES) return { url, skipped: `too large (${blob.size} bytes)` }
        return { url, content_type: type, size: blob.size, base64: await toBase64(blob) }
      } catch (_) { /* try the next candidate */ }
    }
    return { error: 'no downloadable URL found', candidates: urls }
  }

  const out = {
    tool: 'claudelift-project-pull', version: 2, pulled_at: new Date().toISOString(), options: opts,
    account: { profile: await tryJson('/api/account_profile') },
    organizations: [],
  }
  const orgs = asList(await getJson('/api/organizations'))
  log(`${orgs.length} organization(s):`, orgs.map((o) => o.name).join(', '))
  const summary = []

  for (const o of orgs) {
    const org = o.uuid
    const orgOut = { uuid: org, name: o.name, capabilities: o.capabilities || [], projects: [], errors: [] }
    out.organizations.push(orgOut)

    const listed = await listAll(`/api/organizations/${org}/projects?include_harmony_projects=true`)
    if (listed.error) {
      // API-only / customer orgs have no claude.ai chat surface.
      orgOut.errors.push(listed.error)
      log(`${o.name}: no chat access (${listed.error.split(' ')[0]}), skipped`)
      continue
    }
    orgOut.memory = await tryJson(`/api/organizations/${org}/memory`)
    orgOut.memory_settings = await tryJson(`/api/organizations/${org}/memory/settings`)
    orgOut.skills = (await listAll(`/api/organizations/${org}/skills/list-skills`)).items
    orgOut.styles = await tryJson(`/api/organizations/${org}/list_styles`)
    // Connectors (remote MCP servers) and plugins: the list of what to
    // reconnect / reinstall on the new account. Plugin files themselves come
    // from the Cowork plugin folders on the PC.
    orgOut.connectors = await tryJson(`/api/organizations/${org}/mcp/remote_servers`)
    orgOut.plugins = await tryJson(`/api/organizations/${org}/plugins/list-plugins?limit=500`)
    log(`${o.name}: ${listed.items.length} project(s), ${orgOut.skills.length} skill(s)`)

    let n = 0
    for (const p of listed.items) {
      n++
      const puuid = p.uuid
      const base = `/api/organizations/${org}/projects/${puuid}`
      const project = await tryJson(`${base}?include_has_sync_sources=true`)
      const docs = await tryJson(`${base}/docs`)
      const files = await tryJson(`${base}/files`)
      const syncs = await tryJson(`${base}/syncs?calculate_size=false`)
      const memory = await tryJson(`/api/organizations/${org}/memory?project_uuid=${puuid}`)
      // A project linked to a Cowork space keeps its knowledge in a folder on
      // the PC it is bound to, not in claude.ai — so "0 docs, 0 files" is
      // expected there, not a failed download.
      const settings = await tryJson(`${base}/settings`)
      const fileList = asList(files)
      const fileData = []
      for (const f of fileList) fileData.push({ meta: f, data: await downloadFile(f, org) })
      const name = (project && project.name) || p.name || puuid
      const okFiles = fileData.filter((x) => x.data && x.data.base64).length
      const nDocs = asList(docs).length
      const coworkSpace = !settings.__error && !!(settings.local_space_id || settings.cowork_bound_device)
      const instructions = ((project && project.prompt_template) || p.prompt_template || '').length > 0
      const kind = coworkSpace ? 'cowork-space'
        : nDocs || fileList.length ? 'knowledge'
        : instructions ? 'instructions-only' : 'empty'
      const note = nDocs || fileList.length ? ''
        : kind === 'cowork-space' ? ' (Cowork space: its files live in a folder on the linked PC)'
        : kind === 'instructions-only' ? ' (instructions only, no uploads)'
        : ' (nothing uploaded)'
      orgOut.projects.push({ uuid: puuid, listed: p, project, docs, files: fileData, files_raw: files, syncs, memory, settings, kind })
      log(`  [${n}/${listed.items.length}] ${name} — docs ${nDocs}, files ${okFiles}/${fileList.length}${note}`)
      summary.push({ org: o.name, project: name, kind, docs: nDocs, files: `${okFiles}/${fileList.length}` })
    }

    if (opts.chats !== 'none') {
      const chats = await listAll(`/api/organizations/${org}/chat_conversations`)
      orgOut.chats = chats.items
      log(`${o.name}: ${chats.items.length} chat(s) listed (${chats.items.filter((c) => c.project_uuid).length} in projects)`)
      if (opts.chats === 'full') {
        orgOut.chat_bodies = []
        let i = 0
        for (const c of chats.items) {
          i++
          orgOut.chat_bodies.push(await tryJson(
            `/api/organizations/${org}/chat_conversations/${c.uuid}?tree=True&rendering_mode=messages&render_all_tools=true`))
          if (i % 50 === 0) log(`  chats ${i}/${chats.items.length}`)
        }
      }
    }
  }

  console.table(summary)
  const blob = new Blob([JSON.stringify(out)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = opts.runId
    ? `claudelift-pull-${opts.runId}.json`
    : `claude-projects-full-${new Date().toISOString().slice(0, 10)}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.__claudeliftProjectPull = out
  log(`Done: ${summary.length} project(s), ${(blob.size / 1048576).toFixed(1)} MB → ${a.download}`)
})()
