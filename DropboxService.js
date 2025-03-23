import { Dropbox } from 'dropbox';
import { logger } from './logger.js';

export class DropboxService {
  constructor(accessToken) {
    this.dbx = new Dropbox({ accessToken });
  }

  async listFolder(path) {
    try {
      const response = await this.dbx.filesListFolder({
        path: path || '',
        recursive: false
      });
      return response.result.entries;
    } catch (error) {
      logger.error('[Dropbox] Failed to list folder: %s', error.message);
      throw error;
    }
  }

  async getFileMetadata(path) {
    try {
      const response = await this.dbx.filesGetMetadata({
        path,
        include_media_info: true
      });
      return response.result;
    } catch (error) {
      logger.error('[Dropbox] Failed to get file metadata: %s', error.message);
      throw error;
    }
  }
} 