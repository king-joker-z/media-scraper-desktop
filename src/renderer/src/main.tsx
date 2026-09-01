import './assets/main.css'
import './assets/component-enhancements.css'
import './assets/task-island.css'
import './assets/rename-comparison.css'
import './assets/workbench.css'
import './assets/platform.css'
import './assets/terminal.css'
import './assets/comic.css'
import './assets/ukiyo.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
