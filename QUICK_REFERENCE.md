# Quick Reference Guide

---

## 30-Second Overview

**What it does:**
1. Polls Google Drive folder every 10 seconds
2. Finds first file → extracts patient ID from filename
3. Downloads file & converts to base64
4. Applies OCR to extract document title
5. Maps title to LOINC document types
6. Builds JSON: `{ fileName, patientId, documentType, documentTypeDetails, base64Image, timestamp }`
7. Saves payload to file
8. Saves metadata to MongoDB audit trail
9. Moves file to processed folder
10. Repeats with next file

**Time complexity:** ~3-8 seconds per file (including OCR)

---

## Installation (4 Steps)

```bash
# 1. Ensure MongoDB is running
mongod  # or: net start MongoDB (Windows)

# 2. Download files and install
npm install

# 3. Create .env and fill in values
nano .env
# Add: MONGO_URI, MONGO_DB_NAME, QUEUE_FOLDER_ID, PROCESSED_FOLDER_ID, etc.

# 4. Add credentials.json from Google Cloud Console

# 5. Start!
npm run start
```

---

## Environment Variables (Critical)

| Variable | Required | Example | Purpose |
|----------|----------|---------|---------|
| `MONGO_URI` | Yes | `mongodb://localhost:27017` | MongoDB connection string |
| `MONGO_DB_NAME` | Yes | `google_drive_mirth` | MongoDB database name |
| `GOOGLE_KEY_FILE` | Yes | `./credentials.json` | Path to Google Service Account JSON |
| `QUEUE_FOLDER_ID` | Yes | `1A2B3C...` | Google Drive folder containing files to process |
| `PROCESSED_FOLDER_ID` | Yes | `1X2Y3Z...` | Google Drive folder to move processed files to |
| `POLL_INTERVAL_MS` | No | `10000` | How often to check for files (milliseconds) |
| `NODE_ENV` | No | `production` / `development` | Runtime environment |

---

## HTTP Endpoints

### Health Check
```bash
GET /health
# Response: { "status": "ok", "timestamp": "...", "database": "connected" }
```

### Process Next File
```bash
POST /api/process-next
# Response: { "status": "success", "file": "12345_lab_result.PNG" }
```

### Generate Sample Payload
```bash
GET /api/generate-sample/12345
# Response: { fileName, patientId, documentType, documentTypeDetails, base64Image, timestamp }
```

### Validate Sample Payload
```bash
GET /api/validate-sample/12345
# Response: { payload: {...}, validation: { missingFields: [...] } }
```

---

## File Flow Diagram

```
Google Drive Queue Folder
    │
    ├─── test.pdf
    ├─── 12345_lab_result.PNG  ← Picked up
    └─── report.docx
         │
         ↓ [Extract MRN: 12345]
         ↓ [Download + base64]
         ↓ [OCR extract title]
         ↓ [Match to document type mapping]
         │
    JSON Payload:
    {
      "fileName": "12345_lab_result.PNG",
      "patientId": "12345",
      "documentType": "Lab. Test Results",
      "documentTypeDetails": {
        "category": "Laboratory",
        "loincCode": "2345-7",
        "loincDisplay": "Glucose in Serum"
      },
      "base64Image": "iVBORw0KGgo...",
      "timestamp": "2026-06-02T09:11:50.000Z"
    }
         │
         ↓ [Save to file]
         ↓ [Save to MongoDB]
         │
    MongoDB Collection (file_queue)
    and Payload Output File
         │
    Google Drive Processed Folder
    (file moved here after success)
    Destination 3: Send to other systems
         │
```

---

## Payload Format

### Generated JSONPayload (Node.js → Output File + MongoDB)
```json
{
  "fileName": "12345_lab_result.PNG",
  "patientId": "12345",
  "documentType": "Lab. Test Results",
  "documentTypeDetails": {
    "category": "Laboratory",
    "loincCode": "2345-7",
    "loincDisplay": "Glucose in Serum"
  },
  "base64Image": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ...",
  "timestamp": "2026-06-02T09:11:50.000Z"
}
```

