import './assets/main.css'
import './assets/component-enhancements.css'
import './assets/task-island.css'
import './assets/rename-comparison.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
