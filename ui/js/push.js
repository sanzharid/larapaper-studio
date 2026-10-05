/* Larapaper Studio — push-to-server modal. */
window.LPPush = (function () {
  let rootEl = null;
  let sessionToken = '';
  let busy = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function toast(msg, kind) { if (window.LPToast) window.LPToast(msg, kind); }
  function server() { return LPState.getDoc().server || {}; }

  function setStatus(msg, ok) {
    const el = rootEl && rootEl.querySelector('#push-status');
    if (el) { el.textContent = msg || ''; el.className = 'form-status ' + (ok ? 'ok' : (msg ? 'err' : '')); }
  }

  function linkBoxHtml() {
    const s = server();
    if (s.trmnlpId) {
      return '<div class="linked-plugin"><span>Linked plugin:</span><span class="lp-id">#' + esc(s.trmnlpId) + '</span>' +
        '<span style="flex:1"></span><button class="btn small" id="btn-unlink">Unlink</button></div>' +
        '<div class="field-help">Pushing updates this plugin in place.</div>';
    }
    return '<div class="linked-plugin"><span style="color:var(--text-1)">Not linked — the first push creates a new plugin setting.</span>' +
      '<span style="flex:1"></span><button class="btn small" id="btn-choose">Choose existing…</button></div>';
  }

  function render() {
    const s = server();
    rootEl.innerHTML =
      '<div class="modal-backdrop"><div class="modal">' +
      '<h2>Push to Larapaper</h2>' +
      '<p class="modal-sub">Uploads the recipe ZIP (settings.yml + Liquid templates) to your Larapaper server.<br>' +
      'Create an API token in Larapaper → Profile → API tokens.</p>' +
      '<div class="field"><label>Server URL</label>' +
      '<input type="url" id="srv-url" placeholder="http://larapaper.test or https://your-server" value="' + esc(s.baseUrl) + '"></div>' +
      '<div class="field"><label>API token (Sanctum)</label>' +
      '<input type="password" id="srv-token" placeholder="1|abc…" value="' + esc(sessionToken) + '"></div>' +
      '<div class="check-field"><input type="checkbox" id="srv-remember"' + (s.rememberToken ? ' checked' : '') + '>' +
      '<label for="srv-remember">Remember token in the project file (stored as plain text)</label></div>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-bottom:14px">' +
      '<button class="btn" id="btn-test">Test connection</button>' +
      '<span id="test-result" style="font-size:12.5px;color:var(--text-1)"></span></div>' +
      '<div class="section-title">Target plugin</div>' +
      '<div id="link-box">' + linkBoxHtml() + '</div>' +
      '<div id="pick-area"></div>' +
      '<div class="form-status" id="push-status"></div>' +
      '<div class="modal-actions">' +
      '<button class="btn" id="btn-cancel">Close</button>' +
      '<button class="btn primary" id="btn-do-push">⇪ Push now</button>' +
      '</div></div></div>';
  }

  function open() {
    if (rootEl) return;
    sessionToken = server().token || '';
    rootEl = document.createElement('div');
    document.getElementById('modal-root').appendChild(rootEl);
    render();
    rootEl.addEventListener('click', onClick);
    rootEl.addEventListener('input', onInput);
    rootEl.addEventListener('change', onChange);
    rootEl.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !busy) close(); });
    const urlInput = rootEl.querySelector('#srv-url');
    if (urlInput) urlInput.focus();
  }

  function close() {
    if (!rootEl || busy) return;
    rootEl.remove();
    rootEl = null;
  }

  function onInput(e) {
    /* srv-url / srv-token stay LOCAL while typing (persisting per keystroke
       fires a doc event → full canvas + panels re-render, which freezes the
       UI with large sample data); they persist on 'change' — see onChange.
       The remember-token checkbox stays immediate. */
    if (e.target.id === 'srv-token') {
      sessionToken = e.target.value;
    } else if (e.target.id === 'srv-remember') {
      const remember = e.target.checked;
      LPState.updateServer({ rememberToken: remember, token: remember ? sessionToken : '' });
    }
  }

  function onChange(e) {
    if (e.target.id !== 'srv-url' && e.target.id !== 'srv-token') return;
    const patch = { baseUrl: rootEl.querySelector('#srv-url').value.trim() };
    if (rootEl.querySelector('#srv-remember').checked) patch.token = sessionToken;
    LPState.updateServer(patch, 'push:creds');
  }

  function creds() {
    return { baseUrl: rootEl.querySelector('#srv-url').value.trim(), token: sessionToken };
  }

  async function onClick(e) {
    const id = e.target.id;
    if (e.target.classList.contains('modal-backdrop') && !busy) { close(); return; }
    if (id === 'btn-cancel') { close(); return; }
    if (id === 'btn-unlink') {
      LPState.updateServer({ trmnlpId: null });
      rootEl.querySelector('#link-box').innerHTML = linkBoxHtml();
      return;
    }
    if (id === 'btn-test') {
      const btn = e.target;
      const resEl = rootEl.querySelector('#test-result');
      resEl.textContent = 'Testing…';
      resEl.style.color = '';
      btn.disabled = true;
      try {
        const r = await window.lp.testConnection(creds());
        if (r && r.ok) {
          const u = r.user || {};
          resEl.textContent = '✓ Connected' + (u.name || u.email ? ' as ' + (u.name || u.email) : '');
          resEl.style.color = 'var(--ok)';
        } else {
          resEl.textContent = '✗ ' + ((r && r.error) || 'Request failed');
          resEl.style.color = '#ff9d97';
        }
      } catch (err) {
        resEl.textContent = '✗ ' + String((err && err.message) || err);
        resEl.style.color = '#ff9d97';
      } finally {
        btn.disabled = false;
      }
      return;
    }
    if (id === 'btn-choose') {
      const btn = e.target;
      const area = rootEl.querySelector('#pick-area');
      area.innerHTML = '<div class="field-help">Loading plugin settings…</div>';
      btn.disabled = true;
      try {
        const r = await window.lp.listPluginSettings(creds());
        if (!r || !r.ok) {
          area.innerHTML = '<div class="form-status err">' + esc((r && r.error) || 'Request failed') + '</div>';
          return;
        }
        const items = r.items || [];
        if (!items.length) {
          area.innerHTML = '<div class="field-help">No plugin settings found on the server.</div>';
          return;
        }
        area.innerHTML = '<div class="pick-list">' + items.map((it) =>
          '<button class="pick-item" data-pick="' + esc(it.id) + '">' + esc(it.name) +
          ' <span class="pi-id">#' + esc(it.id) + '</span></button>').join('') + '</div>';
      } catch (err) {
        area.innerHTML = '<div class="form-status err">' + esc(String((err && err.message) || err)) + '</div>';
      } finally {
        btn.disabled = false;
      }
      return;
    }
    const pick = e.target.closest ? e.target.closest('[data-pick]') : null;
    if (pick) {
      LPState.updateServer({ trmnlpId: parseInt(pick.getAttribute('data-pick'), 10) });
      rootEl.querySelector('#pick-area').innerHTML = '';
      rootEl.querySelector('#link-box').innerHTML = linkBoxHtml();
      return;
    }
    if (id === 'btn-do-push') doPush();
  }

  async function doPush() {
    const doc = LPState.getDoc();
    const errors = LPRecipe.validateDoc(doc);
    if (errors.length) { setStatus(errors.join(' ')); return; }
    const c = creds();
    if (!c.baseUrl) { setStatus('Enter the server URL.'); return; }
    if (!c.token) { setStatus('Enter an API token.'); return; }
    busy = true;
    rootEl.querySelector('#btn-do-push').disabled = true;
    setStatus('Building recipe & pushing…', true);
    try {
      const files = LPRecipe.buildRecipeFiles(doc);
      const r = await window.lp.pushRecipe({
        baseUrl: c.baseUrl, token: c.token,
        trmnlpId: server().trmnlpId, name: doc.name, files
      });
      if (!r || !r.ok) throw new Error((r && r.error) || 'Push failed');
      LPState.updateServer({ trmnlpId: r.trmnlpId });
      toast('Pushed ✓ — plugin #' + r.trmnlpId + (r.created ? ' (created)' : ' (updated)'), 'ok');
      busy = false;
      close();
    } catch (err) {
      busy = false;
      if (rootEl) {
        rootEl.querySelector('#btn-do-push').disabled = false;
        setStatus(String(err.message || err));
      }
    }
  }

  return { open, close };
})();

