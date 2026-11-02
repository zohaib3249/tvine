// Tvine Shield sensor: L4 environment + L5 behaviour → SensorReport (see shield.md CONTRACT).
// Privacy: fingerprints leave the page only as short hashes; no text, coordinates or keys are sent.
// window.tvineSensor.report() → Promise<SensorReport>
;(function () {
  'use strict'
  var t0 = performance.now(), nav = navigator, W = window
  var b = { moves: 0, scrolls: 0, keys: 0, bins: new Array(8).fill(0), lx: null, ly: null }

  function h(s) { // cyrb53 → 8 hex chars; short, not reversible
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677) }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return ((h2 >>> 0).toString(16) + (h1 >>> 0).toString(16)).slice(0, 8)
  }

  W.addEventListener('pointermove', function (e) {
    if (!e.isTrusted) return
    b.moves++
    if (b.lx !== null) {
      var dx = e.clientX - b.lx, dy = e.clientY - b.ly
      if (dx || dy) b.bins[(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8]++
    }
    b.lx = e.clientX; b.ly = e.clientY
  }, { passive: true })
  W.addEventListener('scroll', function () { b.scrolls++ }, { passive: true })
  W.addEventListener('keydown', function (e) { if (e.isTrusted) b.keys++ })
  W.addEventListener('touchstart', function (e) { if (e.isTrusted) b.moves++ }, { passive: true })

  function entropy() { // Shannon entropy (bits, 0..3) of pointer move directions
    var n = b.bins.reduce(function (a, x) { return a + x }, 0), e = 0
    b.bins.forEach(function (x) { if (x) { var p = x / n; e -= p * Math.log2(p) } })
    return Math.round(e * 100) / 100
  }

  function webgl() {
    try {
      var gl = document.createElement('canvas').getContext('webgl')
      if (!gl) return undefined
      var ext = gl.getExtension('WEBGL_debug_renderer_info')
      var v = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)
      var r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
      return (/swiftshader|llvmpipe|softpipe|software/i.test(v + ' ' + r) ? 'soft:' : 'hw:') + h(v + '|' + r)
    } catch (e) { return undefined }
  }

  function canvas() {
    try {
      var c = document.createElement('canvas'); c.width = 220; c.height = 40
      var x = c.getContext('2d'); if (!x) return undefined
      x.textBaseline = 'top'; x.font = '16px Arial'; x.fillStyle = '#f60'; x.fillRect(100, 1, 62, 20)
      x.fillStyle = '#069'; x.fillText('Tvine shield \u{1F6E1} 0.1', 2, 15)
      x.fillStyle = 'rgba(102,204,0,0.7)'; x.beginPath(); x.arc(50, 20, 18, 0, 6.3); x.fill()
      return h(c.toDataURL())
    } catch (e) { return undefined }
  }

  function audio() {
    try {
      var A = W.OfflineAudioContext || W.webkitOfflineAudioContext; if (!A) return Promise.resolve(undefined)
      var ctx = new A(1, 4410, 44100), o = ctx.createOscillator(), k = ctx.createDynamicsCompressor()
      o.type = 'triangle'; o.frequency.value = 10000; o.connect(k); k.connect(ctx.destination); o.start(0)
      var done = ctx.startRendering().then(function (buf) {
        var d = buf.getChannelData(0), s = 0
        for (var i = 4000; i < 4410; i++) s += Math.abs(d[i])
        return h(s.toFixed(6))
      })
      return Promise.race([done, new Promise(function (r) { setTimeout(r, 700) })]).catch(function () { return undefined })
    } catch (e) { return Promise.resolve(undefined) }
  }

  function headless() {
    var m = [], ua = nav.userAgent, chrome = /Chrome\//.test(ua) && !/Edg\/|OPR\//.test(ua)
    var mobile = /Android|Mobile/.test(ua)
    if (/HeadlessChrome/.test(ua)) m.push('ua-headless')
    if (chrome && !W.chrome) m.push('no-chrome-obj')
    if (chrome && !mobile && (!nav.plugins || nav.plugins.length === 0 || !nav.mimeTypes || nav.mimeTypes.length === 0)) m.push('no-plugins')
    if (!nav.languages || nav.languages.length === 0) m.push('no-langs')
    if (W.outerWidth === 0 || W.outerHeight === 0) m.push('zero-outer')
    if (!W.devicePixelRatio) m.push('no-dpr')
    if (!nav.permissions || typeof Notification === 'undefined') return Promise.resolve(m)
    // Classic headless quirk: Notification.permission 'denied' while permissions.query says 'prompt'.
    return nav.permissions.query({ name: 'notifications' }).then(function (p) {
      if (Notification.permission === 'denied' && p.state === 'prompt') m.push('perm-mismatch')
      return m
    }, function () { return m })
  }

  function report() {
    return Promise.all([headless(), audio()]).then(function (r) {
      var s = W.screen || {}
      return {
        webdriver: nav.webdriver === true,
        headless: r[0],
        webgl: webgl(),
        canvas: canvas(),
        audio: r[1],
        screen: [s.width + 'x' + s.height, W.innerWidth + 'x' + W.innerHeight, W.outerWidth + 'x' + W.outerHeight, W.devicePixelRatio || 0].join('|'),
        tz: (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch (e) { return '' } })(),
        langs: Array.prototype.slice.call(nav.languages || []).slice(0, 5),
        touch: nav.maxTouchPoints || 0,
        cores: nav.hardwareConcurrency || undefined,
        plugins: (nav.plugins && nav.plugins.length) || 0,
        behaviour: { moves: b.moves, entropy: entropy(), scrolls: b.scrolls, keys: b.keys, dwellMs: Math.round(performance.now() - t0) },
      }
    })
  }

  W.tvineSensor = { report: report }
})()
