// Tvine Shield challenge page. Strict-CSP friendly: no inline handlers, no eval, no innerHTML of strings.
// Flow: POST <prefix>/start → run level (pow | checkbox | captcha) → POST <prefix>/verify with the sensor
// report → ok: location.replace(return); {ok:false, level}: escalate to that level. At most 3 retries.
;(function () {
  'use strict'
  var root = document.getElementById('shield')
  var P = root.getAttribute('data-prefix') || '', R = root.getAttribute('data-return') || ''
  var firstLevel = root.getAttribute('data-level') || 'auto'
  var MAX_RETRIES = 3, retries = 0, ch = null, worker = null, busy = false, bg = null, bgWorker = null
  var $ = function (id) { return document.getElementById(id) }

  $('site').textContent = location.hostname || 'this site'

  function status(text, state) {
    var s = $('status'); s.textContent = text
    if (state) s.setAttribute('data-state', state); else s.removeAttribute('data-state')
  }
  function show(step) {
    ['pow', 'checkbox', 'captcha'].forEach(function (s) { $(s).hidden = s !== step })
  }

  function post(path, body) {
    return fetch(P + path, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().then(function (j) { return j }, function () { throw new Error('HTTP ' + res.status) })
    })
  }

  function safeReturn(url) {
    try { var u = new URL(url, location.href); if (u.origin === location.origin) return u.href } catch (e) {}
    return '/'
  }

  // ── start / verify ──────────────────────────────────────────────────────────────────────────────
  function start(level, isRetry) {
    if (worker) { worker.terminate(); worker = null }
    if (isRetry && ++retries > MAX_RETRIES) return giveUp()
    busy = false
    return post('/start', { r: R, level: level || 'auto' }).then(function (c) {
      if (!c || !c.nonce) throw new Error((c && (c.error || c.reason)) || 'bad challenge')
      ch = c
      bg = c.level === 'pow' ? null : backgroundPow(c)   // every level costs the PoW; checkbox / captcha solve it meanwhile
      if (c.ray) $('ray').textContent = 'Ray ' + c.ray
      if (c.level === 'checkbox') return runCheckbox()
      if (c.level === 'captcha') return runCaptcha(c.captcha)
      return runPow(c)
    }).catch(onError)
  }

  function verify(payload) {
    if (busy) return
    busy = true
    status('Verifying…')
    return Promise.all([window.tvineSensor.report(), bg || Promise.resolve(null)]).then(function (got) {
      var body = { nonce: ch.nonce, sensor: got[0], r: R }
      if (got[1] !== null) body.pow = { counter: got[1] }
      for (var k in payload) body[k] = payload[k]
      return post('/verify', body)
    }).then(function (res) {
      if (res && res.ok) {
        show(null)
        status('Check complete. Taking you to the page…', 'ok')
        location.replace(safeReturn(res.return))
        return
      }
      busy = false
      var next = res && res.level
      if (next === 'checkbox' || next === 'captcha' || next === 'pow') {
        if (ch.level === 'captcha' && next === 'captcha') status('That was not quite right. Here is a new puzzle.', 'error')
        return start(next, true)
      }
      throw new Error((res && (res.error || res.reason)) || 'verification failed')
    }).catch(onError)
  }

  function onError(err) {
    busy = false
    if (retries >= MAX_RETRIES) return giveUp()
    status('Something went wrong (' + (err && err.message || 'error') + '). Retrying…', 'error')
    setTimeout(function () { start(ch ? ch.level : firstLevel, true) }, 1200 * (retries + 1))
  }

  function giveUp() {
    show(null)
    status('We could not verify your browser. Open “Having trouble?” below for help.', 'error')
    document.querySelector('.help').open = true
  }

  // ── pow: invisible, Web Worker ──────────────────────────────────────────────────────────────────
  function runPow(c) {
    show('pow')
    status('Checking your browser… this takes a few seconds.')
    var bar = $('pow-progress'), d = Math.max(0, c.difficulty | 0), expected = Math.pow(2, d)
    bar.value = 0
    worker = new Worker(P + '/pow-worker.js')
    worker.onmessage = function (e) {
      var m = e.data || {}
      if (typeof m.progress === 'number') {
        var pct = Math.min(99, Math.round(100 * (1 - Math.exp(-m.progress / expected))))
        bar.value = pct; bar.textContent = pct + '%'
      } else if (typeof m.counter === 'number') {
        bar.value = 100; worker.terminate(); worker = null
        verify({ pow: { counter: m.counter } })
      } else if (m.error) onError(new Error(m.error))
    }
    worker.onerror = function () { onError(new Error('worker failed')) }
    worker.postMessage({ nonce: c.nonce, difficulty: d })
  }

  // the PoW behind the checkbox / captcha levels: resolves with the counter
  function backgroundPow(c) {
    if (bgWorker) bgWorker.terminate()
    return new Promise(function (resolve, reject) {
      var w = bgWorker = new Worker(P + '/pow-worker.js')
      w.onmessage = function (e) {
        var m = e.data || {}
        if (typeof m.counter === 'number') { w.terminate(); bgWorker = null; resolve(m.counter) }
        else if (m.error) reject(new Error(m.error))
      }
      w.onerror = function () { reject(new Error('worker failed')) }
      w.postMessage({ nonce: c.nonce, difficulty: Math.max(0, c.difficulty | 0) })
    })
  }

  // ── checkbox: trusted click + timing ────────────────────────────────────────────────────────────
  var shownAt = 0
  $('human').addEventListener('change', function (e) {
    var box = e.target
    if (!e.isTrusted || !ch || ch.level !== 'checkbox') { box.checked = false; return }
    box.disabled = true
    verify({ checkbox: { t: Math.round(performance.now() - shownAt) } })
  })
  function runCheckbox() {
    show('checkbox')
    var box = $('human'); box.checked = false; box.disabled = false
    shownAt = performance.now()
    status('Please confirm you are human by ticking the box.')
  }

  // ── captcha: server PNG + tile buttons, or a math puzzle PNG ──────────────────────────────────────
  var textMode = false
  function runCaptcha(cap) {
    show('captcha')
    if (!cap) return onError(new Error('missing puzzle'))
    $('captcha-prompt').textContent = cap.prompt + '. Then choose Verify.'
    $('captcha-answer').value = ''
    var png = function (s) { return typeof s === 'string' && s.indexOf('data:image/png;base64,') === 0 ? s : '' }
    var box = $('captcha-image'); box.textContent = ''
    var img = document.createElement('img'); img.alt = 'Image puzzle: 3 by 3 grid of shapes'; img.src = png(cap.image)
    box.appendChild(img)
    $('captcha-math').src = png(cap.mathImage)
    var tiles = $('captcha-tiles'); tiles.textContent = ''
    for (var i = 0; i < 9; i++) {
      var b = document.createElement('button')
      b.type = 'button'; b.setAttribute('aria-pressed', 'false'); b.dataset.i = String(i)
      b.setAttribute('aria-label', 'Tile ' + (i + 1) + ', row ' + (Math.floor(i / 3) + 1) + ', column ' + (i % 3 + 1))
      b.addEventListener('click', function (e) {
        var t = e.currentTarget; t.setAttribute('aria-pressed', t.getAttribute('aria-pressed') === 'true' ? 'false' : 'true')
      })
      tiles.appendChild(b)
    }
    setMode(textMode)
    if ($('status').getAttribute('data-state') !== 'error') status('One more step: solve the puzzle below.')
  }
  function setMode(text) {
    textMode = text
    $('captcha-grid').hidden = text; $('captcha-prompt').hidden = text; $('captcha-text').hidden = !text
    $('captcha-mode').textContent = text ? 'Use the image puzzle instead' : 'Try a math puzzle instead'
    if (text) $('captcha-answer').focus()
  }
  function submitCaptcha(e) {
    if (e) e.preventDefault()
    if (!ch || ch.level !== 'captcha') return
    var answer
    if (textMode) answer = 'text:' + $('captcha-answer').value.trim()
    else answer = 'grid:' + Array.prototype.map.call(document.querySelectorAll('#captcha-tiles [aria-pressed="true"]'), function (b) { return b.dataset.i }).join(',')
    verify({ captcha: { id: ch.captcha && ch.captcha.id, answer: answer } })
  }
  $('captcha-submit').addEventListener('click', submitCaptcha)
  $('captcha-text').addEventListener('submit', submitCaptcha)
  $('captcha-new').addEventListener('click', function () { if (!busy) start('captcha') })
  $('captcha-mode').addEventListener('click', function () { setMode(!textMode) })
  $('retry').addEventListener('click', function () { retries = 0; status('Starting the check again…'); start(firstLevel) })

  start(firstLevel)
})()
