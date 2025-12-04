import { AwsClient } from 'aws4fetch';

// Node.js Runtime ကို အသုံးပြုပါမည် (Header ပိုစိတ်ချရသည်)
export default async function handler(req, res) {
  try {
    const envData = process.env.ACCOUNTS_JSON;
    if (!envData) return res.status(500).send("Config Error");
    
    const R2_ACCOUNTS = JSON.parse(envData);
    
    // URL Parsing (Node.js style)
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
    
    // Filename Logic
    const objectKey = decodeURIComponent(video);
    const cleanFileName = objectKey.split('/').pop();
    const encodedFileName = encodeURIComponent(cleanFileName);
    const contentDisposition = `attachment; filename="${cleanFileName}"; filename*=UTF-8''${encodedFileName}`;

    const encodedPath = encodeURIComponent(video).replace(/%2F/g, "/");
    const objectUrl = new URL(`${endpoint}/${creds.bucketName}/${encodedPath}`);
    
    // R2 URL Params
    objectUrl.searchParams.set("response-content-disposition", contentDisposition);
    
    // Sign URL
    const signed = await r2.sign(objectUrl, {
      method: req.method, // GET or HEAD
      aws: { signQuery: true },
      headers: { "Host": `${creds.accountId}.r2.cloudflarestorage.com` },
      expiresIn: 14400 // 4 Hours
    });

    // 🔥 HEAD Request Handling (Node.js Proxy Mode)
    if (req.method === "HEAD") {
      // R2 ကို Size လှမ်းမေးမယ်
      const r2Response = await fetch(signed.url, { method: "HEAD" });
      
      // Header တွေကို ကူးထည့်မယ်
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Type, Content-Disposition, Accept-Ranges, ETag");

      if (r2Response.headers.has("content-length")) {
        res.setHeader("Content-Length", r2Response.headers.get("content-length"));
      }
      res.setHeader("Content-Type", r2Response.headers.get("content-type") || "video/mp4");
      res.setHeader("Content-Disposition", contentDisposition);
      res.setHeader("Accept-Ranges", "bytes");
      
      // 200 OK နဲ့ အဆုံးသတ်မယ်
      return res.status(200).end();
    }

    // ⬇️ GET Request (Redirect)
    return res.redirect(302, signed.url);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
