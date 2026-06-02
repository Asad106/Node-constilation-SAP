const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { MongoClient } = require('mongodb');
const { google } = require('googleapis');
const dotenv = require('dotenv');
const { createWorker } = require('tesseract.js');
const Jimp = require('jimp');
const xlsx = require('xlsx');

// Load environment variables
dotenv.config();

// ============================================================================
// CONFIGURATION
// ============================================================================

const config = {
  // Google Drive
  googleDrive: {
    keyFile: process.env.GOOGLE_KEY_FILE || './credentials.json',
    queueFolderId: process.env.QUEUE_FOLDER_ID,
    processedFolderId: process.env.PROCESSED_FOLDER_ID || "1MTj-jVoL6517HIjqt5cm_HefoxdXLISb",
  },
  
  // Database
  database: {
    enabled: process.env.DB_ENABLED === 'true',
    mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017',
    dbName: process.env.MONGO_DB_NAME || 'google_drive_mirth',
    collectionName: 'file_queue',
    documentTypesCollection: 'document_types',
    documentTypesFile: process.env.MAPPING_DOCUMENT_TYPES_FILE || 'mapping-documents-types.xlsx',
  },
  
  // Service
  service: {
    port: parseInt(process.env.SERVICE_PORT || '3000'),
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '10000'),
    maxConcurrent: parseInt(process.env.MAX_CONCURRENT || '1'),
    logLevel: process.env.LOG_LEVEL || 'info',
    outputDir: './payload_output', // Directory to write JSON payloads
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
// DATABASE LAYER (MongoDB - for audit trail)
// ============================================================================

class FileQueue {
  constructor() {
    this.client = null;
    this.db = null;
    this.collection = null;
    this.initialized = false;
  }

  async init() {
    if (!config.database.enabled) {
      this.initialized = true;
      return;
    }

    try {
      this.client = new MongoClient(config.database.mongoUri);
      await this.client.connect();
      this.db = this.client.db(config.database.dbName);
      this.collection = this.db.collection(config.database.collectionName);

      // Create unique index on googleFileId
      await this.collection.createIndex({ googleFileId: 1 }, { unique: true });
      // Create index on status for faster queries
      await this.collection.createIndex({ status: 1 });

      this.initialized = true;
      logger.info('MongoDB connection initialized');
    } catch (error) {
      logger.error('Failed to initialize MongoDB', error);
      throw error;
    }
  }

  async recordFile(googleFileId, fileName, mimeType, patientId) {
    if (!config.database.enabled) return;

    try {
      const result = await this.collection.updateOne(
        { googleFileId },
        {
          $setOnInsert: {
            googleFileId,
            fileName,
            mimeType,
            patientId,
            status: 'pending',
            createdAt: new Date(),
            attempts: 0,
            mirthAckReceived: false,
          },
        },
        { upsert: true }
      );
      logger.debug('File recorded in queue', { googleFileId, fileName });
      return result;
    } catch (error) {
      logger.error('Failed to record file in queue', error);
      throw error;
    }
  }

  async getNextFile() {
    if (!config.database.enabled) return null;

    try {
      const file = await this.collection.findOne({ status: 'pending' });
      return file;
    } catch (error) {
      logger.error('Failed to get next file from queue', error);
      throw error;
    }
  }

  async updateFileStatus(googleFileId, status, mirthAckReceived = false, errorMessage = null) {
    if (!config.database.enabled) return;

    try {
      const updateData = {
        status,
        processedAt: new Date(),
      };

      if (mirthAckReceived) {
        updateData.mirthAckReceived = true;
      }

      if (errorMessage) {
        updateData.errorMessage = errorMessage;
      }

      await this.collection.updateOne(
        { googleFileId },
        { $set: updateData }
      );
      logger.debug('File status updated', { googleFileId, status });
    } catch (error) {
      logger.error('Failed to update file status', error);
      throw error;
    }
  }

  async incrementAttempts(googleFileId) {
    if (!config.database.enabled) return;

    try {
      await this.collection.updateOne(
        { googleFileId },
        { $inc: { attempts: 1 } }
      );
    } catch (error) {
      logger.error('Failed to increment attempts', error);
      throw error;
    }
  }

  async close() {
    if (!this.client) return;
    try {
      await this.client.close();
      logger.info('MongoDB connection closed');
    } catch (error) {
      logger.error('Failed to close MongoDB connection', error);
      throw error;
    }
  }
}

class DocumentTypeStore {
  constructor() {
    this.client = null;
    this.db = null;
    this.collection = null;
    this.mappingsCache = null;
    this.initialized = false;
  }

  async init() {
    if (!config.database.enabled) {
      this.initialized = true;
      return;
    }

    try {
      this.client = new MongoClient(config.database.mongoUri);
      await this.client.connect();
      this.db = this.client.db(config.database.dbName);
      this.collection = this.db.collection(config.database.documentTypesCollection);

      await this.collection.createIndex(
        { documentType: 1 },
        { unique: true, collation: { locale: 'en', strength: 2 } }
      );

      this.initialized = true;
      logger.info('Document type store initialized');
    } catch (error) {
      logger.error('Failed to initialize document type store', error);
      throw error;
    }
  }

  async loadMappingsFromSpreadsheet() {
    if (!config.database.enabled) {
      logger.warn('Database disabled; skipping document type mapping import');
      return;
    }

    try {
      const mappingPath = path.resolve(config.database.documentTypesFile);
      await fs.access(mappingPath);

      const workbook = xlsx.readFile(mappingPath, { raw: false });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];

      // Read raw rows (arrays) so we can detect header row even when the sheet
      // has empty leading rows or merged cells that confuse sheet_to_json.
      const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      // Find header row index by looking for expected column names
      const headerCandidates = rawRows.map((r) => r.map((c) => (c || '').toString().toLowerCase()));
      const expectedHeaders = ['document type', 'category', 'loinc code', 'loinc display'];
      let headerIndex = -1;
      for (let i = 0; i < headerCandidates.length; i++) {
        const row = headerCandidates[i];
        const matches = expectedHeaders.filter((h) => row.some((c) => c.includes(h)));
        if (matches.length >= 2) { // require at least two header matches
          headerIndex = i;
          break;
        }
      }

      if (headerIndex === -1) {
        // Fall back to default sheet_to_json behavior and try to parse using keys
        const fallbackRows = xlsx.utils.sheet_to_json(sheet, { defval: '' });
        logger.info(`Loaded ${fallbackRows.length} rows from document type mapping spreadsheet (fallback)`);

        const bulkOps = fallbackRows
          .map((row) => {
            const documentType = (row['Document Type'] || row['documentType'] || '').toString().trim();
            if (!documentType) return null;

            return {
              updateOne: {
                filter: { documentType },
                update: {
                  $set: {
                    documentType,
                    category: (row['Category'] || row['category'] || '').toString().trim(),
                    loincCode: (row['LOINC Code'] || row['loincCode'] || '').toString().trim(),
                    loincDisplay: (row['LOINC Display'] || row['loincDisplay'] || '').toString().trim(),
                  },
                },
                upsert: true,
              },
            };
          })
          .filter(Boolean);

        if (bulkOps.length > 0) {
          await this.collection.bulkWrite(bulkOps, { ordered: false });
        }

        await this.refreshCache();
        logger.info(`Loaded ${bulkOps.length} document type mappings from spreadsheet (fallback)`);
        return;
      }

      const headers = rawRows[headerIndex].map((h) => (h || '').toString().trim());
      const dataRows = rawRows.slice(headerIndex + 1).map((rowArr) => {
        const obj = {};
        for (let c = 0; c < headers.length; c++) {
          const key = headers[c] || `col_${c}`;
          obj[key] = rowArr[c] !== undefined && rowArr[c] !== null ? rowArr[c] : '';
        }
        return obj;
      });

      logger.info(`Detected header row at index ${headerIndex}, parsing ${dataRows.length} rows`);

      const bulkOps = dataRows
        .map((row) => {
          // Try several header name variants
          const documentType = (
            row['Document Type'] || row['documentType'] || row['__EMPTY_1'] || row['__EMPTY_2'] || row['DocumentType'] || ''
          ).toString().trim();
          if (!documentType) return null;

          const category = (
            row['Category'] || row['category'] || row['__EMPTY_3'] || ''
          ).toString().trim();
          const loincCode = (
            row['LOINC Code'] || row['loincCode'] || row['__EMPTY_4'] || ''
          ).toString().trim();
          const loincDisplay = (
            row['LOINC Display'] || row['loincDisplay'] || row['__EMPTY_5'] || ''
          ).toString().trim();

          return {
            updateOne: {
              filter: { documentType },
              update: {
                $set: {
                  documentType,
                  category,
                  loincCode,
                  loincDisplay,
                },
              },
              upsert: true,
            },
          };
        })
        .filter(Boolean);

      if (bulkOps.length > 0) {
        await this.collection.bulkWrite(bulkOps, { ordered: false });
      }

      await this.refreshCache();
      logger.info(`Loaded ${bulkOps.length} document type mappings from spreadsheet`);
    } catch (error) {
      logger.error('Failed to load document type mappings from spreadsheet', error);
      throw error;
    }
  }

  async refreshCache() {
    if (!config.database.enabled) {
      this.mappingsCache = [];
      return;
    }

    this.mappingsCache = await this.collection.find({}).toArray();
  }

  normalizeText(text) {
    return text
      ? text.toString().toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
      : '';
  }

  calculateMatchScore(normalizedTitle, mapping) {
    const normalizedType = this.normalizeText(mapping.documentType);
    const normalizedDisplay = this.normalizeText(mapping.loincDisplay);

    let score = 0;

    if (normalizedType && normalizedTitle === normalizedType) score += 1000;
    if (normalizedDisplay && normalizedTitle === normalizedDisplay) score += 900;
    if (normalizedType && normalizedType.includes(normalizedTitle)) score += 400;
    if (normalizedDisplay && normalizedDisplay.includes(normalizedTitle)) score += 300;
    if (normalizedTitle && normalizedTitle.includes(normalizedType)) score += 200;
    if (normalizedTitle && normalizedTitle.includes(normalizedDisplay)) score += 180;

    const titleWords = new Set(normalizedTitle.split(' ').filter(Boolean));
    const typeWords = new Set(normalizedType.split(' ').filter(Boolean));
    const displayWords = new Set(normalizedDisplay.split(' ').filter(Boolean));

    const overlapType = [...titleWords].filter((word) => typeWords.has(word)).length;
    const overlapDisplay = [...titleWords].filter((word) => displayWords.has(word)).length;

    score += overlapType * 40;
    score += overlapDisplay * 30;

    if (titleWords.size > 0 && [...titleWords].every((word) => typeWords.has(word))) {
      score += 200;
    }

    if (titleWords.size > 0 && [...titleWords].every((word) => displayWords.has(word))) {
      score += 180;
    }

    return score;
  }

  async findBestMatch(title) {
    if (!title) return null;
    if (!this.mappingsCache) {
      await this.refreshCache();
    }

    const normalizedTitle = this.normalizeText(title);
    if (!normalizedTitle) return null;

    let bestMatch = null;
    let bestScore = 0;

    for (const mapping of this.mappingsCache) {
      const score = this.calculateMatchScore(normalizedTitle, mapping);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = mapping;
      }
    }

    return bestScore > 0 ? bestMatch : null;
  }

  async close() {
    if (!this.client) return;
    try {
      await this.client.close();
      logger.info('Document type store MongoDB connection closed');
    } catch (error) {
      logger.error('Failed to close document type store connection', error);
      throw error;
    }
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

  async moveFileToFolder(fileId, targetFolderId, removeFolderId = null) {
    try {
      const file = await this.drive.files.get({
        fileId,
        fields: 'parents',
      });

      const currentParents = Array.isArray(file.data.parents) ? file.data.parents.filter(Boolean) : [];
      logger.debug('Current file parents before move', { fileId, parents: currentParents });

      if (currentParents.includes(targetFolderId) && (!removeFolderId || !currentParents.includes(removeFolderId))) {
        logger.info(`File ${fileId} is already in processed folder ${targetFolderId}`);
        return;
      }

      const updateOptions = {
        fileId,
        addParents: targetFolderId,
        fields: 'id, parents',
      };

      if (removeFolderId && currentParents.includes(removeFolderId)) {
        updateOptions.removeParents = removeFolderId;
      }

      await this.drive.files.update(updateOptions);

      const updatedFile = await this.drive.files.get({
        fileId,
        fields: 'parents',
      });
      const updatedParents = Array.isArray(updatedFile.data.parents) ? updatedFile.data.parents.filter(Boolean) : [];
      logger.debug('Current file parents after move', { fileId, parents: updatedParents });

      if (removeFolderId && updatedParents.includes(removeFolderId)) {
        throw new Error(`File ${fileId} still has queue folder parent ${removeFolderId} after move`);
      }

      logger.info(`File ${fileId} moved to folder ${targetFolderId}`);
    } catch (error) {
      logger.error(`Failed to move file ${fileId}`, error);
      throw error;
    }
  }
}

