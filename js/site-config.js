const SITE = {
  name: 'GitFiles',
  tagline: 'A unified file manager for Google Drive, local storage, and GitHub repositories.',
  developer: 'MbAIGC',
  developerUrl: 'https://github.com/MbAIGC',
  githubRepo: 'https://github.com/MbAIGC/GitFiles',
  homepage: 'https://mbaigc.github.io/GitFiles/',
  // Workers + Static Assets is served at the origin root; GitHub Pages keeps /GitFiles.
  basePath: typeof location !== 'undefined' && /(^|\.)github\.io$/i.test(location.hostname) ? '/GitFiles' : '/',
  // Search Console → URL prefix → HTML tag → paste content value here.
  // Must also appear as a static <meta> inside <head> of index.html (Google does not run JS).
  googleSiteVerification: '', // 你自己的 Search Console 验证值（上游值对本站无效）
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

  if (SITE.googleSiteVerification && !document.querySelector('meta[name="google-site-verification"]')) {
    const verify = document.createElement('meta');
    verify.name = 'google-site-verification';
    verify.content = SITE.googleSiteVerification;
    document.head.appendChild(verify);
  }
})();
