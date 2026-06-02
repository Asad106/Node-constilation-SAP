# Operational Guide: Google Drive → Constellation Service

---

## Quick Start Checklist

- [ ] Node.js 16+ installed
- [ ] MongoDB 4.4+ running (local or remote)
- [ ] `npm install` completed
- [ ] `credentials.json` in project root (from Google Cloud)
- [ ] `.env` configured with:
  - [ ] `MONGO_URI` (MongoDB connection string)
  - [ ] `MONGO_DB_NAME` (database name)
  - [ ] `QUEUE_FOLDER_ID` (Google Drive queue folder)
  - [ ] `PROCESSED_FOLDER_ID` (Google Drive processed folder)
- [ ] `mapping-documents-types.xlsx` in project root
- [ ] Test file in Google Drive queue folder
- [ ] `npm run start` starts without errors
- [ ] `curl http://localhost:3000/health` returns `{ "status": "ok" }`

---

## Common Issues & Solutions

### Issue 1: "MongoDB connection refused"

**Error in logs:**
```
[ERROR] Failed to connect to MongoDB
Error: connect ECONNREFUSED 127.0.0.1:27017
```

**Causes:**
1. MongoDB is not running
2. Wrong `MONGO_URI` in `.env`
3. MongoDB server is not accessible

**Fix:**

```bash
# Step 1: Verify MongoDB is running
mongosh  # or: mongo (older versions)
# Should show: test>

# Step 2: Check connection string
cat .env | grep MONGO_URI
# Example: MONGO_URI=mongodb://localhost:27017

# Step 3: If using MongoDB Atlas (cloud):
# Get connection string from: MongoDB Atlas → Cluster → Connect → Connection String
# Format: mongodb+srv://username:password@cluster.mongodb.net/

# Step 4: Test connection manually
mongosh "mongodb://localhost:27017"
```

---

### Issue 2: "Cannot read property of undefined - documentType"

**Error in logs:**
```
[ERROR] Failed to process file - documentType is undefined
```

**Causes:**
1. OCR failed to extract title from image
2. Document type mapping file not found
3. Mapping collection is empty in MongoDB

**Fix:**

```bash
# Step 1: Verify mapping file exists
ls -la mapping-documents-types.xlsx

# Step 2: Check if mapping is loaded in MongoDB
mongosh
> use google_drive_mirth  # (or your MONGO_DB_NAME)
> db.document_types.countDocuments()
# Should return a number > 0

# Step 3: Restart service to reload mapping
npm run start

# Step 4: Check if OCR is working
curl http://localhost:3000/api/generate-sample/12345
# Look for "documentType" field in response
```

---

### Issue 3: "File not found in processed folder"

**Error in logs:**
```
[ERROR] Failed to move file - File not found: 1X2Y3Z...
```

**Causes:**
1. Service account doesn't have access to processed folder
2. Processed folder ID is wrong
3. Google Drive permission issue

**Fix:**

```bash
# Step 1: Verify folder IDs are correct
cat .env | grep FOLDER_ID

# Step 2: Get service account email
cat credentials.json | jq -r '.client_email'

# Step 3: In Google Drive:
# - Find PROCESSED_FOLDER_ID folder
# - Right-click → Share
# - Paste service account email
# - Grant Editor access

# Step 4: Test file move manually (optional)
# Upload test file to QUEUE_FOLDER_ID
# Watch logs for move operation
```

---

### Issue 4: "No Files Being Processed"

**Symptoms:**
- Service is running
- No errors in logs
- But files aren't being picked up

**Debugging steps:**

```bash
# Step 1: Check polling is active
npm run start 2>&1 | grep -i "polling started"

# Step 2: Verify folder IDs are correct
cat .env | grep FOLDER_ID

# Step 3: Confirm service account has access
cat credentials.json | jq -r '.client_email'
# Share this email with QUEUE_FOLDER_ID in Google Drive

# Step 4: Add a test file and manually trigger
curl -X POST http://localhost:3000/api/process-next

# Step 5: Monitor logs for detailed activity
npm run start
# Should see: "[INFO] Found 1 files in queue"

# Step 6: Enable debug logging for more detail
LOG_LEVEL=debug npm run start
# Shows detailed Google Drive and OCR operations
```

---

### Issue 5: "OCR extraction failed - title is garbled"

**Error in logs:**
```
[WARN] OCR title extraction produced low-quality output: "HEHE HRERHERHBEE"
```

**Causes:**
1. Image quality is poor/blurry
2. Document title is not in the top portion of image
3. OCR cannot recognize the language/font

**Fix:**

