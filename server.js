const http = require('http');
const https = require('https');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const url = require('url');

const UPSTREAM_PORT = 5001;
const LISTEN_PORT = process.env.PORT || 5000;
const MEDIA_DIR = process.env.MEDIA_DIR || '/app/data/media';
const FIXED_MASTER_KEY = 'g2a_af54abb0686c_Kfiu6zVhO-mHm26HBIkWgAeVrkirNFhp';

let currentActiveKey = FIXED_MASTER_KEY;
let isBootstrapped = false;
let bootstrapPromise = null;

// Start grok2api upstream
console.log('[Proxy] Starting grok2api upstream on port ' + UPSTREAM_PORT + '...');
const grokProcess = spawn('/app/grok2api', ['--config', '/app/config.yaml', '--listen', `0.0.0.0:${UPSTREAM_PORT}`], {
  stdio: 'inherit'
});

grokProcess.on('exit', (code, sig) => {
  console.error(`[Proxy] grok2api exited with code ${code}, signal ${sig}`);
  process.exit(code || 1);
});

async function ensureBootstrapped() {
  if (isBootstrapped) return currentActiveKey;
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    console.log('[Bootstrap] Checking upstream and credentials...');
    // Wait for upstream to be healthy
    for (let i = 0; i < 30; i++) {
      try {
        const hRes = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/healthz`);
        if (hRes.ok) break;
      } catch (e) {}
      await new Promise(r => setTimeout(r, 1000));
    }

    try {
      // Login as admin
      const loginRes = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/api/admin/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'AdminSuperGrok2026!' })
      });
      const loginData = await loginRes.json();
      const adminToken = loginData.data?.tokens?.accessToken;
      if (!adminToken) throw new Error('Failed to obtain admin token');

      // 1. Check Accounts (Import SSO if 0)
      const accRes = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/api/admin/v1/accounts`, {
        headers: { 'Authorization': 'Bearer ' + adminToken }
      });
      const accData = await accRes.json();
      const sso = process.env.SSO_TOKEN;
      if (accData.data?.total === 0 && sso) {
        console.log('[Bootstrap] Importing SSO token...');
        const formData = new FormData();
        formData.append('file', new Blob([sso], { type: 'text/plain' }), 'sso.txt');
        await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/api/admin/v1/accounts/web/import`, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + adminToken },
          body: formData
        });
        console.log('[Bootstrap] SSO account imported.');
      }

      // 2. Ensure active client key exists
      const kRes = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/api/admin/v1/client-keys`, {
        headers: { 'Authorization': 'Bearer ' + adminToken }
      });
      const kData = await kRes.json();
      
      // Always create a fresh known client key on container boot if none or store it
      if (kData.data?.total === 0) {
        console.log('[Bootstrap] Generating new client key...');
        const newKey = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/api/admin/v1/client-keys`, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + adminToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'n8n-youtube-autoposter' })
        });
        const newKeyData = await newKey.json();
        if (newKeyData.data?.secret) {
          currentActiveKey = newKeyData.data.secret;
          console.log('[Bootstrap] Active client key set to:', currentActiveKey);
        }
      } else {
        console.log('[Bootstrap] Found existing client keys:', kData.data.total);
      }

      isBootstrapped = true;
      return currentActiveKey;
    } catch (err) {
      console.error('[Bootstrap] Initialization error:', err.message);
      return currentActiveKey;
    } finally {
      bootstrapPromise = null;
    }
  })();

  return bootstrapPromise;
}

// Trigger initial bootstrap in background
setTimeout(ensureBootstrapped, 2000);

// Helper to download a video URL
async function downloadToFile(fileUrl, destPath) {
  return new Promise((resolve, reject) => {
    let target = fileUrl.replace(/https?:\/\/supergrok-api\.onrender\.com/i, `http://127.0.0.1:${UPSTREAM_PORT}`);
    const parsed = new URL(target);

    if (parsed.pathname.startsWith('/v1/media/videos/')) {
      const assetName = path.basename(parsed.pathname);
      const localCandidate = path.join(MEDIA_DIR, 'videos', assetName);
      if (fs.existsSync(localCandidate)) {
        fs.copyFileSync(localCandidate, destPath);
        return resolve(destPath);
      }
    }

    const isHttps = parsed.protocol === 'https:';
    const getter = isHttps ? https.get : http.get;
    const reqOptions = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    };

    getter(target, reqOptions, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadToFile(res.headers.location, destPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download ${fileUrl}: status ${res.statusCode}`));
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve(destPath));
      });
    }).on('error', reject);
  });
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);

  // Health check endpoint
  if (parsedUrl.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, bootstrapped: isBootstrapped }));
  }

  // Custom Endpoint: POST /v1/videos/stitch
  if (req.method === 'POST' && (parsedUrl.pathname === '/v1/videos/stitch' || parsedUrl.pathname === '/api/stitch')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const videos = payload.videos || payload.urls;
        if (!Array.isArray(videos) || videos.length < 2) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Expected at least 2 video URLs in "videos" array' }));
        }

        const runId = Date.now() + '_' + Math.random().toString(36).substring(2, 7);
        const tmpDir = path.join('/tmp', 'stitch_' + runId);
        fs.mkdirSync(tmpDir, { recursive: true });

        console.log(`[Stitcher] Downloading ${videos.length} videos...`);
        const downloadedFiles = [];
        for (let i = 0; i < videos.length; i++) {
          const dest = path.join(tmpDir, `clip_${i}.mp4`);
          await downloadToFile(videos[i], dest);
          downloadedFiles.push(dest);
        }

        const listFile = path.join(tmpDir, 'concat_list.txt');
        const listContent = downloadedFiles.map(f => `file '${f}'`).join('\n');
        fs.writeFileSync(listFile, listContent);

        const assetId = 'vid_stitched_' + runId;
        const outDir = path.join(MEDIA_DIR, 'videos');
        fs.mkdirSync(outDir, { recursive: true });
        const outFile = path.join(outDir, assetId);

        console.log(`[Stitcher] Running FFmpeg concat to ${outFile}...`);
        try {
          execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy -movflags +faststart "${outFile}"`, { stdio: 'pipe' });
        } catch (copyErr) {
          console.warn('[Stitcher] Fast copy failed, using re-encode filter...', copyErr.message);
          execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -preset veryfast -crf 22 -c:a aac -movflags +faststart "${outFile}"`, { stdio: 'pipe' });
        }

        fs.rmSync(tmpDir, { recursive: true, force: true });

        const host = req.headers.host || 'supergrok-api.onrender.com';
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const publicUrl = `${proto}://${host}/v1/media/videos/${assetId}`;

        console.log(`[Stitcher] Successfully stitched 30s video: ${publicUrl}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          asset_id: assetId,
          duration: 30,
          url: publicUrl
        }));
      } catch (err) {
        console.error('[Stitcher] Error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Ensure bootstrap is complete before routing API requests
  if (!isBootstrapped && parsedUrl.pathname.startsWith('/v1/')) {
    await ensureBootstrapped();
  }

  // Clone headers for upstream
  const upstreamHeaders = { ...req.headers };

  // SMART AUTH MAPPING: If incoming request has our master key or any g2a_ key, map to current active key!
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    const incomingToken = authHeader.substring(7).trim();
    if (incomingToken === FIXED_MASTER_KEY || incomingToken.startsWith('g2a_')) {
      if (currentActiveKey) {
        upstreamHeaders['authorization'] = `Bearer ${currentActiveKey}`;
      }
    }
  }

  // Reverse Proxy to grok2api (127.0.0.1:5001)
  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: UPSTREAM_PORT,
    path: req.url,
    method: req.method,
    headers: upstreamHeaders
  }, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', err => {
    console.error('[Proxy] Upstream error:', err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'grok2api upstream unreachable' }));
  });

  req.pipe(proxyReq);
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`[Proxy] Server listening on port ${LISTEN_PORT}, forwarding to 127.0.0.1:${UPSTREAM_PORT}`);
});
