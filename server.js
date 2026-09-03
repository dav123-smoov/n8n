const http = require('http');
const https = require('https');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const url = require('url');

const UPSTREAM_PORT = 5001;
const LISTEN_PORT = process.env.PORT || 5000;
const MEDIA_DIR = process.env.MEDIA_DIR || '/app/data/media';

// Start grok2api upstream process
console.log('[Proxy] Starting grok2api upstream on port ' + UPSTREAM_PORT + '...');
const grokProcess = spawn('/app/grok2api', ['--config', '/app/config.yaml', '--listen', `0.0.0.0:${UPSTREAM_PORT}`], {
  stdio: 'inherit'
});

grokProcess.on('exit', (code, sig) => {
  console.error(`[Proxy] grok2api exited with code ${code}, signal ${sig}`);
  process.exit(code || 1);
});

// Auto-bootstrap check after grok2api boots
setTimeout(async () => {
  try {
    const sso = process.env.SSO_TOKEN;
    if (!sso) return;

    // Check health
    const hRes = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/healthz`).catch(() => null);
    if (!hRes || !hRes.ok) return;

    // Login as admin
    const loginRes = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/api/admin/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'AdminSuperGrok2026!' })
    });
    const loginData = await loginRes.json();
    const token = loginData.data?.tokens?.accessToken;
    if (!token) return;

    // Check accounts
    const accRes = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/api/admin/v1/accounts`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const accData = await accRes.json();
    if (accData.data?.total === 0) {
      console.log('[Bootstrap] Auto-importing SSO token...');
      const formData = new FormData();
      formData.append('file', new Blob([sso], { type: 'text/plain' }), 'sso.txt');
      await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/api/admin/v1/accounts/web/import`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
        body: formData
      });
      console.log('[Bootstrap] SSO account imported.');
    }

    // Check client keys
    const kRes = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/api/admin/v1/client-keys`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const kData = await kRes.json();
    if (kData.data?.total === 0) {
      console.log('[Bootstrap] Auto-creating client key...');
      const newKey = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/api/admin/v1/client-keys`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'n8n-youtube-autoposter' })
      });
      const newKeyData = await newKey.json();
      console.log('[Bootstrap] Created client key:', newKeyData.data?.secret);
    }
  } catch (err) {
    console.error('[Bootstrap] Error:', err.message);
  }
}, 5000);

// Helper to download a video URL to local tmp file
async function downloadToFile(fileUrl, destPath) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(fileUrl);
    // If it's localhost or direct asset, resolve local path if possible
    if (parsed.pathname.startsWith('/v1/media/videos/')) {
      const assetName = path.basename(parsed.pathname);
      const localCandidate = path.join(MEDIA_DIR, 'videos', assetName);
      if (fs.existsSync(localCandidate)) {
        fs.copyFileSync(localCandidate, destPath);
        return resolve(destPath);
      }
    }

    const getter = parsed.protocol === 'https:' ? https.get : http.get;
    getter(fileUrl, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadToFile(res.headers.location, destPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download ${fileUrl}: ${res.statusCode}`));
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
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

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

        // Create concat list file
        const listFile = path.join(tmpDir, 'concat_list.txt');
        const listContent = downloadedFiles.map(f => `file '${f}'`).join('\n');
        fs.writeFileSync(listFile, listContent);

        // Target output inside grok2api media directory so it is instantly servable!
        const assetId = 'vid_stitched_' + runId;
        const outDir = path.join(MEDIA_DIR, 'videos');
        fs.mkdirSync(outDir, { recursive: true });
        const outFile = path.join(outDir, assetId);

        console.log(`[Stitcher] Running FFmpeg concat to ${outFile}...`);
        // Use fast demuxer concat (stream copy, no quality loss, <1s)
        try {
          execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy -movflags +faststart "${outFile}"`, { stdio: 'pipe' });
        } catch (copyErr) {
          console.warn('[Stitcher] Fast stream copy failed, falling back to re-encode filter...', copyErr.message);
          execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -preset veryfast -crf 22 -c:a aac -movflags +faststart "${outFile}"`, { stdio: 'pipe' });
        }

        // Cleanup tmp files
        fs.rmSync(tmpDir, { recursive: true, force: true });

        const host = req.headers.host || 'supergrok-api.onrender.com';
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const publicUrl = `${proto}://${host}/v1/media/videos/${assetId}`;

        console.log(`[Stitcher] Success! Output: ${publicUrl}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          asset_id: assetId,
          duration: 30,
          url: publicUrl
        }));
      } catch (err) {
        console.error('[Stitcher] Error stitching videos:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Transparent Reverse Proxy to grok2api (127.0.0.1:5001)
  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port: UPSTREAM_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers
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
