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
    
    // Filename Logic (Node.js ကုဒ်အတိုင်း)
    const objectKey = decodeURIComponent(video);
    const cleanFileName = objectKey.split('/').pop();
    const encodedFileName = encodeURIComponent(cleanFileName);
    const contentDisposition = `attachment; filename="${cleanFileName}"; filename*=UTF-8''${encodedFileName}`;

    // R2 URL
    const encodedPath = encodeURIComponent(video).replace(/%2F/g, "/");
    const objectUrl = new URL(`${endpoint}/${creds.bucketName}/${encodedPath}`);
    const hostHeader = { "Host": `${creds.accountId}.r2.cloudflarestorage.com` };

    // ⬇️ Signed URL ထုတ်ခြင်း (GET & HEAD နှစ်ခုလုံးအတွက် သုံးမည်)
    // Node.js ကုဒ်လိုမျိုး params ထည့်ပေးလိုက်ပါမယ်
    objectUrl.searchParams.set("response-content-disposition", contentDisposition);
    
    const signedUrl = await r2.sign(objectUrl, {
      method: 'GET', 
      aws: { signQuery: true },
      headers: hostHeader,
      expiresIn: 14400 // 4 Hours
    });

    // 🔥 HEAD Request Logic (Hybrid Fallback System)
    if (request.method === "HEAD") {
      try {
        // ၁. R2 ကို Size လှမ်းမေးမယ်
        const r2Response = await fetch(signedUrl.url, { method: "HEAD" });
        
        const size = r2Response.headers.get("Content-Length");

        // ၂. Size အမှန်တကယ်ရမှသာ 200 OK နဲ့ ပြန်ပို့မယ်
        if (r2Response.ok && size && size !== "0") {
          const newHeaders = new Headers();
          newHeaders.set("Access-Control-Allow-Origin", "*");
          newHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
          newHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Type, Content-Disposition, Accept-Ranges, ETag");
          
          newHeaders.set("Content-Length", size);
          newHeaders.set("Content-Type", r2Response.headers.get("Content-Type") || "video/mp4");
          newHeaders.set("Content-Disposition", contentDisposition);
          newHeaders.set("Accept-Ranges", "bytes");

          return new Response(null, {
            status: 200,
            headers: newHeaders
          });
        }
      } catch (e) {
        // Error ဖြစ်ရင် ဘာမှမလုပ်ဘဲ အောက်က Redirect ကို သွားမယ်
      }
      
      // ၃. (Plan B) Size မေးမရရင် Redirect လုပ်လိုက်မယ်
      // APK က Redirect URL (R2) ဆီကနေ Size ကို တိုက်ရိုက်သွားယူလိမ့်မယ်
      return Response.redirect(signedUrl.url, 302);
    }

    // ⬇️ GET Request (Direct Redirect)
    return Response.redirect(signedUrl.url, 302);

  } catch (error) {
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
}