// ============================================================================
// MIRTH CONNECTOR (COMMENTED OUT - Not used in current phase)
// ============================================================================

/*
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
    return response.status >= 200 && response.status < 300;
  }
}
*/

// ============================================================================
// FILE PROCESSOR (Main Logic)
// ============================================================================

class FileProcessor {
  constructor(googleDrive, fileQueue, documentTypeStore) {
    this.googleDrive = googleDrive;
    this.fileQueue = fileQueue;
    this.documentTypeStore = documentTypeStore;
    this.processing = false;
  }

  /**
   * Extract document type from image using OCR (Tesseract.js)
   * Reads text from top section of image to find title/document type
   */
  async extractDocumentTypeFromImage(base64Data, fileName) {
    try {
      logger.info(`Extracting document type from image via OCR: ${fileName}`);
      const docType = await extractTitleFromBase64(base64Data);
      if (docType) {
        logger.info(`Document type extracted: ${docType}`);
        return docType;
      }

      logger.warn('OCR did not produce a valid document type, falling back to filename');
      return fileName.replace(/\.[^/.]+$/, '').replace(/^\d+_/, '');
    } catch (error) {
      logger.warn(`Failed to extract document type via OCR, using filename`, error);
      return fileName.replace(/\.[^/.]+$/, '').replace(/^\d+_/, '');
    }
  }

