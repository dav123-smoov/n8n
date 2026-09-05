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

// In-memory registry for 30s composite video jobs
const jobs30 = {};

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
    for (let i = 0; i < 30; i++) {
      try {
        const hRes = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/healthz`);
        if (hRes.ok) break;
      } catch (e) {}
      await new Promise(r => setTimeout(r, 1000));
    }

    try {
      const loginRes = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/api/admin/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'AdminSuperGrok2026!' })
      });
      const loginData = await loginRes.json();
      const adminToken = loginData.data?.tokens?.accessToken;
      if (!adminToken) throw new Error('Failed to obtain admin token');

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

      const kRes = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/api/admin/v1/client-keys`, {
        headers: { 'Authorization': 'Bearer ' + adminToken }
      });
      const kData = await kRes.json();
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

setTimeout(ensureBootstrapped, 2000);

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
    getter(target, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadToFile(res.headers.location, destPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download ${fileUrl}: status ${res.statusCode}`));
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(destPath)));
    }).on('error', reject);
  });
}

// Background handler to generate 2 clips and stitch into 30s
async function process30sJob(jobId, prompt1, prompt2, aspectRatio, host, proto) {
  try {
    console.log(`[30s Orchestrator] Starting 30s generation for ${jobId}...`);
    jobs30[jobId].progress = 10;

    // Helper to submit a 15s clip to local grok2api
    async function submitClip(promptText) {
      const res = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/v1/videos/generations`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${currentActiveKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'grok-imagine-video',
          prompt: promptText,
          duration: 15,
          aspect_ratio: aspectRatio || '9:16'
        })
      });
      const data = await res.json();
      const reqId = data.request_id || data.id;
      if (!reqId) throw new Error('Failed to submit clip: ' + JSON.stringify(data));
      return reqId;
    }

    // Helper to wait for a clip to complete
    async function pollClip(reqId) {
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 4000));
        const res = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/v1/videos/${reqId}`, {
          headers: { 'Authorization': `Bearer ${currentActiveKey}` }
        });
        const data = await res.json();
        if (data.status === 'done' || data.status === 'completed') {
          return data.asset_url || `${proto}://${host}/v1/media/videos/${data.asset_id || data.video_id}`;
        }
        if (data.status === 'failed' || data.status === 'error') {
          throw new Error('Clip rendering failed: ' + (data.error_message || data.errorMessage));
        }
      }
      throw new Error('Clip rendering timed out');
    }

    console.log(`[30s Orchestrator] Submitting Clip 1 and Clip 2 in parallel...`);
    const id1 = await submitClip(prompt1);
    // Slight pause to ensure distinct task IDs
    await new Promise(r => setTimeout(r, 1000));
    const id2 = await submitClip(prompt2);

    jobs30[jobId].progress = 25;
    console.log(`[30s Orchestrator] Polling clips ${id1} and ${id2}...`);

    // Poll both clips concurrently
    const [clip1Url, clip2Url] = await Promise.all([pollClip(id1), pollClip(id2)]);
    console.log(`[30s Orchestrator] Both clips ready! Clip1: ${clip1Url}, Clip2: ${clip2Url}`);
    jobs30[jobId].progress = 85;

    // Stitch via local FFmpeg
    const tmpDir = path.join('/tmp', 'stitch_' + jobId);
    fs.mkdirSync(tmpDir, { recursive: true });
    const f1 = path.join(tmpDir, 'clip_0.mp4');
    const f2 = path.join(tmpDir, 'clip_1.mp4');
    await downloadToFile(clip1Url, f1);
    await downloadToFile(clip2Url, f2);

    const listFile = path.join(tmpDir, 'list.txt');
    fs.writeFileSync(listFile, `file '${f1}'\nfile '${f2}'`);

    const assetId = 'vid_stitched_' + jobId;
    const outDir = path.join(MEDIA_DIR, 'videos');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, assetId);

    console.log(`[30s Orchestrator] Concatenating 30s Short to ${outFile}...`);
    try {
      execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy -movflags +faststart "${outFile}"`, { stdio: 'pipe' });
    } catch (e) {
      execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -preset veryfast -crf 22 -c:a aac -movflags +faststart "${outFile}"`, { stdio: 'pipe' });
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
    const finalUrl = `${proto}://${host}/v1/media/videos/${assetId}`;

    jobs30[jobId] = {
      status: 'completed',
      progress: 100,
      duration: 30,
      asset_id: assetId,
      video_id: assetId,
      url: finalUrl,
      asset_url: finalUrl
    };
    console.log(`[30s Orchestrator] Job ${jobId} finished successfully! 30s Video: ${finalUrl}`);
  } catch (err) {
    console.error(`[30s Orchestrator] Error on job ${jobId}:`, err);
    jobs30[jobId] = {
      status: 'failed',
      progress: 0,
      error_message: err.message
    };
  }
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const host = req.headers.host || 'supergrok-api.onrender.com';
  const proto = req.headers['x-forwarded-proto'] || 'https';

  if (parsedUrl.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, bootstrapped: isBootstrapped }));
  }

  // Intercept GET /v1/videos/:requestId for 30s composite jobs
  if (req.method === 'GET' && parsedUrl.pathname.startsWith('/v1/videos/video_30s_')) {
    const jobId = path.basename(parsedUrl.pathname);
    const job = jobs30[jobId];
    if (job) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(job));
    }
  }

  // Intercept POST /v1/videos/generations when duration == 30 or prompt_clip1/2 provided
  if (req.method === 'POST' && parsedUrl.pathname === '/v1/videos/generations') {
    let bodyText = '';
    req.on('data', chunk => bodyText += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(bodyText);
        const duration = Number(payload.duration) || 15;
        const hasTwoPrompts = Boolean(payload.prompt_clip1 && payload.prompt_clip2);

        if (duration === 30 || hasTwoPrompts) {
          await ensureBootstrapped();
          const jobId = 'video_30s_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
          
          let p1 = payload.prompt_clip1 || payload.prompt;
          let p2 = payload.prompt_clip2 || (payload.prompt + ' (Part 2: Continuing camera move directly into climax)');

          jobs30[jobId] = {
            id: jobId,
            request_id: jobId,
            status: 'processing',
            progress: 5
          };

          // Trigger 30s pipeline in background
          process30sJob(jobId, p1, p2, payload.aspect_ratio, host, proto);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            id: jobId,
            request_id: jobId,
            status: 'processing'
          }));
        }

        // Standard 15s generation pass-through
        proxyPass(req, res, bodyText);
      } catch (err) {
        proxyPass(req, res, bodyText);
      }
    });
    return;
  }

  // Manual stitch endpoint
  if (req.method === 'POST' && (parsedUrl.pathname === '/v1/videos/stitch' || parsedUrl.pathname === '/api/stitch')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const videos = payload.videos || payload.urls;
        if (!Array.isArray(videos) || videos.length < 2) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Expected at least 2 video URLs' }));
        }

        const runId = Date.now() + '_' + Math.random().toString(36).substring(2, 7);
        const tmpDir = path.join('/tmp', 'stitch_' + runId);
        fs.mkdirSync(tmpDir, { recursive: true });

        const downloadedFiles = [];
        for (let i = 0; i < videos.length; i++) {
          const dest = path.join(tmpDir, `clip_${i}.mp4`);
          await downloadToFile(videos[i], dest);
          downloadedFiles.push(dest);
        }

        const listFile = path.join(tmpDir, 'concat_list.txt');
        fs.writeFileSync(listFile, downloadedFiles.map(f => `file '${f}'`).join('\n'));

        const assetId = 'vid_stitched_' + runId;
        const outDir = path.join(MEDIA_DIR, 'videos');
        fs.mkdirSync(outDir, { recursive: true });
        const outFile = path.join(outDir, assetId);

        try {
          execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy -movflags +faststart "${outFile}"`, { stdio: 'pipe' });
        } catch (e) {
          execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -preset veryfast -crf 22 -c:a aac -movflags +faststart "${outFile}"`, { stdio: 'pipe' });
        }

        fs.rmSync(tmpDir, { recursive: true, force: true });
        const publicUrl = `${proto}://${host}/v1/media/videos/${assetId}`;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          asset_id: assetId,
          duration: 30,
          url: publicUrl
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Standard Reverse Proxy Pass-through
  proxyPass(req, res);
});

function proxyPass(req, res, customBody) {
  if (!isBootstrapped && req.url.startsWith('/v1/')) {
    ensureBootstrapped().then(() => doProxy(req, res, customBody));
  } else {
    doProxy(req, res, customBody);
  }
}

function doProxy(req, res, customBody) {
  const upstreamHeaders = { ...req.headers };
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    const incomingToken = authHeader.substring(7).trim();
    if (incomingToken === FIXED_MASTER_KEY || incomingToken.startsWith('g2a_')) {
      if (currentActiveKey) {
        upstreamHeaders['authorization'] = `Bearer ${currentActiveKey}`;
      }
    }
  }

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

  if (customBody) {
    proxyReq.write(customBody);
    proxyReq.end();
  } else {
    req.pipe(proxyReq);
  }
}

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`[Proxy] Server listening on port ${LISTEN_PORT}, forwarding to 127.0.0.1:${UPSTREAM_PORT}`);
});
