// Permissions are slash-delimited paths, e.g. /events/evt_123/view. A grant is a
// glob over such paths: a literal segment matches itself, `*` matches exactly
// one segment, and `**` matches any number of segments (including zero) — so a
// lone `**` grants everything. A caller holds a list of grants; they `can` do X
// if any grant matches X.

function segments(p) {
    return p.split('/').filter(Boolean);
}

function matchSegments(grant, path) {
    if (grant.length === 0) return path.length === 0;

    const [head, ...rest] = grant;

    if (head === '**') {
        // `**` consumes zero-or-more path segments; try each split point.
        for (let i = 0; i <= path.length; i++) {
            if (matchSegments(rest, path.slice(i))) return true;
        }
        return false;
    }

    if (path.length === 0) return false;
    if (head === '*' || head === path[0]) {
        return matchSegments(rest, path.slice(1));
    }
    return false;
}

// Does a single grant glob match a concrete permission path?
export function grantMatches(grant, path) {
    return matchSegments(segments(grant), segments(path));
}

// Does any of a caller's grants permit the path?
export function can(grants, path) {
    return grants.some(grant => grantMatches(grant, path));
}
