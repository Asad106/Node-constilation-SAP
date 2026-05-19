# Operational Guide: Google Drive → Mirth Service

---

## Quick Start Checklist

- [ ] Node.js 16+ installed
- [ ] `npm install` completed
- [ ] `credentials.json` in project root (from Google Cloud)
- [ ] `.env` configured with:
  - [ ] `QUEUE_FOLDER_ID` (correct 25+ character string)
  - [ ] `MIRTH_BASE_URL` (accessible URL)
  - [ ] `MIRTH_ENDPOINT` (channel endpoint path)
- [ ] Test file in Google Drive queue folder
- [ ] Mirth channel running and returning HTTP 200
- [ ] `npm run dev` starts without errors
- [ ] `curl http://localhost:3000/health` returns OK

---

## Common Issues & Solutions

### Issue 1: "Cannot read property 'file' of undefined"

**Error in logs:**
```
[ERROR] Failed to initialize Google Drive client
```

**Cause**: `credentials.json` is missing or has wrong path.

**Fix:**
```bash
# 1. Verify file exists
ls -la credentials.json

# 2. Verify it's valid JSON
cat credentials.json | jq .

# 3. Verify path in .env
cat .env | grep GOOGLE_KEY_FILE
# Should output: GOOGLE_KEY_FILE=./credentials.json

# 4. If relative path doesn't work, use absolute:
# .env:
GOOGLE_KEY_FILE=/opt/mirth-file-processor/credentials.json
```

---

### Issue 2: "Error: Invalid Credentials"

**Error in logs:**
```
[ERROR] Failed to initialize Google Drive client
Error: Invalid value for: config.credentials
```

**Causes:**
1. Service account doesn't have Drive API access
2. Service account email not granted access to queue folder
3. Credentials are invalid or corrupted

**Fix:**

```bash
# Step 1: Verify credentials structure
cat credentials.json | jq 'keys'
# Should have: "type", "project_id", "private_key_id", "private_key", 
# "client_email", "client_id", "auth_uri", "token_uri", etc.

# Step 2: Get service account email
SERVICE_EMAIL=$(cat credentials.json | jq -r '.client_email')
echo "Service account: $SERVICE_EMAIL"

# Step 3: Manually verify API is enabled
# Go to Google Cloud Console:
# APIs & Services → Enabled APIs & Services → Search "Google Drive API"
# Should see "Google Drive API" in the list with "Enable" button grayed out

# Step 4: Share queue folder in Google Drive with service account
# 1. Open Google Drive
# 2. Right-click queue folder → Share
# 3. Paste service account email
# 4. Grant "Editor" access
# 5. Uncheck "Notify people"
# 6. Share
```

---

### Issue 3: "No Files Being Processed"

**Symptoms:**
- Service is running
- No errors in logs
- But files aren't being picked up

**Debugging steps:**

```bash
# Step 1: Check polling is active
npm run dev 2>&1 | grep -i "polling started"

# Step 2: Check queue folder ID is correct
cat .env | grep QUEUE_FOLDER_ID

# Step 3: Verify folder exists and has files
# In Google Drive:
# 1. Open the folder
# 2. Copy folder ID from URL: https://drive.google.com/drive/folders/[ID]
# 3. Compare with .env QUEUE_FOLDER_ID

# Step 4: Add a test file and manually trigger
curl -X POST http://localhost:3000/api/process-next

# Step 5: Watch logs
npm run dev
# Should see: "[INFO] Processing file from queue: [filename]"

# Step 6: If still nothing, enable debug logging
LOG_LEVEL=debug npm run dev
# Should see detailed Google Drive API calls
```

---

### Issue 4: "Connection Refused" to Mirth

**Error in logs:**
```
[WARN] Mirth send failed (attempt 1/3)
Error: connect ECONNREFUSED 127.0.0.1:8080
```

**Cause**: Mirth is not running or endpoint is wrong.

**Fix:**

```bash
# Step 1: Test Mirth connectivity
curl -v http://localhost:8080/api/status

# If that fails:
# - Mirth is not running
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
# 3. Check destination script for issues

# Step 3: Add logging to Mirth destination
// In Mirth destination Processor:
logger.info('Received file: ' + msg['fileName']);
logger.info('Payload size: ' + msg['base64'].length);
var result = db.executeCachedQuery('SELECT 1');
logger.info('Database check passed');
// Process the file...

# Step 4: Increase retry attempts
# In .env:
MIRTH_RETRIES=5        # 3 → 5 retries

# Step 5: Check network latency
# From service machine to Mirth server:
ping mirth-server.company.com
# Should be < 50ms
```

---

### Issue 6: "Database is locked" Error

**Error in logs:**
```
[ERROR] Failed to update file status
Error: database is locked
```

**Cause**: Multiple processes trying to write to SQLite simultaneously.

**Fix:**

```bash
# Step 1: Ensure only 1 instance is running
pm2 list
# Should show 1 instance of mirth-filer

# Step 2: Close any other SQLite connections
# Check if you're running sqlite3 CLI on the DB:
ps aux | grep sqlite3

# Step 3: Increase SQLite timeout (in code)
// In FileQueue.updateFileStatus():
this.db.configure("busyTimeout", 5000); // 5 second timeout

# Step 4: Use WAL mode for better concurrency
// In FileQueue.init():
this.db.run("PRAGMA journal_mode=WAL");

# Step 5: If persistent, disable database
# In .env:
DB_ENABLED=false
# Service will skip database operations entirely
```

---

### Issue 7: "File already processed" Error

**Symptoms**: File is reprocessed multiple times (duplicates in Mirth).

**Cause**: Service crashed before updating database status, or duplicate file in folder.

**Fix:**

```bash
# Step 1: Check database status of problematic file
sqlite3 file-queue.db
sqlite> SELECT * FROM file_queue WHERE fileName = 'test.pdf';
# Check the status column

# Step 2: If status is 'pending', but file was processed:
# Update manually:
sqlite> UPDATE file_queue 
        SET status = 'processed', mirthAckReceived = 1 
        WHERE googleFileId = 'abc123';

# Step 3: Prevent in future by moving processed files
# In .env, set:
PROCESSED_FOLDER_ID=your_processed_folder_id
# Service will move files after successful processing

# Step 4: If files keep coming back:
# Check if someone is moving them back to queue folder
# Or if there's a scheduled task that's duplicating them
```

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
*/1 * * * * /opt/mirth-file-processor/healthcheck.sh >> /var/log/mirth-health.log
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