  /**
   * Write payload to JSON file in output directory
   */
  async writePayloadToFile(payload, fileName) {
    try {
      // Ensure output directory exists
      await fs.mkdir(config.service.outputDir, { recursive: true });
      
      // Create unique filename
      const fileNameWithoutExt = fileName.replace(/\.[^/.]+$/, '');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputFileName = `${fileNameWithoutExt}_${timestamp}.json`;
      const outputPath = path.join(config.service.outputDir, outputFileName);
      
      // Write payload to file
      await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf8');
      
      logger.info(`Payload written to file: ${outputPath}`);
      return outputPath;
    } catch (error) {
      logger.error(`Failed to write payload to file`, error);
      throw error;
    }
  }

  async processNextFile() {
    if (this.processing) {
      logger.debug('Already processing a file, skipping this cycle');
      return;
    }

    this.processing = true;

    try {
      // Step 1: List files in queue
      const files = await this.googleDrive.listFilesInFolder(
        config.googleDrive.queueFolderId
      );

      if (files.length === 0) {
        logger.debug('No files in Google Drive queue');
        return;
      }

      const file = files[0];
      logger.info(`Processing file from queue: ${file.name}`);

      // Step 2: Extract patient ID from filename
      const patientId = this.extractPatientIdFromFileName(file.name);

      // Step 3: Record in database (optional audit trail)
      await this.fileQueue.recordFile(file.id, file.name, file.mimeType, patientId);

      try {
        // Step 4: Download file as base64
        const base64Data = await this.googleDrive.downloadFileAsBase64(file.id);
        // logger.info(`File downloaded: ${file.name} (${base64Data.length} bytes)`);

        // Step 5: Extract document type using OCR (safe, with fallback)
        const title = await extractTitleFromBase64(base64Data);
        logger.info(`Document type extracted from image: ${title || 'N/A'}`);
        const documentType = title || await this.extractDocumentTypeFromImage(base64Data, file.name);

        // Step 6: Map the OCR document type to the configured document type store
        const documentTypeMapping = await this.documentTypeStore.findBestMatch(documentType);

        const payload = {
          fileName: file.name,
          patientId: patientId,
          documentType: documentType,
          documentTypeDetails: documentTypeMapping
            ? {
                documentType: documentTypeMapping.documentType,
                category: documentTypeMapping.category,
                loincCode: documentTypeMapping.loincCode,
                loincDisplay: documentTypeMapping.loincDisplay,
              }
            : null,
          base64Image: base64Data,
          timestamp: new Date().toISOString(),
        };

        logger.debug('Payload built', {
          fileName: file.name,
          patientId: patientId,
          documentType: documentType,
        });

        // Step 7: Write payload to JSON file
        await this.writePayloadToFile(payload, file.name);

        // Step 8: Move file to processed folder
        if (config.googleDrive.processedFolderId) {
          logger.info(`Moving file to processed folder: ${file.name}`);
          await this.googleDrive.moveFileToFolder(
            file.id,
            config.googleDrive.processedFolderId,
            config.googleDrive.queueFolderId
          );
          logger.info(`File moved to processed folder: ${file.name}`);
        } else {
          logger.warn(
            'Processed folder is not configured, file will remain in queue',
            { fileName: file.name }
          );
        }

        // Step 9: Mark as processed in database
        await this.fileQueue.updateFileStatus(
          file.id,
          'processed',
          true,
          null
        );

        logger.info(`Successfully processed file: ${file.name}`);
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
      }
    } catch (error) {
      logger.error('Unexpected error in processNextFile', error);
    } finally {
      this.processing = false;
    }
  }

