const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const sqlite3 = require('sqlite3').verbose(); // Optional: lightweight audit DB
const { google } = require('googleapis');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// ============================================================================
// CONFIGURATION
// ============================================================================

const config = {
  // Google Drive
  googleDrive: {
    keyFile: process.env.GOOGLE_KEY_FILE || './credentials.json',
    queueFolderId: process.env.QUEUE_FOLDER_ID, // Google Drive folder ID
    processedFolderId: process.env.PROCESSED_FOLDER_ID, //move files after processing
  },
  // http://8.213.21.244:8070/api/channels/receive/
  // Mirth Connect
  mirth: {
    baseUrl: process.env.MIRTH_BASE_URL || 'http://localhost:8088',
    endpoint: process.env.MIRTH_ENDPOINT || '/api/channels/receive',
    timeout: parseInt(process.env.MIRTH_TIMEOUT || '30000'), // 30 seconds
    retries: parseInt(process.env.MIRTH_RETRIES || '3'),
  },
  
  // Database (optional)
  database: {
    enabled: process.env.DB_ENABLED === 'true',
    file: process.env.DB_FILE || './file-queue.db',
  },
  
  // Service
  service: {
    port: parseInt(process.env.SERVICE_PORT || '3000'),
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '10000'), // 10 seconds
    maxConcurrent: parseInt(process.env.MAX_CONCURRENT || '1'), // Process 1 file at a time
    logLevel: process.env.LOG_LEVEL || 'info', // debug, info, warn, error
  },
};

// ============================================================================
// LOGGING
// ============================================================================