---

## Command Reference

### Starting the Service
```bash
npm start                    # Production mode
npm run dev                  # Development mode with nodemon
node google-drive-mirth-service.js  # Direct execution
```

### Monitoring
```bash
curl http://localhost:3000/health           # Quick health check
curl http://localhost:3000/api/process-next # Manual trigger
curl http://localhost:3000/api/generate-sample/12345  # Test payload generation
```

### Testing
```bash
# Manual file processing
curl -X POST http://localhost:3000/api/process-next

# Test MongoDB connection
mongosh "mongodb://localhost:27017"

# Check generated payload
curl http://localhost:3000/api/generate-sample/test123 | jq .
```

### MongoDB Queries
```bash
# Connect to MongoDB
mongosh

# Switch to database
> use google_drive_mirth

# View all processed files
> db.file_queue.find({ status: "processed" })

# Count by status
> db.file_queue.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }])

# View document type mappings
> db.document_types.find().limit(5)

# Count document types loaded
> db.document_types.countDocuments()
```

### Logs
```bash
# View live logs
npm run start

# View only errors
npm run start 2>&1 | grep ERROR

# Enable debug logging
LOG_LEVEL=debug npm run start

# Save logs to file
npm run start > service.log 2>&1 &
tail -f service.log
```

---

## Troubleshooting Quick Fixes

| Problem | Quick Fix |
|---------|-----------|
| No files being processed | 1. Add test file to Drive folder 2. Check `QUEUE_FOLDER_ID` in `.env` 3. Verify service account has been granted access |
| "MongoDB connection refused" | 1. Start MongoDB: `mongod` 2. Verify `MONGO_URI` in `.env` 3. Check MongoDB is accessible |
| "Google Drive permission denied" | 1. Share both queue & processed folders with service account 2. Grant Editor access 3. Check credentials.json is valid |
| OCR title is garbled | 1. Check image quality (should be clear, high contrast) 2. Ensure title is in top portion of image 3. Try a different image |
| Document type not matching | 1. Check mapping file: `mapping-documents-types.xlsx` exists 2. Verify MongoDB has document types loaded 3. Restart service: `npm run start` |
| Service won't start | 1. Check Node.js version: `node --version` (should be 16+) 2. Reinstall deps: `npm install` 3. Check .env syntax with: `cat .env | jq -R .` |

---

## Key Metrics

| Metric | Healthy | Warning | Critical |
|--------|---------|---------|----------|
| Files/hour | 100+ | 50-100 | < 50 |
| Processing time | 3-8s | 8-15s | > 15s |
| MongoDB uptime | 99.9%+ | 95-99.9% | < 95% |
| OCR success rate | > 95% | 85-95% | < 85% |
| Queue depth | 0-10 | 10-50 | > 50 |

**Check queue:**
```bash
curl http://localhost:3000/api/process-next
mongosh -e "use google_drive_mirth; db.file_queue.countDocuments({ status: 'pending' })"
```

---

## File Naming Convention

The service extracts **Patient ID** (MRN) from filename:

```javascript
// Supported patterns:
12345.PNG                   → Patient ID: 12345
12345_lab_result.PNG        → Patient ID: 12345
12345_any_description.ext   → Patient ID: 12345
MRN12345_file.PDF          → Patient ID: 12345 (first numeric sequence)
```

---

## MongoDB Schema