  extractPatientIdFromFileName(fileName) {
    // Try several patterns to extract a patient ID (MRN):
    // 1) Leading digits: "19507-discharge.PNG" -> "19507"
    // 2) Digits before an underscore: "19507_anyname.png" -> "19507"
    // 3) Any group of 4-15 digits in the filename
    // Returns 'UNKNOWN' if none found
    if (!fileName || typeof fileName !== 'string') return 'UNKNOWN';

    // 1) Leading digits
    let m = fileName.match(/^(\d{3,15})/);
    if (m) return m[1];

    // 2) digits after optional prefix and underscore
    m = fileName.match(/(?:^|_)(\d{3,15})(?:_|\.|$)/);
    if (m) return m[1];

    // 3) any digits group
    m = fileName.match(/(\d{4,15})/);
    if (m) return m[1];

    return 'UNKNOWN';
  }
}

// ============================================================================
// EXPRESS SERVER (Health checks, manual triggers)
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
    processing: fileProcessor ? fileProcessor.processing : false,
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

// ============================================================================
// STARTUP
// ============================================================================

async function start() {
  try {
    logger.info('=== Google Drive → Payload Service Starting ===');
    logger.info('Configuration', {
      googleDriveQueueFolder: config.googleDrive.queueFolderId,
      processedFolder: config.googleDrive.processedFolderId || 'not configured',
      outputDirectory: config.service.outputDir,
      pollInterval: `${config.service.pollIntervalMs}ms`,
      databaseEnabled: config.database.enabled,
      documentTypesFile: config.database.documentTypesFile,
    });

    // Initialize database (optional)
    const fileQueue = new FileQueue();
    await fileQueue.init();
    logger.info(`Database layer: ${config.database.enabled ? 'ENABLED' : 'DISABLED'}`);

    const documentTypeStore = new DocumentTypeStore();
    await documentTypeStore.init();
    await documentTypeStore.loadMappingsFromSpreadsheet();
    logger.info(`Document type store: ${config.database.enabled ? 'ENABLED' : 'DISABLED'}`);

    // Initialize Google Drive
    const googleDrive = new GoogleDriveClient();
    await googleDrive.init();

    // Initialize file processor (removed Mirth)
    fileProcessor = new FileProcessor(googleDrive, fileQueue, documentTypeStore);

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

  if (fileProcessor?.documentTypeStore?.db) {
    await fileProcessor.documentTypeStore.close();
  }

  process.exit(0);
});