```bash
# Step 1: Check that Tesseract is working
npm list tesseract.js
# Should show: tesseract.js@latest

# Step 2: Test OCR with a known good image
curl http://localhost:3000/api/generate-sample/test123
# Check the "documentType" field in response

# Step 3: If OCR is consistently bad:
# - Improve image quality before uploading
# - Ensure document title is in top 25% of image
# - Use high-contrast, clear printing
```

---

### Issue 6: "MongoDB document not inserting"

**Error in logs:**
```
[ERROR] Failed to insert file record - validation failed
```

**Causes:**
1. Required fields missing in payload
2. Collection validation rules too strict
3. MongoDB connection lost mid-operation

**Fix:**

```bash
# Step 1: Check MongoDB connection
mongosh "mongodb://localhost:27017"
> use google_drive_mirth
> db

# Step 2: Inspect collection structure
> db.file_queue.findOne()
# Should show: { googleFileId, fileName, status, patientId, createdAt, ... }

# Step 3: Check if collection exists
> db.file_queue.stats()

# Step 4: If collection is corrupted, drop and recreate
> db.file_queue.drop()
# Service will recreate on next restart
> exit

# Step 5: Restart service
npm run start
```
# - URL in .env is wrong
# - Firewall blocking port

# Step 2: Verify Mirth URL in .env
cat .env | grep MIRTH_BASE_URL
# Should be: http://localhost:8080 (or your Mirth server IP)

# Step 3: Check Mirth is running
# On Mirth server:
ps aux | grep -i "mirth\|java"

# If not running, start Mirth:
# /opt/mirth/mirth start

# Step 4: Verify channel exists and is running
# In Mirth Admin:
# 1. Channels → Find your channel
# 2. Status should be "Started" (green)
# 3. Verify endpoint path matches MIRTH_ENDPOINT in .env

# Step 5: Test endpoint directly
curl -X POST http://localhost:8080/api/channels/receive \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}'
# Should NOT get "connection refused"
```

---

### Issue 5: "ACK Timeout" or "All Retry Attempts Failed"

**Error in logs:**
```
[ERROR] All retry attempts failed for Mirth send
Error: timeout of 30000ms exceeded
```

**Causes:**
1. Mirth is processing the request but slowly
2. Mirth destination has errors
3. Network latency too high

**Fix:**

```bash
# Step 1: Increase timeout
# In .env:
MIRTH_TIMEOUT=60000    # 60 seconds instead of 30

# Step 2: Check Mirth channel logs
# In Mirth Admin:
# 1. Channels → Select channel → Message Logger
# 2. Look for errors in processing


---

## Monitoring & Observability

### Health Check Script

```bash
#!/bin/bash
# save as: healthcheck.sh

SERVICE_URL="http://localhost:3000/health"
RESPONSE=$(curl -s $SERVICE_URL)
STATUS=$(echo $RESPONSE | jq -r '.status')

if [ "$STATUS" == "ok" ]; then
  echo "✓ Service is healthy"
  exit 0
else
  echo "✗ Service is down"
  echo "Response: $RESPONSE"
  exit 1
fi
```

**Run every 30 seconds:**
```bash
# In crontab:
*/1 * * * * /path/to/healthcheck.sh >> /var/log/constellation-service.log
```

---

### MongoDB Health Check

```bash
#!/bin/bash
# check if MongoDB is accessible

MONGO_URI="${MONGO_URI:-mongodb://localhost:27017}"
mongosh "$MONGO_URI" --eval "db.adminCommand('ping')" > /dev/null 2>&1

if [ $? -eq 0 ]; then
  echo "✓ MongoDB is reachable"
  exit 0
else
  echo "✗ MongoDB is unreachable"
  exit 1
fi
```

---

### Logging & Alerting

```bash
# View service logs
npm run start 2>&1 | tee service.log

# Monitor for errors
npm run start 2>&1 | grep -i "error\|failed"

# Save logs to file with timestamp
npm run start > logs/service-$(date +%Y%m%d).log 2>&1 &

# View MongoDB operations
mongosh
> use google_drive_mirth
> db.currentOp()
```

---

## Performance Tuning

### MongoDB Indexes

```javascript
// Create indexes for better performance
db.file_queue.createIndex({ status: 1 })
db.file_queue.createIndex({ googleFileId: 1 }, { unique: true })
db.file_queue.createIndex({ patientId: 1 })
db.file_queue.createIndex({ createdAt: 1 })
db.file_queue.createIndex({ status: 1, createdAt: 1 })

// Check indexes
db.file_queue.getIndexes()

// Document types indexes
db.document_types.createIndex({ documentType: 1 })
db.document_types.createIndex({ loincCode: 1 })
```

### Connection Pooling

