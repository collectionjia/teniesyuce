/** Sofascore 网球比赛页：需 slug+customId，纯数字 id 会 404。 */
export function sofaTennisMatchUrl(m) {
  if (!m) return '#'
  const slug = String(m.slug || '').trim()
  const customId = String(m.customId || '').trim()
  const id = m.id
  if (slug && customId) {
    return id != null
      ? `https://www.sofascore.com/tennis/match/${slug}/${customId}#id:${id}`
      : `https://www.sofascore.com/tennis/match/${slug}/${customId}`
  }
  if (id != null) return `https://www.sofascore.com/event/tennis/${id}`
  const raw = String(m.url || '').trim()
  if (raw && !/\/tennis\/match\/\d+$/i.test(raw)) return raw
  return raw || '#'
}