async function extractTitleFromBase64(base64String) {
  const worker = await createWorker();
  try {
    await worker.loadLanguage('eng');
    await worker.initialize('eng');
    await worker.setParameters({ tessedit_pageseg_mode: '6' });

    const imageBuffer = Buffer.from(base64String, 'base64');
    const image = await Jimp.read(imageBuffer);

    const preprocessImage = async (img) => {
      await img.grayscale().contrast(0.2).brightness(0.05).normalize();
      return img.getBufferAsync(Jimp.MIME_PNG);
    };

    const topCropHeight = Math.min(Math.max(Math.floor(image.bitmap.height * 0.22), 120), 400);
    const topCrop = image.clone().crop(0, 0, image.bitmap.width, topCropHeight);
    const topBuffer = await preprocessImage(topCrop);

    let text = '';
    let ocrSource = 'topCrop';

    try {
      const topResult = await worker.recognize(topBuffer);
      text = topResult?.data?.text || '';
      logger.debug('OCR top crop text', { text: text.substring(0, 500) });
    } catch (err) {
      logger.warn('Top crop OCR failed, falling back to full image', err);
    }

    if (!text || !text.trim()) {
      const fullImage = image.clone();
      const fullBuffer = await preprocessImage(fullImage);
      const fullResult = await worker.recognize(fullBuffer);
      text = fullResult?.data?.text || '';
      ocrSource = 'fullImage';
      logger.debug('OCR full image text', { text: text.substring(0, 500) });
    }

    const rawLines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const cleanLine = (line) =>
      line
        .replace(/[^A-Za-z0-9 \-\/\(\)\[\]\.\,]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const isMeaningfulLine = (line) => {
      const cleaned = cleanLine(line);
      if (!cleaned) return false;
      if (cleaned.length < 5) return false;
      const words = cleaned.split(' ').filter(Boolean);
      if (words.length < 2) return false;
      const letters = (cleaned.match(/[A-Za-z]/g) || []).length;
      const digits = (cleaned.match(/[0-9]/g) || []).length;
      if (letters < digits) return false;
      if (/^[^A-Za-z]*$/.test(cleaned)) return false;
      return true;
    };

    const scoreLine = (cleaned, index) => {
      const letters = (cleaned.match(/[A-Za-z]/g) || []).length;
      const digits = (cleaned.match(/[0-9]/g) || []).length;
      const words = cleaned.split(' ').filter(Boolean).length;
      const uppercaseWords = cleaned.split(' ').filter((w) => /^[A-Z][a-z]/.test(w)).length;
      const punctuationBonus = /[\.\-\/\(\)\[\],]/.test(cleaned) ? 12 : 0;
      const repeatedPatternPenalty = /([A-Z])\1{2,}/.test(cleaned) ? -40 : 0;
      const digitPenalty = digits * 8;
      const upperRatio = words > 0 ? (uppercaseWords / words) * 15 : 0;
      const positionBonus = Math.max(0, 30 - index * 6);
      return letters * 4 + words * 9 + upperRatio + punctuationBonus - digitPenalty + repeatedPatternPenalty + positionBonus;
    };

    logger.debug('OCR raw extracted text', { text: text.substring(0, 1000), source: ocrSource });

    const candidateLines = rawLines
      .map((line, index) => {
        const cleaned = cleanLine(line);
        const score = scoreLine(cleaned, index);
        return { index, original: line, cleaned, score };
      })
      .filter((entry) => entry.cleaned.length > 0 && isMeaningfulLine(entry.original));

    if (candidateLines.length === 0) {
      logger.warn('No valid OCR heading found, returning null');
      return null;
    }

    candidateLines.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.cleaned.length !== a.cleaned.length) return b.cleaned.length - a.cleaned.length;
      return a.index - b.index;
    });

    const topCandidates = candidateLines.slice(0, Math.min(3, candidateLines.length));
    topCandidates.sort((a, b) => a.index - b.index);

    const topLine = topCandidates[0].cleaned;
    logger.debug('OCR selected top heading', {
      text: topLine,
      score: topCandidates[0].score,
      index: topCandidates[0].index,
      source: ocrSource,
    });
    return topLine;
  } catch (error) {
    logger.error('Error extracting title from base64 image', error);
    return null;
  } finally {
    await worker.terminate();
  }
}

start();