```javascript
// MongoDB automatically manages connection pooling
// Default: 10 connections in pool
// Max active connections: unlimited by default

// To tune, modify in code:
const client = new MongoClient(mongoUri, {
  maxPoolSize: 50,        // Max 50 connections
  minPoolSize: 10,        // Min 10 connections
  maxIdleTimeMS: 45000,   // Close idle connections after 45s
});
```

---

## Backup & Recovery

### MongoDB Backup

```bash
# Full database backup
mongodump --uri "mongodb://localhost:27017" --out ./backup/$(date +%Y%m%d)

# Restore from backup
mongorestore --uri "mongodb://localhost:27017" --dir ./backup/20260602

# Single collection export
mongoexport --uri "mongodb://localhost:27017/google_drive_mirth" \
  --collection file_queue \
  --out file_queue_export.json

# Single collection import
mongoimport --uri "mongodb://localhost:27017/google_drive_mirth" \
  --collection file_queue \
  --file file_queue_export.json
```

---

## Maintenance Tasks

### Weekly Cleanup

```bash
# Remove failed records older than 30 days
mongosh
> use google_drive_mirth
> db.file_queue.deleteMany({ 
    status: "failed", 
    createdAt: { $lt: new Date(Date.now() - 30*24*60*60*1000) }
  })

# Archive processed files older than 60 days
> db.file_queue.find({ 
    status: "processed", 
    processedAt: { $lt: new Date(Date.now() - 60*24*60*60*1000) }
  }).limit(100)
```

### Monthly Maintenance

```bash
# Rebuild indexes
mongosh
> use google_drive_mirth
> db.file_queue.reIndex()

# Check collection size
> db.file_queue.stats()

# Compact collection (if supported)
> db.runCommand({ compact: "file_queue" })
```

---

### Queue Depth Monitoring

```bash
#!/bin/bash
# save as: check-queue.sh

PENDING=$(curl -s http://localhost:3000/api/queue-status | jq -r '.pending')

echo "Pending files: $PENDING"

# Alert if too many pending
if [ $PENDING -gt 50 ]; then
  echo "WARNING: Queue depth is $PENDING (threshold: 50)"
  # Send alert: email, Slack, PagerDuty, etc.
fi
```

---

### Real-time Log Monitoring

```bash
# Watch logs in real-time
pm2 logs mirth-filer --lines 100

# Filter for errors only
pm2 logs mirth-filer | grep ERROR

# Filter for successful processing
pm2 logs mirth-filer | grep "Successfully processed"

# Count events per minute
pm2 logs mirth-filer | grep INFO | wc -l
```

---

### Database Audit Query Examples

```bash
sqlite3 file-queue.db

# Files processed today
SELECT COUNT(*) FROM file_queue 
WHERE DATE(processedAt) = DATE('now');

# Success rate
SELECT 
  status, 
  COUNT(*) as count,
  ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM file_queue), 2) as percent
FROM file_queue
GROUP BY status;

# Files taking longest to process
SELECT 
  fileName, 
  patientId,
  DATETIME(processedAt) - DATETIME(createdAt) as duration
FROM file_queue
WHERE status = 'processed'
ORDER BY duration DESC
LIMIT 10;

# Largest files processed
SELECT 
  fileName, 
  mimeType, 
  ROUND(LENGTH(base64) / 1024 / 1024, 2) as size_mb
FROM file_queue
WHERE status = 'processed'
ORDER BY size_mb DESC
LIMIT 10;

# Failed files with retry count
SELECT 
  fileName, 
  errorMessage, 
  attempts, 
  DATETIME(createdAt) as createdAt
FROM file_queue
WHERE status = 'failed'
ORDER BY createdAt DESC;

# Patient ID frequency
SELECT 
  patientId, 
  COUNT(*) as file_count
FROM file_queue
WHERE status = 'processed'
GROUP BY patientId
ORDER BY file_count DESC;
```

---

## Performance Metrics

### Key Metrics to Track

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| Files processed/hour | 60-100 | < 10 |
| Average processing time | 2-5 seconds | > 30 seconds |
| Mirth ACK success rate | > 99% | < 95% |
| Queue depth (pending) | 0-5 | > 50 |
| Database size | < 100MB | > 500MB |
| Service uptime | 99.9% | Any downtime |

### Calculate Processing Rate

```bash
# Files processed in last hour
sqlite3 file-queue.db \
  "SELECT COUNT(*) FROM file_queue 
   WHERE status = 'processed' 
   AND processedAt > datetime('now', '-1 hour');"
```

### Calculate Average Processing Time

