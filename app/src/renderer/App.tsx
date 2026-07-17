/**
 * App shell (Task 9): wires initApp once, then renders Nav + the
 * current view + StatusFooter + ToastHost.
 *
 * Layout: h-screen flex — left rail (w-56) on lg via Nav's <aside>,
 * fixed bottom dock below lg (the pb-16 on the content column reserves
 * its height); main content scrolls independently.
 */
import { useEffect } from 'react'
import type { JSX } from 'react'
import { useAppStore } from './store'
import type { ViewName } from './store'
import Nav from './components/Nav'
import StatusFooter from './components/StatusFooter'
import ToastHost from './components/ToastHost'
import TasksView from './views/TasksView'
import BundlesView from './views/BundlesView'
import NotionView from './views/NotionView'
import SettingsView from './views/SettingsView'

const VIEWS: Record<ViewName, () => JSX.Element> = {
  tasks: TasksView,
  bundles: BundlesView,
  notion: NotionView,
  settings: SettingsView
}

export default function App(): JSX.Element {
  const view = useAppStore((s) => s.view)
  const initApp = useAppStore((s) => s.initApp)

  useEffect(() => {
    void initApp() // module-level once-guard makes this StrictMode-safe
  }, [initApp])

  const View = VIEWS[view]

  return (
    <div className="flex h-screen flex-col lg:flex-row">
      <Nav />
      <div className="flex min-w-0 flex-1 flex-col pb-16 lg:pb-0">
        <main className="min-h-0 flex-1 overflow-y-auto bg-base-200 p-4 lg:p-6">
          <View />
        </main>
        <StatusFooter />
      </div>
      <ToastHost />
    </div>
  )
}
