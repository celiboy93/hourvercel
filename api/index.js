import { AwsClient } from 'aws4fetch';

export const config = {
  runtime: 'edge', // အမြန်ဆုံး Edge ကိုပဲ ပြန်သုံးမယ်
};

export default async function handler(request) {
  try {
    const envData = process.env.ACCOUNTS_JSON;
    if (!envData) return new Response("Config Error", { status: 500 });
    const R2_ACCOUNTS = JSON.parse(envData);

    const url = new URL(request.url);
    const video = url.searchParams.get('video');
    const acc = url.searchParams.get('acc') || "1";

    // Ping for Cron-job
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
    
    // Filename Logic
    const objectKey = decodeURIComponent(video);
    const cleanFileName = objectKey.split('/').pop();
    const encodedFileName = encodeURIComponent(cleanFileName);
    const contentDisposition = `attachment; filename="${cleanFileName}"; filename*=UTF-8''${encodedFileName}`;

    const encodedPath = encodeURIComponent(video).replace(/%2F/g, "/");
    const objectUrl = new URL(`${endpoint}/${creds.bucketName}/${encodedPath}`);
    const hostHeader = { "Host": `${creds.accountId}.r2.cloudflarestorage.com` };

    // 🔥 HEAD Request Logic (Manual Force Mode)
    if (request.method === "HEAD") {
      // 1. R2 ကို Size လှမ်းမေး
      const signedHead = await r2.sign(objectUrl, {
        method: "HEAD",
        aws: { signQuery: true },
        headers: hostHeader,
        expiresIn: 3600
      });

      const r2Response = await fetch(signedHead.url, { method: "HEAD" });

      if (r2Response.ok) {
        // 2. Header တွေကို တစ်ခုချင်း "အတင်း" ထည့်မယ်
        // new Headers(r2Response.headers) လို့မသုံးဘဲ လက်နဲ့ရေးထည့်မယ်
        const fileSize = r2Response.headers.get("Content-Length");
        const fileType = r2Response.headers.get("Content-Type");
        const eTag = r2Response.headers.get("ETag");

        const headers = new Headers();
        
        // CORS (APK မြင်အောင်)
        headers.set("Access-Control-Allow-Origin", "*");
        headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Type, Content-Disposition, ETag, Accept-Ranges");

        // Data Headers
        if (fileSize) headers.set("Content-Length", fileSize);
        headers.set("Content-Type", fileType || "video/mp4");
        headers.set("Content-Disposition", contentDisposition);
        headers.set("Accept-Ranges", "bytes");
        if (eTag) headers.set("ETag", eTag);

        // 3. Body မပါတဲ့ Response (null) ကို Header အပြည့်နဲ့ ပြန်ပို့မယ်
        return new Response(null, {
          status: 200,
          headers: headers
        });
      }
      
      // Error တက်ရင် Redirect လုပ် (Fallback)
      const signedGetFallback = await r2.sign(objectUrl, {
        method: 'GET',
        aws: { signQuery: true },
        headers: hostHeader,
        expiresIn: 3600
      });
      return Response.redirect(signedGetFallback.url, 302);
    }

    // ⬇️ GET Request (Download Redirect)
    objectUrl.searchParams.set("response-content-disposition", contentDisposition);
    const signedGet = await r2.sign(objectUrl, {
      method: 'GET',
      aws: { signQuery: true },
      headers: hostHeader,
      expiresIn: 14400 
    });

    return Response.redirect(signedGet.url, 302);

  } catch (error) {
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
}