```bash
sqlite3 file-queue.db \
  "SELECT AVG((julianday(processedAt) - julianday(createdAt)) * 24 * 60 * 60) as avg_seconds
   FROM file_queue 
   WHERE status = 'processed';"
```

---

## Maintenance Tasks

### Daily
- Check `/health` endpoint returns OK
- Monitor queue depth via `/api/queue-status`
- Scan logs for ERROR or WARN entries

### Weekly
- Check database size: `du -h file-queue.db`
- Verify no stuck files: `SELECT * FROM file_queue WHERE status='pending' AND createdAt < datetime('now', '-1 day');`
- Review failed files and error messages

### Monthly
- Backup database: `cp file-queue.db file-queue.db.backup.$(date +%Y%m%d)`
- Archive old records (optional): `DELETE FROM file_queue WHERE processedAt < datetime('now', '-90 days');`
- Update dependencies: `npm update`
- Review Mirth channel health

### Quarterly
- Load test with sample file volumes
- Review and optimize retry strategy
- Update credentials.json if needed

---

## Debugging Techniques

### Enable Maximum Debug Output

```bash
# In .env:
LOG_LEVEL=debug

# In code, add temporary logging:
// Before sending to Mirth:
logger.debug('Full payload:', JSON.stringify(payload));

// After Mirth response:
logger.debug('Mirth response:', response.data);
```

### Capture Network Traffic

```bash
# If Mirth is local, sniff HTTP:
tcpdump -i lo -A 'tcp port 8080' | grep -A 50 'POST /api/channels'

# Or use Mirth's own logging:
# In Mirth: Channels → Select Channel → Settings → "Log all connector data"
```

### Simulate File Processing

```bash
# Create a test file in Google Drive queue folder
# Or use curl to manually POST to Mirth:

curl -X POST http://localhost:8080/api/channels/receive \
  -H "Content-Type: application/json" \
  -d '{
    "fileName": "test-19507-test.pdf",
    "mimeType": "application/pdf",
    "patientId": "19507",
    "base64": "JVBERi0xLjQ...",
    "timestamp": "2024-01-15T10:00:00Z"
  }'
```

---

## Deployment Validation Checklist

Before going to production:

- [ ] Service health check passes: `curl http://localhost:3000/health`
- [ ] Queue status endpoint works: `curl http://localhost:3000/api/queue-status`
- [ ] Manual trigger works: `curl -X POST http://localhost:3000/api/process-next`
- [ ] Test file processes end-to-end without errors
- [ ] Mirth receives correct payload format
- [ ] Mirth returns HTTP 200 ACK
- [ ] Database audit trail records file status
- [ ] Service restarts cleanly: `systemctl restart mirth-file-processor`
- [ ] Logs are readable: `journalctl -u mirth-file-processor`
- [ ] Service starts on boot: `systemctl is-enabled mirth-file-processor` returns `enabled`

---

## Getting Help

### Collect These Logs Before Reporting Issues

```bash
# 1. Service logs (last 100 lines)
pm2 logs mirth-filer --lines 100 > service-logs.txt

# 2. Environment (without secrets)
cat .env | grep -v "private_key" > env-config.txt

# 3. Credentials structure (without private key)
cat credentials.json | jq 'del(.private_key)' > credentials-public.json

# 4. Dependencies
npm list > dependencies.txt

# 5. System info
node --version > system-info.txt
npm --version >> system-info.txt
uname -a >> system-info.txt

# 6. Database status
sqlite3 file-queue.db "SELECT status, COUNT(*) FROM file_queue GROUP BY status;" > db-status.txt

# 7. Recent errors (last 50)
pm2 logs mirth-filer 2>&1 | grep ERROR | tail -50 > recent-errors.txt
```

Share these files (with secrets redacted) when seeking support.

---

## Useful Commands Reference

```bash
# Service management
npm start                              # Start service
npm run dev                            # Start with debug logging
pm2 start google-drive-mirth-service.js
pm2 stop mirth-filer
pm2 restart mirth-filer
pm2 logs mirth-filer
pm2 delete mirth-filer

# Testing
curl http://localhost:3000/health
curl http://localhost:3000/api/queue-status
curl -X POST http://localhost:3000/api/process-next

# Database
sqlite3 file-queue.db
sqlite> .tables
sqlite> SELECT COUNT(*) FROM file_queue;
sqlite> .exit

# Logs
tail -f /var/log/syslog | grep mirth-filer
journalctl -u mirth-file-processor -f
journalctl -u mirth-file-processor --since "1 hour ago"

# Dependencies
npm list
npm update
npm audit

# File inspection
file credentials.json
cat .env
ls -lah file-queue.db
du -h file-queue.db
```

---

**Last Updated**: 2024-01-15  
**Service Version**: 1.0.0
