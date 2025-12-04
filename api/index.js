import { AwsClient } from 'aws4fetch';

// runtime: 'edge' ကို ဖြုတ်လိုက်ပါ (Node.js သုံးပါမယ်)
export default async function handler(req, res) {
  try {
    const envData = process.env.ACCOUNTS_JSON;
    if (!envData) return res.status(500).send("Config Error");
    
    const R2_ACCOUNTS = JSON.parse(envData);
    
    // URL Parsing
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
    
    // R2 URL Params (Force Download Name)
    objectUrl.searchParams.set("response-content-disposition", contentDisposition);
    
    const signed = await r2.sign(objectUrl, {
      method: req.method,
      aws: { signQuery: true },
      headers: { "Host": `${creds.accountId}.r2.cloudflarestorage.com` },
      expiresIn: 14400
    });

    // 🔥 HEAD Request Handling (Node.js Mode - 100% Size Works)
    if (req.method === "HEAD") {
      const r2Response = await fetch(signed.url, { method: "HEAD" });
      
      // Node.js မှာ Header ဖြတ်မချပါ၊ ဒီတိုင်း အကုန်ပြန်ထည့်ပေးမယ်
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
