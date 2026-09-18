/**
 * 在 Node 里加载浏览器端 `js/github-paths.js` + `js/githubdisk.js` 的测试夹具。
 *
 * 这两个文件都是「IIFE 赋值给顶层 const」的浏览器脚本，直接 `new Function(code)`
 * 后 const 只存在于函数作用域。这里把两个文件拼进同一个函数体，再显式挂到
 * globalThis，既保留它们之间的相互引用（githubdisk 依赖 GithubPaths），
 * 又让测试拿得到实例。
 *
 * 同时提供最小浏览器全局桩与可注入的 GithubApi，用于精确断言网络请求次数。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadGithubDisk({
  treeHead = 'H1',
  treeEntries = [],
  operationHead = 'H2',
  disks = null,
  respond = null,
} = {}) {
  const store = new Map();
  const requests = [];

  // Node ≥21 把 navigator / crypto 等声明为只读访问器属性，直接赋值会抛 TypeError。
  const define = (name, value) => Object.defineProperty(globalThis, name, {
    value, configurable: true, writable: true,
  });

  define('window', { addEventListener() {} });
  define('document', { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] });
  define('location', { href: 'https://app.test/', origin: 'https://app.test', hostname: 'app.test', pathname: '/', search: '', hash: '' });
  define('navigator', {});
  define('performance', { now: () => 0 });
  define('BroadcastChannel', class { postMessage() {} close() {} });
  define('crypto', {
    randomUUID: (() => { let n = 0; return () => `uuid-${++n}`; })(),
    getRandomValues: (arr) => arr,
  });
  define('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  });
  define('sessionStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });

  const diskList = disks || [{
    id: 'github:o/r',
    name: 'r',
    owner: 'o',
    repo: 'r',
    branch: 'main',
    head: treeHead,
    private: true,
  }];
  store.set('storage_hub_github_disks', JSON.stringify({ disks: diskList }));

  define('GithubApi', {
    async request(url, options = {}) {
      const method = options.method || 'GET';
      requests.push({ url, method, body: options.body });
      if (respond) {
        const custom = await respond({ url, method, options });
        if (custom !== undefined) return custom;
      }
      if (/\/tree\?/.test(url)) {
        return { head: treeHead, treeSha: 'T1', updatedAt: Date.UTC(2026, 8, 18), tree: treeEntries };
      }
      if (/\/operations$/.test(url)) {
        return { head: operationHead, treeSha: 'T2', blobsCreated: 1 };
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  const source = ['js/github-paths.js', 'js/githubdisk.js']
    .map((rel) => readFileSync(path.join(ROOT, rel), 'utf8'))
    .join('\n');
  new Function(`${source}\n;globalThis.__GithubDisk = GithubDisk;globalThis.__GithubPaths = GithubPaths;`).call(globalThis);

  const GithubDisk = globalThis.__GithubDisk;
  GithubDisk.init();
  return { GithubDisk, GithubPaths: globalThis.__GithubPaths, requests };
}

export const treeRequests = (requests) => requests.filter((r) => /\/tree\?/.test(r.url));
export const operationRequests = (requests) => requests.filter((r) => /\/operations$/.test(r.url));
