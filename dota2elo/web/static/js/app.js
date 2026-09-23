// Global helpers + top-bar search

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

(function () {
  const search = document.getElementById('globalSearch');
  const popup = document.getElementById('searchResults');
  if (!search || !popup) return;
  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    const q = search.value.trim();
    if (!q) { popup.hidden = true; popup.innerHTML = ''; return; }
    timer = setTimeout(async () => {
      const list = await fetch('/api/teams?q=' + encodeURIComponent(q)).then(r => r.json());
      if (!list.length) { popup.hidden = true; return; }
      popup.innerHTML = list.slice(0, 10).map(t => `
        <a class="suggest-item" href="/team/${t.id}">
          <span>${escapeHtml(t.name)}</span>
          <span class="muted small">${t.rating}</span>
        </a>
      `).join('');
      popup.hidden = false;
    }, 200);
  });
  document.addEventListener('click', (e) => {
    if (!popup.contains(e.target) && e.target !== search) {
      popup.hidden = true;
    }
  });
})();
