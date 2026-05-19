# Quick Reference Guide

---

## 30-Second Overview

**What it does:**
1. Polls Google Drive folder every 10 seconds
2. Finds first file → downloads as base64
3. Builds JSON: `{ fileName, mimeType, patientId, base64 }`
4. POSTs to Mirth with retry logic (3 attempts, exponential backoff)
5. Waits for HTTP 200 ACK
6. Records in SQLite audit database
7. Moves file to processed folder (optional)
8. Repeats with next file

**Time complexity:** ~2-5 seconds per file (depending on size and Mirth processing)

---

## Installation (3 Steps)

```bash
# 1. Download files and install
npm install

# 2. Copy .env.example → .env and fill in values
cp .env.example .env
nano .env  # Add QUEUE_FOLDER_ID, MIRTH_BASE_URL, etc.

# 3. Add credentials.json from Google Cloud
# (Download from Google Cloud Console)

# 4. Start!
npm run dev
```

---

## Environment Variables (Critical)

| Variable | Required | Example | Purpose |
|----------|----------|---------|---------|
| `GOOGLE_KEY_FILE` | Yes | `./credentials.json` | Path to Google Service Account JSON |
| `QUEUE_FOLDER_ID` | Yes | `1A2B3C...` | Google Drive folder containing files |
| `MIRTH_BASE_URL` | Yes | `http://localhost:8080` | Mirth Connect host:port |
| `MIRTH_ENDPOINT` | Yes | `/api/channels/receive` | Endpoint path on Mirth |
| `DB_ENABLED` | No | `true` / `false` | Enable SQLite audit database |
| `POLL_INTERVAL_MS` | No | `10000` | How often to check for files (ms) |
| `LOG_LEVEL` | No | `debug` / `info` / `warn` | Verbosity of logs |

---

## HTTP Endpoints

### Health Check
```bash
GET /health
# Response: { "status": "ok", "timestamp": "...", "processing": false }
```

### Queue Status
```bash
GET /api/queue-status
# Response: { "pending": 5, "processed": 120, "failed": 2 }
```

### Manual Trigger
```bash
POST /api/process-next
# Response: { "status": "File processing initiated" }
```

---

## File Flow Diagram

```
Google Drive Folder
    │
    ├─── test.pdf
    ├─── 19507-discharge.PNG  ← Picked up
    └─── report.docx
         │
         ↓ [Download + base64]
         │
    JSON Payload:
    {
      "fileName": "19507-discharge.PNG",
      "mimeType": "image/png",
      "patientId": "19507",
      "base64": "iVBORw0KGgo..."
    }
         │
         ↓ [POST to Mirth]
         │
    Mirth Channel
         │
    Destination 1: Save to Database
    Destination 2: Store to File System
    Destination 3: Send to other systems
         │
         ↓ [Return HTTP 200 ACK]
         │
    Node.js Service
         │
    ✓ Mark file as "processed"
    ✓ Move to processed folder (optional)
    ✓ Record in audit DB
         │
         ↓ [Pick up NEXT file in 10 seconds]
```

---

## Payload Format

### Request (Node.js → Mirth)
```json
{
  "fileName": "19507-discharge.PNG",
  "mimeType": "image/png",
  "patientId": "19507",
  "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "timestamp": "2024-01-15T10:30:50.123Z"
}
```

### Response (Mirth → Node.js)
```json
{
  "status": 200,
  "message": "File processed successfully",
  "fileName": "19507-discharge.PNG",
  "patientId": "19507"
}
```

---

## Command Reference

### Starting the Service
```bash
npm start                    # Production mode
npm run dev                  # Debug mode (LOG_LEVEL=debug)
node google-drive-mirth-service.js  # Direct
pm2 start google-drive-mirth-service.js  # With PM2
```

### Monitoring
```bash
curl http://localhost:3000/health           # Quick health check
curl http://localhost:3000/api/queue-status  # Queue depth
pm2 logs mirth-filer                        # Live logs
tail -f /var/log/syslog | grep mirth        # System logs
```

### Testing
```bash
# Manual process trigger
curl -X POST http://localhost:3000/api/process-next

# Test Mirth connectivity
curl http://localhost:8080/api/status

# Test direct Mirth POST
curl -X POST http://localhost:8080/api/channels/receive \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}'
```

### Database
```bash
sqlite3 file-queue.db                  # Open DB
sqlite> SELECT * FROM file_queue;      # View all files
sqlite> SELECT status, COUNT(*) FROM file_queue GROUP BY status;  # Summary
sqlite> .quit                          # Exit
```

### Logs
```bash
# View all logs
pm2 logs mirth-filer

# View only errors
pm2 logs mirth-filer | grep ERROR

# View from specific time
journalctl -u mirth-file-processor --since "2 hours ago"

# Count errors
pm2 logs mirth-filer 2>&1 | grep -c ERROR
```

---

## Troubleshooting Quick Fixes

