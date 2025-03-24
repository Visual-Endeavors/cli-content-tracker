import { Dropbox } from 'dropbox';
import { logger } from './logger.js';
import express from 'express';
import open from 'open';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export class DropboxService {
  constructor(config) {
    if (!config.appKey) {
      throw new Error('Dropbox service requires appKey');
    }

    this.config = config;
    this.PORT = 3002;
    this.REDIRECT_URI = `http://localhost:${this.PORT}/oauth`;
    this.TIMEOUT_MS = 300000;
    this.accessToken = null;
    this.dbx = null;
    this.retried = false;
    this.teamMemberId = null;
    this.appKey = config.appKey;
    this.teamMemberEmail = config.teamMemberEmail;
    this.rootPath = config.rootPath;
    this.tokenPath = path.join(process.cwd(), '.dropbox_token.json');
  }

  generatePKCE() {
    // Generate verifier - must be between 43-128 chars
    const verifier = crypto.randomBytes(64).toString('base64url');
    // Generate challenge
    const challenge = crypto
      .createHash('sha256')
      .update(verifier)
      .digest('base64url');
    return { verifier, challenge };
  }

  async authenticate() {
    const app = express();
    let server;
    let timeoutId;
    const { verifier, challenge } = this.generatePKCE();

    return new Promise((resolve, reject) => {
      const cleanup = (message = 'Server closed') => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (server) {
          server.close(() => {
            logger.debug('[Dropbox] ' + message);
          });
          server = null;
        }
      };

      timeoutId = setTimeout(() => {
        logger.warn("[Dropbox] Authentication is taking longer than expected...");
        timeoutId = setTimeout(() => {
          cleanup('Authentication timed out after 5 minutes');
          reject(new Error('Authentication timed out'));
        }, 60000);
      }, this.TIMEOUT_MS - 60000);

      app.get('/oauth', async (req, res) => {
        try {
          const { code, error } = req.query;
          logger.debug("[Dropbox] Received OAuth callback with code:", !!code);
          
          if (error) {
            throw new Error(`OAuth error: ${error}`);
          }
          
          if (!code) {
            throw new Error('No authorization code received');
          }
          
          logger.debug("[Dropbox] Exchanging code for tokens...");
          
          const tokenResponse = await fetch('https://api.dropbox.com/oauth2/token', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              code,
              grant_type: 'authorization_code',
              client_id: this.config.appKey,
              redirect_uri: this.REDIRECT_URI,
              code_verifier: verifier,
            }).toString(),
          });

          if (!tokenResponse.ok) {
            const errorText = await tokenResponse.text();
            throw new Error(`Token exchange failed: ${tokenResponse.status} - ${errorText}`);
          }

          const tokenData = await tokenResponse.json();
          this.accessToken = tokenData.access_token;
          
          logger.debug("[Dropbox] Authentication successful");
          res.send('Success! You can close this window.');
          
          cleanup('OAuth completed successfully');
          resolve(this.accessToken);
        } catch (error) {
          logger.error("[Dropbox] OAuth error:", error);
          res.status(500).send('Authentication failed: ' + error.message);
          cleanup('OAuth failed');
          reject(error);
        }
      });

      app.get('/', (_req, res) => {
        try {
          const authUrl = 'https://www.dropbox.com/oauth2/authorize?' + new URLSearchParams({
            client_id: this.config.appKey,
            response_type: 'code',
            redirect_uri: this.REDIRECT_URI,
            token_access_type: 'offline',
            code_challenge: challenge,
            code_challenge_method: 'S256',
            scope: 'members.read team_data.member team_data.team_space team_data.content.read team_data.content.write files.metadata.read'  // Added files.metadata.read
          }).toString();

          logger.debug("[Dropbox] Generated auth URL with team scopes");
          res.redirect(authUrl);
        } catch (error) {
          logger.error("[Dropbox] Auth URL generation failed:", error);
          res.status(500).send('Failed to start authentication: ' + error.message);
          cleanup('Failed to generate auth URL');
          reject(error);
        }
      });

      server = app.listen(this.PORT, () => {
        logger.debug(`[Dropbox] Server is ready on port ${this.PORT}`);
        open(`http://localhost:${this.PORT}`).catch(err => {
          logger.error("[Dropbox] Failed to open browser:", err);
        });
      });

      server.on('error', (error) => {
        cleanup('Server error occurred');
        reject(error);
      });
    });
  }

  async validateToken() {
    try {
      // Test the token with a simple API call
      await this.dbx.usersGetCurrentAccount();
      return true;
    } catch (error) {
      logger.debug('[Dropbox] Token validation failed:', error.message);
      // Delete invalid token file
      if (fs.existsSync(this.tokenPath)) {
        fs.unlinkSync(this.tokenPath);
      }
      return false;
    }
  }

  async init() {
    try {
      // Try to load existing token
      if (fs.existsSync(this.tokenPath)) {
        const tokenData = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
        if (tokenData.accessToken && tokenData.teamMemberId) {
          logger.debug('[Dropbox] Found saved token, validating...');
          this.accessToken = tokenData.accessToken;
          this.teamMemberId = tokenData.teamMemberId;
          this.dbx = new Dropbox({ accessToken: this.accessToken });
          
          // Validate token before using
          if (await this.validateToken()) {
            return;
          }
        }
      }

      logger.debug('[Dropbox] No valid token found, starting authentication...');
      if (!this.accessToken || !this.dbx) {
        logger.debug('[Dropbox] No token found, starting authentication...');
        await this.authenticate();
      }
      
      logger.debug('[Dropbox] Verifying connection...');
      try {
        // Try direct API call first
        const response = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          },
          body: 'null'
        });

        if (!response.ok) {
          logger.debug('[Dropbox] Basic auth failed, trying team member lookup...');
          
          // Try team member lookup with correct format
          const teamResponse = await fetch('https://api.dropboxapi.com/2/team/members/list', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              "limit": 100
            })
          });

          if (!teamResponse.ok) {
            const errorText = await teamResponse.text();
            logger.error('[Dropbox] Team API Error:', {
              status: teamResponse.status,
              body: errorText
            });
            throw new Error(`Team info failed: ${teamResponse.status} - ${errorText}`);
          }

          const teamInfo = await teamResponse.json();
          logger.debug('[Dropbox] Team members response:', teamInfo);
          
          // Find the member by email
          const member = teamInfo.members.find(m => 
            m.profile.email === this.config.teamMemberEmail
          );
          
          if (!member) {
            throw new Error(`Could not find team member with email: ${this.config.teamMemberEmail}`);
          }

          const teamMemberId = member.profile.team_member_id;
          logger.debug('[Dropbox] Got team member ID:', teamMemberId);

          // Store the team member ID
          this.teamMemberId = teamMemberId;

          // Initialize SDK with team member ID
          this.dbx = new Dropbox({
            accessToken: this.accessToken,
            selectUser: teamMemberId
          });
        } else {
          // Basic auth worked, initialize SDK normally
          const account = await response.json();
          logger.debug('[Dropbox] Connected as:', account.email);
          
          this.dbx = new Dropbox({
            accessToken: this.accessToken
          });
        }
        
        // After successful authentication, save the token
        const tokenData = {
          accessToken: this.accessToken,
          teamMemberId: this.teamMemberId
        };
        fs.writeFileSync(this.tokenPath, JSON.stringify(tokenData, null, 2));
        logger.debug('[Dropbox] Saved token for future use');

        return true;
      } catch (error) {
        logger.error('[Dropbox] Account verification failed:', {
          message: error.message,
          status: error?.status,
          response: error?.response?.data
        });
        
        // If verification fails, try re-authenticating once
        if (!this.retried) {
          logger.debug('[Dropbox] Retrying authentication...');
          this.retried = true;
          this.accessToken = null;
          this.dbx = null;
          return this.init();
        }
        throw error;
      }
    } catch (error) {
      logger.error('[Dropbox] Initialization failed:', {
        message: error.message,
        status: error?.status,
        response: error?.response?.data
      });
      throw error;
    }
  }

  async listFolder(path) {
    try {
      if (!this.dbx) {
        await this.init();
      }

      const cleanPath = path === '' || path === '/' 
        ? ''
        : '/' + path.split('/')
            .filter(p => p)
            .filter((p, i) => i > 0 || !p.includes('Altmark'))
            .join('/');

      logger.debug('[Dropbox] Listing folder with path:', {
        original: path,
        cleaned: cleanPath
      });
      
      try {
        // Get all entries with metadata in one call
        const response = await this.dbx.filesListFolder({
          path: cleanPath,
          recursive: true,
          include_mounted_folders: true,
          include_non_downloadable_files: true,
          include_media_info: true  // Get media info directly in list call
        });
        
        logger.debug('[Dropbox] Initial response entries:', {
          count: response.result.entries.length,
          firstFew: response.result.entries.slice(0, 3).map(e => e.path_display)
        });

        const allEntries = [...response.result.entries];

        // Handle pagination if there are more entries
        while (response.result.has_more) {
          response = await this.dbx.filesListFolderContinue({
            cursor: response.result.cursor
          });
          logger.debug('[Dropbox] Additional entries found:', response.result.entries.length);
          allEntries.push(...response.result.entries);
        }

        logger.debug('[Dropbox] Found total items:', {
          count: allEntries.length,
          folders: allEntries.filter(e => e['.tag'] === 'folder').length,
          files: allEntries.filter(e => e['.tag'] === 'file').length,
          paths: allEntries.slice(0, 5).map(e => e.path_display)  // Log first 5 paths
        });

        return allEntries.map(entry => ({
          ...entry,
          metadata: entry.media_info || {}  // Include media info if available
        }));
      } catch (listError) {
        logger.error('[Dropbox] List error:', {
          status: listError?.status,
          message: listError?.message,
          path: cleanPath
        });
        throw listError;
      }
    } catch (error) {
      logger.error('[Dropbox] List folder error:', {
        originalPath: path,
        status: error.status,
        message: error.message,
        response: error.response?.data
      });
      throw error;
    }
  }

  async getFileMetadata(path) {
    try {
      logger.debug('[Dropbox] Getting metadata for:', path);
      
      const response = await this.dbx.filesGetMetadata({
        path: path,
        include_media_info: true  // This gets us video/image metadata
      });

      const metadata = response.result;
      logger.debug('[Dropbox] Got metadata:', metadata);

      // Format metadata similar to original scraper
      const result = {
        path: metadata.path_display,
        name: metadata.name,
        size: metadata.size,
        type: metadata.name.split('.').pop().toLowerCase(),
        created: metadata.client_modified,
        modified: metadata.server_modified
      };

      // Add media-specific metadata if available
      if (metadata.media_info) {
        if (metadata.media_info.metadata.dimensions) {
          result.width = metadata.media_info.metadata.dimensions.width;
          result.height = metadata.media_info.metadata.dimensions.height;
        }
        if (metadata.media_info.metadata.duration) {
          result.duration = metadata.media_info.metadata.duration;
        }
      }

      return result;
    } catch (error) {
      logger.error('[Dropbox] Metadata error:', {
        path,
        status: error?.status,
        message: error?.message
      });
      throw error;
    }
  }

  async getSharedLink(path) {
    try {
      // Try to create a shared link
      const response = await this.dbx.sharingCreateSharedLinkWithSettings({
        path: path,
        settings: {
          requested_visibility: { '.tag': 'public' },
          audience: { '.tag': 'public' },
          access: { '.tag': 'viewer' }
        }
      });
      
      logger.debug('[Dropbox] Created shared link:', response.result.url);
      return response.result.url;
    } catch (error) {
      // If link already exists, get existing link
      if (error?.status === 409) {
        const listResponse = await this.dbx.sharingListSharedLinks({
          path: path,
          direct_only: true
        });
        
        if (listResponse.result.links.length > 0) {
          logger.debug('[Dropbox] Found existing shared link:', listResponse.result.links[0].url);
          return listResponse.result.links[0].url;
        }
      }
      
      logger.error('[Dropbox] Failed to get shared link:', {
        path,
        error: error.message
      });
      throw error;
    }
  }
} 