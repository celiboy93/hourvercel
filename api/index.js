import { AwsClient } from 'aws4fetch';

export const config = {
  runtime: 'edge', // အမြန်ဆုံး Edge Runtime သုံးမည်
};

export default async function handler(request) {
  try {
    // 1. Config ယူခြင်း (JSON စနစ်)
    const envData = process.env.ACCOUNTS_JSON;
    if (!envData) return new Response("Config Error", { status: 500 });
    const R2_ACCOUNTS = JSON.parse(envData);

    // 2. URL Params
    const url = new URL(request.url);
    const video = url.searchParams.get('video');
    const acc = url.searchParams.get('acc') || "1"; // Default acc=1

    // Ping check for Cron-job
    if (video === "ping") return new Response("Pong!", { status: 200 });

    if (!video || !R2_ACCOUNTS[acc]) {
      return new Response("Invalid Parameters", { status: 400 });
    }

    const creds = R2_ACCOUNTS[acc];
    const r2 = new AwsClient({
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      service: 's3',
      region: 'auto',
    });

    const endpoint = `https://${creds.accountId}.r2.cloudflarestorage.com`;
    // Filename Cleaning logic from your Node.js code
    const objectKey = decodeURIComponent(video);
    const cleanFileName = objectKey.split('/').pop();
    const encodedFileName = encodeURIComponent(cleanFileName);
    
    // URL Encode for R2 path
    const encodedPath = encodeURIComponent(video).replace(/%2F/g, "/");
    const objectUrl = new URL(`${endpoint}/${creds.bucketName}/${encodedPath}`);
    const hostHeader = { "Host": `${creds.accountId}.r2.cloudflarestorage.com` };

    // Content-Disposition Format (Node.js ကုဒ်အတိုင်း ပြန်ယူထားသည်)
    const contentDisposition = `attachment; filename="${cleanFileName}"; filename*=UTF-8''${encodedFileName}`;

    // 🔥 HEAD Request Logic (APK Size Check)
    if (request.method === "HEAD") {
      // ၁. R2 ဆီက Size သွားမေးရန် Link ထုတ်ခြင်း
      const signedHead = await r2.sign(objectUrl, {
        method: "HEAD",
        aws: { signQuery: true },
        headers: hostHeader,
        expiresIn: 3600
      });

      // ၂. R2 ကို တကယ်လှမ်းမေးခြင်း
      const r2Response = await fetch(signedHead.url, { method: "HEAD" });
      
      // ၃. Header များ ပြန်စီခြင်း
      const newHeaders = new Headers();
      
      // CORS (အရေးကြီးသည်)
      newHeaders.set("Access-Control-Allow-Origin", "*");
      newHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      newHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Disposition, Content-Type");

      // R2 မှရသော Data များကို ထည့်ခြင်း
      if (r2Response.headers.has("Content-Length")) {
        newHeaders.set("Content-Length", r2Response.headers.get("Content-Length"));
      }
      newHeaders.set("Content-Type", r2Response.headers.get("Content-Type") || "video/mp4");
      newHeaders.set("Content-Disposition", contentDisposition);
      newHeaders.set("Accept-Ranges", "bytes");

      return new Response(null, {
        status: 200,
        headers: newHeaders
      });
    }

    // ⬇️ GET Request (Download Redirect)
    // ၄. Download Link ထုတ်ပေးခြင်း (Filename ပါထည့်ပေးသည်)
    objectUrl.searchParams.set("response-content-disposition", contentDisposition);
    
    const signedGet = await r2.sign(objectUrl, {
      method: 'GET',
      aws: { signQuery: true },
      headers: hostHeader,
      expiresIn: 14400 // 4 Hours (Node.js ကုဒ်အတိုင်း)
    });

    return Response.redirect(signedGet.url, 302);

  } catch (error) {
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
}
