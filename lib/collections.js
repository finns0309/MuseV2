// The things Muse makes and keeps:
//
//   asks       your conversations with the DJ — each request, its answer, and
//              the Muse playlist the conversation keeps
//   playlists  Muse's own playlists (local; NetEase ones live in
//              saved-playlists, bookmarked by the renderer)
//
// Main owns them so every reader shares one copy — the window today, a CLI /
// MCP server next — and announces each change (onChange) so copies held
// elsewhere can refresh. Stored through lib/store.js, newest first.
//
// Shapes (the renderer builds them; see renderer/lib/dj.js):
//   ask      { id, createdAt, updatedAt, title, playlistId,
//              turns: [{ q, at, status: 'thinking'|'done'|'error',
//                        title, reply, tracks, error, model, ms }] }
//   playlist { id, name, tracks, createdAt, updatedAt,
//              source: { kind: 'ask', askId, prompt } }
//   track    { id, name, ar: [{ id, name }], al: { id, name, picUrl }, dt }

const KINDS = {
  asks:      { key: 'asks',           cap: 300 },
  playlists: { key: 'muse-playlists', cap: 1000 },
};
const ID_RE = /^[a-z]{2,8}_[a-z0-9]{6,32}$/;

function create(store, onChange = () => {}) {
  const spec = (kind) => {
    const s = KINDS[kind];
    if (!s) throw new Error(`[collections] unknown kind: ${kind}`);
    return s;
  };
  const all = (kind) => {
    const v = store.get(spec(kind).key, []);
    return Array.isArray(v) ? v : [];
  };

  return {
    list: (kind) => all(kind),
    get: (kind, id) => all(kind).find((x) => x.id === id) || null,

    // Insert or replace by id. The newest change sorts first; past the cap
    // the oldest fall off.
    put(kind, item) {
      const { key, cap } = spec(kind);
      if (!item || typeof item !== 'object' || !ID_RE.test(item.id || '')) {
        throw new Error(`[collections] bad ${kind} item id: ${JSON.stringify(item?.id)}`);
      }
      const next = [item, ...all(kind).filter((x) => x.id !== item.id)]
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, cap);
      store.set(key, next);
      onChange(kind, item.id);
      return item;
    },

    remove(kind, id) {
      const { key } = spec(kind);
      const before = all(kind);
      const next = before.filter((x) => x.id !== id);
      if (next.length === before.length) return false;
      store.set(key, next);
      onChange(kind, id);
      return true;
    },
  };
}

module.exports = { create, KINDS };
