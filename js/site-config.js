const SITE = {
  name: 'GitFiles',
  tagline: '统一管理本地存储和 GitHub 仓库的文件管理器。',
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
