'use strict'

const byId = id => document.getElementById(id)
const MAX_RENDERED_LOGS = 1000

document.querySelectorAll('.tab-button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tab-button').forEach(item => item.classList.remove('active'))
    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'))
    button.classList.add('active')
    byId(`panel-${button.dataset.tab}`).classList.add('active')
  })
})

function appendLog(entry) {
  const container = byId('log-container')
  const row = document.createElement('div')
  const level = ['debug', 'info', 'warn', 'error'].includes(entry.level) ? entry.level : 'info'
  row.className = `log-${level}`
  row.textContent = `[${entry.timestamp}] [${level.toUpperCase()}] ${entry.message}`
  container.appendChild(row)
  while (container.childElementCount > MAX_RENDERED_LOGS)
    container.firstElementChild.remove()
  container.scrollTop = container.scrollHeight
}

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(`${protocol}//${location.host}/ws`)
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.type === 'log')
      appendLog(message.data)
  })
  socket.addEventListener('close', () => setTimeout(connectWebSocket, 3000))
}

async function request(path, options) {
  const response = await fetch(path, options)
  if (response.status === 401) {
    location.reload()
    throw new Error('Web session expired')
  }
  if (!response.ok)
    throw new Error(`Request failed with status ${response.status}`)
  return response
}

function textElement(tag, className, value) {
  const element = document.createElement(tag)
  if (className)
    element.className = className
  element.textContent = String(value)
  return element
}

function renderLastRun(lastRun) {
  const container = byId('last-run')
  if (!lastRun || !Array.isArray(lastRun.results))
    return

  const rows = lastRun.results.map((result) => {
    const row = document.createElement('div')
    row.className = 'result-row'
    row.append(
      textElement('span', '', result.taskId),
      textElement('span', result.success ? 'success' : 'failure', result.success ? 'OK' : 'FAIL'),
      textElement('span', 'duration', `${result.durationMs}ms`),
    )
    return row
  })
  container.replaceChildren(...rows)
}

async function fetchStatus() {
  try {
    const response = await request('/api/status')
    const data = await response.json()
    const status = byId('run-status')
    status.textContent = data.running ? 'Running' : 'Idle'
    status.className = `badge ${data.running ? 'running' : 'idle'}`
    renderLastRun(data.lastRun)
  }
  catch {
    // The next poll retries transient failures.
  }
}

async function fetchTasks() {
  try {
    const response = await request('/api/tasks')
    const tasks = await response.json()
    const rows = tasks.map((task) => {
      const row = document.createElement('div')
      const identity = document.createElement('div')
      row.className = 'task-row'
      identity.append(
        textElement('strong', '', task.name),
        textElement('span', 'task-id', task.id),
      )
      row.append(
        identity,
        textElement('span', task.enabled ? 'enabled' : 'disabled', task.enabled ? 'Enabled' : 'Disabled'),
      )
      return row
    })
    byId('task-list').replaceChildren(...rows)
  }
  catch {
    // Keep the last successfully rendered task list.
  }
}

async function fetchPlugins() {
  try {
    const response = await request('/api/plugins')
    const plugins = await response.json()
    if (!Array.isArray(plugins) || plugins.length === 0) {
      byId('plugin-list').replaceChildren(textElement('p', 'muted', 'No plugins discovered.'))
      return
    }

    const rows = plugins.map((plugin) => {
      const row = document.createElement('div')
      row.className = 'plugin-row'
      const title = document.createElement('div')
      title.className = 'plugin-title'
      title.append(
        textElement('strong', '', plugin.name || plugin.id),
        textElement('span', 'task-id', plugin.id),
        textElement('span', '', plugin.version ? ` v${plugin.version}` : ''),
        textElement('span', plugin.loaded ? 'enabled' : 'disabled', plugin.loaded ? 'Loaded' : (plugin.enabled ? 'Failed' : 'Disabled')),
        textElement('span', 'task-id', plugin.bundled ? 'bundled' : 'external'),
      )
      row.append(title)
      if (plugin.description)
        row.append(textElement('p', 'muted', plugin.description))
      if (plugin.failure)
        row.append(textElement('p', 'failure', plugin.failure))
      for (const [label, values] of [
        ['channels', plugin.channels],
        ['services', plugin.services],
        ['routes', plugin.routes],
        ['tools', plugin.tools],
      ]) {
        if (Array.isArray(values) && values.length > 0)
          row.append(textElement('p', 'plugin-capability', `${label}: ${values.join(', ')}`))
      }
      return row
    })
    byId('plugin-list').replaceChildren(...rows)
  }
  catch {
    // Keep the last successfully rendered plugin list.
  }
}

async function fetchConfig() {
  try {
    const response = await request('/api/config')
    byId('config-display').textContent = JSON.stringify(await response.json(), null, 2)
  }
  catch {
    // Keep the last successfully rendered configuration.
  }
}

async function triggerRun() {
  const button = byId('run-button')
  button.disabled = true
  button.textContent = 'Starting...'
  try {
    await request('/api/run', { method: 'POST' })
  }
  catch {
    // Status refresh below reflects whether the request started.
  }
  setTimeout(() => {
    button.disabled = false
    button.textContent = 'Run Now'
    fetchStatus()
  }, 2000)
}

byId('run-button').addEventListener('click', triggerRun)
connectWebSocket()
fetchStatus()
fetchTasks()
fetchPlugins()
fetchConfig()
setInterval(fetchStatus, 10000)
