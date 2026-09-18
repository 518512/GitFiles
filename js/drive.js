// Google Drive integration was removed. This legacy facade prevents old URLs
// and stale local UI state from crashing while making the removed capability
// explicit. It never performs network requests or stores credentials.
const Drive = (() => {
  const ROOT_ID = 'root';

  function removed() {
    const error = new Error('Google Drive 功能已移除，请使用本地存储或 GitHub 仓库。');
    error.code = 'GOOGLE_REMOVED';
    throw error;
  }

  function isNotepadFile(file) {
    const mime = String(file?.mimeType || '').toLowerCase();
    const name = String(file?.name || '').toLowerCase();
    return mime.startsWith('text/') || mime === 'application/json'
      || /\.(txt|md|markdown|csv|log|xml|yml|yaml|html|htm|css|js|ts|tsx|jsx|py|sh|bat|sql|json)$/i.test(name);
  }

  return {
    ROOT_ID,
    isNotepadFile,
    getDefaultIcon: () => '📄',
    // Drive 已移除：路径解析退化为一律返回空数组（原先这里有一份实现，
    // 但紧接着就被这个箭头函数覆盖，属于永不执行的代码）。
    parseNotepadFilePath: () => [],
    ...Object.fromEntries([
      'listFiles', 'listShared', 'listStarred', 'listRecent', 'listTrash',
      'getStorageQuota', 'getFolderPath', 'getFileMeta', 'resolveFileByPath',
      'canWriteFile', 'buildNotepadFilePath', 'getTextFileContent',
      'updateFileContent', 'renameFile', 'createFile', 'createFileFromBlob',
      'createFolder', 'createGoogleApp', 'trashFile', 'restoreFile',
      'deleteFile', 'downloadFile', 'getFileBlobForExternalCopy',
      'copyItemToUser', 'copyFile', 'moveFile', 'getFileProperties',
    ].map((name) => [name, removed])),
  };
})();
