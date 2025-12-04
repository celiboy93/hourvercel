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

    if (!video || !acc || !R2_ACCOUNTS[acc]) return new Response("Invalid Params", { status: 400 });

    const creds = R2_ACCOUNTS[acc];
    const r2 = new AwsClient({
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      service: 's3',
      region: 'auto',
    });

    const endpoint = `https://${creds.accountId}.r2.cloudflarestorage.com`;
    // URL Encode space fix
    const encodedVideo = encodeURIComponent(video).replace(/%2F/g, "/");
    const objectUrl = new URL(`${endpoint}/${creds.bucketName}/${encodedVideo}`);
    const headers = { "Host": `${creds.accountId}.r2.cloudflarestorage.com` };

    // 🔥 HEAD Request Handling (Size Check)
    if (request.method === "HEAD") {
      const signedHead = await r2.sign(objectUrl, {
        method: "HEAD",
        aws: { signQuery: true },
        headers: headers,
        expiresIn: 3600
      });

      const r2Response = await fetch(signedHead.url, { method: "HEAD" });
      
      const newHeaders = new Headers(r2Response.headers);
      newHeaders.set("Access-Control-Allow-Origin", "*");

      return new Response(null, {
        status: 200,
        headers: newHeaders
      });
    }

    // Normal Redirect
    const signedGet = await r2.sign(objectUrl, {
      method: 'GET',
      aws: { signQuery: true },
      headers: headers,
      expiresIn: 3600
    });

    return Response.redirect(signedGet.url, 307);

  } catch (error) {
    return new Response(`Error: ${error.message}`, { status: 500 });
  }
}
