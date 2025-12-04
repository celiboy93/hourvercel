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
    const acc = url.searchParams.get('acc');

    // Ping check for Cron-job
    if (video === "ping") {
      return new Response("Pong! Vercel is awake 🤖", { status: 200 });
    }

    if (!video || !acc || !R2_ACCOUNTS[acc]) {
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
    const encodedVideo = encodeURIComponent(video).replace(/%2F/g, "/");
    const objectUrl = new URL(`${endpoint}/${creds.bucketName}/${encodedVideo}`);
    const hostHeader = { "Host": `${creds.accountId}.r2.cloudflarestorage.com` };

    // 🔥 FIX: APK အတွက် Size Check (HEAD Request)
    if (request.method === "HEAD") {
      const signedHead = await r2.sign(objectUrl, {
        method: "HEAD",
        aws: { signQuery: true },
        headers: hostHeader,
        expiresIn: 3600
      });

      // R2 ဆီက Header တွေ လှမ်းယူမယ်
      const r2Response = await fetch(signedHead.url, { method: "HEAD" });
      
      // Header အသစ်ပြန်စီမယ်
      const newHeaders = new Headers(r2Response.headers);
      
      // CORS: APK က Header တွေကို ဖတ်ခွင့်ရအောင် ဖွင့်ပေးခြင်း
      newHeaders.set("Access-Control-Allow-Origin", "*");
      newHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      // 👇 ဒီလိုင်းက အရေးအကြီးဆုံးပါ (Size နဲ့ Name ကို ဖော်ပြခိုင်းတာပါ)
      newHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Disposition, Content-Type, ETag");

      return new Response(null, {
        status: 200,
        headers: newHeaders
      });
    }

    // Normal Redirect (GET)
    const signedGet = await r2.sign(objectUrl, {
      method: 'GET',
      aws: { signQuery: true },
      headers: hostHeader,
      expiresIn: 3600
    });

    return Response.redirect(signedGet.url, 307);

  } catch (error) {
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
}
