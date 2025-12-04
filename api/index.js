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
    
    // Filename Logic
    const objectKey = decodeURIComponent(video);
    const cleanFileName = objectKey.split('/').pop();
    const encodedFileName = encodeURIComponent(cleanFileName);
    const contentDisposition = `attachment; filename="${cleanFileName}"; filename*=UTF-8''${encodedFileName}`;

    const encodedPath = encodeURIComponent(video).replace(/%2F/g, "/");
    const objectUrl = new URL(`${endpoint}/${creds.bucketName}/${encodedPath}`);
    const hostHeader = { "Host": `${creds.accountId}.r2.cloudflarestorage.com` };

    // 🔥 HEAD Request Logic (Proxy Mode - 200 OK)
    // APK က Size မေးရင် Redirect မလုပ်ဘဲ Vercel ကပဲ တိုက်ရိုက်ဖြေမယ်
    if (request.method === "HEAD") {
      
      // 1. R2 ကို Size လှမ်းမေးမယ်
      const signedHead = await r2.sign(objectUrl, {
        method: "HEAD",
        aws: { signQuery: true },
        headers: hostHeader,
        expiresIn: 3600
      });

      const r2Response = await fetch(signedHead.url, { method: "HEAD" });

      if (r2Response.ok) {
        // 2. APK ဆီပြန်ပို့မယ့် Header တွေကို တည်ဆောက်မယ်
        const newHeaders = new Headers();
        
        // CORS (APK ဝင်ဖတ်လို့ရအောင်)
        newHeaders.set("Access-Control-Allow-Origin", "*");
        newHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        newHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Type, Content-Disposition, Accept-Ranges, ETag");

        // Size နဲ့ Type ကို R2 ဆီကယူပြီး ထည့်မယ်
        const size = r2Response.headers.get("Content-Length");
        const type = r2Response.headers.get("Content-Type");
        const etag = r2Response.headers.get("ETag");

        if (size) newHeaders.set("Content-Length", size);
        newHeaders.set("Content-Type", type || "video/mp4");
        newHeaders.set("Content-Disposition", contentDisposition);
        newHeaders.set("Accept-Ranges", "bytes"); // Resume ရအောင်
        if (etag) newHeaders.set("ETag", etag);

        // 3. 200 OK နဲ့ ပြန်ပို့မယ် (Redirect မဟုတ်ပါ)
        return new Response(null, {
          status: 200,
          headers: newHeaders
        });
      }
      
      // R2 မှာ ဖိုင်မရှိရင် 404 ပြမယ်
      return new Response("File Not Found", { status: 404 });
    }

    // ⬇️ GET Request (Download) - ဒီကျမှ Redirect လုပ်မယ်
    // Filename ပါအောင် parameter ထည့်မယ်
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
