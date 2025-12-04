import { AwsClient } from 'aws4fetch';

export const config = {
  runtime: 'edge',
};

export default async function handler(request) {
  try {
    const envData = process.env.ACCOUNTS_JSON;
    if (!envData) return new Response("Config Error", { status: 500 });
    const R2_ACCOUNTS = JSON.parse(envData);

    const url = new URL(request.url);
    const video = url.searchParams.get('video');
    const acc = url.searchParams.get('acc') || "1";

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
    // Filename Logic (Node.js Code အတိုင်း)
    const objectKey = decodeURIComponent(video);
    const cleanFileName = objectKey.split('/').pop();
    const encodedFileName = encodeURIComponent(cleanFileName);
    
    // R2 Path Encode
    const encodedPath = encodeURIComponent(video).replace(/%2F/g, "/");
    const objectUrl = new URL(`${endpoint}/${creds.bucketName}/${encodedPath}`);
    const hostHeader = { "Host": `${creds.accountId}.r2.cloudflarestorage.com` };

    // Content-Disposition String
    const contentDisposition = `attachment; filename="${cleanFileName}"; filename*=UTF-8''${encodedFileName}`;

    // ⬇️ Signed URL for GET (Download)
    // 4 Hours Expiry (Node.js Code အတိုင်း)
    const signedGet = await r2.sign(objectUrl, {
      method: 'GET',
      aws: { signQuery: true },
      headers: hostHeader,
      expiresIn: 14400 
    });
    
    // Add content-disposition to the signed URL query for R2 to force it
    signedGet.url.searchParams.set("response-content-disposition", contentDisposition);

    // 🔥 HEAD Request Logic (Improved with Fallback)
    if (request.method === "HEAD") {
      try {
        const signedHead = await r2.sign(objectUrl, {
          method: "HEAD",
          aws: { signQuery: true },
          headers: hostHeader,
          expiresIn: 3600
        });

        const r2Response = await fetch(signedHead.url, { method: "HEAD" });

        // အကယ်၍ R2 က 200 OK ပြန်မှသာ Size ကို ပို့မယ်
        if (r2Response.ok) {
          const newHeaders = new Headers();
          newHeaders.set("Access-Control-Allow-Origin", "*");
          newHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
          newHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Type, Content-Disposition, Accept-Ranges, ETag");
          
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
        // R2 က Error တက်ရင် အောက်က Redirect (Fallback) ကို ဆက်သွားမယ်...
      } catch (e) {
        // Fallback to Redirect
      }
      
      // Fallback: HEAD request မအောင်မြင်ရင် 302 Redirect လုပ်လိုက်မယ်
      // APK က Redirect URL ဆီကနေ Size ကို သူ့ဘာသာ ဆက်ရှာလိမ့်မယ်
      return Response.redirect(signedGet.url, 302);
    }

    // ⬇️ GET Request (Direct Redirect)
    return Response.redirect(signedGet.url, 302);

  } catch (error) {
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
}
