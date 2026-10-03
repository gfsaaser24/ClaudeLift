(async () => {
  const req = typeof require === 'function' ? require : process.mainModule.require.bind(process.mainModule)
  const { webContents } = req('electron')
  const wc = webContents.getAllWebContents().find((w) => w.getType() === 'window' && w.getURL().startsWith('https://claude.ai'))
  if (!wc) return 'claude.ai page not found'
  return await wc.executeJavaScript(`JSON.stringify({ url: location.href, recorder: !!window.__clRecInstalled, calls: window.__clRec || [] })`, true)
})()
