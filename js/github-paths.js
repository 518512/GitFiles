const GithubPaths = (() => {
  const FOLDER_KEEP = '.keep';

  function normalizePath(path) {
    if (!path || path === 'root') return '';
    const value = String(path).replace(/^\/+|\/+$/g, '');
    if (!value || value.includes('\0') || value.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`Invalid repository path: ${path}`);
    }
    return value;
  }

  function joinPath(parent, name) {
    const base = !parent || parent === 'root' ? '' : normalizePath(parent);
    const child = normalizePath(name);
    return base ? `${base}/${child}` : child;
  }

  function isInsidePath(child, parent) {
    return child === parent || child.startsWith(`${parent}/`);
  }

  function isFolderPath(entries, path) {
    const normalized = normalizePath(path);
    return !entries.some((entry) => entry.type === 'blob' && entry.path === normalized)
      && entries.some((entry) => isInsidePath(entry.path || '', normalized));
  }

  function isFolderInTree(entries, path) {
    const normalized = normalizePath(path);
    return entries.some((entry) => isInsidePath(entry.path || '', normalized));
  }

  function isPathVisible(entries, path, folder) {
    const normalized = normalizePath(path);
    return folder ? isFolderInTree(entries, normalized) : entries.some((entry) => entry.type === 'blob' && entry.path === normalized);
  }

  function collectDescendants(entries, path) {
    const normalized = normalizePath(path);
    return entries.filter((entry) => isInsidePath(entry.path || '', normalized));
  }

  function getBaseName(path) {
    return normalizePath(path).split('/').pop();
  }

  function makeUniquePath(entries, path, taken = new Set()) {
    if (!isPathVisible(entries, path, false) && !isFolderInTree(entries, path) && !taken.has(path)) return path;
    const slash = path.lastIndexOf('/');
    const parent = slash === -1 ? '' : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    const match = /^(.*?)(\.[^.]+)?$/.exec(name);
    const stem = match?.[1] || name;
    const extension = match?.[2] || '';
    let number = 1;
    let candidate;
    do {
      candidate = `${parent ? `${parent}/` : ''}${stem}${number === 1 ? ' (copy)' : ` (copy ${number})`}${extension}`;
      number += 1;
    } while (isPathVisible(entries, candidate, false) || isFolderInTree(entries, candidate) || taken.has(candidate));
    taken.add(candidate);
    return candidate;
  }

  return { FOLDER_KEEP, normalizePath, joinPath, getBaseName, isFolderPath, isFolderInTree, isPathVisible, collectDescendants, makeUniquePath };
})();
