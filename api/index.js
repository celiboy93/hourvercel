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

    // Deno Logic အတိုင်း URL တည်ဆောက်ပုံကို ရိုးရှင်းလိုက်ပါမယ်
    // (အပို Encode တွေ ဖြုတ်လိုက်ပါပြီ)
    const endpoint = `https://${creds.accountId}.r2.cloudflarestorage.com`;
    const objectUrl = new URL(`${endpoint}/${creds.bucketName}/${video}`);
    const hostHeader = { "Host": `${creds.accountId}.r2.cloudflarestorage.com` };

    // 🔥 HEAD Request (Proxy All Headers)
    // Deno မှာ အလုပ်ဖြစ်တဲ့ နည်းလမ်းအတိုင်း Header အကုန်ကူးထည့်ပါမယ်
    if (request.method === "HEAD") {
      const signedHead = await r2.sign(objectUrl, {
        method: "HEAD",
        aws: { signQuery: true },
        headers: hostHeader,
        expiresIn: 3600
      });

      const r2Response = await fetch(signedHead.url, { method: "HEAD" });
      
      // R2 က ပြန်လာတဲ့ Header အကုန်လုံးကို အသစ်ထဲ ထည့်မယ်
      const newHeaders = new Headers(r2Response.headers);
      
      // CORS နဲ့ Expose Headers ကို ထပ်ဖြည့်မယ် (ဒါက အရေးကြီးပါတယ်)
      newHeaders.set("Access-Control-Allow-Origin", "*");
      newHeaders.set("Access-Control-Expose-Headers", "*"); // Header အကုန်ပြမယ်လို့ ပြောလိုက်တာပါ

      return new Response(null, {
        status: r2Response.status, // R2 status အတိုင်းပြန်မယ် (usually 200)
        headers: newHeaders
      });
    }

    // ⬇️ GET Request (Download Redirect)
    // Filename Force Download
    const objectKey = decodeURIComponent(video);
    const cleanFileName = objectKey.split('/').pop();
    const contentDisposition = `attachment; filename="${cleanFileName}"`;
    
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
