const SITE = {
  name: 'GitFiles',
  tagline: '把 GitHub Repository 当作云端文件系统来浏览、编辑与提交的 PWA。',
  developer: 'MbAIGC',
  developerUrl: 'https://github.com/MbAIGC',
  githubRepo: 'https://github.com/MbAIGC/GitFiles',
  homepage: 'https://mbaigc.github.io/GitFiles/',
  // Workers + Static Assets is served at the origin root; GitHub Pages keeps /GitFiles.
  basePath: typeof location !== 'undefined' && /(^|\.)github\.io$/i.test(location.hostname) ? '/GitFiles' : '/',
};

(function applySiteHead() {
  if (typeof document === 'undefined') return;

  const description = `${SITE.name} by ${SITE.developer} — ${SITE.tagline}`;

  if (!document.querySelector('meta[name="description"]')) {
    const meta = document.createElement('meta');
    meta.name = 'description';
    meta.content = description;
    document.head.appendChild(meta);
  }

})();