const logger = {
  debug: (msg, data) => {
    if (['debug', 'info', 'warn', 'error'].includes(config.service.logLevel)) {
      console.log(`[DEBUG] ${new Date().toISOString()} - ${msg}`, data || '');
    }
  },
  info: (msg, data) => {
    if (['info', 'warn', 'error'].includes(config.service.logLevel)) {
      console.log(`[INFO] ${new Date().toISOString()} - ${msg}`, data || '');
    }
  },
  warn: (msg, data) => {
    if (['warn', 'error'].includes(config.service.logLevel)) {
      console.warn(`[WARN] ${new Date().toISOString()} - ${msg}`, data || '');
    }
  },
  error: (msg, error) => {
    console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`, error ? error.message : '');
    if (error?.stack && config.service.logLevel === 'debug') {
      console.error(error.stack);
    }
  },
};

// ============================================================================
// DATABASE LAYER (Optional - for audit trail)
// ============================================================================

class FileQueue {
  constructor() {
    this.db = null;
    this.initialized = false;
  }

  async init() {
    if (!config.database.enabled) {
      this.initialized = true;
      return;
    }

    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(config.database.file, (err) => {
        if (err) {
          logger.error('Failed to open database', err);
          reject(err);
          return;
        }

        this.db.serialize(() => {
          // Create audit table
          this.db.run(`
            CREATE TABLE IF NOT EXISTS file_queue (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              googleFileId TEXT UNIQUE NOT NULL,
              fileName TEXT NOT NULL,
              mimeType TEXT NOT NULL,
              patientId TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'pending',
              createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
              processedAt DATETIME,
              mirthAckReceived BOOLEAN DEFAULT 0,
              errorMessage TEXT,
              attempts INTEGER DEFAULT 0
            );
          `, (err) => {
            if (err) logger.error('Failed to create table', err);
          });

          // Create index on status for faster queries
          this.db.run(`
            CREATE INDEX IF NOT EXISTS idx_status ON file_queue(status);
          `, (err) => {
            if (err) logger.error('Failed to create index', err);
          });

          this.initialized = true;
          resolve();
        });
      });
    });
  }

  async recordFile(googleFileId, fileName, mimeType, patientId) {
    if (!config.database.enabled) return;

    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT OR IGNORE INTO file_queue (googleFileId, fileName, mimeType, patientId, status)
         VALUES (?, ?, ?, ?, 'pending')`,
        [googleFileId, fileName, mimeType, patientId],
        function(err) {
          if (err) {
            logger.error('Failed to record file in queue', err);
            reject(err);
          } else {
            resolve(this.lastID);
          }
        }
      );
    });
  }

  async getNextFile() {
    if (!config.database.enabled) return null;

    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT * FROM file_queue WHERE status = 'pending' ORDER BY createdAt ASC LIMIT 1`,
        (err, row) => {
          if (err) {
            logger.error('Failed to get next file from queue', err);
            reject(err);
          } else {
            resolve(row);
          }
        }
      );
    });
  }

  async updateFileStatus(googleFileId, status, mirthAckReceived = false, errorMessage = null) {
    if (!config.database.enabled) return;

    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE file_queue 
         SET status = ?, processedAt = CURRENT_TIMESTAMP, mirthAckReceived = ?, errorMessage = ?
         WHERE googleFileId = ?`,
        [status, mirthAckReceived ? 1 : 0, errorMessage, googleFileId],
        function(err) {
          if (err) {
            logger.error('Failed to update file status', err);
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });
  }

  async incrementAttempts(googleFileId) {
    if (!config.database.enabled) return;

    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE file_queue SET attempts = attempts + 1 WHERE googleFileId = ?`,
        [googleFileId],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async close() {
    if (!this.db) return;
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

// ============================================================================
// GOOGLE DRIVE CLIENT
// ============================================================================

class GoogleDriveClient {
  constructor() {
    this.drive = null;
    this.initialized = false;
  }

  async init() {
    try {
      // const auth = new google.auth.GoogleAuth({
      //   keyFilename: config.googleDrive.keyFile,
      //   scopes: ['https://www.googleapis.com/auth/drive'],
      // });
      const keyFilePath = path.resolve(config.googleDrive.keyFile);

      // Verify file exists before using
      try {
        await fs.access(keyFilePath);
      } catch (err) {
        throw new Error(`Credentials file not found at: ${keyFilePath}`);
      }

      const auth = new google.auth.GoogleAuth({
        keyFilename: keyFilePath,  // ← Use resolved absolute path
        scopes: ['https://www.googleapis.com/auth/drive'],
      });

      this.drive = google.drive({ version: 'v3', auth });
      this.initialized = true;
      logger.info('Google Drive client initialized');
    } catch (error) {
      logger.error('Failed to initialize Google Drive client', error);
      throw error;
    }
  }

  async listFilesInFolder(folderId) {
    try {
      const response = await this.drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'files(id, name, mimeType, size)',
        spaces: 'drive',
        pageSize: 100,
      });

      return response.data.files || [];
    } catch (error) {
      logger.error('Failed to list files in Google Drive folder', error);
      throw error;
    }
  }

  async downloadFileAsBase64(fileId) {
    try {
      const response = await this.drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'arraybuffer' }
      );

      const base64 = Buffer.from(response.data).toString('base64');
      return base64;
    } catch (error) {
      logger.error(`Failed to download file ${fileId}`, error);
      throw error;
    }
  }

  async getFileMetadata(fileId) {
    try {
      const response = await this.drive.files.get({
        fileId,
        fields: 'id, name, mimeType, size',
      });
      return response.data;
    } catch (error) {
      logger.error(`Failed to get file metadata ${fileId}`, error);
      throw error;
    }
  }

  async moveFileToFolder(fileId, targetFolderId) {
    try {
      const file = await this.drive.files.get({
        fileId,
        fields: 'parents',
      });

      const previousParents = file.data.parents.join(',');

      await this.drive.files.update({
        fileId,
        addParents: targetFolderId,
        removeParents: previousParents,
        fields: 'id, parents',
      });

      logger.info(`File ${fileId} moved to folder ${targetFolderId}`);
    } catch (error) {
      logger.error(`Failed to move file ${fileId}`, error);
      throw error;
    }
  }
}

// ============================================================================
// MIRTH CONNECTOR
// ============================================================================

class MirthConnector {
  async sendFileWithRetry(payload, maxRetries = config.mirth.retries) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.debug(`Sending file to Mirth (attempt ${attempt}/${maxRetries})`, {
          fileName: payload.fileName,
          patientId: payload.patientId,
        });

        console.debug('Payload being sent to Mirth:', `${config.mirth.baseUrl}${config.mirth.endpoint}`);
        const response = await axios.post(
          `${config.mirth.baseUrl}${config.mirth.endpoint}`,
          payload,
          {
            timeout: config.mirth.timeout,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        );

        // Check for ACK in response
        if (this.isValidAck(response)) {
          logger.info(`ACK received from Mirth for ${payload.fileName}`, {
            status: response.status,
            responseTime: response.headers['x-response-time'],
          });
          return { success: true, response };
        } else {
          throw new Error(`Invalid ACK response: ${response.status}`);
        }
      } catch (error) {
        lastError = error;
        logger.warn(`Mirth send failed (attempt ${attempt}/${maxRetries})`, {
          fileName: payload.fileName,
          error: error.message,
          waitingBeforeRetry: attempt < maxRetries ? `${attempt * 2}s` : null,
        });

        // Exponential backoff: 2s, 4s, 8s, etc.
        if (attempt < maxRetries) {
          const delayMs = attempt * 2000;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    logger.error(`All retry attempts failed for Mirth send`, lastError);
    throw lastError;
  }

  isValidAck(response) {
    // Adjust based on your Mirth ACK format
    // Common: 200/201 status or presence of specific headers/body fields
    return response.status >= 200 && response.status < 300;
  }
}

// ============================================================================
// FILE PROCESSOR (Main Logic)
// ============================================================================

class FileProcessor {
  constructor(googleDrive, mirth, fileQueue) {
    this.googleDrive = googleDrive;
    this.mirth = mirth;
    this.fileQueue = fileQueue;
    this.processing = false;
  }

  async processNextFile() {
    if (this.processing) {
      logger.debug('Already processing a file, skipping this cycle');
      return;
    }

    this.processing = true;

    try {
      // Step 1: Get list of files from Google Drive
      const files = await this.googleDrive.listFilesInFolder(
        config.googleDrive.queueFolderId
      );

      if (files.length === 0) {
        logger.debug('No files in Google Drive queue');
        return;
      }

      const file = files[0];
      logger.info(`Processing file from queue: ${file.name}`);

      // Step 2: Record in database (audit trail)
      const patientId = this.extractPatientIdFromFileName(file.name);
      await this.fileQueue.recordFile(file.id, file.name, file.mimeType, patientId);

      try {
        // Step 3: Download and convert to base64
        const base64Data = await this.googleDrive.downloadFileAsBase64(file.id);

        // Step 4: Build Mirth payload
        const payload = {
          fileName: file.name,
          mimeType: file.mimeType,
          patientId: patientId,
          docType:file.name.replace(/^\d+_/, '').replace(/\.[^/.]+$/, ''),
          base64: base64Data,
          timestamp: new Date().toISOString(),
        };

        logger.debug('Payload built', { fileName: file.name, size: base64Data.length });
        logger.debug('Payload', payload);
        // Step 6: Optional - Move file to processed folder
        if (config.googleDrive.processedFolderId) {
          await this.googleDrive.moveFileToFolder(
            file.id,
            config.googleDrive.processedFolderId
          );
        } else {
          logger.warn(
            'Processed folder is not configured, file will remain in the queue folder',
            { fileName: file.name }
          );
        }
        // Step 5: Send to Mirth with retry logic
        await this.mirth.sendFileWithRetry(payload);

        

        // Step 7: Mark as processed in database
        await this.fileQueue.updateFileStatus(
          file.id,
          'processed',
          true,
          null
        );

        logger.info(`Successfully processed and sent file: ${file.name}`);
      } catch (error) {
        // Update database with error
        await this.fileQueue.updateFileStatus(
          file.id,
          'failed',
          false,
          error.message
        );

        await this.fileQueue.incrementAttempts(file.id);

        logger.error(`Failed to process file ${file.name}`, error);
        // Don't re-throw; continue processing other files
      }
    } catch (error) {
      logger.error('Unexpected error in processNextFile', error);
    } finally {
      this.processing = false;
    }
  }

  extractPatientIdFromFileName(fileName) {
    // Example: "19507-discharge.PNG" -> "19507"
    // Adjust regex based on your naming convention
    const match = fileName.match(/^(\d+)_/);
    return match ? match[1] : 'UNKNOWN';
  }
}

// ============================================================================
// EXPRESS SERVER (Health checks, metrics, manual triggers)
// ============================================================================

const app = express();
app.use(express.json());

let fileProcessor;
let processingInterval;

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    processing: fileProcessor.processing,
  });
});

// Manual trigger to process next file
app.post('/api/process-next', async (req, res) => {
  try {
    logger.info('Manual process-next triggered');
    await fileProcessor.processNextFile();
    res.json({ status: 'File processing initiated' });
  } catch (error) {
    logger.error('Manual process-next failed', error);
    res.status(500).json({ error: error.message });
  }
});

// Get queue status (database optional)
app.get('/api/queue-status', async (req, res) => {
  if (!config.database.enabled) {
    return res.json({ database: 'disabled' });
  }

  try {
    const pending = await new Promise((resolve, reject) => {
      fileProcessor.fileQueue.db.get(
        'SELECT COUNT(*) as count FROM file_queue WHERE status = ?',
        ['pending'],
        (err, row) => {
          if (err) reject(err);
          else resolve(row.count);
        }
      );
    });

    const processed = await new Promise((resolve, reject) => {
      fileProcessor.fileQueue.db.get(
        'SELECT COUNT(*) as count FROM file_queue WHERE status = ?',
        ['processed'],
        (err, row) => {
          if (err) reject(err);
          else resolve(row.count);
        }
      );
    });

    const failed = await new Promise((resolve, reject) => {
      fileProcessor.fileQueue.db.get(
        'SELECT COUNT(*) as count FROM file_queue WHERE status = ?',
        ['failed'],
        (err, row) => {
          if (err) reject(err);
          else resolve(row.count);
        }
      );
    });

    res.json({ pending, processed, failed });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// STARTUP
// ============================================================================

async function start() {
  try {
    logger.info('=== Google Drive → Mirth Service Starting ===');
    logger.info('Configuration', {
      googleDriveFolder: config.googleDrive.queueFolderId,
      processedFolder: config.googleDrive.processedFolderId || 'not configured',
      mirthEndpoint: `${config.mirth.baseUrl}${config.mirth.endpoint}`,
      pollInterval: `${config.service.pollIntervalMs}ms`,
      databaseEnabled: config.database.enabled,
    });

    // Initialize database
    const fileQueue = new FileQueue();
    await fileQueue.init();
    logger.info(`Database layer: ${config.database.enabled ? 'ENABLED' : 'DISABLED'}`);

    // Initialize Google Drive
    const googleDrive = new GoogleDriveClient();
    await googleDrive.init();

    // Initialize Mirth connector
    const mirth = new MirthConnector();

    // Initialize file processor
    fileProcessor = new FileProcessor(googleDrive, mirth, fileQueue);

    // Start polling
    processingInterval = setInterval(async () => {
      await fileProcessor.processNextFile();
    }, config.service.pollIntervalMs);

    logger.info(`Polling started (every ${config.service.pollIntervalMs}ms)`);

    // Start Express server
    app.listen(config.service.port, () => {
      logger.info(`Service running on http://localhost:${config.service.port}`);
      logger.info('Endpoints:');
      logger.info(`  GET  /health           - Service health check`);
      logger.info(`  POST /api/process-next - Manually trigger file processing`);
      logger.info(`  GET  /api/queue-status - Queue metrics (database only)`);
    });
  } catch (error) {
    logger.error('Failed to start service', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutdown signal received');
  clearInterval(processingInterval);

  if (fileProcessor?.fileQueue?.db) {
    await fileProcessor.fileQueue.close();
  }

  process.exit(0);
});

start();
