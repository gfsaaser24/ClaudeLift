(async () => {
  const req = typeof require === 'function' ? require : process.mainModule.require.bind(process.mainModule)
  const { webContents } = req('electron')
  const wc = webContents.getAllWebContents().find((w) => w.getType() === 'window' && w.getURL().startsWith('https://claude.ai'))
  if (!wc) return 'claude.ai page not found'
  return await wc.executeJavaScript(`(() => {
    if (window.__clRecInstalled) return 'recorder already installed (' + window.__clRec.length + ' calls so far)'
    window.__clRecInstalled = true
    window.__clRec = []
    const orig = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input && input.url
      const method = (init && init.method) || (input && input.method) || 'GET'
      let reqBody = null
      try {
        const b = init && init.body
        reqBody = typeof b === 'string' ? b.slice(0, 20000)
          : b instanceof FormData ? [...b.entries()].map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 2000) : '<file ' + v.name + ' ' + v.size + 'B ' + v.type + '>'])
          : b ? '<' + Object.prototype.toString.call(b) + '>' : null
      } catch (_) {}
      let headers = null
      try { headers = init && init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : null } catch (_) {}
      const res = await orig(input, init)
      try {
        const u = url || ''
        const noise = /event_logging|\\/rum\\?|presence|branch-status|\\/ping$|mark_read/.test(u)
        if (!noise && (method !== 'GET' || /\\/v1\\/code\\//.test(u))) {
          res.clone().text().then((t) => window.__clRec.push({ at: new Date().toISOString(), method, url: u, headers, reqBody, status: res.status, resp: t.slice(0, 20000) }))
        }
      } catch (_) {}
      return res
    }
    return 'recorder installed on ' + location.href
  })()`, true)
})()
