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

  function isNotepadFile() {
    return false;
  }

  return {
    ROOT_ID,
    isNotepadFile,
    getDefaultIcon: () => '📄',
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