| Problem | Quick Fix |
|---------|-----------|
| No files being processed | 1. Add test file to Drive folder 2. Check `QUEUE_FOLDER_ID` in `.env` 3. Verify service account has access |
| "Connection refused" to Mirth | 1. Start Mirth 2. Verify URL in `.env` 3. Check firewall: `telnet localhost 8080` |
| "Invalid credentials" | 1. Check `credentials.json` exists 2. Verify Drive API enabled 3. Share queue folder with service account email |
| ACK timeout | 1. Increase `MIRTH_TIMEOUT` in `.env` 2. Check Mirth channel is running 3. Look for errors in Mirth logs |
| Database locked | 1. Ensure only 1 service instance running 2. Disable DB: `DB_ENABLED=false` |
| Service won't start | 1. Check Node.js version: `node --version` 2. Reinstall deps: `npm install` 3. Check .env syntax |

---

## Key Metrics

| Metric | Healthy | Warning | Critical |
|--------|---------|---------|----------|
| Files/hour | 60-100 | 10-60 | < 10 |
| Processing time | 2-5s | 5-30s | > 30s |
| ACK success rate | > 99% | 95-99% | < 95% |
| Queue depth | 0-5 | 5-50 | > 50 |
| Service uptime | 99.9% | 95-99.9% | < 95% |

**Check queue:**
```bash
curl http://localhost:3000/api/queue-status | jq '.pending'
```

---

## File Naming Convention

The service extracts **Patient ID** from file name using regex:

```javascript
// Pattern: ^(\d+)-
// Examples:
19507-discharge.PNG          → Patient ID: 19507
19507_scan.pdf              → Patient ID: 19507
PATIENT_19507_form.docx     → Patient ID: UNKNOWN (needs regex update)
```

**To customize**, edit this in `FileProcessor.extractPatientIdFromFileName()`:

```javascript
// Change from:
const match = fileName.match(/^(\d+)-/);

// To match your format:
const match = fileName.match(/PATIENT_(\d+)_/);  // For "PATIENT_19507_file.pdf"
const match = fileName.match(/\[(\d+)\]/);       // For "[19507]_file.pdf"
```

---

## Database Schema

```sql
CREATE TABLE file_queue (
  id INTEGER PRIMARY KEY,
  googleFileId TEXT UNIQUE,          -- Google Drive file ID
  fileName TEXT,                     -- Original file name
  mimeType TEXT,                     -- e.g., "image/png"
  patientId TEXT,                    -- Extracted from file name
  status TEXT,                       -- "pending", "processed", "failed"
  createdAt DATETIME,                -- When added to queue
  processedAt DATETIME,              -- When sent to Mirth
  mirthAckReceived BOOLEAN,          -- Did Mirth return ACK?
  errorMessage TEXT,                 -- Error message if failed
  attempts INTEGER                   -- Number of retry attempts
);
```

**Useful queries:**
```sql
-- Pending files
SELECT * FROM file_queue WHERE status = 'pending';

-- Files processed today
SELECT COUNT(*) FROM file_queue WHERE DATE(processedAt) = DATE('now');

-- Failed files
SELECT fileName, errorMessage, attempts FROM file_queue WHERE status = 'failed';

-- By patient
SELECT patientId, COUNT(*) FROM file_queue WHERE status = 'processed' GROUP BY patientId;
```

---

## Retry Logic

**Attempt 1:** 0s (immediate)  
**Attempt 2:** +2s (wait, retry)  
**Attempt 3:** +4s (wait, retry)  
**Attempt 4:** +8s (wait, retry)  
**Max Retries:** 3 (configurable via `MIRTH_RETRIES`)

If all fail → mark as "failed" in database, continue to next file.

---

## Performance Tips

**For high volume (1000+ files/day):**

```bash
# .env tuning
POLL_INTERVAL_MS=5000        # Check more frequently
MIRTH_TIMEOUT=60000          # Give Mirth more time
MIRTH_RETRIES=5              # More resilience
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

---

## Production Deployment Checklist

- [ ] Node.js 18+ installed on server
- [ ] `npm install --production` completed
- [ ] `.env` configured with production values
- [ ] `credentials.json` in place with 600 permissions
- [ ] Database backup strategy in place
- [ ] Health check endpoint monitored
- [ ] Error alerts configured
- [ ] Service auto-restart on crash (systemd or PM2)
- [ ] Log rotation configured
- [ ] Firewall allows Mirth connectivity
- [ ] Test file processes end-to-end
- [ ] Mirth channel returns HTTP 200 ACK

---

## Support Resources

- **Logs:** `pm2 logs mirth-filer` or `journalctl -u mirth-file-processor`
- **Health:** `curl http://localhost:3000/health`
- **Queue Status:** `curl http://localhost:3000/api/queue-status`
- **Database:** `sqlite3 file-queue.db`
- **Mirth Status:** `curl http://localhost:8080/api/status`

---

## Version Info

| Component | Version |
|-----------|---------|
| Service | 1.0.0 |
| Node.js | 16+ (18+ recommended) |
| npm | 8+ |
| Mirth | 4.1.0+ |

---

**Last Updated:** 2024-01-15
