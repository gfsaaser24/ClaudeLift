import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './app.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root element missing from index.html')

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