```javascript
// Collection: file_queue
{
  _id: ObjectId("..."),
  googleFileId: "1fVqIcsMbjflawIG...",   // Google Drive file ID
  fileName: "12345_lab_result.PNG",       // Original file name
  mimeType: "image/png",                   // File MIME type
  patientId: "12345",                      // Extracted from filename
  status: "processed",                     // "pending", "processing", "processed", "failed"
  createdAt: ISODate("2026-06-02T..."),   // When added to queue
  processedAt: ISODate("2026-06-02T..."), // When successfully processed
  errorMessage: null,                      // Error message if failed
  attempts: 1                              // Retry attempt count
}

// Collection: document_types
{
  _id: ObjectId("..."),
  documentType: "Lab. Test Results",       // Document type name
  category: "Laboratory",                  // Category
  loincCode: "2345-7",                     // LOINC code
  loincDisplay: "Glucose in Serum"         // LOINC display name
}
```

**Useful queries:**
```javascript
// Pending files (not yet processed)
db.file_queue.find({ status: "pending" })

// Files processed today
db.file_queue.find({ 
  processedAt: { $gte: new Date(new Date().setHours(0,0,0,0)) }
})

// Failed files
SELECT fileName, errorMessage, attempts FROM file_queue WHERE status = 'failed';

// Count by status
db.file_queue.countDocuments({ status: "pending" })
db.file_queue.countDocuments({ status: "processed" })
db.file_queue.countDocuments({ status: "failed" })

// By patient
db.file_queue.aggregate([
  { $match: { status: "processed" } },
  { $group: { _id: "$patientId", count: { $sum: 1 } } }
])
```

---

## Processing Flow

```
1. Service polls QUEUE_FOLDER_ID every 10 seconds
2. Finds first "pending" file
3. Extracts Patient ID from filename (e.g., "12345_lab.PNG" → "12345")
4. Downloads file and converts to base64
5. Applies OCR to extract document title
6. Matches title to document type mapping in MongoDB
7. Builds JSON payload with all required fields
8. Saves payload to file: sample_output/<fileId>_<name>.json
9. Records metadata in MongoDB (file_queue collection)
10. Moves file to PROCESSED_FOLDER_ID in Google Drive
11. Marks status as "processed"
12. Repeats with next file
```

---

## Performance Tips

**For high volume (500+ files/day):**

```bash
# .env tuning
POLL_INTERVAL_MS=5000        # Check more frequently
NODE_ENV=production          # Disable debug logging
LOG_LEVEL=warn               # Less logging overhead

# System tuning
node --max-old-space-size=2048 google-drive-mirth-service.js
```

**For low volume:**
```bash
# .env tuning
POLL_INTERVAL_MS=30000       # Check less frequently (save CPU)
LOG_LEVEL=info               # Standard logging
```

**MongoDB optimization:**
```javascript
// Ensure indexes exist
db.file_queue.createIndex({ status: 1 })
db.file_queue.createIndex({ googleFileId: 1 }, { unique: true })
db.file_queue.createIndex({ createdAt: 1 })
```

---

## Production Deployment Checklist

- [ ] Node.js 18+ installed on server
- [ ] `npm install --production` completed
- [ ] `.env` configured with production values
- [ ] `credentials.json` in place with proper permissions (600)
- [ ] MongoDB backup strategy in place
- [ ] Health check endpoint monitored
- [ ] Error alerts configured
- [ ] Service auto-restart on crash (systemd or PM2)
- [ ] Log rotation configured
- [ ] Firewall allows Google Drive API connectivity
- [ ] Test file processes end-to-end
- [ ] MongoDB connection is secure (if remote)
- [ ] Processed folder verified in Google Drive

---

## Support Resources

- **Live Logs:** `npm run start`
- **Health Check:** `curl http://localhost:3000/health`
- **Manual Trigger:** `curl -X POST http://localhost:3000/api/process-next`
- **Generate Sample:** `curl http://localhost:3000/api/generate-sample/12345`
- **MongoDB Admin:** `mongosh`
- **Payload Output:** `./sample_output/` directory

---

## Version Info

| Component | Version |
|-----------|---------|
| Service | 2.0.0 |
| Node.js | 16+ (18+ recommended) |
| npm | 8+ |
| MongoDB | 4.4+ |
| Tesseract.js | ^5.0.0 |

---

**Last Updated:** 2026-06-02
