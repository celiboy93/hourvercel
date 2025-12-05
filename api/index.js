import { AwsClient } from 'aws4fetch';

// Node.js Runtime (Size ပေါ်အောင်)
export default async function handler(req, res) {
  try {
    const envData = process.env.ACCOUNTS_JSON;
    if (!envData) return res.status(500).send("Config Error");
    
    const R2_ACCOUNTS = JSON.parse(envData);
    
    // ---------------------------------------------------------
    // 🔍 URL Parsing Logic (Hybrid: Path & Query)
    // ---------------------------------------------------------
    // Query Params ယူမယ်
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    const fullUrl = new URL(req.url, `${protocol}://${host}`);
    
    let video = fullUrl.searchParams.get('video');
    let acc = fullUrl.searchParams.get('acc');

    // Query မှာ မပါရင် Path (Clean URL) ကနေ ယူမယ်
    // URL Structure: /api/<acc>/<video_path>
    if (!video || !acc) {
        const pathParts = fullUrl.pathname.replace('/api/', '').split('/');
        // အနည်းဆုံး acc နဲ့ filename ပါရမယ်
        if (pathParts.length >= 2) {
            acc = pathParts[0]; // ပထမဆုံးအကွက်က Account နံပါတ်
            // ကျန်တာအကုန်ပြန်ပေါင်းမယ် (Filename/Folder)
            video = decodeURIComponent(pathParts.slice(1).join('/'));
        }
    }

    // Ping check
    if (video === "ping") return res.status(200).send("Pong!");

    // Validation
    if (!video || !acc || !R2_ACCOUNTS[acc]) {
      return res.status(400).send("Invalid Parameters. Use format: /api/1/folder/video.m3u8");
    }

    const creds = R2_ACCOUNTS[acc];
    const r2 = new AwsClient({
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      service: 's3',
      region: 'auto',
    });

    const endpoint = `https://${creds.accountId}.r2.cloudflarestorage.com`;
    
    // =========================================================
    // 🎥 PART 1: M3U8 HANDLING (VPN Bypass & Rewrite)
    // =========================================================
    if (video.endsWith(".m3u8")) {
        const encodedPath = video.split('/').map(encodeURIComponent).join('/');
        const m3u8Url = new URL(`${endpoint}/${creds.bucketName}/${encodedPath}`);
        
        // Master File ကို Sign လုပ်ခြင်း
        const signedM3u8 = await r2.sign(m3u8Url, {
            method: "GET",
            aws: { signQuery: true },
            headers: { "Host": `${creds.accountId}.r2.cloudflarestorage.com` },
            expiresIn: 3600
        });

        const response = await fetch(signedM3u8.url);
        if (!response.ok) return res.status(404).send("M3U8 Not Found");
        
        const originalText = await response.text();
        
        // Base Directory ရှာခြင်း
        const lastSlashIndex = video.lastIndexOf("/");
        const baseDir = lastSlashIndex !== -1 ? video.substring(0, lastSlashIndex + 1) : "";

        // Rewrite Lines (.ts files to Signed URLs)
        const lines = originalText.split("\n");
        const newLines = await Promise.all(lines.map(async (line) => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith("#") && (trimmed.endsWith(".ts") || trimmed.endsWith(".m4s") || trimmed.endsWith(".mp4"))) {
                let fullPath = trimmed;
                if (!trimmed.startsWith("http")) {
                    fullPath = baseDir + trimmed;
                }
                
                const encodedFullPath = fullPath.split('/').map(encodeURIComponent).join('/');
                const tsUrl = new URL(`${endpoint}/${creds.bucketName}/${encodedFullPath}`);
                
                const signedTs = await r2.sign(tsUrl, {
                    method: "GET",
                    aws: { signQuery: true },
                    headers: { "Host": `${creds.accountId}.r2.cloudflarestorage.com` },
                    expiresIn: 14400 // 4 Hours
                });
                return signedTs.url;
            }
            return line;
        }));

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); // APK အတွက် အရေးကြီး
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(200).send(newLines.join("\n"));
    }

    // =========================================================
    // 📦 PART 2: MP4 HANDLING (Size Fix)
    // =========================================================
    const cleanFileName = video.split('/').pop();
    const encodedFileName = encodeURIComponent(cleanFileName);
    const contentDisposition = `attachment; filename="${cleanFileName}"; filename*=UTF-8''${encodedFileName}`;
    
    const encodedPath = video.split('/').map(encodeURIComponent).join('/');
    const objectUrl = new URL(`${endpoint}/${creds.bucketName}/${encodedPath}`);
    
    objectUrl.searchParams.set("response-content-disposition", contentDisposition);
    
    const signed = await r2.sign(objectUrl, {
      method: req.method,
      aws: { signQuery: true },
      headers: { "Host": `${creds.accountId}.r2.cloudflarestorage.com` },
      expiresIn: 14400
    });

    if (req.method === "HEAD") {
      const r2Response = await fetch(signed.url, { method: "HEAD" });
      
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Type, Content-Disposition, Accept-Ranges, ETag");

      if (r2Response.headers.has("content-length")) {
        res.setHeader("Content-Length", r2Response.headers.get("content-length"));
      }
      res.setHeader("Content-Type", r2Response.headers.get("content-type") || "video/mp4");
      res.setHeader("Content-Disposition", contentDisposition);
      res.setHeader("Accept-Ranges", "bytes");
      
      return res.status(200).end();
    }

    return res.redirect(302, signed.url);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
