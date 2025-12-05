import { AwsClient } from 'aws4fetch';

// runtime: 'edge' မထည့်ပါ (Node.js နဲ့ Run မှ APK Header မြင်ရလို့ပါ)
export default async function handler(req, res) {
  try {
    const envData = process.env.ACCOUNTS_JSON;
    if (!envData) return res.status(500).send("Config Error");
    
    const R2_ACCOUNTS = JSON.parse(envData);
    
    // URL Parsing (Node.js Style)
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    const fullUrl = new URL(req.url, `${protocol}://${host}`);
    
    const video = fullUrl.searchParams.get('video');
    const acc = fullUrl.searchParams.get('acc') || "1";

    if (video === "ping") return res.status(200).send("Pong!");

    if (!video || !R2_ACCOUNTS[acc]) {
      return res.status(400).send("Invalid Parameters");
    }

    const creds = R2_ACCOUNTS[acc];
    const r2 = new AwsClient({
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      service: 's3',
      region: 'auto',
    });

    const endpoint = `https://${creds.accountId}.r2.cloudflarestorage.com`;
    const objectPath = decodeURIComponent(video);
    
    // =========================================================
    // 🎥 PART 1: M3U8 HANDLING (Dynamic Rewriter)
    // =========================================================
    if (objectPath.endsWith(".m3u8")) {
        const encodedPath = objectPath.split('/').map(encodeURIComponent).join('/');
        const m3u8Url = new URL(`${endpoint}/${creds.bucketName}/${encodedPath}`);
        
        // Master File ကို Sign လုပ်ခြင်း
        const signedM3u8 = await r2.sign(m3u8Url, {
            method: "GET",
            aws: { signQuery: true },
            headers: { "Host": `${creds.accountId}.r2.cloudflarestorage.com` },
            expiresIn: 3600
        });

        // R2 ဆီက M3U8 စာသားကို လှမ်းယူခြင်း
        const response = await fetch(signedM3u8.url);
        if (!response.ok) return res.status(404).send("M3U8 Not Found");
        
        const originalText = await response.text();
        
        // Base Directory ရှာခြင်း
        const lastSlashIndex = objectPath.lastIndexOf("/");
        const baseDir = lastSlashIndex !== -1 ? objectPath.substring(0, lastSlashIndex + 1) : "";

        // လိုင်းတစ်ကြောင်းစီကို လိုက်စစ်ပြီး .ts တွေ့ရင် Sign လုပ်ခြင်း
        const lines = originalText.split("\n");
        const newLines = await Promise.all(lines.map(async (line) => {
            const trimmed = line.trim();
            
            // .ts သို့မဟုတ် .mp4 နဲ့ဆုံးတဲ့လိုင်းဆိုရင်
            if (trimmed && !trimmed.startsWith("#") && (trimmed.endsWith(".ts") || trimmed.endsWith(".m4s") || trimmed.endsWith(".mp4"))) {
                let fullPath = trimmed;
                if (!trimmed.startsWith("http")) {
                    fullPath = baseDir + trimmed;
                }
                
                const encodedFullPath = fullPath.split('/').map(encodeURIComponent).join('/');
                const tsUrl = new URL(`${endpoint}/${creds.bucketName}/${encodedFullPath}`);
                
                // Segment တစ်ခုချင်းစီကို 4 နာရီသက်တမ်းနဲ့ Sign လုပ်ခြင်း
                const signedTs = await r2.sign(tsUrl, {
                    method: "GET",
                    aws: { signQuery: true },
                    headers: { "Host": `${creds.accountId}.r2.cloudflarestorage.com` },
                    expiresIn: 14400 
                });
                
                return signedTs.url;
            }
            return line;
        }));

        // ပြင်ပြီးသား M3U8 ကို ပြန်ပို့ခြင်း
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(200).send(newLines.join("\n"));
    }

    // =========================================================
    // 📦 PART 2: MP4 HANDLING (File Size Fix & Redirect)
    // =========================================================
    const cleanFileName = objectPath.split('/').pop();
    const encodedFileName = encodeURIComponent(cleanFileName);
    const contentDisposition = `attachment; filename="${cleanFileName}"; filename*=UTF-8''${encodedFileName}`;
    
    const encodedPath = objectPath.split('/').map(encodeURIComponent).join('/');
    const objectUrl = new URL(`${endpoint}/${creds.bucketName}/${encodedPath}`);
    
    // Force Download Name
    objectUrl.searchParams.set("response-content-disposition", contentDisposition);
    
    const signed = await r2.sign(objectUrl, {
      method: req.method,
      aws: { signQuery: true },
      headers: { "Host": `${creds.accountId}.r2.cloudflarestorage.com` },
      expiresIn: 14400
    });

    // 🔥 HEAD Request (APK Size Check)
    if (req.method === "HEAD") {
      const r2Response = await fetch(signed.url, { method: "HEAD" });
      
      // Header များကို APK မြင်အောင် ဖွင့်ပေးခြင်း
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

    // ⬇️ GET Request (Redirect)
    return res.redirect(302, signed.url);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
